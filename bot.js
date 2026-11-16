const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const { WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const crypto = require('crypto');
const helmet = require('helmet');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = String(process.env.ADMIN_ID);
const MASTER_SEED = process.env.MASTER_SEED;
const states = new Map();

function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function getWallet(userId) {
  try {
    const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { return null; }
}

async function updateWallet(userId, patch) {
  try { await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId)); } catch (e) {}
}

async function logHistory(userId, type, amount, currency) {
  try { await supabase.from('smaster_history').insert({ user_id: Number(userId), type, amount, currency }); } catch (e) {}
}

async function createWallet(user) {
  try {
    const mnemonic = ethers.Mnemonic.fromPhrase(MASTER_SEED);
    const ethWallet = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${user.id % 100000}`);
    const tonMnemonic = MASTER_SEED.split(' ');
    const tonKey = await mnemonicToPrivateKey(tonMnemonic);
    const userSeed = tonKey.secretKey.toString('hex') + String(user.id);
    const userHash = crypto.createHash('sha256').update(userSeed).digest();
    const tonWallet = WalletContractV4.create({ publicKey: userHash.subarray(0, 32), workchain: 0 });
    
    const { data, error } = await supabase.from('smaster_wallets').insert({
      user_id: Number(user.id),
      username: user.username ? escapeHtml(user.username) : null,
      ton_deposit_address: tonWallet.address.toString({ bounceable: false }),
      eth_deposit_address: ethWallet.address
    }).select();
    if (error) throw error;
    return { data: data[0] };
  } catch (e) { return { error: e.message }; }
}

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
        [{ text: '🚀 Mini App', web_app: { url: process.env.APP_URL }, style: 'primary' }]
      ]
    }
  };
}bot.onText(/^\/start/, async (msg) => {
  const w = await getWallet(msg.from.id);
  await bot.sendMessage(msg.chat.id, w ? 'Добро пожаловать в SMaster!' : 'Создай кошелек кнопкой ниже:', { ...getMainMenu(!!w) });
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {}); // МГНОВЕННЫЙ ОТВЕТ

  try {
    let w = await getWallet(userId);

    if (data === 'create_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const res = await createWallet(query.from);
      if (res.error) return bot.sendMessage(chatId, `❌ Ошибка: ${res.error}`);
      return bot.sendMessage(chatId, '✅ Кошелек создан!', { ...getMainMenu(true) });
    }
    if (!w) return bot.sendMessage(chatId, 'Нажми /start');

    if (data === 'back_to_menu') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Меню:', { ...getMainMenu(true) });
    }

    // --- БАЛАНС ---
    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton).toFixed(2)}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    // --- ПОПОЛНЕНИЕ ---
    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⬇️ Выбери валюту:', { reply_markup: { inline_keyboard: [[{ text: '💎 TON', callback_data: 'dep_ton' }, { text: '💵 USDT', callback_data: 'dep_eth' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
    }
    if (data === 'dep_ton') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); return bot.sendMessage(chatId, `💎 <b>TON Адрес:</b>\n<code>${w.ton_deposit_address}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }
    if (data === 'dep_eth') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); return bot.sendMessage(chatId, `💵 <b>ETH Адрес:</b>\n<code>${w.eth_deposit_address}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }

    // --- ВЫВОД ---
    if (data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'withdraw_addr' });
      return bot.sendMessage(chatId, '⬆️ Введи TON-адрес для вывода:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
    }

    // --- ОБМЕН ---
    if (data === 'menu_swap') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '💱 <b>Обмен</b>\nКурс: 1 USDT = 5.5 TON', { reply_markup: { inline_keyboard: [[{ text: 'USDT ➡️ TON', callback_data: 'swap_usdt_ton' }], [{ text: 'TON ➡️ USDT', callback_data: 'swap_ton_usdt' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'swap_usdt_ton' || data === 'swap_ton_usdt') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'swap_amount', from: data === 'swap_usdt_ton' ? 'USDT' : 'TON' });
      return bot.sendMessage(chatId, `Введи сумму в ${data === 'swap_usdt_ton' ? 'USDT' : 'TON'}:`);
    }

    // --- ЧЕКИ ---
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🧾 <b>Чеки</b>', { reply_markup: { inline_keyboard: [[{ text: '🎁 Создать чек', callback_data: 'check_create' }], [{ text: '🎫 Активировать', callback_data: 'check_activate' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'check_create') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_amount' }); return bot.sendMessage(chatId, 'Введи сумму USDT для чека:'); }
    if (data === 'check_activate') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); states.set(userId, { type: 'check_activate_id' }); return bot.sendMessage(chatId, 'Введи ID чека:'); }

    // --- СЧЕТА ---
    if (data === 'menu_invoices') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📄 <b>Счета</b>\nВыбери тип:', { reply_markup: { inline_keyboard: [[{ text: 'Одноразовый', callback_data: 'inv_single' }, { text: 'Мульти-счёт', callback_data: 'inv_multi' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'inv_single' || data === 'inv_multi') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'inv_amount', inv_type: data === 'inv_single' ? 'single' : 'multi' });
      return bot.sendMessage(chatId, `Введи сумму для ${data === 'inv_single' ? 'одноразового' : 'мульти'}-счёта:`);
    }

    // --- P2P ---
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

    // --- НАСТРОЙКИ И РЕФЕРАЛКА ---
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

  } catch (e) { console.error(e); }
});bot.on('message', async (msg) => {
  const userId = String(msg.from.id);
  const state = states.get(userId);
  if (!state) return;

  try {
    if (state.type === 'withdraw_addr') {
      states.set(userId, { ...state, type: 'withdraw_amount', address: msg.text.trim() });
      return bot.sendMessage(msg.chat.id, 'Введи сумму TON:');
    }
    if (state.type === 'withdraw_amount') {
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, `✅ Заявка на вывод создана!`, { ...getMainMenu(true) });
    }

    if (state.type === 'swap_amount') {
      states.delete(userId);
      const amount = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (state.from === 'USDT') {
        if (Number(w.balance_usdt) < amount) return bot.sendMessage(msg.chat.id, '❌ Мало USDT.');
        await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8), balance_ton: (Number(w.balance_ton) + amount * 5.5).toFixed(8) });
      } else {
        if (Number(w.balance_ton) < amount) return bot.sendMessage(msg.chat.id, '❌ Мало TON.');
        await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - amount).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount / 5.5).toFixed(8) });
      }
      return bot.sendMessage(msg.chat.id, `✅ Обмен успешен!`, { ...getMainMenu(true) });
    }

    if (state.type === 'check_amount') {
      const amount = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало средств.'); }
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

    if (state.type === 'p2p_amount') {
      states.set(userId, { ...state, type: 'p2p_currency', amount: Number(msg.text.replace(',', '.')) });
      return bot.sendMessage(msg.chat.id, 'Валюта: TON или RUB');
    }
    if (state.type === 'p2p_currency') {
      states.set(userId, { ...state, type: 'p2p_price', currency: msg.text.toUpperCase() });
      return bot.sendMessage(msg.chat.id, `Цена за 1 USDT?`);
    }
    if (state.type === 'p2p_price') {
      const price = Number(msg.text.replace(',', '.'));
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < state.amount) { states.delete(userId); return bot.sendMessage(msg.chat.id, '❌ Мало USDT.'); }
      await supabase.from('smaster_p2p_ads').insert({ seller_id: Number(userId), seller_username: msg.from.username || null, amount: state.amount, price, currency: state.currency });
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, `✅ Объявление создано!`, { ...getMainMenu(true) });
    }
  } catch (e) { console.error(e); }
});

// --- СЕРВЕР И MINI APP ---
const app = express();
app.use(helmet());
app.use(express.json());

app.get('/api/user/:id', async (req, res) => {
  const w = await getWallet(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ balance_usdt: w.balance_usdt, balance_ton: w.balance_ton, ton_address: w.ton_deposit_address, eth_address: w.eth_deposit_address });
});

app.get('/app', (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://telegram.org/js/telegram-web-app.js"></script><title>SMaster</title><style>
    :root { --bg-dark: #0f0715; --bg-card: #1c102b; --accent-pink: #ff007f; --text-main: #ffffff; --text-muted: #9e8bb5; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; user-select: none; }
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
    .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(28, 16, 43, 0.95); display: flex; justify-content: space-around; padding: 16px 0; border-top: 1px solid rgba(255,0,127,0.1); backdrop-filter: blur(10px); }
    .nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
    .nav-item.active { color: var(--accent-pink); }
    </style></head><body>
    <div class="header"><div class="logo">SMaster</div><div class="avatar" id="user-avatar">S</div></div>
    <div class="balance-card"><div class="balance-title">Общий баланс</div><div class="balance-amount"><span id="total-balance">0.00</span> <span style="font-size:24px;color:white;">USDT</span></div></div>
    <div class="grid"><div class="btn" onclick="alert('В боте')"><div class="icon">💳</div><div class="label">Пополнить</div></div><div class="btn" onclick="alert('В боте')"><div class="icon">🎲</div><div class="label">P2P</div></div><div class="btn" onclick="alert('В боте')"><div class="icon">🧾</div><div class="label">Чеки</div></div><div class="btn" onclick="alert('В боте')"><div class="icon">📤</div><div class="label">Вывести</div></div></div>
    <div class="section-title">Активы</div><div class="coin-list"><div class="coin-item"><div class="coin-info"><div class="coin-icon" style="background:#26a17b;">💵</div><div><div class="coin-name">Tether</div><div style="font-size:12px;color:#888;">USDT</div></div></div><div class="coin-amount" id="coin-usdt">0.00</div></div><div class="coin-item"><div class="coin-info"><div class="coin-icon" style="background:#0098ea;">💎</div><div><div class="coin-name">Toncoin</div><div style="font-size:12px;color:#888;">TON</div></div></div><div class="coin-amount" id="coin-ton">0.00</div></div></div>
    <div class="bottom-nav"><div class="nav-item active"><div class="nav-icon">🏠</div>Главная</div><div class="nav-item"><div class="nav-icon">🎲</div>P2P</div><div class="nav-item"><div class="nav-icon">💳</div>Пополнить</div></div>
    <script>const tg = window.Telegram.WebApp; tg.expand(); tg.setHeaderColor('#0f0715'); if (tg.initDataUnsafe && tg.initDataUnsafe.user) document.getElementById('user-avatar').innerText = tg.initDataUnsafe.user.first_name.charAt(0); async function loadData() { try { const userId = tg.initDataUnsafe?.user?.id; if (!userId) return; const res = await fetch('/api/user/' + userId); const data = await res.json(); if (data) { document.getElementById('total-balance').innerText = Number(data.balance_usdt || 0).toFixed(2); document.getElementById('coin-usdt').innerText = Number(data.balance_usdt || 0).toFixed(2); document.getElementById('coin-ton').innerText = Number(data.balance_ton || 0).toFixed(2); } } catch (e) { console.error(e); } } loadData();</script></body></html>
  `);
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 SMaster Server ready'));
