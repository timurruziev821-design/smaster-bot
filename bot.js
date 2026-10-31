const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.SMASTER_BOT_TOKEN || process.env.BOT_TOKEN;
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ОШИБКА: Не заданы токены в Render!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TRANSFER_FEE = 0.1;

// ============ ПЕРЕВОДЫ ============
const i18n = {
  ru: {
    welcome: 'Привет, {name}! 👋\n\nДобро пожаловать в SMaster.\nВыбирай действие в меню 👇',
    btn_balance: '💰 Баланс', btn_deposit: '💳 Пополнить', btn_transfer: '📤 Перевести',
    btn_rocket: '🚀 Ракета', btn_p2p: '🔄 P2P Маркет', btn_ref: '🎁 Рефералка',
    btn_rates: '📈 Курсы', btn_create: '➕ Создать кошелек',
    balance_text: '💰 Твой баланс:\n\n• USDT: {usdt}\n• TON: {ton}',
    wallet_not_found: '❌ Кошелёк не найден. Нажми «➕ Создать кошелек».',
    wallet_exists: '✅ У тебя уже есть кошелёк!\n\n• USDT: {usdt}\n• TON: {ton}',
    wallet_created: '✅ Кошелёк успешно создан! Теперь тебе доступны все функции.',
    cancel: 'Отменено. Главное меню.',
    deposit_ask: '💳 Сколько USDT хочешь пополнить? Напиши число (или «отмена»).',
    transfer_ask_recipient: '📤 Кому перевести? Напиши ID или @username.\n\nКомиссия: 0.1 USDT (или «отмена»).',
    transfer_ask_amount: 'Кому: {to}\n\nСколько USDT? (Комиссия: 0.1)',
    transfer_success: '✅ Переведено: {amount} USDT\nКомиссия: 0.1 USDT\nКому: {to}',
    transfer_received: '💸 Тебе пришло {amount} USDT от {from}',
    low_balance: '❌ Недостаточно USDT на балансе!',
    p2p_menu: '🔄 P2P Маркет SMaster\n\nВыбирай:',
    p2p_buy: '🛒 Купить USDT', p2p_create: '➕ Выставить объявление', p2p_my: '📢 Мои объявления',
    need_wallet: '❌ Сначала создай кошелёк!'
  },
  en: {
    welcome: 'Hello, {name}! 👋\n\nWelcome to SMaster.\nChoose an action below 👇',
    btn_balance: '💰 Balance', btn_deposit: '💳 Deposit', btn_transfer: '📤 Transfer',
    btn_rocket: '🚀 Rocket', btn_p2p: '🔄 P2P Market', btn_ref: '🎁 Referral',
    btn_rates: '📈 Rates', btn_create: '➕ Create Wallet',
    balance_text: '💰 Your balance:\n\n• USDT: {usdt}\n• TON: {ton}',
    wallet_not_found: '❌ Wallet not found. Click "➕ Create Wallet".',
    wallet_exists: '✅ You already have a wallet!\n\n• USDT: {usdt}\n• TON: {ton}',
    wallet_created: '✅ Wallet created successfully! All features are now available.',
    cancel: 'Cancelled. Main menu.',
    deposit_ask: '💳 How much USDT to deposit? Type a number (or "cancel").',
    transfer_ask_recipient: '📤 Who to transfer to? Type ID or @username.\n\nFee: 0.1 USDT (or "cancel").',
    transfer_ask_amount: 'To: {to}\n\nHow much USDT? (Fee: 0.1)',
    transfer_success: '✅ Transferred: {amount} USDT\nFee: 0.1 USDT\nTo: {to}',
    transfer_received: '💸 You received {amount} USDT from {from}',
    low_balance: '❌ Insufficient USDT balance!',
    p2p_menu: '🔄 P2P Market SMaster\n\nChoose:',
    p2p_buy: '🛒 Buy USDT', p2p_create: '➕ Create Ad', p2p_my: '📢 My Ads',
    need_wallet: '❌ Create a wallet first!'
  }
};

// ============ ДИНАМИЧЕСКОЕ МЕНЮ ============
function getMainMenu(lang, hasWallet) {
  const t = i18n[lang] || i18n.ru;
  let keyboard = [];
  
  if (!hasWallet) {
    // Если кошелька нет, показываем ТОЛЬКО создание и курсы
    keyboard = [
      [{ text: t.btn_create }],
      [{ text: t.btn_rates }]
    ];
  } else {
    // Если есть — полное меню
    keyboard = [
      [{ text: t.btn_balance }, { text: t.btn_deposit }],
      [{ text: t.btn_transfer }, { text: t.btn_rocket }],
      [{ text: t.btn_p2p }, { text: t.btn_ref }],
      [{ text: t.btn_rates }]
    ];
  }
  return { reply_markup: { keyboard, resize_keyboard: true } };
}

