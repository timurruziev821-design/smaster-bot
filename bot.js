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

const states = new Map();

// ============ ТЕКСТЫ ============
const i18n = {
  ru: {
    welcome: 'Привет, {name}! 👋\n\nДобро пожаловать в SMaster.\nТвой надежный крипто-кошелек.',
    balance_text: '👛 **Твой кошелёк**\n\n💰 Баланс:\n• USDT: {usdt}\n• TON: {ton}',
    deposit_ask: '💳 Введи сумму в USDT для пополнения (например 5).',
    transfer_ask_recipient: '📤 Кому перевести? Напиши ID или @username.\n\nКомиссия: 0.1 USDT.',
    transfer_ask_amount: 'Кому: {to}\n\nСколько USDT? (Комиссия: 0.1)',
    transfer_success: '✅ Успешно!\nПереведено: {amount} USDT\nКомиссия: 0.1 USDT\nКому: {to}',
    transfer_received: '💸 Тебе пришло {amount} USDT от {from}',
    low_balance: '❌ Недостаточно USDT на балансе!',
    p2p_menu: '🎲 P2P Маркет SMaster\n\nЗдесь ты можешь купить или продать USDT за TON.',
    p2p_buy: '🛒 Купить USDT', p2p_create: '➕ Выставить объявление', p2p_my: '📢 Мои объявления',
    cancel: '⬅️ Назад в меню',
    settings: '⚙️ **Настройки**\n\nУправляй своим аккаунтом и приложением:',
    ref_link: '🎁 Твоя реферальная ссылка:\n{link}\n\nПриглашай друзей и получай бонусы!',
    rates: '📈 **Курсы (CryptoBot):**\n\n• 1 USDT = {usdt_ton} TON\n• 1 TON = {ton_usdt} USDT\n• 1 USDT = {usdt_rub} RUB',
    about: 'ℹ️ **О SMaster**\n\nSMaster — это твой быстрый и безопасный Telegram-кошелёк.\n\n🚀 Мы поддерживаем:\n• Мгновенные переводы USDT/TON\n• P2P Маркет\n• Подарочные чеки\n• Пополнения через CryptoBot\n\n👨‍💻 Разработчик: Тимур (Solo_Men)\nЕсли есть вопросы, пиши в поддержку.',
    checks_menu: '🧾 **Чеки SMaster**\n\nЧеки — это крутой способ подарить крипту другу. Создай чек, отправь ссылку, и получатель сможет забрать деньги.',
    check_create: '➕ Создать чек',
    check_activate: '🎁 Активировать по коду',
    check_ask_amount: 'Введи сумму в USDT для создания чека:',
    check_success: '✅ Чек на {amount} USDT создан!\n\nОтправь эту ссылку другу:\n{link}\n\nКак только он перейдет по ней, деньги спишутся с твоего баланса и перейдут ему.',
    check_ask_code: 'Введи ID чека или ссылку на него (например 12):',
    check_claimed: '🎉 Ты успешно активировал чек на {amount} USDT!',
    check_error: '❌ Чек не найден или уже активирован.',
    support: '👨‍💻 **Поддержка**\n\nЕсли у тебя возникли проблемы или вопросы, напиши нашему менеджеру: @TonRocketSupportBot',
    delete_wallet: '⚠️ Ты уверен, что хочешь удалить свой кошелёк? Все средства сгорят! (Введи "УДАЛИТЬ" для подтверждения)',
    profile: '👤 **Мой профиль**\n\nID: {id}\nИмя: {name}\nЯзык: {lang}',
  },
  en: {
    welcome: 'Hello, {name}! 👋\n\nWelcome to SMaster.\nYour reliable crypto wallet.',
    balance_text: '👛 **Your Wallet**\n\n💰 Balance:\n• USDT: {usdt}\n• TON: {ton}',
    deposit_ask: '💳 Enter USDT amount to deposit (e.g. 5).',
    transfer_ask_recipient: '📤 Who to transfer to? Type ID or @username.\n\nFee: 0.1 USDT.',
    transfer_ask_amount: 'To: {to}\n\nHow much USDT? (Fee: 0.1)',
    transfer_success: '✅ Success!\nTransferred: {amount} USDT\nFee: 0.1 USDT\nTo: {to}',
    transfer_received: '💸 You received {amount} USDT from {from}',
    low_balance: '❌ Insufficient USDT balance!',
    p2p_menu: '🎲 P2P Market SMaster\n\nHere you can buy or sell USDT for TON.',
    p2p_buy: '🛒 Buy USDT', p2p_create: '➕ Create Ad', p2p_my: '📢 My Ads',
    cancel: '⬅️ Back to menu',
    settings: '⚙️ **Settings**\n\nManage your account and app:',
    ref_link: '🎁 Your referral link:\n{link}\n\nInvite friends and get bonuses!',
    rates: '📈 **Rates (CryptoBot):**\n\n• 1 USDT = {usdt_ton} TON\n• 1 TON = {ton_usdt} USDT\n• 1 USDT = {usdt_rub} RUB',
    about: 'ℹ️ **About SMaster**\n\nSMaster is your fast and secure Telegram wallet.\n\n🚀 Features:\n• Instant USDT/TON transfers\n• P2P Market\n• Gift checks\n• Deposits via CryptoBot',
    checks_menu: '🧾 **SMaster Checks**\n\nChecks are a great way to gift crypto to a friend. Create a check, send the link, and they can claim it.',
    check_create: '➕ Create Check',
    check_activate: '🎁 Activate by Code',
    check_ask_amount: 'Enter USDT amount for the check:',
    check_success: '✅ Check for {amount} USDT created!\n\nSend this link to a friend:\n{link}',
    check_ask_code: 'Enter Check ID or link (e.g. 12):',
    check_claimed: '🎉 You successfully claimed a check for {amount} USDT!',
    check_error: '❌ Check not found or already claimed.',
    support: '👨‍💻 **Support**\n\nIf you have issues, contact our manager: @TonRocketSupportBot',
    delete_wallet: '⚠️ Are you sure you want to delete your wallet? All funds will be lost! (Type "DELETE" to confirm)',
    profile: '👤 **My Profile**\n\nID: {id}\nName: {name}\nLanguage: {lang}',
  }
};

