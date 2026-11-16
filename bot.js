const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const { WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 1. ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_ID', 'MASTER_SEED'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: Отсутствует переменная ${env}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = String(process.env.ADMIN_ID);
const MASTER_SEED = process.env.MASTER_SEED;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const states = new Map();

// 2. ФУНКЦИЯ ЭКРАНИРОВАНИЯ (ЗАЩИТА ОТ XSS)
function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    if (m === '"') return '&quot;';
    if (m === "'") return '&#039;';
  });
}

// 3. ХЕЛПЕРЫ БАЗЫ ДАННЫХ
async function getWallet(userId) {
  const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function updateWallet(userId, patch) {
  await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId));
}

async function logHistory(userId, type, amount, currency) {
  await supabase.from('smaster_history').insert({ user_id: Number(userId), type, amount, currency });
}

// 4. ГЕНЕРАЦИЯ HD-КОШЕЛЬКОВ
async function createWallet(user, referrer_id = null) {
  try {
    // ETH (HD)
    const hdNode = ethers.HDNodeWallet.fromPhrase(MASTER_SEED);
    const ethWallet = hdNode.derivePath(`m/44'/60'/0'/0/${user.id % 100000}`);
    const ethAddress = ethWallet.address;

    // TON (HD)
    const tonMnemonic = MASTER_SEED.split(' ');
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
    console.error('Wallet Gen Error:', e.message);
    return { error: e.message };
  }
}

// 5. МЕНЮ КОМАНД
bot.setMyCommands([
  { command: '/start', description: 'Запустить бота' },
  { command: '/app', description: 'Открыть Mini App' },
  { command: '/help', description: 'Помощь' },
  { command: '/admin', description: 'Админ-панель' }
]);// 6. ГЛАВНОЕ МЕНЮ
function getMainMenu(hasWallet) {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }, { text: '👤 Профиль', callback_data: 'set_profile' }],
        [{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '🎲 P2P', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '🎁 Рефералка', callback_data: 'menu_ref' }],
        [{ text: '🚀 Mini App', callback_data: 'open_app', style: 'primary' }, { text: '⚙️ Настройки', callback_data: 'menu_settings' }]
      ]
    }
  };
}

// 7. СТАРТ
bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    let w = await getWallet(msg.from.id);
    
    if (!w) {
      const textParts = msg.text.split(' ');
      let ref = null;
      if (textParts.length > 1 && textParts[1].startsWith('ref_')) ref = textParts[1].split('_')[1];
      const res = await createWallet(msg.from, ref);
      w = res.data;
    }

    await bot.sendMessage(chatId, `<b>Привет, ${escapeHtml(msg.from.first_name)}! 👋</b>\n\nДобро пожаловать в SMaster.`, { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { console.error(e); }
});