// ============ БАЗА ============
async function getWallet(userId) {
  try {
    const { data, error } = await supabase.from('smaster_wallets').select('*').eq('user_id', String(userId)).limit(1);
    if (error) { console.error('DB read error:', error.message); return null; }
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { return null; }
}

async function createWallet(user, lang = 'ru') {
  try {
    const { data, error } = await supabase.from('smaster_wallets').insert({
      user_id: String(user.id), username: user.username || null,
      balance_usdt: 0, balance_ton: 0, language: lang
    }).select();
    if (error) { console.error('DB create error:', error.message); return { error: error.message }; }
    return { data: data[0] };
  } catch (e) { return { error: e.message }; }
}

async function updateWallet(userId, patch) {
  try {
    await supabase.from('smaster_wallets').update(patch).eq('user_id', String(userId));
  } catch (e) { console.error('DB update error:', e.message); }
}

function fmt(n, d = 2) { return Number(n || 0).toFixed(d); }
const states = new Map();

// ============ СТАРТ ============
bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const w = await getWallet(msg.from.id);

    if (!w) {
      return bot.sendMessage(chatId, '🇷🇺 Выбери язык / 🇬🇧 Choose your language:', {
        reply_markup: { inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }], [{ text: '🇬🇧 English', callback_data: 'lang_en' }]] }
      });
    }

    const lang = w.language || 'ru';
    await bot.sendMessage(chatId, i18n[lang].welcome.replace('{name}', msg.from.first_name || 'друг'), getMainMenu(lang, true));
  } catch (e) { console.log('start err:', e.message); }
});

// ============ ОБРАБОТЧИК ТЕКСТА ============
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const text = msg.text;
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const w = await getWallet(userId);
    const lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    // Список ВСЕХ кнопок меню
    const menuBtns = [
      t.btn_balance, 'Баланс', 'Balance',
      t.btn_deposit, 'Пополнить', 'Deposit',
      t.btn_transfer, 'Перевести', 'Transfer',
      t.btn_rocket, 'Ракета', 'Rocket',
      t.btn_p2p, 'P2P Маркет', 'P2P Market',
      t.btn_ref, 'Рефералка', 'Referral',
      t.btn_rates, 'Курсы', 'Rates',
      t.btn_create, 'Создать кошелек', 'Create Wallet',
      '⬅️ Назад', 'отмена', 'cancel'
    ];

    // Если нажата кнопка меню - СБРАСЫВАЕМ ЛЮБОЕ ОЖИДАНИЕ ВВОДА
    if (menuBtns.includes(text)) {
      states.delete(userId);
    }

    // --- ОБРАБОТКА КНОПОК ---
    if (text === '⬅️ Назад' || text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
      return bot.sendMessage(chatId, t.cancel, getMainMenu(lang, !!w));
    }

    if (text === t.btn_create || text === 'Создать кошелек' || text === 'Create Wallet') return handleCreateWalletBtn(msg, lang, !!w);
    if (text === t.btn_rates || text === 'Курсы' || text === 'Rates') return handleRates(msg, lang, !!w);

    // Проверка на наличие кошелька для остальных кнопок
    if (!w) {
      if (menuBtns.includes(text)) return bot.sendMessage(chatId, t.need_wallet, getMainMenu(lang, false));
    }

    if (text === t.btn_balance || text === 'Баланс' || text === 'Balance') return handleBalance(msg, lang, w);
    if (text === t.btn_deposit || text === 'Пополнить' || text === 'Deposit') {
      states.set(userId, { type: 'deposit' });
      return bot.sendMessage(chatId, t.deposit_ask);
    }
    if (text === t.btn_transfer || text === 'Перевести' || text === 'Transfer') {
      states.set(userId, { type: 'transfer', step: 'recipient' });
      return bot.sendMessage(chatId, t.transfer_ask_recipient);
    }
    if (text === t.btn_rocket || text === 'Ракета' || text === 'Rocket') return handleRocket(msg, lang, w);
    if (text === t.btn_p2p || text === 'P2P Маркет' || text === 'P2P Market') return handleP2PMenu(msg, lang);
    if (text === t.btn_ref || text === 'Рефералка' || text === 'Referral') return handleReferral(msg, lang, !!w);

    // --- ОБРАБОТКА ВВОДА (ЕСЛИ НЕ НАЖАТА КНОПКА) ---
    const state = states.get(userId);
    if (state) {
      if (state.type === 'p2p_create') return handleCreateInput(msg, state, lang);
      if (state.type === 'deposit') return handleDepositInput(msg, lang);
      if (state.type === 'transfer') return handleTransferInput(msg, state, lang);
    }

  } catch (e) { console.log('msg err:', e.message); }
});