// ============ КЛАВИАТУРЫ ============
function getMainMenu(lang, hasWallet) {
  if (!hasWallet) {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Создать кошелек / Create Wallet', callback_data: 'create_wallet' }]
        ]
      }
    };
  }

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк / Wallet', callback_data: 'menu_balance' }, { text: '💳 Пополнить / Deposit', callback_data: 'menu_deposit' }],
        [{ text: '📤 Перевести / Transfer', callback_data: 'menu_transfer' }, { text: '📥 Вывести / Withdraw', callback_data: 'menu_withdraw' }],
        [{ text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }, { text: '🧾 Чеки / Checks', callback_data: 'menu_checks' }],
        [{ text: '🎁 Рефералка / Referral', callback_data: 'menu_ref' }, { text: '📈 Курсы / Rates', callback_data: 'menu_rates' }],
        [{ text: '⚙️ Настройки / Settings', callback_data: 'menu_settings' }, { text: 'ℹ️ О SMaster', callback_data: 'menu_about' }]
      ]
    }
  };
}

// ============ БАЗА ============
async function getWallet(userId) {
  try {
    const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', String(userId)).limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { return null; }
}
async function createWallet(user, lang = 'ru') {
  try {
    const { data } = await supabase.from('smaster_wallets').insert({
      user_id: String(user.id), username: user.username || null, balance_usdt: 0, balance_ton: 0, language: lang
    }).select();
    return data && data.length > 0 ? { data: data[0] } : { error: 'Fail' };
  } catch (e) { return { error: e.message }; }
}
async function updateWallet(userId, patch) {
  await supabase.from('smaster_wallets').update(patch).eq('user_id', String(userId));
}
function fmt(n, d = 2) { return Number(n || 0).toFixed(d); }

// ============ СТАРТ ============
bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    // Сначала принудительно убиваем старую клавиатуру
    await bot.sendMessage(chatId, '⏳ Обновляю меню...', { reply_markup: { remove_keyboard: true } });

    let w = await getWallet(msg.from.id);
    let lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    const textParts = msg.text.split(' ');
    if (textParts.length > 1 && textParts[1].startsWith('check_')) {
      const checkId = textParts[1].split('_')[1];
      return handleClaimCheck(msg, checkId, w, lang);
    }

    if (!w) {
      return bot.sendMessage(chatId, '🇷🇺 Выбери язык / 🇬🇧 Choose your language:', {
        reply_markup: { inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }], [{ text: '🇬🇧 English', callback_data: 'lang_en' }]] }
      });
    }

    await bot.sendMessage(chatId, t.welcome.replace('{name}', msg.from.first_name || 'друг'), getMainMenu(lang, true));
  } catch (e) { console.log('start err:', e.message); }
});

