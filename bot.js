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
    // ETH
    const hdNode = ethers.HDNodeWallet.fromPhrase(process.env.MASTER_SEED);
    const ethWallet = hdNode.derivePath(`m/44'/60'/0'/0/${user.id % 100000}`);
    const ethAddress = ethWallet.address;

    // TON
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

// Функция, которая выдает правильное меню (с кнопкой или без)
function getMenu(hasWallet) {
  if (!hasWallet) {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]
        ]
      }
    };
  }
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
      await bot.sendMessage(chatId, 'У тебя еще нет кошелька. Нажми кнопку ниже, чтобы создать его.', { ...getMenu(false), parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(chatId, `<b>Привет, ${escapeHtml(msg.from.first_name)}! 👋</b>\n\nТвой кошелек готов к работе.`, { ...getMenu(true), parse_mode: 'HTML' });
    }
  } catch (e) { console.error(e); }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  let w = await getWallet(userId);

  // Если нажали "Создать кошелек"
  if (data === 'create_wallet') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const res = await createWallet(query.from);
    if (res.error) {
      return bot.sendMessage(chatId, `❌ Ошибка создания: ${res.error}`, { ...getMenu(false) });
    }
    // После создания показываем полное меню
    return bot.sendMessage(chatId, '✅ <b>Кошелек успешно создан!</b>', { ...getMenu(true), parse_mode: 'HTML' });
  }

  // Если кошелька нет, а нажимают другие кнопки
  if (!w) {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, 'Кошелек не найден. Создай его кнопкой ниже:', { ...getMenu(false) });
  }

  if (data === 'back_to_menu') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, 'Главное меню:', { ...getMenu(true), parse_mode: 'HTML' });
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

  if (data === 'open_app') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const appUrl = process.env.APP_URL || 'https://smaster-bot.onrender.com/app';
    return bot.sendMessage(chatId, '🚀 Открываю Mini App...', { reply_markup: { inline_keyboard: [[{ text: '📱 Открыть', web_app: { url: appUrl } }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }

  if (data === 'set_profile') {
    await bot.deleteMessage(chatId, query.message.message_id);
    return bot.sendMessage(chatId, `👤 ID: <code>${userId}</code>\nИмя: ${w.username || 'Нет'}\nРейтинг: ⭐ 5.00`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  }
  
  if (data === 'menu_p2p' || data === 'menu_checks' || data === 'menu_settings') {
    await bot.deleteMessage(chatId, query.message.message_id);
    return bot.sendMessage(chatId, '🚧 Раздел в разработке...', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
  }
});const app = express();
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use(express.json({ limit: '10kb' }));

app.get('/api/user/:id', async (req, res) => {
  try {
    const w = await getWallet(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json({ balance_usdt: w.balance_usdt, balance_ton: w.balance_ton, balance_eth: w.balance_eth, ton_deposit_address: w.ton_deposit_address, eth_deposit_address: w.eth_deposit_address });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/app', (req, res) => {
  // ВСТАВЬ СЮДА HTML-КОД MINI APP ИЗ ПРЕДЫДУЩЕГО СООБЩЕНИЯ
  res.send('<h1>Mini App loading...</h1>');
});

app.get('/', (req, res) => res.send('SMaster is running securely'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP listening'));
console.log('🤖 SMaster запущен!');