// ============ КНОПКА СОЗДАНИЯ КОШЕЛЬКА ============
async function handleCreateWalletBtn(msg, lang, hasWallet) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  if (hasWallet) return bot.sendMessage(chatId, t.wallet_exists.replace('{usdt}', '0').replace('{ton}', '0'), getMainMenu(lang, true)); // Просто на всякий случай
  
  const temp = await bot.sendMessage(chatId, '⏳...');
  const res = await createWallet(msg.from, lang);
  await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
  
  if (res.error) return bot.sendMessage(chatId, `❌ Ошибка БД: ${res.error}`, getMainMenu(lang, false));
  
  // Отправляем меню БЕЗ кнопки "Создать кошелек"
  await bot.sendMessage(chatId, t.wallet_created, getMainMenu(lang, true));
}

// ============ БАЛАНС ============
async function handleBalance(msg, lang, w) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  const temp = await bot.sendMessage(chatId, '⏳...');
  await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
  await bot.sendMessage(chatId, t.balance_text.replace('{usdt}', fmt(w.balance_usdt)).replace('{ton}', fmt(w.balance_ton)), getMainMenu(lang, true));
}

// ============ ПОПОЛНЕНИЕ ============
async function handleDepositInput(msg, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, i18n[lang].cancel, getMainMenu(lang, true));
  states.delete(msg.from.id);
  
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', amount: String(amount), description: `Deposit #${msg.from.id}`, payload: String(msg.from.id), allow_comments: false, allow_anonymous: false, expires_in: 3600 })
    });
    const data = await res.json();
    if (!data.ok) return bot.sendMessage(chatId, 'Error.', getMainMenu(lang, true));
    await bot.sendMessage(chatId, `💳 Invoice: ${data.result.bot_invoice_url}`, getMainMenu(lang, true));
  } catch (e) { await bot.sendMessage(chatId, 'Error.', getMainMenu(lang, true)); }
}

// ============ ПЕРЕВОД ============
async function handleTransferInput(msg, state, lang) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  const userId = msg.from.id;

  if (state.step === 'recipient') {
    const tr = msg.text.trim();
    let recipient = null;
    if (tr.startsWith('@')) {
      const { data } = await supabase.from('smaster_wallets').select('*').ilike('username', tr.slice(1)).limit(1);
      recipient = data && data.length > 0 ? data[0] : null;
    } else {
      const rid = Number(tr);
      if (rid) recipient = await getWallet(rid);
    }
    if (!recipient) return bot.sendMessage(chatId, '❌ Не найден / Not found.', getMainMenu(lang, true));
    if (String(recipient.user_id) === String(userId)) return bot.sendMessage(chatId, '❌ Нельзя себе / Cannot self.', getMainMenu(lang, true));
    
    states.set(userId, { type: 'transfer', step: 'amount', to: recipient.user_id, toName: recipient.username || recipient.user_id });
    return bot.sendMessage(chatId, t.transfer_ask_amount.replace('{to}', recipient.username ? '@' + recipient.username : recipient.user_id));
  }

  if (state.step === 'amount') {
    const amount = Number(msg.text.replace(',', '.'));
    if (!amount || amount <= 0) return bot.sendMessage(chatId, t.cancel, getMainMenu(lang, true));
    
    const w = await getWallet(userId);
    const totalDeduct = amount + TRANSFER_FEE;
    
    if (Number(w.balance_usdt) < totalDeduct) {
      states.delete(userId);
      return bot.sendMessage(chatId, t.low_balance, getMainMenu(lang, true));
    }
    
    const to = await getWallet(state.to);
    await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - totalDeduct).toFixed(8) });
    await updateWallet(state.to, { balance_usdt: (Number(to.balance_usdt) + amount).toFixed(8) });
    states.delete(userId);
    
    await bot.sendMessage(chatId, t.transfer_success.replace('{amount}', fmt(amount)).replace('{to}', state.toName), getMainMenu(lang, true));
    bot.sendMessage(state.to, t.transfer_received.replace('{amount}', fmt(amount)).replace('{from}', userId)).catch(() => {});
  }
}