// ============ ТЕКСТОВЫЙ ВВОД ============
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.from.id;
    const state = states.get(userId);
    if (!state) return;

    const w = await getWallet(userId);
    const lang = w ? (w.language || 'ru') : 'ru';

    if (state.type === 'deposit') return handleDepositInput(msg, lang);
    if (state.type === 'transfer_recipient') return handleTransferRecipient(msg, lang);
    if (state.type === 'transfer_amount') return handleTransferAmount(msg, state, lang);
    if (state.type === 'p2p_amount') return handleP2pAmount(msg, lang);
    if (state.type === 'p2p_currency') return handleP2pCurrency(msg, state, lang);
    if (state.type === 'p2p_price') return handleP2pPrice(msg, state, lang);
    if (state.type === 'check_create_amount') return handleCreateCheckAmount(msg, w, lang);
    if (state.type === 'check_activate_code') return handleClaimCheck(msg, msg.text.trim(), w, lang);

  } catch (e) { console.log('msg err:', e.message); }
});

// ============ CALLBACK'И (Кнопки) ============
bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    await bot.answerCallbackQuery(query.id).catch(() => {});

    let w = await getWallet(userId);
    let lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    // --- ЯЗЫК ---
    if (data.startsWith('lang_')) {
      lang = data.split('_')[1];
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      if (!w) { const res = await createWallet(query.from, lang); w = res.data; } 
      else { await updateWallet(userId, { language: lang }); }
      return bot.sendMessage(chatId, t.welcome.replace('{name}', query.from.first_name || 'друг'), getMainMenu(lang, true));
    }

    // --- НАВИГАЦИЯ ---
    if (data === 'back_to_menu' || data === 'cancel') {
      states.delete(userId);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.welcome.replace('{name}', query.from.first_name || 'друг'), getMainMenu(lang, !!w));
    }

    // --- СОЗДАНИЕ КОШЕЛЬКА ---
    if (data === 'create_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await createWallet(query.from, lang);
      return bot.sendMessage(chatId, '✅ Кошелёк создан! / Wallet created!', getMainMenu(lang, true));
    }

    // --- БАЛАНС ---
    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.balance_text.replace('{usdt}', fmt(w.balance_usdt)).replace('{ton}', fmt(w.balance_ton)), {
        reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }
      });
    }

    // --- ПОПОЛНЕНИЕ ---
    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'deposit' });
      return bot.sendMessage(chatId, t.deposit_ask, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // --- ПЕРЕВОД ---
    if (data === 'menu_transfer') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'transfer_recipient' });
      return bot.sendMessage(chatId, t.transfer_ask_recipient, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // --- ВЫВОД ---
    if (data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📥 Вывод средств появится в следующем обновлении!', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // --- КУРСЫ ---
    if (data === 'menu_rates') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const temp = await bot.sendMessage(chatId, '⏳...');
      try {
        const res = await fetch('https://pay.crypt.bot/api/getExchangeRates', { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN } });
        const cbData = await res.json();
        await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
        const usdtTon = cbData.result.find(r => r.source === 'USDT' && r.target === 'TON');
        const tonUsdt = cbData.result.find(r => r.source === 'TON' && r.target === 'USDT');
        const usdtRub = cbData.result.find(r => r.source === 'USDT' && r.target === 'RUB');
        const text = t.rates.replace('{usdt_ton}', fmt(usdtTon?.rate, 4)).replace('{ton_usdt}', fmt(tonUsdt?.rate, 2)).replace('{usdt_rub}', fmt(usdtRub?.rate, 2));
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
      } catch (e) { await bot.sendMessage(chatId, 'Error', getMainMenu(lang, true)); }
      return;
    }

    // --- РЕФЕРАЛКА ---
    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const me = await bot.getMe();
      const link = `https://t.me/${me.username}?start=ref_${userId}`;
      return bot.sendMessage(chatId, t.ref_link.replace('{link}', link), { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // --- О SMaster ---
    if (data === 'menu_about') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.about, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // --- НАСТРОЙКИ ---
    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.settings, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }, { text: '🇬🇧 English', callback_data: 'lang_en' }],
            [{ text: '👤 Профиль / Profile', callback_data: 'set_profile' }],
            [{ text: '👨‍💻 Поддержка / Support', callback_data: 'set_support' }],
            [{ text: '⚠️ Удалить кошелёк', callback_data: 'set_delete' }],
            [{ text: t.cancel, callback_data: 'back_to_menu' }]
          ]
        }
      });
    }
    if (data === 'set_profile') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const text = t.profile.replace('{id}', w.user_id).replace('{name}', w.username ? '@' + w.username : 'None').replace('{lang}', lang.toUpperCase());
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] } });
    }
    if (data === 'set_support') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.support, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] } });
    }
    if (data === 'set_delete') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.delete_wallet, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] } });
    }

    // ================= ЧЕКИ =================
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.checks_menu, {
        reply_markup: {
          inline_keyboard: [
            [{ text: t.check_create, callback_data: 'check_create' }],
            [{ text: t.check_activate, callback_data: 'check_activate' }],
            [{ text: t.cancel, callback_data: 'back_to_menu' }]
          ]
        }
      });
    }
    if (data === 'check_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'check_create_amount' });
      return bot.sendMessage(chatId, t.check_ask_amount, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }
    if (data === 'check_activate') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'check_activate_code' });
      return bot.sendMessage(chatId, t.check_ask_code, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }

    // ================= P2P =================
    if (data === 'menu_p2p') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.p2p_menu, {
        reply_markup: { inline_keyboard: [[{ text: t.p2p_buy, callback_data: 'p2p_buy' }], [{ text: t.p2p_create, callback_data: 'p2p_create' }], [{ text: t.p2p_my, callback_data: 'p2p_my' }], [{ text: t.cancel, callback_data: 'back_to_menu' }]] }
      });
    }
    if (data === 'p2p_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'p2p_amount' });
      return bot.sendMessage(chatId, '➕ Сколько USDT хочешь продать? Напиши число.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
    }
    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', String(userId)).limit(10);
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 Нет активных объявлений.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] } });
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      buttons.push([{ text: t.cancel, callback_data: 'menu_p2p' }]);
      return bot.sendMessage(chatId, '🛒 Выбери объявление:', { reply_markup: { inline_keyboard: buttons } });
    }
    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', getMainMenu(lang, true));
      const total = Number(ad.amount) * Number(ad.price);
      const extra = ad.currency === 'RUB' ? '\n\n⚠️ Оплата рублями.' : '';
      return bot.sendMessage(chatId, `📢 Объявление #${ad.id}\n\nПродавец: @${ad.seller_username || 'id'+ad.seller_id}\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}\nИтого: ${fmt(total)} ${ad.currency}${extra}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Купить', callback_data: `p2p_buy_${ad.id}` }], [{ text: t.cancel, callback_data: 'menu_p2p' }]] } });
    }
    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', getMainMenu(lang, true));
      if (String(ad.seller_id) === String(userId)) return bot.sendMessage(chatId, '❌ Нельзя купить своё.', getMainMenu(lang, true));
      const amount = Number(ad.amount);
      const total = amount * Number(ad.price);
      if (ad.currency === 'RUB') return bot.sendMessage(chatId, `💬 Свяжись с @${ad.seller_username || 'id'+ad.seller_id}\n\nПереведи ${fmt(total)} RUB.`, getMainMenu(lang, true));
      const seller = await getWallet(ad.seller_id);
      if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, `❌ Нужно ${fmt(total)} TON.`, getMainMenu(lang, true));
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: String(userId) }).eq('id', ad.id);
      await bot.sendMessage(chatId, `✅ Сделка #${ad.id}!\n\n+${amount} USDT\n−${fmt(total)} TON`, getMainMenu(lang, true));
      bot.sendMessage(ad.seller_id, `✅ Твоё объявление #${ad.id} куплено!\n\n−${amount} USDT\n+${fmt(total)} TON`).catch(() => {});
    }
    if (data === 'p2p_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('seller_id', String(userId)).eq('status', 'active');
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '📢 У тебя нет объявлений.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] } });
      for (const ad of ads) {
        await bot.sendMessage(chatId, `📢 #${ad.id}\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отменить', callback_data: `p2p_cancel_${ad.id}` }]] } });
      }
      return bot.sendMessage(chatId, '⬆️ Твои объявления.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] } });
    }
    if (data.startsWith('p2p_cancel_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', id).eq('seller_id', String(userId));
      return bot.sendMessage(chatId, `✅ Объявление #${id} отменено.`, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] } });
    }

  } catch (e) { console.log('cb err:', e.message); }
});

