const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { WalletContractV4, internal, toNano, TonClient } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const axios = require('axios');
const helmet = require('helmet');

process.on('uncaughtException', (err) => console.error('КРИТ. ОШИБКА:', err.message));
process.on('unhandledRejection', (err) => console.error('ОШИБКА ПРОМИСА:', err.message));

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = String(process.env.ADMIN_ID);
const MAIN_WALLET_MNEMONIC = (process.env.MAIN_WALLET_MNEMONIC || '').split(' ');
const states = new Map();
const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY });

function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function getWallet(userId) {
  try {
    const { data, error } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { console.error('DB Error:', e.message); return null; }
}

async function updateWallet(userId, patch) {
  try { await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId)); } catch (e) {}
}

async function checkTonDeposits() {
  if (MAIN_WALLET_MNEMONIC.length < 24) return;
  try {
    const { publicKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey });
    const mainAddress = wallet.address.toString({ bounceable: false });
    const res = await axios.get(`https://toncenter.com/api/v2/getTransactions?address=${mainAddress}&limit=20&api_key=${process.env.TONCENTER_API_KEY}`);
    for (const tx of (res.data.result || [])) {
      if (tx.in_msg && tx.in_msg.source !== mainAddress && tx.in_msg.message) {
        const userId = Number(tx.in_msg.message);
        const amount = Number(tx.in_msg.value) / 1e9;
        const txHash = 'dep_' + tx.transaction_id.hash;
        if (userId && amount > 0) {
          const { data: existing } = await supabase.from('smaster_history').select('*').eq('type', txHash).limit(1);
          if (existing && existing.length > 0) continue;
          const w = await getWallet(userId);
          if (w) {
            await updateWallet(userId, { balance_ton: (Number(w.balance_ton) + amount).toFixed(8) });
            await supabase.from('smaster_history').insert({ user_id: userId, type: txHash, amount, currency: 'TON' });
            bot.sendMessage(userId, `✅ <b>Пополнение!</b>\nЗачислено: <code>${amount} TON</code>`, { parse_mode: 'HTML' }).catch(() => {});
          }
        }
      }
    }
  } catch (e) { console.error('Ошибка мониторинга:', e.message); }
}
setInterval(checkTonDeposits, 60000);

function getMainMenu(hasWallet) {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }],
        [{ text: '⬇️ Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '⬆️ Вывести', callback_data: 'menu_withdraw', style: 'danger' }],
        [{ text: '💱 Обмен', callback_data: 'menu_swap' }, { text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '📄 Счета', callback_data: 'menu_invoices' }],
        [{ text: '🎁 Рефералка', callback_data: 'menu_ref' }, { text: '⚙️ Настройки', callback_data: 'menu_settings' }],
        [{ text: '📱 Открыть приложение', web_app: { url: process.env.APP_URL } }]
      ]
    }
  };
}