// ============ РАКЕТА, РЕФЕРАЛКА, КУРСЫ ============
async function handleRocket(msg, lang, w) {
  if (Math.random() < 0.000001) {
    await updateWallet(msg.from.id, { balance_usdt: (Number(w.balance_usdt) + 100).toFixed(8) });
    await bot.sendMessage(msg.chat.id, '🚀🚀🚀 РАКЕТА ВЗЛЕТЕЛА!!!\n\n🎉 Ты выиграл 100 USDT!\n\n(шанс 1 на миллион)', getMainMenu(lang, true));
  } else {
    await bot.sendMessage(msg.chat.id, '🚀 Ракета взорвалась.\n\nПовезет в следующий раз!', getMainMenu(lang, true));
  }
}

async function handleReferral(msg, lang, hasWallet) {
  const me = await bot.getMe();
  await bot.sendMessage(msg.chat.id, `🎁 Твоя ссылка:\nhttps://t.me/${me.username}?start=ref_${msg.from.id}`, getMainMenu(lang, hasWallet));
}

async function handleRates(msg, lang, hasWallet) {
  const temp = await bot.sendMessage(msg.chat.id, '⏳...');
  try {
    const res = await fetch('https://pay.crypt.bot/api/getExchangeRates', { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN } });
    const data = await res.json();
    await bot.deleteMessage(msg.chat.id, temp.message_id).catch(() => {});
    
    const usdtTon = data.result.find(r => r.source === 'USDT' && r.target === 'TON');
    const tonUsdt = data.result.find(r => r.source === 'TON' && r.target === 'USDT');
    const usdtRub = data.result.find(r => r.source === 'USDT' && r.target === 'RUB');
    
    let text = '📈 Курсы:\n\n';
    if (usdtTon) text += `• 1 USDT = ${fmt(usdtTon.rate, 4)} TON\n`;
    if (tonUsdt) text += `• 1 TON = ${fmt(tonUsdt.rate, 2)} USDT\n`;
    if (usdtRub) text += `• 1 USDT = ${fmt(usdtRub.rate, 2)} RUB\n`;
    await bot.sendMessage(msg.chat.id, text, getMainMenu(lang, hasWallet));
  } catch (e) { 
    await bot.deleteMessage(msg.chat.id, temp.message_id).catch(() => {});
    await bot.sendMessage(msg.chat.id, 'Ошибка загрузки курсов.', getMainMenu(lang, hasWallet)); 
  }
}

// ============ P2P ============
async function handleP2PMenu(msg, lang) {
  const t = i18n[lang];
  await bot.sendMessage(msg.chat.id, t.p2p_menu, {
    reply_markup: { inline_keyboard: [[{ text: t.p2p_buy, callback_data: 'p2p_buy' }], [{ text: t.p2p_create, callback_data: 'p2p_create' }], [{ text: t.p2p_my, callback_data: 'p2p_my' }]] }
  });
}

async function handleCreateInput(msg, state, lang) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  const t = i18n[lang];

  if (state.step === 'amount') {
    const amount = Number(text.replace(',', '.'));
    if (!amount || amount <= 0) return bot.sendMessage(chatId, t.cancel, getMainMenu(lang, true));
    states.set(userId, { ...state, step: 'currency', amount });
    return bot.sendMessage(chatId, 'Валюта: TON или RUB');
  }

  if (state.step === 'currency') {
    const cur = text.toUpperCase();
    if (cur !== 'TON' && cur !== 'RUB') return bot.sendMessage(chatId, '❌ TON or RUB');
    states.set(userId, { ...state, step: 'price', currency: cur });
    return bot.sendMessage(chatId, `Цена за 1 USDT в ${cur}?`);
  }

  if (state.step === 'price') {
    const price = Number(text.replace(',', '.'));
    if (!price || price <= 0) return bot.sendMessage(chatId, t.cancel, getMainMenu(lang, true));
    
    const w = await getWallet(userId);
    if (Number(w.balance_usdt) < state.amount) {
      states.delete(userId);
      return bot.sendMessage(chatId, t.low_balance, getMainMenu(lang, true));
    }
    
    const { data, error } = await supabase.from('smaster_p2p_ads').insert({ seller_id: String(userId), seller_username: msg.from.username || null, amount: state.amount, price: price, currency: state.currency }).select();
    states.delete(userId);
    
    if (error) return bot.sendMessage(chatId, '❌ Error.', getMainMenu(lang, true));
    await bot.sendMessage(chatId, `✅ Ad #${data[0].id} created!\n\nSelling: ${state.amount} USDT\nPrice: ${price} ${state.currency}`, getMainMenu(lang, true));
  }
}

