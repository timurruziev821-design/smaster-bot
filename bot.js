const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { WalletContractV4, internal, toNano, TonClient } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const axios = require('axios');
const helmet = require('helmet');
const crypto = require('crypto');

process.on('uncaughtException', (err) => console.error('КРИТ. ОШИБКА:', err.message));
process.on('unhandledRejection', (err) => console.error('ОШИБКА ПРОМИСА:', err.message));

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = String(process.env.ADMIN_ID);
const MAIN_WALLET_MNEMONIC = (process.env.MAIN_WALLET_MNEMONIC || '').split(' ');
const states = new Map();
const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY });

// ФУНКЦИЯ СБРОСА ЗАВИСШИХ СОСТОЯНИЙ (Анти-флуд)
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of states.entries()) {
    if (now - state.timestamp > 600000) { // 10 минут
      states.delete(userId);
      bot.sendMessage(userId, '⏳ Время ожидания истекло. Действие отменено. Нажми /start').catch(() => {});
    }
  }
}, 60000);

function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function getWallet(userId) {
  const { data, error } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
  if (error) throw new Error('Ошибка базы данных (getWallet)');
  return data && data.length > 0 ? data[0] : null;
}

async function updateWallet(userId, patch) {
  const { error } = await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId));
  if (error) throw new Error('Ошибка обновления баланса');
}

async function logHistory(userId, type, amount, currency) {
  await supabase.from('smaster_history').insert({ user_id: Number(userId), type, amount, currency });
}