bot.onText(/^\/start/, async (msg) => {
  try {
    let w = await getWallet(msg.from.id);
    if (!w) { await supabase.from('smaster_wallets').insert({ user_id: Number(msg.from.id), username: msg.from.username || null }); }
    await bot.sendMessage(msg.chat.id, '👋 Добро пожаловать в <b>SMaster</b>!', { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(msg.chat.id, '❌ Ошибка базы. Выполни SQL.'); }
});bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    let w = await getWallet(userId);
    if (data === 'back_to_menu') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Меню:', { ...getMainMenu(!!w) });
    }
    if (!w) return bot.sendMessage(chatId, 'Нажми /start');

    // --- СЧЕТА ---
    if (data === 'menu_invoices') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📄 <b>Счета</b>\nВыбери действие:', { reply_markup: { inline_keyboard: [
        [{ text: '➕ Создать счет', callback_data: 'inv_create', style: 'success' }],
        [{ text: '📄 Мои счета', callback_data: 'inv_my' }],
        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data === 'inv_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Выбери валюту счёта:', { reply_markup: { inline_keyboard: [
        [{ text: '💎 USDT', callback_data: 'inv_curr_USDT' }, { text: '🟡 XROCK', callback_data: 'inv_curr_XROCK' }, { text: '🔵 USDC', callback_data: 'inv_curr_USDC' }],
        [{ text: '⚪ GRAM', callback_data: 'inv_curr_GRAM' }, { text: '🔴 TRX', callback_data: 'inv_curr_TRX' }, { text: '⚫ SOL', callback_data: 'inv_curr_SOL' }],
        [{ text: '🟠 BTC', callback_data: 'inv_curr_BTC' }, { text: '🔷 ETH', callback_data: 'inv_curr_ETH' }, { text: '🟡 BNB', callback_data: 'inv_curr_BNB' }],
        [{ text: '⬅️ Назад', callback_data: 'menu_invoices' }]
      ]} });
    }
    if (data.startsWith('inv_curr_')) {
      const currency = data.split('_')[2];
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'inv_amount', currency, timestamp: Date.now() });
      return bot.sendMessage(chatId, `Выбери сумму счёта в ${currency}:`, { reply_markup: { inline_keyboard: [
        [{ text: '1', callback_data: 'inv_set_1' }, { text: '2', callback_data: 'inv_set_2' }],
        [{ text: '⬅️ Назад', callback_data: 'inv_create' }]
      ]} });
    }
    if (data.startsWith('inv_set_')) {
      const amount = Number(data.split('_')[2]);
      const state = states.get(userId);
      if (!state || state.type !== 'inv_amount') return;
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      
      const { data: inv, error } = await supabase.from('smaster_invoices').insert({ creator_id: Number(userId), amount, currency: state.currency }).select();
      if (error) throw new Error(error.message);
      states.delete(userId);
      
      const link = `https://t.me/${(await bot.getMe()).username}?start=invoice_${inv[0].id}`;
      return bot.sendMessage(chatId, `📄 <b>Счет на ${amount} ${state.currency} создан!</b>\n\nСсылка:\n<code>${link}</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }
    
    // МОИ СЧЕТА
    if (data === 'inv_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: invs } = await supabase.from('smaster_invoices').select('*').eq('creator_id', Number(userId)).order('created_at', { ascending: false }).limit(10);
      if (!invs || invs.length === 0) return bot.sendMessage(chatId, 'У тебя нет счетов.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_invoices' }]] } });
      
      let text = '📄 <b>Твои счета:</b>\n\n';
      for (const inv of invs) {
        const status = inv.status === 'paid' ? '✅ Оплачен' : '⏳ Ожидает';
        text += `ID: <code>${inv.id}</code> | ${inv.amount} ${inv.currency} | ${status}\n`;
      }
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_invoices' }]] }, parse_mode: 'HTML' });
    }

    // --- НАСТРОЙКИ ---
    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⚙️ <b>Настройки</b>', { reply_markup: { inline_keyboard: [
        [{ text: `Валюта: ${w.display_currency || 'USD'}`, callback_data: 'set_currency' }],
        [{ text: `Уведомления: ${w.notifications ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'set_notify' }],
        [{ text: `Язык: ${w.language === 'ru' ? 'RU' : 'EN'}`, callback_data: 'set_lang' }],
        [{ text: `Верификация (KYC)`, callback_data: 'set_kyc' }],
        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data === 'set_currency') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Выбери валюту отображения:', { reply_markup: { inline_keyboard: [
        [{ text: 'USD', callback_data: 'curr_USD' }, { text: 'RUB', callback_data: 'curr_RUB' }, { text: 'EUR', callback_data: 'curr_EUR' }],
        [{ text: 'UAH', callback_data: 'curr_UAH' }, { text: 'KZT', callback_data: 'curr_KZT' }],
        [{ text: '⬅️ Назад', callback_data: 'menu_settings' }]
      ]} });
    }
    if (data.startsWith('curr_')) {
      const cur = data.split('_')[1];
      await updateWallet(userId, { display_currency: cur });
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `✅ Валюта изменена на ${cur}`, { ...getMenuSettings(w), parse_mode: 'HTML' });
    }
    if (data === 'set_notify') {
      await updateWallet(userId, { notifications: !w.notifications });
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `✅ Уведомления: ${!w.notifications ? 'ВКЛ' : 'ВЫКЛ'}`, { ...getMenuSettings(w) });
    }
    if (data === 'set_lang') {
      await updateWallet(userId, { language: w.language === 'ru' ? 'en' : 'ru' });
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `✅ Язык изменен`, { ...getMenuSettings(w) });
    }
    if (data === 'set_kyc') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🛡 <b>Верификация (KYC)</b>\n\nДля прохождения отправь фото паспорта или селфи.', { reply_markup: { inline_keyboard: [[{ text: '📸 Отправить', callback_data: 'send_kyc' }], [{ text: '⬅️ Назад', callback_data: 'menu_settings' }]] } });
    }
    if (data === 'send_kyc') {
      await updateWallet(userId, { is_verified: true });
      await bot.answerCallbackQuery(query.id, { text: '✅ Верификация пройдена (тестовый режим)', show_alert: true });
      return;
    }

    // --- ОСТАЛЬНЫЕ КНОПКИ ---
    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton).toFixed(2)}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { publicKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
      const mainWallet = WalletContractV4.create({ publicKey, workchain: 0 });
      const addr = mainWallet.address.toString({ bounceable: false });
      return bot.sendMessage(chatId, `⬇️ <b>Пополнение</b>\nАдрес: <code>${addr}</code>\n\n⚠️ В комментарии укажи: <code>${userId}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'withdraw_addr', timestamp: Date.now() });
      return bot.sendMessage(chatId, '⬆️ Введи TON-адрес для вывода:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
    }
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🧾 <b>Чеки</b>', { reply_markup: { inline_keyboard: [[{ text: '🎁 Создать чек', callback_data: 'check_create' }], [{ text: '🎫 Активировать', callback_data: 'check_activate' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'check_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'check_amount', timestamp: Date.now() });
      return bot.sendMessage(chatId, 'Введи сумму USDT для чека:');
    }
    if (data === 'check_activate') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'check_activate_id', timestamp: Date.now() });
      return bot.sendMessage(chatId, 'Введи ID чека:');
    }
    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const link = `https://t.me/${(await bot.getMe()).username}?start=ref_${userId}`;
      return bot.sendMessage(chatId, `🎁 Твоя ссылка:\n<code>${link}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

  } catch (e) { console.error(e); bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
});

// ВВОД ТЕКСТА
bot.on('message', async (msg) => {
  const userId = String(msg.from.id);
  const state = states.get(userId);
  if (!state || !msg.text) return;

  try {
    if (state.type === 'inv_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи корректное число.');
      const { data, error } = await supabase.from('smaster_invoices').insert({ creator_id: Number(userId), amount, currency: state.currency }).select();
      if (error) throw new Error('Ошибка БД.');
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=invoice_${data[0].id}`;
      return bot.sendMessage(msg.chat.id, `📄 Счет на ${amount} ${state.currency} создан!\n\n<code>${link}</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }
    if (state.type === 'check_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи число.');
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало USDT.'); }
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
      const { data, error } = await supabase.from('smaster_checks').insert({ creator_id: Number(userId), amount }).select();
      if (error) throw new Error('Ошибка БД.');
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=check_${data[0].id}`;
      return bot.sendPhoto(msg.chat.id, `https://placehold.co/600x400/0f0715/ff007f/png?text=SMaster+Check%0A%0A${amount}+USDT`, { caption: `🎁 Чек на ${amount} USDT!\n\n<code>${link}</code>`, parse_mode: 'HTML' });
    }
    if (state.type === 'withdraw_addr') {
      states.set(userId, { ...state, type: 'withdraw_amount', address: msg.text.trim() });
      return bot.sendMessage(msg.chat.id, 'Введи сумму TON:');
    }
    if (state.type === 'withdraw_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (isNaN(amount) || amount <= 0 || Number(w.balance_ton) < amount) return bot.sendMessage(msg.chat.id, '❌ Ошибка в сумме.');
      const { publicKey, secretKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
      const wallet = WalletContractV4.create({ publicKey, workchain: 0 });
      const contract = tonClient.open(wallet);
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({ seqno, secretKey, messages: [internal({ to: state.address, value: toNano(amount.toString()), body: 'SMaster' })] });
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - amount).toFixed(8) });
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, `✅ Выведено ${amount} TON!`, { ...getMainMenu(true) });
    }
  } catch (e) { console.error(e); states.delete(userId); bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`); }
});

// СЕРВЕР И MINI APP
const app = express();
app.use(helmet());
app.use(express.json());

app.get('/api/user/:id', async (req, res) => {
  const w = await getWallet(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ balance_usdt: w.balance_usdt, balance_ton: w.balance_ton });
});

app.get('/app', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://telegram.org/js/telegram-web-app.js"></script><style>body { background: #0f0715; color: white; font-family: sans-serif; padding: 20px; } .card { background: #1c102b; padding: 20px; border-radius: 20px; border: 1px solid #ff007f; margin-bottom: 15px; } h1 { color: #ff007f; }</style></head><body><h1>SMaster</h1><div class="card"><div>Баланс USDT</div><div style="font-size:30px;color:#00ff88;" id="usdt">0.00</div></div><div class="card"><div>Баланс TON</div><div style="font-size:30px;color:#0098ea;" id="ton">0.00</div></div><script>const tg = window.Telegram.WebApp; tg.expand(); fetch('/api/user/' + tg.initDataUnsafe.user.id).then(r => r.json()).then(data => { document.getElementById('usdt').innerText = data.balance_usdt || 0; document.getElementById('ton').innerText = data.balance_ton || 0; });</script></body></html>`);
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 SMaster Server ready'));
