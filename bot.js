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

// Инициализация клиента TON
const tonClient = new TonClient({ 
  endpoint: 'https://toncenter.com/api/v2/jsonRPC', 
  apiKey: process.env.TONCENTER_API_KEY 
});

function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function getWallet(userId) {
  try {
    const { data, error } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { console.error('Ошибка БД:', e.message); return null; }
}

async function updateWallet(userId, patch) {
  try { await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId)); } catch (e) {}
}

async function logHistory(userId, type, amount, currency) {
  try { await supabase.from('smaster_history').insert({ user_id: Number(userId), type, amount, currency }); } catch (e) {}
}

// МОНИТОРИНГ ВХОДЯЩИХ ТРАНЗАКЦИЙ TON
async function checkTonDeposits() {
  if (MAIN_WALLET_MNEMONIC.length < 24) return;
  try {
    const { publicKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey });
    const mainAddress = wallet.address.toString({ bounceable: false });
    
    const res = await axios.get(`https://toncenter.com/api/v2/getTransactions?address=${mainAddress}&limit=20&api_key=${process.env.TONCENTER_API_KEY}`);
    const txs = res.data.result || [];

    for (const tx of txs) {
      if (tx.in_msg && tx.in_msg.source !== mainAddress && tx.in_msg.message) {
        const userId = Number(tx.in_msg.message);
        const amount = Number(tx.in_msg.value) / 1e9;
        
        if (userId && amount > 0) {
          const { data: existing } = await supabase.from('smaster_history').select('*').eq('type', 'dep_' + tx.transaction_id.hash).limit(1);
          if (existing && existing.length > 0) continue;

          const w = await getWallet(userId);
          if (w) {
            await updateWallet(userId, { balance_ton: (Number(w.balance_ton) + amount).toFixed(8) });
            await logHistory(userId, 'dep_' + tx.transaction_id.hash, amount, 'TON');
            bot.sendMessage(userId, `✅ <b>Пополнение!</b>\n\nЗачислено: <code>${amount} TON</code>`, { parse_mode: 'HTML' }).catch(() => {});
            console.log(`[БЛОКЧЕЙН] Зачислено ${amount} TON юзеру ${userId}`);
          }
        }
      }
    }
  } catch (e) { console.error('Ошибка мониторинга TON:', e.message); }
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
}bot.onText(/^\/start/, async (msg) => {
  try {
    let w = await getWallet(msg.from.id);
    if (!w) {
      await supabase.from('smaster_wallets').insert({ user_id: Number(msg.from.id), username: msg.from.username || null });
    }
    await bot.sendMessage(msg.chat.id, '👋 Добро пожаловать в <b>SMaster</b>!', { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { console.error(e); }
});

bot.onText(/^\/admin/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  await bot.sendMessage(msg.chat.id, '👑 <b>Админ-панель</b>', {
    reply_markup: { inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '💰 Выдать баланс', callback_data: 'adm_give' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '🎁 Создать промокод', callback_data: 'adm_promo' }]
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
      return bot.sendMessage(chatId, 'Меню:', { ...getMainMenu(!!w) });
    }
    if (!w) return bot.sendMessage(chatId, '❌ Нажми /start');

    // БАЛАНС
    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton).toFixed(2)}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    // ПОПОЛНЕНИЕ
    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { publicKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
      const mainWallet = WalletContractV4.create({ publicKey, workchain: 0 });
      const addr = mainWallet.address.toString({ bounceable: false });
      const text = `⬇️ <b>Пополнение TON</b>\n\nАдрес:\n<code>${addr}</code>\n\n⚠️ <b>ВАЖНО:</b> В комментарии к переводу укажи свой ID: <code>${userId}</code>\nБез комментария деньги не зачислятся!`;
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    // ВЫВОД
    if (data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'withdraw_addr' });
      return bot.sendMessage(chatId, '⬆️ Введи адрес TON-кошелька для вывода:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
    }

    // ЧЕКИ
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🧾 <b>Чеки</b>', { reply_markup: { inline_keyboard: [[{ text: '🎁 Создать чек', callback_data: 'check_create' }], [{ text: '🎫 Активировать', callback_data: 'check_activate' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'check_create') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_amount' }); return bot.sendMessage(chatId, 'Введи сумму USDT для чека:'); }
    if (data === 'check_activate') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_activate_id' }); return bot.sendMessage(chatId, 'Введи ID чека:'); }

    // СЧЕТА
    if (data === 'menu_invoices') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📄 <b>Счета</b>\nВыбери тип:', { reply_markup: { inline_keyboard: [[{ text: 'Одноразовый', callback_data: 'inv_single' }, { text: 'Мульти-счёт', callback_data: 'inv_multi' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'inv_single' || data === 'inv_multi') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'inv_amount', inv_type: data === 'inv_single' ? 'single' : 'multi' });
      return bot.sendMessage(chatId, `Введи сумму для счёта:`);
    }

    // P2P
    if (data === 'menu_p2p') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🎲 <b>P2P Маркет</b>', { reply_markup: { inline_keyboard: [[{ text: '🛒 Купить USDT', callback_data: 'p2p_buy' }], [{ text: '➕ Продать USDT', callback_data: 'p2p_create' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'p2p_create') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'p2p_amount' }); return bot.sendMessage(chatId, 'Сколько USDT продаешь?'); }
    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', userId).limit(10);
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 Нет объявлений.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_p2p' }]] } });
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      return bot.sendMessage(chatId, '🛒 Выбери:', { reply_markup: { inline_keyboard: buttons } });
    }
    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      const total = Number(ad.amount) * Number(ad.price);
      return bot.sendMessage(chatId, `📢 <b>Объявление #${ad.id}</b>\n\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}\nИтого: ${total}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Купить', callback_data: `p2p_buy_${ad.id}`, style: 'success' }], [{ text: '⬅️ Назад', callback_data: 'p2p_buy' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      const seller = await getWallet(ad.seller_id);
      const amount = Number(ad.amount);
      const total = amount * Number(ad.price);
      if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, '❌ Мало TON.');
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: userId }).eq('id', ad.id);
      return bot.sendMessage(chatId, `✅ Сделка завершена! +${amount} USDT`, { ...getMainMenu(true) });
    }

    // РЕФЕРАЛКА И НАСТРОЙКИ
    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const link = `https://t.me/${(await bot.getMe()).username}?start=ref_${userId}`;
      return bot.sendMessage(chatId, `🎁 Твоя ссылка:\n<code>${link}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⚙️ <b>Настройки</b>', { reply_markup: { inline_keyboard: [[{ text: 'История', callback_data: 'set_history' }, { text: 'Поддержка', callback_data: 'set_support' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'set_history') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: hist } = await supabase.from('smaster_history').select('*').eq('user_id', Number(userId)).order('created_at', { ascending: false }).limit(5);
      let text = '📜 <b>История:</b>\n\n';
      if (!hist || hist.length === 0) text += 'Пусто.';
      else for (const h of hist) text += `• ${h.type}: ${h.amount} ${h.currency}\n`;
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'set_support') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🚨 Поддержка: @TonRocketSupportBot', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_settings' }]] } });
    }

    // АДМИНКА
    if (data === 'adm_stats') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { count } = await supabase.from('smaster_wallets').select('*', { count: 'exact', head: true });
      return bot.sendMessage(chatId, `📊 Всего юзеров: <b>${count || 0}</b>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_give') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_give_input' });
      return bot.sendMessage(chatId, '💰 Введи ID юзера и сумму (например: <code>8447147405 10</code>):', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_broadcast') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_broadcast_input' });
      return bot.sendMessage(chatId, '📢 Введи текст для рассылки:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_promo') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_promo_input' });
      return bot.sendMessage(chatId, '🎁 Введи код и сумму (например: <code>SMASTER 5</code>):', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

  } catch (e) { console.error(e); bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
});bot.on('message', async (msg) => {
  const userId = String(msg.from.id);
  const state = states.get(userId);
  if (!state) return;

  try {
    // ВЫВОД TON
    if (state.type === 'withdraw_addr') {
      states.set(userId, { ...state, type: 'withdraw_amount', address: msg.text.trim() });
      return bot.sendMessage(msg.chat.id, 'Введи сумму TON для вывода:');
    }
    if (state.type === 'withdraw_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (!amount || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи число.');
      if (Number(w.balance_ton) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало TON.'); }

      await bot.sendMessage(msg.chat.id, '⏳ Отправляю транзакцию в сеть TON...');
      try {
        const { publicKey, secretKey } = await mnemonicToWalletKey(MAIN_WALLET_MNEMONIC);
        const wallet = WalletContractV4.create({ publicKey, workchain: 0 });
        const contract = tonClient.open(wallet);
        const seqno = await contract.getSeqno();
        
        await contract.sendTransfer({
          seqno,
          secretKey,
          messages: [internal({ to: state.address, value: toNano(amount.toString()), body: 'SMaster Withdrawal' })]
        });

        await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - amount).toFixed(8) });
        await logHistory(userId, 'withdrawal', amount, 'TON');
        states.delete(userId);
        return bot.sendMessage(msg.chat.id, `✅ <b>Выведено ${amount} TON!</b>\nТранзакция в сети.`, { ...getMainMenu(true), parse_mode: 'HTML' });
      } catch (e) { states.delete(userId); return bot.sendMessage(msg.chat.id, `❌ Ошибка сети: ${e.message}`); }
    }

    // ЧЕКИ И СЧЕТА
    if (state.type === 'check_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало USDT.'); }
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
      const { data } = await supabase.from('smaster_checks').insert({ creator_id: Number(userId), amount, limit_activations: 1 }).select();
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=check_${data[0].id}`;
      const imageUrl = `https://placehold.co/600x400/0f0715/ff007f/png?text=SMaster+Check%0A%0A${amount}+USDT`;
      return bot.sendPhoto(msg.chat.id, imageUrl, { caption: `🎁 <b>Чек на ${amount} USDT!</b>\n\nСсылка:\n<code>${link}</code>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${link}` }]] } });
    }
    if (state.type === 'check_activate_id') {
      states.delete(userId);
      const checkId = msg.text.trim().split('_').pop();
      const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(checkId)).limit(1);
      const check = arr && arr.length > 0 ? arr[0] : null;
      if (!check || check.status !== 'active') return bot.sendMessage(msg.chat.id, '❌ Чек не найден.');
      await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: Number(userId) }).eq('id', check.id);
      const w = await getWallet(userId);
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + Number(check.amount)).toFixed(8) });
      return bot.sendMessage(msg.chat.id, `🎉 Чек активирован! +${check.amount} USDT`, { ...getMainMenu(true) });
    }
    if (state.type === 'inv_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      const { data } = await supabase.from('smaster_invoices').insert({ creator_id: Number(userId), amount, type: state.inv_type }).select();
      states.delete(userId);
      const link = `https://t.me/${(await bot.getMe()).username}?start=invoice_${data[0].id}`;
      return bot.sendMessage(msg.chat.id, `📄 Счет создан!\nСсылка:\n<code>${link}</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    // АДМИН ВВОД
    if (state.type === 'adm_give_input') {
      states.delete(userId);
      const [targetId, amountStr] = msg.text.split(' ');
      const amount = Number(amountStr);
      const targetW = await getWallet(targetId);
      if (!targetW || !amount) return bot.sendMessage(msg.chat.id, '❌ Ошибка данных.');
      await updateWallet(targetId, { balance_usdt: (Number(targetW.balance_usdt) + amount).toFixed(8) });
      return bot.sendMessage(msg.chat.id, `✅ Выдано ${amount} USDT юзеру ${targetId}.`, { ...getMainMenu(true) });
    }
    if (state.type === 'adm_broadcast_input') {
      states.delete(userId);
      const { data: users } = await supabase.from('smaster_wallets').select('user_id');
      let success = 0;
      for (const u of users) { try { await bot.sendMessage(u.user_id, msg.text, { parse_mode: 'HTML' }); success++; await new Promise(r => setTimeout(r, 50)); } catch (e) {} }
      return bot.sendMessage(msg.chat.id, `✅ Дошло: ${success}`, { ...getMainMenu(true) });
    }
    if (state.type === 'adm_promo_input') {
      states.delete(userId);
      const [code, amountStr] = msg.text.split(' ');
      const amount = Number(amountStr);
      if (!code || !amount) return bot.sendMessage(msg.chat.id, '❌ Ошибка.');
      await supabase.from('smaster_promocodes').insert({ code: code.toUpperCase(), amount, uses_left: 10 });
      return bot.sendMessage(msg.chat.id, `✅ Промокод ${code} создан.`, { ...getMainMenu(true) });
    }

  } catch (e) { console.error(e); bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`); }
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