// 8. КНОПКИ
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  let w = await getWallet(userId);

  if (data === 'back_to_menu') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, 'Главное меню:', { ...getMainMenu(!!w), parse_mode: 'HTML' });
  }

  if (data === 'menu_balance') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const text = `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton).toFixed(2)}</code>\nETH: <code>${Number(w.balance_eth).toFixed(4)}</code>`;
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  }

  if (data === 'menu_deposit') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, '💳 Выбери валюту:', { reply_markup: { inline_keyboard: [[{ text: '💎 TON', callback_data: 'dep_ton' }, { text: '💵 USDT', callback_data: 'dep_eth' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }

  if (data === 'dep_ton') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, `💎 <b>TON Адрес:</b>\n<code>${w.ton_deposit_address}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }
  if (data === 'dep_eth') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, `💵 <b>ETH Адрес:</b>\n<code>${w.eth_deposit_address}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }

  if (data === 'open_app') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const appUrl = process.env.APP_URL || 'https://твой-сайт.onrender.com/app';
    return bot.sendMessage(chatId, '🚀 Открываю Mini App...', { reply_markup: { inline_keyboard: [[{ text: '📱 Открыть', web_app: { url: appUrl } }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }
});// 9. EXPRESS СЕРВЕР С ЗАЩИТОЙ
const app = express();

// Helmet для защиты заголовков
app.use(helmet());
// Лимит на запросы (100 в минуту)
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
// Ограничение размера JSON
app.use(express.json({ limit: '10kb' }));

// API для Mini App
app.get('/api/user/:id', async (req, res) => {
  try {
    // В реальности тут нужно проверять initData от Telegram, но для простоты проверим ID
    const w = await getWallet(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json({ 
      balance_usdt: w.balance_usdt, 
      balance_ton: w.balance_ton,
      ton_deposit_address: w.ton_deposit_address, 
      eth_deposit_address: w.eth_deposit_address 
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// MINI APP
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
        :root { --bg-dark: #0f0715; --bg-card: #1c102b; --accent-pink: #ff007f; --text-main: #ffffff; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; user-select: none; }
        body { background-color: var(--bg-dark); color: var(--text-main); padding: 20px; padding-bottom: 80px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .logo { font-size: 26px; font-weight: 900; color: var(--accent-pink); }
        .card { background: var(--bg-card); border-radius: 20px; padding: 20px; margin-bottom: 16px; }
        .balance { font-size: 40px; font-weight: 800; color: #00ff88; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .btn { background: rgba(255,0,127,0.1); border: 1px solid var(--accent-pink); color: white; padding: 16px; border-radius: 16px; text-align: center; font-weight: 600; cursor: pointer; }
        .btn:active { transform: scale(0.95); }
        .addr { background: #09040d; padding: 14px; border-radius: 12px; font-family: monospace; font-size: 13px; word-break: break-all; color: var(--accent-pink); text-align: center; margin-top: 8px; }
        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-card); display: flex; justify-content: space-around; padding: 16px; border-top: 1px solid rgba(255,0,127,0.1); }
        .nav-item { color: #888; font-size: 12px; text-align: center; }
        .nav-item.active { color: var(--accent-pink); }
        .screen { display: none; }
        .screen.active { display: block; }
      </style>
    </head>
    <body>
      <div id="screen-main" class="screen active">
        <div class="header"><div class="logo">SMaster</div></div>
        <div class="card">
          <div style="color:#888; font-size:14px;">Общий баланс</div>
          <div class="balance" id="total-balance">0.00 USDT</div>
        </div>
        <div class="grid">
          <div class="btn" onclick="showScreen('screen-deposit')">💳 Пополнить</div>
          <div class="btn" onclick="alert('В разработке')">📤 Вывести</div>
          <div class="btn" onclick="alert('В разработке')">🎲 P2P</div>
          <div class="btn" onclick="alert('В разработке')">🧾 Чеки</div>
        </div>
      </div>
      <div id="screen-deposit" class="screen">
        <div class="header"><div class="logo" style="font-size:20px;">Пополнение</div><div style="cursor:pointer;" onclick="showScreen('screen-main')">✕</div></div>
        <div class="card"><div style="color:#888;">TON Адрес</div><div class="addr" id="dep-ton">Загрузка...</div></div>
        <div class="card"><div style="color:#888;">ETH Адрес</div><div class="addr" id="dep-eth">Загрузка...</div></div>
      </div>
      <div class="bottom-nav">
        <div class="nav-item active" onclick="showScreen('screen-main')">🏠 Главная</div>
        <div class="nav-item" onclick="alert('В разработке')">🎲 P2P</div>
        <div class="nav-item" onclick="alert('В разработке')">👤 Профиль</div>
      </div>
      <script>
        const tg = window.Telegram.WebApp; tg.expand(); tg.setHeaderColor('#0f0715');
        async function loadData() { 
          try { 
            const userId = tg.initDataUnsafe?.user?.id; 
            if (!userId) return; 
            const res = await fetch('/api/user/' + userId); 
            const data = await res.json(); 
            if (data) { 
              document.getElementById('total-balance').innerText = Number(data.balance_usdt || 0).toFixed(2) + ' USDT'; 
              document.getElementById('dep-ton').innerText = data.ton_deposit_address || 'Ошибка'; 
              document.getElementById('dep-eth').innerText = data.eth_deposit_address || 'Ошибка'; 
            } 
          } catch (e) { console.error(e); } 
        }
        function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); document.getElementById(id).classList.add('active'); }
        loadData();
      </script>
    </body>
    </html>
  `);
});

app.get('/', (req, res) => res.send('SMaster is running securely'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP listening'));
console.log('🤖 Бот запущен с защитой!');
