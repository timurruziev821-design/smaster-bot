const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const { WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_ID', 'MASTER_SEED'];
for (const env of requiredEnv) { if (!process.env[env]) { console.error(`❌ Нет ${env}`); process.exit(1); } }

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const states = new Map();

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

async function getWallet(userId) {
  const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function updateWallet(userId, patch) {
  await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId));
}

async function createWallet(user, referrer_id = null) {
  try {
    const hdNode = ethers.HDNodeWallet.fromPhrase(process.env.MASTER_SEED);
    const ethWallet = hdNode.derivePath(`m/44'/60'/0'/0/${user.id % 100000}`);
    const ethAddress = ethWallet.address;

    const tonMnemonic = process.env.MASTER_SEED.split(' ');
    const tonKey = await mnemonicToPrivateKey(tonMnemonic);
    const userSeed = tonKey.secretKey.toString('hex') + String(user.id);
    const userHash = crypto.createHash('sha256').update(userSeed).digest();
    const userPublicKey = userHash.subarray(0, 32);
    const tonWallet = WalletContractV4.create({ publicKey: userPublicKey, workchain: 0 });
    const tonAddress = tonWallet.address.toString({ bounceable: false });

    const { data, error } = await supabase.from('smaster_wallets').insert({
      user_id: Number(user.id),
      username: user.username ? escapeHtml(user.username) : null,
      ton_deposit_address: tonAddress,
      eth_deposit_address: ethAddress,
      referrer_id: referrer_id ? Number(referrer_id) : null
    }).select();

    if (error) throw error;
    return { data: data[0] };
  } catch (e) {
    console.error('Wallet error:', e.message);
    return { error: e.message };
  }
}

bot.setMyCommands([
  { command: '/start', description: '🚀 Запустить' },
  { command: '/app', description: '📱 Mini App' }
]);

function getMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }, { text: '👤 Профиль', callback_data: 'set_profile' }],
        [{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '🚀 Mini App', callback_data: 'open_app', style: 'primary' }],
        [{ text: '⚙️ Настройки', callback_data: 'menu_settings' }]
      ]
    }
  };
}bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    let w = await getWallet(msg.from.id);
    if (!w) {
      const textParts = msg.text.split(' ');
      let ref = textParts.length > 1 && textParts[1].startsWith('ref_') ? textParts[1].split('_')[1] : null;
      const res = await createWallet(msg.from, ref);
      w = res.data;
    }
    await bot.sendMessage(chatId, `<b>Привет, ${escapeHtml(msg.from.first_name)}! 👋</b>\n\nДобро пожаловать в SMaster.`, { ...getMainMenu(), parse_mode: 'HTML' });
  } catch (e) { console.error(e); }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  let w = await getWallet(userId);

  if (data === 'back_to_menu') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, 'Меню:', { ...getMainMenu(), parse_mode: 'HTML' });
  }

  if (data === 'menu_balance') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const text = `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt || 0).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton || 0).toFixed(2)}</code>\nETH: <code>${Number(w.balance_eth || 0).toFixed(4)}</code>`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  }

  if (data === 'menu_deposit') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, '💳 Выбери валюту:', { reply_markup: { inline_keyboard: [[{ text: '💎 TON', callback_data: 'dep_ton' }, { text: '💵 USDT', callback_data: 'dep_eth' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }

  if (data === 'dep_ton') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, `💎 <b>TON Адрес:</b>\n<code>${w.ton_deposit_address || 'Ошибка'}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }
  if (data === 'dep_eth') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, `💵 <b>ETH Адрес:</b>\n<code>${w.eth_deposit_address || 'Ошибка'}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }

  if (data === 'set_profile') {
    await bot.deleteMessage(chatId, query.message.message_id);
    const text = `👤 <b>Профиль</b>\n\nID: <code>${userId}</code>\nИмя: ${w.username || 'Нет'}\nРейтинг P2P: ⭐ 5.00\nСделок: 0`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  }

  if (data === 'menu_p2p') {
    await bot.deleteMessage(chatId, query.message.message_id);
    const text = `🎲 <b>P2P Маркет</b>\n\nЗдесь вы можете купить или продать USDT.\n\nВыберите действие:`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [
      [{ text: '🛒 Купить USDT', callback_data: 'p2p_buy' }],
      [{ text: '➕ Создать объявление', callback_data: 'p2p_create', style: 'success' }],
      [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
    ]}, parse_mode: 'HTML' });
  }

  if (data === 'menu_checks') {
    await bot.deleteMessage(chatId, query.message.message_id);
    const text = `🧾 <b>Чеки</b>\n\nСоздайте чек и отправьте другу.`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [
      [{ text: '➕ Создать чек', callback_data: 'check_create', style: 'success' }],
      [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
    ]}, parse_mode: 'HTML' });
  }

  if (data === 'menu_settings') {
    await bot.deleteMessage(chatId, query.message.message_id);
    const text = `⚙️ <b>Настройки</b>\n\nУправляйте аккаунтом:`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [
      [{ text: '🔔 Уведомления', callback_data: 'settings_notify' }],
      [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
    ]}, parse_mode: 'HTML' });
  }

  if (data === 'settings_notify') {
    const newStatus = !w.notifications;
    await updateWallet(userId, { notifications: newStatus });
    await bot.answerCallbackQuery(query.id, { text: newStatus ? '🔔 Включены' : '🔕 Выключены' }).catch(() => {});
  }

  if (data === 'open_app') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const appUrl = process.env.APP_URL || 'https://smaster-bot.onrender.com/app';
    return bot.sendMessage(chatId, '🚀 Открываю Mini App...', { reply_markup: { inline_keyboard: [[{ text: '📱 Открыть', web_app: { url: appUrl } }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }
});const app = express();
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use(express.json({ limit: '10kb' }));

app.get('/api/user/:id', async (req, res) => {
  try {
    const w = await getWallet(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json({ 
      balance_usdt: w.balance_usdt, balance_ton: w.balance_ton, balance_eth: w.balance_eth, 
      ton_deposit_address: w.ton_deposit_address, eth_deposit_address: w.eth_deposit_address 
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/app', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <script src="https://telegram.org/js/telegram-web-app.js"></script>
      <title>SMaster</title>
      <style>
        :root { --bg-dark: #0f0715; --bg-card: #1c102b; --accent-pink: #ff007f; --text-main: #ffffff; --text-muted: #9e8bb5; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; user-select: none; }
        body { background-color: var(--bg-dark); color: var(--text-main); padding: 20px; padding-bottom: 80px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .logo { font-size: 26px; font-weight: 900; background: linear-gradient(90deg, var(--accent-pink), #8a2be2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, var(--accent-pink), #8a2be2); display: flex; justify-content: center; align-items: center; font-weight: bold; }
        .balance-card { background: var(--bg-card); border-radius: 24px; padding: 24px; margin-bottom: 20px; border: 1px solid rgba(255, 0, 127, 0.1); }
        .balance-title { font-size: 14px; color: var(--text-muted); margin-bottom: 8px; }
        .balance-amount { font-size: 40px; font-weight: 800; }
        .balance-amount span { color: #00ff88; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
        .btn { background: var(--bg-card); border: 1px solid rgba(255, 0, 127, 0.1); border-radius: 18px; padding: 16px 8px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px; cursor: pointer; }
        .btn:active { transform: scale(0.95); background: #2a1840; }
        .btn .icon { font-size: 24px; }
        .btn .label { font-size: 12px; color: var(--text-muted); }
        .section-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
        .coin-list { background: var(--bg-card); border-radius: 20px; padding: 8px; margin-bottom: 24px; }
        .coin-item { display: flex; justify-content: space-between; padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .coin-item:last-child { border-bottom: none; }
        .coin-info { display: flex; align-items: center; gap: 12px; }
        .coin-icon { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.1); display: flex; justify-content: center; align-items: center; font-size: 18px; }
        .coin-name { font-weight: 600; }
        .coin-amount { font-weight: 700; text-align: right; }
        .address-card { background: var(--bg-card); border-radius: 20px; padding: 20px; margin-bottom: 16px; }
        .address-title { font-size: 14px; color: var(--text-muted); margin-bottom: 12px; display: flex; justify-content: space-between; }
        .address-box { background: #09040d; padding: 14px; border-radius: 12px; font-family: monospace; font-size: 13px; word-break: break-all; color: var(--accent-pink); text-align: center; border: 1px solid rgba(255,0,127,0.2); }
        .copy-btn { background: rgba(255,0,127,0.1); color: var(--accent-pink); border: none; padding: 12px; border-radius: 12px; width: 100%; margin-top: 12px; font-weight: 600; cursor: pointer; }
        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(28, 16, 43, 0.95); display: flex; justify-content: space-around; padding: 16px 0; border-top: 1px solid rgba(255,0,127,0.1); backdrop-filter: blur(10px); }
        .nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
        .nav-item .nav-icon { font-size: 22px; }
        .nav-item.active { color: var(--accent-pink); }
        .screen { display: none; }
        .screen.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      </style>
    </head>
    <body>
      <div id="screen-main" class="screen active">
        <div class="header"><div class="logo">SMaster</div><div class="avatar" id="user-avatar">S</div></div>
        <div class="balance-card"><div class="balance-title">Общий баланс</div><div class="balance-amount"><span id="total-balance">0.00</span> <span style="font-size:24px;color:white;">USDT</span></div></div>
        <div class="grid">
          <div class="btn" onclick="showScreen('screen-deposit')"><div class="icon">💳</div><div class="label">Пополнить</div></div>
          <div class="btn" onclick="showScreen('screen-p2p')"><div class="icon">🎲</div><div class="label">P2P</div></div>
          <div class="btn" onclick="showScreen('screen-checks')"><div class="icon">🧾</div><div class="label">Чеки</div></div>
          <div class="btn" onclick="alert('В разработке')"><div class="icon">📤</div><div class="label">Вывести</div></div>
        </div>
        <div class="section-title">Активы</div>
        <div class="coin-list">
          <div class="coin-item"><div class="coin-info"><div class="coin-icon" style="background:#26a17b;">💵</div><div><div class="coin-name">Tether</div><div style="font-size:12px;color:#888;">USDT</div></div></div><div class="coin-amount" id="coin-usdt">0.00</div></div>
          <div class="coin-item"><div class="coin-info"><div class="coin-icon" style="background:#0098ea;">💎</div><div><div class="coin-name">Toncoin</div><div style="font-size:12px;color:#888;">TON</div></div></div><div class="coin-amount" id="coin-ton">0.00</div></div>
          <div class="coin-item"><div class="coin-info"><div class="coin-icon" style="background:#627eea;">🔷</div><div><div class="coin-name">Ethereum</div><div style="font-size:12px;color:#888;">ETH</div></div></div><div class="coin-amount" id="coin-eth">0.00</div></div>
        </div>
      </div>

      <div id="screen-deposit" class="screen">
        <div class="header"><div class="logo" style="font-size:20px;">Пополнение</div><div style="color:var(--accent-pink);cursor:pointer;" onclick="showScreen('screen-main')">✕</div></div>
        <div class="address-card"><div class="address-title"><span>TON</span><span style="color:#00ff88;">Сеть: TON</span></div><div class="address-box" id="dep-ton">Загрузка...</div><button class="copy-btn" onclick="copyText('dep-ton')">Копировать</button></div>
        <div class="address-card"><div class="address-title"><span>ETH</span><span style="color:#8a2be2;">Сеть: ERC20</span></div><div class="address-box" id="dep-eth">Загрузка...</div><button class="copy-btn" onclick="copyText('dep-eth')">Копировать</button></div>
      </div>

      <div id="screen-p2p" class="screen"><div class="header"><div class="logo" style="font-size:20px;">P2P</div><div style="cursor:pointer;" onclick="showScreen('screen-main')">✕</div></div><div class="balance-card" style="text-align:center;"><div style="font-size:40px;">🎲</div><div>P2P Маркет</div><div style="font-size:14px;color:#888;">Сделки доступны в боте.</div></div></div>
      <div id="screen-checks" class="screen"><div class="header"><div class="logo" style="font-size:20px;">Чеки</div><div style="cursor:pointer;" onclick="showScreen('screen-main')">✕</div></div><div class="balance-card" style="text-align:center;"><div style="font-size:40px;">🧾</div><div>Чеки</div><div style="font-size:14px;color:#888;">Создание чеков доступно в боте.</div></div></div>

      <div class="bottom-nav">
        <div class="nav-item active" onclick="showScreen('screen-main')"><div class="nav-icon">🏠</div>Главная</div>
        <div class="nav-item" onclick="showScreen('screen-p2p')"><div class="nav-icon">🎲</div>P2P</div>
        <div class="nav-item" onclick="showScreen('screen-checks')"><div class="nav-icon">🧾</div>Чеки</div>
        <div class="nav-item" onclick="showScreen('screen-deposit')"><div class="nav-icon">💳</div>Пополнить</div>
      </div>
      <script>
        const tg = window.Telegram.WebApp; tg.expand(); tg.setHeaderColor('#0f0715');
        if (tg.initDataUnsafe && tg.initDataUnsafe.user) document.getElementById('user-avatar').innerText = tg.initDataUnsafe.user.first_name.charAt(0);
        async function loadData() { 
          try { const userId = tg.initDataUnsafe?.user?.id; if (!userId) return; const res = await fetch('/api/user/' + userId); const data = await res.json(); 
          if (data) { 
            document.getElementById('total-balance').innerText = Number(data.balance_usdt || 0).toFixed(2); 
            document.getElementById('coin-usdt').innerText = Number(data.balance_usdt || 0).toFixed(2); 
            document.getElementById('coin-ton').innerText = Number(data.balance_ton || 0).toFixed(2); 
            document.getElementById('coin-eth').innerText = Number(data.balance_eth || 0).toFixed(4);
            document.getElementById('dep-ton').innerText = data.ton_deposit_address || 'Ошибка'; 
            document.getElementById('dep-eth').innerText = data.eth_deposit_address || 'Ошибка'; 
          } } catch (e) { console.error(e); } 
        }
        function showScreen(id) { 
          document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); 
          document.getElementById(id).classList.add('active'); 
          document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
          if(id === 'screen-main') document.querySelectorAll('.nav-item')[0].classList.add('active');
          if(id === 'screen-p2p') document.querySelectorAll('.nav-item')[1].classList.add('active');
          if(id === 'screen-checks') document.querySelectorAll('.nav-item')[2].classList.add('active');
          if(id === 'screen-deposit') document.querySelectorAll('.nav-item')[3].classList.add('active');
        }
        function copyText(id) { 
          const text = document.getElementById(id).innerText; 
          if (text === 'Ошибка' || text === 'Загрузка...') return; 
          navigator.clipboard.writeText(text).then(() => tg.showAlert('Скопировано!')); 
        }
        loadData();
      </script>
    </body>
    </html>
  `);
});

app.get('/', (req, res) => res.send('SMaster is running securely'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP listening'));
console.log('🤖 SMaster запущен!');