// МОНИТОРИНГ ВХОДЯЩИХ ТРАНЗАКЦИЙ
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
            await logHistory(userId, txHash, amount, 'TON');
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
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }, { text: '👤 Профиль', callback_data: 'menu_profile' }],
        [{ text: '⬇️ Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '⬆️ Вывести', callback_data: 'menu_withdraw', style: 'danger' }],
        [{ text: '💱 Обмен', callback_data: 'menu_swap' }, { text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '📄 Счета', callback_data: 'menu_invoices' }],
        [{ text: '🎁 Рефералка', callback_data: 'menu_ref' }, { text: '⚙️ Настройки', callback_data: 'menu_settings' }],
        [{ text: '📱 Mini App', web_app: { url: process.env.APP_URL } }]
      ]
    }
  };
}bot.onText(/^\/start/, async (msg) => {
  try {
    let w = await getWallet(msg.from.id);
    if (!w) {
      await supabase.from('smaster_wallets').insert({ user_id: Number(msg.from.id), username: msg.from.username || null });
    }
    await bot.sendMessage(msg.chat.id, '👋 Добро пожаловать в <b>SMaster</b>!', { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { bot.sendMessage(msg.chat.id, '❌ Ошибка базы данных. Проверьте SQL.'); }
});

bot.onText(/^\/admin/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  await bot.sendMessage(msg.chat.id, '👑 <b>Админ-панель</b>', {
    reply_markup: { inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '💰 Выдать баланс', callback_data: 'adm_give' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '🎁 Промокод', callback_data: 'adm_promo' }]
    ]}, parse_mode: 'HTML'
  });
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    let w = await getWallet(userId);
    
    if (data === 'back_to_menu') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Главное меню:', { ...getMainMenu(!!w) });
    }
    if (!w) return bot.sendMessage(chatId, 'Нажми /start');

    // --- СЧЕТА ---
    if (data === 'menu_invoices') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📄 <b>Счета</b>\n\nСоздай одноразовый счет для приема оплаты.', { reply_markup: { inline_keyboard: [[{ text: '➕ Создать счет', callback_data: 'inv_create' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'inv_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'inv_amount', timestamp: Date.now() });
      return bot.sendMessage(chatId, 'Введи сумму в USDT (например: 10):');
    }

    // --- ЧЕКИ ---
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🧾 <b>Чеки</b>\n\nСоздай чек, чтобы отправить криптовалюту другу.', { reply_markup: { inline_keyboard: [[{ text: '🎁 Создать чек', callback_data: 'check_create' }], [{ text: '🎫 Активировать', callback_data: 'check_activate' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'check_create') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_amount', timestamp: Date.now() }); return bot.sendMessage(chatId, 'Введи сумму USDT для чека:'); }
    if (data === 'check_activate') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_activate_id', timestamp: Date.now() }); return bot.sendMessage(chatId, 'Введи ID чека:'); }

    // --- ОСТАЛЬНОЕ ---
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
    if (data === 'menu_p2p') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🎲 <b>P2P Маркет</b>', { reply_markup: { inline_keyboard: [[{ text: '🛒 Купить USDT', callback_data: 'p2p_buy' }], [{ text: '➕ Продать', callback_data: 'p2p_create' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const link = `https://t.me/${(await bot.getMe()).username}?start=ref_${userId}`;
      return bot.sendMessage(chatId, `🎁 Твоя ссылка:\n<code>${link}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⚙️ <b>Настройки</b>', { reply_markup: { inline_keyboard: [[{ text: 'История', callback_data: 'set_history' }, { text: 'Поддержка', callback_data: 'set_support' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    
    // АДМИНКА
    if (data === 'adm_give') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_give_input', timestamp: Date.now() });
      return bot.sendMessage(chatId, '💰 Введи ID и сумму (например: <code>8447147405 10</code>):', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_broadcast') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_broadcast_input', timestamp: Date.now() });
      return bot.sendMessage(chatId, '📢 Введи текст для рассылки:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

  } catch (e) { console.error(e); bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
});bot.on('message', async (msg) => {
  const userId = String(msg.from.id);
  const state = states.get(userId);
  if (!state) return;

  // Защита от стикеров, фото и нецифрового текста
  if (!msg.text) return bot.sendMessage(msg.chat.id, '❌ Пожалуйста, отправь текстовое сообщение (число).');

  try {
    // СЧЕТА
    if (state.type === 'inv_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи корректное число больше 0.');
      
      const { data, error } = await supabase.from('smaster_invoices').insert({ creator_id: Number(userId), amount }).select();
      if (error) throw new Error('Ошибка БД при создании счета. Проверь SQL.');
      
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=invoice_${data[0].id}`;
      return bot.sendMessage(msg.chat.id, `📄 <b>Счет на ${amount} USDT создан!</b>\n\nСсылка:\n<code>${link}</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    // ЧЕКИ
    if (state.type === 'check_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи корректное число.');
      
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Недостаточно USDT.', { ...getMainMenu(true) }); }
      
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
      const { data, error } = await supabase.from('smaster_checks').insert({ creator_id: Number(userId), amount }).select();
      if (error) throw new Error('Ошибка БД при создании чека. Проверь SQL.');
      
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=check_${data[0].id}`;
      const imageUrl = `https://placehold.co/600x400/0f0715/ff007f/png?text=SMaster+Check%0A%0A${amount}+USDT`;
      return bot.sendPhoto(msg.chat.id, imageUrl, { caption: `🎁 <b>Чек на ${amount} USDT!</b>\n\nСсылка:\n<code>${link}</code>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${link}` }]] } });
    }

    // ВЫВОД TON
    if (state.type === 'withdraw_addr') {
      states.set(userId, { ...state, type: 'withdraw_amount', address: msg.text.trim() });
      return bot.sendMessage(msg.chat.id, 'Введи сумму TON для вывода:');
    }
    if (state.type === 'withdraw_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи число.');
      
      const w = await getWallet(userId);
      if (Number(w.balance_ton) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало TON.'); }

      await bot.sendMessage(msg.chat.id, '⏳ Отправляю транзакцию в сеть TON...');
      const { publicKey, secretKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
      const wallet = WalletContractV4.create({ publicKey, workchain: 0 });
      const contract = tonClient.open(wallet);
      const seqno = await contract.getSeqno();
      
      await contract.sendTransfer({ seqno, secretKey, messages: [internal({ to: state.address, value: toNano(amount.toString()), body: 'SMaster Withdraw' })] });
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - amount).toFixed(8) });
      await logHistory(userId, 'withdrawal', amount, 'TON');
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, `✅ <b>Выведено ${amount} TON!</b>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    // АДМИН: ВЫДАТЬ БАЛАНС
    if (state.type === 'adm_give_input') {
      states.delete(userId);
      const [targetId, amountStr] = msg.text.split(' ');
      const amount = Number(amountStr);
      if (!targetId || isNaN(amount)) return bot.sendMessage(msg.chat.id, '❌ Ошибка формата. Пиши: ID СУММА');
      const targetW = await getWallet(targetId);
      if (!targetW) return bot.sendMessage(msg.chat.id, '❌ Юзер не найден.');
      await updateWallet(targetId, { balance_usdt: (Number(targetW.balance_usdt) + amount).toFixed(8) });
      return bot.sendMessage(msg.chat.id, `✅ Выдано ${amount} USDT юзеру ${targetId}.`, { ...getMainMenu(true) });
    }

    // АДМИН: РАССЫЛКА
    if (state.type === 'adm_broadcast_input') {
      states.delete(userId);
      const { data: users } = await supabase.from('smaster_wallets').select('user_id');
      let success = 0;
      await bot.sendMessage(msg.chat.id, '⏳ Рассылка начата...');
      for (const u of users) { try { await bot.sendMessage(u.user_id, msg.text, { parse_mode: 'HTML' }); success++; await new Promise(r => setTimeout(r, 50)); } catch (e) {} }
      return bot.sendMessage(msg.chat.id, `✅ Дошло до ${success} юзеров.`, { ...getMainMenu(true) });
    }

  } catch (e) { 
    console.error(e); 
    states.delete(userId);
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`, { ...getMainMenu(true) }); 
  }
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