// ============ CALLBACK'И ============
bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    await bot.answerCallbackQuery(query.id).catch(() => {});

    let w = await getWallet(userId);
    let lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    if (data.startsWith('lang_')) {
      lang = data.split('_')[1];
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      
      const res = await createWallet(query.from, lang);
      if (res.error) return bot.sendMessage(chatId, `❌ Ошибка БД: ${res.error}`, getMainMenu(lang, false));
      
      return bot.sendMessage(chatId, t.welcome.replace('{name}', query.from.first_name || 'друг'), getMainMenu(lang, true));
    }

    if (data === 'p2p_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'p2p_create', step: 'amount' });
      return bot.sendMessage(chatId, '➕ Сколько USDT продаёшь?\n\nИли «отмена».');
    }

    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', String(userId)).limit(10);
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 No ads found.', getMainMenu(lang, true));
      
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      return bot.sendMessage(chatId, '🛒 Ads:', { reply_markup: { inline_keyboard: buttons } });
    }

    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Unavailable.', getMainMenu(lang, true));
      
      const total = Number(ad.amount) * Number(ad.price);
      return bot.sendMessage(chatId,
        `📢 #${ad.id}\n\nSeller: @${ad.seller_username || 'id'+ad.seller_id}\nUSDT: ${ad.amount}\nPrice: ${ad.price} ${ad.currency}\nTotal: ${fmt(total)} ${ad.currency}`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Buy', callback_data: `p2p_buy_${ad.id}` }], [{ text: '↩️ Back', callback_data: 'p2p_buy' }]] } }
      );
    }

    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Unavailable.', getMainMenu(lang, true));
      if (String(ad.seller_id) === String(userId)) return bot.sendMessage(chatId, '❌ Cannot buy your own ad.', getMainMenu(lang, true));

      const amount = Number(ad.amount);
      const total = amount * Number(ad.price);

      if (ad.currency === 'RUB') {
        return bot.sendMessage(chatId, `💬 Contact @${ad.seller_username || 'id'+ad.seller_id}\n\nSend ${fmt(total)} RUB.`, getMainMenu(lang, true));
      }

      const seller = await getWallet(ad.seller_id);
      if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, `❌ Need ${fmt(total)} TON.`, getMainMenu(lang, true));
      
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: String(userId) }).eq('id', ad.id);

      await bot.sendMessage(chatId, `✅ Deal #${ad.id} completed!\n\n+${amount} USDT\n−${fmt(total)} TON`, getMainMenu(lang, true));
      bot.sendMessage(ad.seller_id, `✅ Your ad #${ad.id} bought!\n\n−${amount} USDT\n+${fmt(total)} TON`).catch(() => {});
    }

    if (data === 'p2p_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('seller_id', String(userId)).eq('status', 'active');
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '📢 No active ads.', getMainMenu(lang, true));
      
      for (const ad of ads) {
        await bot.sendMessage(chatId, `📢 #${ad.id}\nUSDT: ${ad.amount}\nPrice: ${ad.price} ${ad.currency}`, { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `p2p_cancel_${ad.id}` }]] } });
      }
      return bot.sendMessage(chatId, '⬆️ Your ads.', getMainMenu(lang, true));
    }

    if (data.startsWith('p2p_cancel_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', id).eq('seller_id', String(userId));
      return bot.sendMessage(chatId, `✅ Cancelled.`, getMainMenu(lang, true));
    }

  } catch (e) { console.log('cb err:', e.message); }
});

// ============ ВЕБХУК CRYPTOBOT & SERVER ============
const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/cryptobot', async (req, res) => {
  try {
    const u = req.body;
    if (u.update_type === 'invoice_paid') {
      const userId = u.payload.payload;
      const amount = Number(u.payload.amount);
      if (userId && amount > 0) {
        const w = await getWallet(userId);
        if (w) {
          await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
          bot.sendMessage(userId, `✅ +${amount} USDT deposited!`).catch(() => {});
        }
      }
    }
    res.sendStatus(200);
  } catch (e) { res.sendStatus(200); }
});

app.get('/', (req, res) => res.send('SMaster is running'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP listening'));

bot.on('polling_error', (err) => console.log('polling_error:', err.message));
console.log('🤖 SMaster bot started');