// ============ ФУНКЦИИ ВВОДА ============
async function handleDepositInput(msg, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  
  states.delete(msg.from.id);
  const temp = await bot.sendMessage(chatId, '⏳...');
  
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', amount: String(amount), description: `Deposit #${msg.from.id}`, payload: String(msg.from.id), allow_comments: false, allow_anonymous: false, expires_in: 3600 })
    });
    const data = await res.json();
    await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
    if (!data.ok) return bot.sendMessage(chatId, '❌ Ошибка.', getMainMenu(lang, true));
    await bot.sendMessage(chatId, `💳 Счёт на ${amount} USDT создан!\n\nОплати по ссылке:\n${data.result.bot_invoice_url}`, getMainMenu(lang, true));
  } catch (e) { await bot.sendMessage(chatId, '❌ Ошибка.', getMainMenu(lang, true)); }
}

async function handleTransferRecipient(msg, lang) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  const tr = msg.text.trim();
  let recipient = null;
  if (tr.startsWith('@')) {
    const { data } = await supabase.from('smaster_wallets').select('*').ilike('username', tr.slice(1)).limit(1);
    recipient = data && data.length > 0 ? data[0] : null;
  } else {
    const rid = Number(tr);
    if (rid) recipient = await getWallet(rid);
  }
  if (!recipient) return bot.sendMessage(chatId, '❌ Не найден.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  if (String(recipient.user_id) === String(msg.from.id)) return bot.sendMessage(chatId, '❌ Нельзя себе.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  
  states.set(msg.from.id, { type: 'transfer_amount', to: recipient.user_id, toName: recipient.username || recipient.user_id });
  await bot.sendMessage(chatId, t.transfer_ask_amount.replace('{to}', recipient.username ? '@' + recipient.username : recipient.user_id), { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
}

async function handleTransferAmount(msg, state, lang) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  
  const w = await getWallet(msg.from.id);
  const totalDeduct = amount + TRANSFER_FEE;
  if (Number(w.balance_usdt) < totalDeduct) {
    states.delete(msg.from.id);
    return bot.sendMessage(chatId, t.low_balance, getMainMenu(lang, true));
  }
  
  const to = await getWallet(state.to);
  await updateWallet(msg.from.id, { balance_usdt: (Number(w.balance_usdt) - totalDeduct).toFixed(8) });
  await updateWallet(state.to, { balance_usdt: (Number(to.balance_usdt) + amount).toFixed(8) });
  
  states.delete(msg.from.id);
  await bot.sendMessage(chatId, t.transfer_success.replace('{amount}', fmt(amount)).replace('{to}', state.toName), getMainMenu(lang, true));
  bot.sendMessage(state.to, t.transfer_received.replace('{amount}', fmt(amount)).replace('{from}', msg.from.id)).catch(() => {});
}

async function handleP2pAmount(msg, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  states.set(msg.from.id, { type: 'p2p_currency', amount });
  await bot.sendMessage(chatId, 'Валюта оплаты: TON или RUB', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
}

async function handleP2pCurrency(msg, state, lang) {
  const chatId = msg.chat.id;
  const cur = msg.text.toUpperCase();
  const t = i18n[lang];
  if (cur !== 'TON' && cur !== 'RUB') return bot.sendMessage(chatId, '❌ Напиши TON или RUB.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  states.set(msg.from.id, { ...state, type: 'p2p_price', currency: cur });
  await bot.sendMessage(chatId, `Цена за 1 USDT в ${cur}?`, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
}

async function handleP2pPrice(msg, state, lang) {
  const chatId = msg.chat.id;
  const price = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!price || price <= 0) return bot.sendMessage(chatId, '❌ Введи цену.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  
  const w = await getWallet(msg.from.id);
  if (Number(w.balance_usdt) < state.amount) {
    states.delete(msg.from.id);
    return bot.sendMessage(chatId, t.low_balance, getMainMenu(lang, true));
  }
  
  const { data, error } = await supabase.from('smaster_p2p_ads').insert({ seller_id: String(msg.from.id), seller_username: msg.from.username || null, amount: state.amount, price: price, currency: state.currency }).select();
  states.delete(msg.from.id);
  if (error) return bot.sendMessage(chatId, '❌ Ошибка.', getMainMenu(lang, true));
  await bot.sendMessage(chatId, `✅ Объявление #${data[0].id} создано!\n\nПродаёшь: ${state.amount} USDT\nЦена: ${price} ${state.currency}`, getMainMenu(lang, true));
}

// ============ ЧЕКИ ============
async function handleCreateCheckAmount(msg, w, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] } });
  
  if (Number(w.balance_usdt) < amount) {
    states.delete(msg.from.id);
    return bot.sendMessage(chatId, t.low_balance, getMainMenu(lang, true));
  }
  
  await updateWallet(msg.from.id, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
  
  const { data, error } = await supabase.from('smaster_checks').insert({ creator_id: String(msg.from.id), amount: amount, status: 'active' }).select();
  states.delete(msg.from.id);
  
  if (error || !data) return bot.sendMessage(chatId, '❌ Ошибка БД.', getMainMenu(lang, true));
  
  const me = await bot.getMe();
  const link = `https://t.me/${me.username}?start=check_${data[0].id}`;
  
  await bot.sendMessage(chatId, t.check_success.replace('{amount}', fmt(amount)).replace('{link}', link), getMainMenu(lang, true));
}

async function handleClaimCheck(msg, checkId, w, lang) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  
  if (!w) {
    return bot.sendMessage(chatId, '🇷🇺 Сначала выбери язык / First choose language:', {
      reply_markup: { inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: `claim_lang_ru_${checkId}` }], [{ text: '🇬🇧 English', callback_data: `claim_lang_en_${checkId}` }]] }
    });
  }

  const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(checkId)).limit(1);
  const check = arr && arr.length > 0 ? arr[0] : null;
  
  if (!check || check.status !== 'active') {
    states.delete(msg.from.id);
    return bot.sendMessage(chatId, t.check_error, getMainMenu(lang, true));
  }
  
  if (String(check.creator_id) === String(msg.from.id)) {
    states.delete(msg.from.id);
    return bot.sendMessage(chatId, '❌ Ты не можешь активировать свой же чек.', getMainMenu(lang, true));
  }
  
  await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: String(msg.from.id) }).eq('id', check.id);
  await updateWallet(msg.from.id, { balance_usdt: (Number(w.balance_usdt) + Number(check.amount)).toFixed(8) });
  
  states.delete(msg.from.id);
  await bot.sendMessage(chatId, t.check_claimed.replace('{amount}', fmt(check.amount)), getMainMenu(lang, true));
}

// ============ ВЕБХУКИ И СЕРВЕР ============
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
