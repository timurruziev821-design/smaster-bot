const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.SMASTER_BOT_TOKEN || process.env.BOT_TOKEN;
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = String(process.env.ADMIN_ID || '');

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ОШИБКА: Не заданы токены!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const states = new Map();

const i18n = {
  ru: {
    welcome: '<b>Привет, {name}! 👋</b>\n\nДобро пожаловать в <b>SMaster</b> — твой премиальный крипто-кошелек.\n\n⚡️ Мгновенные переводы\n🎲 Собственный P2P Маркет\n🧾 Подарочные чеки\n\n<i>Выбери действие в меню ниже:</i>',
    balance_text: '👛 <b>Мой кошелёк</b>\n\n🪙 Tether: <code>{usdt}</code> USDT\n🪙 USD Coin: <code>{usdc}</code> USDC\n🪙 Gram: <code>{gram}</code> GRAM\n🪙 Solana: <code>{sol}</code> SOL\n🪙 TRON: <code>{trx}</code> TRX\n🪙 Ethereum: <code>{eth}</code> ETH\n🪙 Bitcoin: <code>{btc}</code> BTC\n🪙 Binance Coin: <code>{bnb}</code> BNB\n🪙 Dogecoin: <code>{doge}</code> DOGE\n🪙 Litecoin: <code>{ltc}</code> LTC\n🪙 Tether Gold: <code>{xaut}</code> XAUT\n🪙 GGT: <code>{ggt}</code> GGT\n\n≈ <b>{total} {curr}</b>\n\n<i>Чтобы настроить отображение, нажми на кнопку "Настройки"</i>',
    balance_empty: '👛 <b>Мой кошелёк</b>\n\n💰 <i>Баланс пуст.</i>\nПополни счет, чтобы начать!',
    deposit_ask: '💳 <b>Пополнение</b>\n\nВведи сумму в USDT (например, <code>5</code>):',
    p2p_menu: '💠 <b>Здесь вы можете купить или продать криптовалюту переводом на карту или электронный кошелёк.</b>\n\n<a href="https://t.me/Solo_Men_Studio">Смотреть видеоинструкцию ></a>',
    check_menu: '🧾 <b>Чеки SMaster</b>\n\nСоздай чек и отправь ссылку другу. Он сможет забрать крипту себе.',
    settings: '⚙️ <b>Настройки</b>\n\nУправляй своим аккаунтом и приложением:',
    profile: '👤 <b>Мой профиль</b>\n\n🆔 ID: <code>{id}</code>\n👤 Имя: {name}\n🌐 Язык: {lang}\n💱 Валюта: {curr}\n📅 В системе с: {date}\n\n🛡 Статус: <b>Verified</b>',
    balance_settings: '👁 <b>Настройки баланса</b>\n\nКак отображать твои активы?',
    bal_all: 'Показывать все', bal_hide_zero: 'Скрывать нули', bal_hide_1: 'Скрывать ниже $1',
    bot_currency: '💱 <b>Валюта отображения</b>\n\nВ какой валюте показывать общую стоимость?',
    history_menu: '📜 <b>История действий</b>\n\nВыбери нужный раздел:',
    history_empty: '📭 <i>История пуста.</i>',
    limits_menu: '📊 <b>Лимиты и комиссии</b>\n\n• Пополнение: <code>0%</code>\n• P2P: <code>0%</code>',
    connect_wallet: '🔗 <b>Привязка кошелька</b>\n\nПривяжи TON-кошелек для восстановления доступа.\n\nТекущий: <code>{wallet}</code>',
    ask_wallet_addr: '🔗 Отправь адрес TON-кошелька (или напиши <code>удалить</code>):',
    wallet_linked: '✅ Кошелёк <code>{addr}</code> привязан!',
    about: 'ℹ️ <b>О SMaster</b>\n\nSMaster — это экосистема для управления криптоактивами внутри Telegram.\n\n🚀 <b>Наши фишки:</b>\n• Мгновенные переводы без границ\n• P2P Маркет без комиссий\n• Подарочные чеки\n\n👨‍💻 <b>Основатель:</b> @Solo_Men\n💡 <i>Мы делаем крипту простой и доступной.</i>',
    support: '👨‍💻 <b>Поддержка</b>\n\nВозникли вопросы? Пиши нашему менеджеру: @TonRocketSupportBot',
    help_text: '🤖 <b>Помощь по SMaster</b>\n\nДоступные команды:\n/start — Перезапустить бота\n/help — Показать это сообщение\n/admin — Админ-панель (только для создателя)\n\n<b>Основные разделы:</b>\n• 👛 <b>Кошелёк</b> — твой баланс.\n• 💳 <b>Пополнить</b> — пополнение через CryptoBot.\n• 🎲 <b>P2P Маркет</b> — купля/продажа USDT за TON.\n• 🧾 <b>Чеки</b> — создание подарочных чеков.\n• 🎁 <b>Рефералка</b> — приглашай друзей.\n\nЕсли нужна помощь — пиши @TonRocketSupportBot',
    cancel: '⬅️ Назад в меню',
    check_create: '➕ Создать чек', check_create_multi: '🎁 Мульти-чек', check_activate: '🎁 Активировать', check_my: '📜 Мои чеки',
    check_ask_amount: '🧾 Введи сумму в USDT для чека:',
    check_ask_multi_count: '🧾 Введи общую сумму и кол-во чеков через пробел (например: <code>10 5</code>):',
    check_success: '✅ <b>Чек создан!</b>\n\nСумма: <code>{amount} USDT</code>\n\nОтправь эту ссылку другу:\n{link}',
    check_multi_success: '✅ <b>Создано {count} чеков по {amount} USDT!</b>\n\nСсылки:\n{links}',
    check_ask_code: '🧾 Введи ID чека или ссылку:',
    check_claimed: '🎉 <b>Чек активирован!</b>\n\nТвой баланс пополнен на <code>{amount} USDT</code>!',
    check_error: '❌ <i>Чек не найден или уже активирован.</i>',
    check_list: '📜 <b>Твои активные чеки:</b>\n\n{list}', check_list_empty: '📭 <i>У тебя нет активных чеков.</i>',
    ref_menu: '🎁 <b>Реферальная система</b>\n\nПриглашай друзей и получай <b>5%</b> от их комиссий!\n\n👥 Приглашено: <b>{count}</b>\n💰 Заработано: <b>{earned} USDT</b>\n\n🔗 Твоя ссылка:\n{link}',
    earn_menu: '💼 <b>EARN (Задания)</b>\n\nВыполняй простые задания и получай USDT на баланс!',
    earn_task_1: '📢 Подписаться на канал Solo_Men Studio',
    earn_success: '✅ <b>Задание выполнено!</b>\n\nТы получил <code>{amount} USDT</code> на баланс!',
    spin_menu: '🎲 <b>Колесо Фортуны</b>\n\nИспытай удачу! Стоимость спина — <b>0.1 USDT</b>.\nМожно выиграть от 0.01 до 10 USDT!\n\nКрути!',
    spin_win: '🎰 <b>Крутим колесо...</b> 🎰\n\n🎉 <b>ДЖЕКПОТ!</b> Ты выиграл <code>{amount} USDT</code>!\n\nТвой баланс: <code>{balance} USDT</code>',
    spin_lose: '🎰 <b>Крутим колесо...</b> 🎰\n\n😢 Не повезло. Попробуй еще раз!\n\nТвой баланс: <code>{balance} USDT</code>',
    set_nick_ask: '👤 Введи свой новый ник (до 20 символов):',
    set_nick_success: '✅ Твой новый ник: <b>{nick}</b>'
  },
  en: {
    welcome: '<b>Hello, {name}! 👋</b>\n\nWelcome to <b>SMaster</b> — your premium crypto wallet.\n\n⚡️ Instant transfers\n🎲 Own P2P Market\n🧾 Gift checks\n\n<i>Choose an action below:</i>',
    balance_text: '👛 <b>My Wallet</b>\n\n🪙 Tether: <code>{usdt}</code> USDT\n🪙 USD Coin: <code>{usdc}</code> USDC\n🪙 Gram: <code>{gram}</code> GRAM\n🪙 Solana: <code>{sol}</code> SOL\n🪙 TRON: <code>{trx}</code> TRX\n🪙 Ethereum: <code>{eth}</code> ETH\n🪙 Bitcoin: <code>{btc}</code> BTC\n🪙 Binance Coin: <code>{bnb}</code> BNB\n🪙 Dogecoin: <code>{doge}</code> DOGE\n🪙 Litecoin: <code>{ltc}</code> LTC\n🪙 Tether Gold: <code>{xaut}</code> XAUT\n🪙 GGT: <code>{ggt}</code> GGT\n\n≈ <b>{total} {curr}</b>\n\n<i>To customize display, click "Settings"</i>',
    balance_empty: '👛 <b>My Wallet</b>\n\n💰 <i>Balance is empty.</i>\nDeposit to start!',
    deposit_ask: '💳 <b>Deposit</b>\n\nEnter USDT amount (e.g., <code>5</code>):',
    p2p_menu: '💠 <b>Here you can buy or sell crypto via card or e-wallet.</b>\n\n<a href="https://t.me/Solo_Men_Studio">Watch video guide ></a>',
    check_menu: '🧾 <b>SMaster Checks</b>\n\nCreate a check and send the link to a friend.',
    settings: '⚙️ <b>Settings</b>\n\nManage your account and app:',
    profile: '👤 <b>My Profile</b>\n\n🆔 ID: <code>{id}</code>\n👤 Name: {name}\n🌐 Lang: {lang}\n💱 Currency: {curr}\n📅 Joined: {date}\n\n🛡 Status: <b>Verified</b>',
    balance_settings: '👁 <b>Balance Settings</b>\n\nHow to display assets?',
    bal_all: 'Show all', bal_hide_zero: 'Hide zeros', bal_hide_1: 'Hide below $1',
    bot_currency: '💱 <b>Display Currency</b>\n\nIn what currency to show total value?',
    history_menu: '📜 <b>Action History</b>\n\nChoose a section:',
    history_empty: '📭 <i>History is empty.</i>',
    limits_menu: '📊 <b>Limits and Fees</b>\n\n• Deposit: <code>0%</code>\n• P2P: <code>0%</code>',
    connect_wallet: '🔗 <b>Connect Wallet</b>\n\nLink your TON wallet for recovery.\n\nCurrent: <code>{wallet}</code>',
    ask_wallet_addr: '🔗 Send TON address (or type <code>delete</code>):',
    wallet_linked: '✅ Wallet <code>{addr}</code> linked!',
    about: 'ℹ️ <b>About SMaster</b>\n\nSMaster is an ecosystem for managing crypto inside Telegram.\n\n🚀 <b>Features:</b>\n• Instant transfers\n• P2P Market\n• Gift checks\n\n👨‍💻 <b>Founder:</b> @Solo_Men',
    support: '👨‍💻 <b>Support</b>\n\nQuestions? Write to: @TonRocketSupportBot',
    help_text: '🤖 <b>SMaster Help</b>\n\nCommands:\n/start — Restart bot\n/help — Show this message\n/admin — Admin panel (creator only)\n\n<b>Sections:</b>\n• 👛 <b>Wallet</b> — your balance.\n• 💳 <b>Deposit</b> — via CryptoBot.\n• 🎲 <b>P2P Market</b> — trade USDT for TON.\n• 🧾 <b>Checks</b> — gift crypto.\n• 🎁 <b>Referral</b> — invite friends.\n\nNeed help? @TonRocketSupportBot',
    cancel: '⬅️ Back to menu',
    check_create: '➕ Create Check', check_create_multi: '🎁 Multi-Check', check_activate: '🎁 Activate', check_my: '📜 My Checks',
    check_ask_amount: '🧾 Enter USDT amount:',
    check_ask_multi_count: '🧾 Enter total amount and count (e.g., <code>10 5</code>):',
    check_success: '✅ <b>Check created!</b>\n\nAmount: <code>{amount} USDT</code>\n\nSend link:\n{link}',
    check_multi_success: '✅ <b>Created {count} checks of {amount} USDT!</b>\n\nLinks:\n{links}',
    check_ask_code: '🧾 Enter Check ID or link:',
    check_claimed: '🎉 <b>Check activated!</b>\n\nBalance topped up by <code>{amount} USDT</code>!',
    check_error: '❌ <i>Check not found or already claimed.</i>',
    check_list: '📜 <b>Active checks:</b>\n\n{list}', check_list_empty: '📭 <i>No active checks.</i>',
    ref_menu: '🎁 <b>Referral System</b>\n\nInvite friends and earn <b>5%</b> of their fees!\n\n👥 Invited: <b>{count}</b>\n💰 Earned: <b>{earned} USDT</b>\n\n🔗 Your link:\n{link}',
    earn_menu: '💼 <b>EARN (Tasks)</b>\n\nComplete tasks and get USDT!',
    earn_task_1: '📢 Subscribe to Solo_Men Studio',
    earn_success: '✅ <b>Task completed!</b>\n\nYou received <code>{amount} USDT</code>!',
    spin_menu: '🎲 <b>Wheel of Fortune</b>\n\nTry your luck! Spin cost — <b>0.1 USDT</b>.\nWin from 0.01 to 10 USDT!\n\nSpin!',
    spin_win: '🎰 <b>Spinning...</b> 🎰\n\n🎉 <b>JACKPOT!</b> You won <code>{amount} USDT</code>!\n\nBalance: <code>{balance} USDT</code>',
    spin_lose: '🎰 <b>Spinning...</b> 🎰\n\n😢 No luck. Try again!\n\nBalance: <code>{balance} USDT</code>',
    set_nick_ask: '👤 Enter new nickname (max 20 chars):',
    set_nick_success: '✅ New nickname: <b>{nick}</b>'
  }
};

function getMainMenu(hasWallet, lang = 'ru') {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек / Create Wallet', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк / Wallet', callback_data: 'menu_balance' }, { text: '👤 Профиль / Profile', callback_data: 'set_profile' }],
        [{ text: '💳 Пополнить / Deposit', callback_data: 'menu_deposit', style: 'success' }],
        [{ text: '📈 Курсы / Rates', callback_data: 'menu_rates' }, { text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки / Checks', callback_data: 'menu_checks' }, { text: '🎁 Рефералка / Referral', callback_data: 'menu_ref' }],
        [{ text: '💼 EARN', callback_data: 'menu_earn', style: 'primary' }, { text: '⚙️ Настройки / Settings', callback_data: 'menu_settings' }],
        [{ text: 'ℹ️ О SMaster', callback_data: 'menu_about' }]
      ]
    }
  };
}

function getSettingsMenu(lang = 'ru') {
  const t = i18n[lang] || i18n.ru;
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👤 Сменить ник / Change Nick', callback_data: 'set_nick' }, { text: '👁 Отображение / Display', callback_data: 'set_bal' }],
        [{ text: '💱 Валюта / Currency', callback_data: 'set_curr' }, { text: '📊 Лимиты / Limits', callback_data: 'set_limits' }],
        [{ text: '🎲 Колесо Фортуны / Spin', callback_data: 'menu_spin', style: 'success' }],
        [{ text: '📜 История / History', callback_data: 'set_hist' }],
        [{ text: '🔗 Connect Wallet', callback_data: 'set_wallet', style: 'primary' }, { text: '🛡 Безопасность / Security', callback_data: 'set_security' }],
        [{ text: t.cancel, callback_data: 'back_to_menu', style: 'danger' }]
      ]
    }
  };
}

async function getWallet(userId) {
  try {
    const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', String(userId)).limit(1);
    return data && data.length > 0 ? data[0] : null;
  } catch (e) { return null; }
}

async function createWallet(user, referrer_id = null) {
  try {
    const { data } = await supabase.from('smaster_wallets').insert({
      user_id: String(user.id), username: user.username || null, 
      balance_usdt: 0, balance_ton: 0, balance_usdc: 0, balance_gram: 0, balance_sol: 0, balance_trx: 0, 
      balance_eth: 0, balance_btc: 0, balance_bnb: 0, balance_doge: 0, balance_ltc: 0, balance_xaut: 0, balance_ggt: 0,
      language: 'ru', bot_currency: 'USD', referrer_id: referrer_id ? String(referrer_id) : null
    }).select();
    
    if (referrer_id) {
      const ref = await getWallet(referrer_id);
      if (ref) await updateWallet(referrer_id, { ref_count: (Number(ref.ref_count) || 0) + 1 });
    }
    return data && data.length > 0 ? { data: data[0] } : { error: 'Fail' };
  } catch (e) { return { error: e.message }; }
}

async function updateWallet(userId, patch) { 
  await supabase.from('smaster_wallets').update(patch).eq('user_id', String(userId)); 
}

async function logHistory(userId, type, amount, currency) { 
  try { await supabase.from('smaster_history').insert({ user_id: String(userId), type, amount, currency }); } catch (e) {} 
}

function fmt(n, d = 2) { return Number(n || 0).toFixed(d); }

bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '⏳ Загружаю интерфейс...', { reply_markup: { remove_keyboard: true }, parse_mode: 'HTML' });

    let w = await getWallet(msg.from.id);
    const textParts = msg.text.split(' ');
    let referrerId = null;
    if (textParts.length > 1) {
      if (textParts[1].startsWith('ref_')) referrerId = textParts[1].split('_')[1];
      if (textParts[1].startsWith('check_')) return handleClaimCheck(msg, textParts[1].split('_')[1], w);
    }

    if (!w) {
      return bot.sendMessage(chatId, '🇷🇺 Выбери язык / 🇬🇧 Choose your language:', {
        reply_markup: { inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang_ru' }, { text: '🇬🇧 English', callback_data: 'lang_en' }]] }
      });
    }

    const lang = w.language || 'ru';
    await bot.sendMessage(chatId, i18n[lang].welcome.replace('{name}', msg.from.first_name || 'друг'), { ...getMainMenu(true, lang), parse_mode: 'HTML' });
  } catch (e) { console.log('start err:', e.message); }
});

bot.onText(/^\/help/, async (msg) => {
  const w = await getWallet(msg.from.id);
  const lang = w ? (w.language || 'ru') : 'ru';
  await bot.sendMessage(msg.chat.id, i18n[lang].help_text, { ...getMainMenu(!!w, lang), parse_mode: 'HTML' });
});

bot.onText(/^\/admin/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  await bot.sendMessage(msg.chat.id, '👑 <b>Админ-панель SMaster</b>\n\nВыбери действие:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Кол-во юзеров', callback_data: 'adm_users' }],
        [{ text: '💰 Выдать баланс', callback_data: 'adm_give' }],
        [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
        [{ text: '⬅️ В меню', callback_data: 'back_to_menu' }]
      ]
    }, parse_mode: 'HTML'
  });
});bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = String(msg.from.id);
    const state = states.get(userId);
    if (!state) return;

    const w = await getWallet(userId);
    const lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    if (state.type === 'deposit') return handleDepositInput(msg, lang);
    if (state.type === 'check_create_amount') return handleCreateCheckAmount(msg, w, lang);
    if (state.type === 'check_multi_amount') return handleCreateMultiCheck(msg, w, lang);
    if (state.type === 'check_activate_code') return handleClaimCheck(msg, msg.text.trim(), w);
    if (state.type === 'set_wallet_ask') return handleSetWallet(msg, w, lang);
    if (state.type === 'p2p_amount') return handleP2pAmount(msg, lang);
    if (state.type === 'p2p_currency') return handleP2pCurrency(msg, state, lang);
    if (state.type === 'p2p_price') return handleP2pPrice(msg, state, lang);
    
    if (state.type === 'set_nick_input') {
      if (msg.text.length > 20) return bot.sendMessage(msg.chat.id, '❌ Макс 20 символов.');
      await updateWallet(userId, { custom_nick: msg.text });
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, t.set_nick_success.replace('{nick}', msg.text), { ...getSettingsMenu(lang), parse_mode: 'HTML' });
    }
    
    if (state.type === 'adm_give_input') {
      const parts = msg.text.trim().split(' ');
      if (parts.length < 2) return bot.sendMessage(msg.chat.id, '❌ Формат: ID сумма');
      const targetId = parts[0];
      const amount = Number(parts[1].replace(',', '.'));
      const targetW = await getWallet(targetId);
      
      if (!targetW) return bot.sendMessage(msg.chat.id, '❌ Юзер не найден.');
      if (!amount || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Неверная сумма.');
      
      await updateWallet(targetId, { balance_usdt: (Number(targetW.balance_usdt) + amount).toFixed(8) });
      states.delete(userId);
      
      await bot.sendMessage(msg.chat.id, `✅ Выдано <code>${amount} USDT</code> юзеру <code>${targetId}</code>.`, { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
      bot.sendMessage(targetId, `🎁 Начислено <code>${amount} USDT</code> от администрации!`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    
    if (state.type === 'adm_broadcast_input') {
      states.delete(userId);
      const text = msg.text;
      await bot.sendMessage(msg.chat.id, '⏳ Рассылка...');
      
      const { data: users } = await supabase.from('smaster_wallets').select('user_id');
      let success = 0, fail = 0;
      
      for (const u of users) {
        try {
          await bot.sendMessage(u.user_id, text, { parse_mode: 'HTML' });
          success++;
          await new Promise(r => setTimeout(r, 50));
        } catch (e) { fail++; }
      }
      return bot.sendMessage(msg.chat.id, `✅ Дошло: <b>${success}</b>\nЗаблокировали: <b>${fail}</b>`, { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
    }
  } catch (e) { console.log('msg err:', e.message); }
});

bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    
    let w = await getWallet(userId);
    let lang = w ? (w.language || 'ru') : 'ru';
    const t = i18n[lang];

    if (data.startsWith('lang_')) {
      lang = data.split('_')[1];
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      if (!w) { const res = await createWallet(query.from, null); w = res.data; } 
      else { await updateWallet(userId, { language: lang }); }
      return bot.sendMessage(chatId, t.welcome.replace('{name}', query.from.first_name || 'друг'), { ...getMainMenu(true, lang), parse_mode: 'HTML' });
    }

    if (data === 'back_to_menu' || data === 'cancel') {
      states.delete(userId);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.welcome.replace('{name}', query.from.first_name || 'друг'), { ...getMainMenu(!!w, lang), parse_mode: 'HTML' });
    }

    if (data === 'create_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await createWallet(query.from);
      return bot.sendMessage(chatId, '✅ <b>Кошелёк создан! / Wallet created!</b>', { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
    }

    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      let text = t.balance_text
        .replace('{usdt}', fmt(w.balance_usdt, 6)).replace('{usdc}', fmt(w.balance_usdc)).replace('{gram}', fmt(w.balance_gram))
        .replace('{sol}', fmt(w.balance_sol)).replace('{trx}', fmt(w.balance_trx)).replace('{eth}', fmt(w.balance_eth, 4))
        .replace('{btc}', fmt(w.balance_btc, 6)).replace('{bnb}', fmt(w.balance_bnb, 4)).replace('{doge}', fmt(w.balance_doge))
        .replace('{ltc}', fmt(w.balance_ltc, 4)).replace('{xaut}', fmt(w.balance_xaut, 4)).replace('{ggt}', fmt(w.balance_ggt));
      
      const curr = w.bot_currency || 'USD';
      let totalUsd = Number(w.balance_usdt) + (Number(w.balance_ton || 0) * 5.5) + (Number(w.balance_btc) * 65000) + (Number(w.balance_eth) * 3000) + (Number(w.balance_sol) * 150) + (Number(w.balance_usdc) * 1) + (Number(w.balance_bnb) * 600) + (Number(w.balance_trx) * 0.12) + (Number(w.balance_doge) * 0.15) + (Number(w.balance_ltc) * 80) + (Number(w.balance_xaut) * 2400);
      
      if (curr === 'RUB') totalUsd = totalUsd * 90; 
      else if (curr === 'EUR') totalUsd = totalUsd * 0.92; 
      
      text = text.replace('{total}', fmt(totalUsd)).replace('{curr}', curr);
      
      if (w.balance_display_mode === 'hide_zero' && totalUsd === 0) text = t.balance_empty;
      else if (w.balance_display_mode === 'hide_1' && totalUsd < 1) text = `👛 <b>Wallet</b>\n\n🙈 <i>Hidden (below $1).</i>`;
      
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '💳 Пополнить / Deposit', callback_data: 'menu_deposit', style: 'success' }, { text: '🔄 Обновить / Refresh', callback_data: 'menu_balance' }], [{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'set_profile') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const d = w.created_at ? new Date(w.created_at).toLocaleDateString() : 'Unknown';
      const displayName = w.custom_nick ? w.custom_nick : (w.username ? '@' + w.username : 'None');
      const text = t.profile.replace('{id}', w.user_id).replace('{name}', displayName).replace('{lang}', lang.toUpperCase()).replace('{curr}', w.bot_currency || 'USD').replace('{date}', d);
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.settings, { ...getSettingsMenu(lang), parse_mode: 'HTML' });
    }

    if (data === 'set_nick') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'set_nick_input' });
      return bot.sendMessage(chatId, t.set_nick_ask, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_spin') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      if (Number(w.balance_usdt) < 0.1) return bot.sendMessage(chatId, '❌ Need 0.1 USDT!', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      
      let newBalance = Number(w.balance_usdt) - 0.1;
      let winAmount = 0;
      const roll = Math.random();
      if (roll < 0.70) winAmount = 0;
      else if (roll < 0.85) winAmount = 0.05;
      else if (roll < 0.95) winAmount = 0.2;
      else if (roll < 0.99) winAmount = 1.0;
      else winAmount = 10.0;

      newBalance += winAmount;
      await updateWallet(userId, { balance_usdt: newBalance.toFixed(8) });
      if (winAmount > 0) await logHistory(userId, 'win', winAmount, 'USDT');
      
      const text = winAmount > 0 ? t.spin_win.replace('{amount}', fmt(winAmount)).replace('{balance}', fmt(newBalance)) : t.spin_lose.replace('{balance}', fmt(newBalance));
      return bot.sendMessage(chatId, text, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
    }

    if (data === 'set_bal') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const mode = w.balance_display_mode || 'all';
      return bot.sendMessage(chatId, t.balance_settings, { reply_markup: { inline_keyboard: [
        [{ text: `${mode === 'all' ? '✅ ' : ''}${t.bal_all}`, callback_data: 'set_bal_all' }],
        [{ text: `${mode === 'hide_zero' ? '✅ ' : ''}${t.bal_hide_zero}`, callback_data: 'set_bal_zero' }],
        [{ text: `${mode === 'hide_1' ? '✅ ' : ''}${t.bal_hide_1}`, callback_data: 'set_bal_1' }],
        [{ text: t.cancel, callback_data: 'menu_settings' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data === 'set_bal_all') { await updateWallet(userId, { balance_display_mode: 'all' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ OK', getSettingsMenu(lang)); }
    if (data === 'set_bal_zero') { await updateWallet(userId, { balance_display_mode: 'hide_zero' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ OK', getSettingsMenu(lang)); }
    if (data === 'set_bal_1') { await updateWallet(userId, { balance_display_mode: 'hide_1' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ OK', getSettingsMenu(lang)); }    if (data === 'set_curr') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const curr = w.bot_currency || 'USD';
      return bot.sendMessage(chatId, t.bot_currency, { reply_markup: { inline_keyboard: [
        [{ text: `${curr === 'USD' ? '✅ ' : ''}USD $`, callback_data: 'set_curr_USD' }],
        [{ text: `${curr === 'RUB' ? '✅ ' : ''}RUB ₽`, callback_data: 'set_curr_RUB' }],
        [{ text: `${curr === 'EUR' ? '✅ ' : ''}EUR €`, callback_data: 'set_curr_EUR' }],
        [{ text: t.cancel, callback_data: 'menu_settings' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data.startsWith('set_curr_')) {
      const newCurr = data.split('_')[2];
      await updateWallet(userId, { bot_currency: newCurr });
      await bot.deleteMessage(chatId, query.message.message_id);
      return bot.sendMessage(chatId, `✅ ${newCurr}`, { ...getSettingsMenu(lang), parse_mode: 'HTML' });
    }

    if (data === 'set_hist') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.history_menu, { reply_markup: { inline_keyboard: [
        [{ text: '📥 Депозиты / Deposits', callback_data: 'hist_dep' }],
        [{ text: t.cancel, callback_data: 'menu_settings' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data.startsWith('hist_')) {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const type = data.split('_')[1];
      const { data: hist } = await supabase.from('smaster_history').select('*').eq('user_id', userId).eq('type', type).order('created_at', { ascending: false }).limit(10);
      if (!hist || hist.length === 0) return bot.sendMessage(chatId, t.history_empty, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'set_hist' }]] }, parse_mode: 'HTML' });
      
      let text = '📜 <b>History:</b>\n\n';
      for (const h of hist) text += `• <b>${h.type.toUpperCase()}</b>: <code>${fmt(h.amount)} ${h.currency}</code> (${new Date(h.created_at).toLocaleString()})\n`;
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'set_hist' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'set_limits') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, t.limits_menu, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' }); }
    if (data === 'set_security') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '🛡 <b>Security</b>', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' }); }

    if (data === 'set_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const curAddr = w.linked_ton_wallet || 'None';
      return bot.sendMessage(chatId, t.connect_wallet.replace('{wallet}', curAddr), { reply_markup: { inline_keyboard: [[{ text: '🔗 Link / Change', callback_data: 'ask_wallet', style: 'primary' }], [{ text: t.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'ask_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'set_wallet_ask' });
      return bot.sendMessage(chatId, t.ask_wallet_addr, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const me = await bot.getMe();
      const link = `https://t.me/${me.username}?start=ref_${userId}`;
      const count = w.ref_count || 0;
      const earned = fmt(w.ref_earned || 0);
      const text = t.ref_menu.replace('{count}', count).replace('{earned}', earned).replace('{link}', link);
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '📤 Share', url: `https://t.me/share/url?url=${link}&text=Join SMaster!`, style: 'primary' }], [{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_earn') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.earn_menu, { reply_markup: { inline_keyboard: [[{ text: t.earn_task_1, url: 'https://t.me/Solo_Men_Studio' }], [{ text: '✅ Check (+0.1 USDT)', callback_data: 'earn_check_sub' }], [{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'earn_check_sub') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      try {
        const chatMember = await bot.getChatMember('@Solo_Men_Studio', userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          return bot.sendMessage(chatId, '❌ Subscribe to channel first!', { reply_markup: { inline_keyboard: [[{ text: '📢 Subscribe', url: 'https://t.me/Solo_Men_Studio' }], [{ text: '✅ Check', callback_data: 'earn_check_sub' }], [{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
        }
        const { data: hist } = await supabase.from('smaster_history').select('*').eq('user_id', userId).eq('type', 'earn').limit(1);
        if (hist && hist.length > 0) return bot.sendMessage(chatId, '⚠️ Already claimed!', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
        
        await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + 0.1).toFixed(8) });
        await logHistory(userId, 'earn', 0.1, 'USDT');
        return bot.sendMessage(chatId, t.earn_success.replace('{amount}', '0.1'), { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      } catch (e) { return bot.sendMessage(chatId, '❌ Bot not admin in channel.', { ...getMainMenu(true, lang), parse_mode: 'HTML' }); }
    }

    if (data === 'menu_about') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.about, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'deposit' });
      return bot.sendMessage(chatId, t.deposit_ask, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_rates') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const temp = await bot.sendMessage(chatId, '⏳...');
      try {
        const res = await fetch('https://pay.crypt.bot/api/getExchangeRates', { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN } });
        const cbData = await res.json();
        await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
        const usdtTon = cbData.result.find(r => r.source === 'USDT' && r.target === 'TON');
        const tonUsdt = cbData.result.find(r => r.source === 'TON' && r.target === 'USDT');
        const text = `📈 <b>Rates:</b>\n\n• 1 USDT = <code>${fmt(usdtTon?.rate, 4)}</code> TON\n• 1 TON = <code>${fmt(tonUsdt?.rate, 2)}</code> USDT`;
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
      } catch (e) { await bot.sendMessage(chatId, '❌ Error', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
      return;
    }

    // ================= ЧЕКИ =================
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.check_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: t.check_create, callback_data: 'check_create', style: 'success' }],
          [{ text: t.check_create_multi, callback_data: 'check_multi', style: 'success' }],
          [{ text: t.check_my, callback_data: 'check_my' }],
          [{ text: t.check_activate, callback_data: 'check_activate', style: 'primary' }],
          [{ text: t.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data === 'check_create') { await bot.deleteMessage(chatId, query.message.message_id); states.set(userId, { type: 'check_create_amount' }); return bot.sendMessage(chatId, t.check_ask_amount, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
    if (data === 'check_multi') { await bot.deleteMessage(chatId, query.message.message_id); states.set(userId, { type: 'check_multi_amount' }); return bot.sendMessage(chatId, t.check_ask_multi_count, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
    if (data === 'check_activate') { await bot.deleteMessage(chatId, query.message.message_id); states.set(userId, { type: 'check_activate_code' }); return bot.sendMessage(chatId, t.check_ask_code, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
    
    if (data === 'check_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: checks } = await supabase.from('smaster_checks').select('*').eq('creator_id', userId).eq('status', 'active');
      if (!checks || checks.length === 0) return bot.sendMessage(chatId, t.check_list_empty, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_checks' }]] }, parse_mode: 'HTML' });
      let list = '';
      for (const c of checks) list += `• ID: <code>${c.id}</code> | Сумма: <code>${fmt(c.amount)} USDT</code>\n`;
      return bot.sendMessage(chatId, t.check_list.replace('{list}', list), { reply_markup: { inline_keyboard: [[{ text: '❌ Удалить все', callback_data: 'check_delete_all', style: 'danger' }], [{ text: t.cancel, callback_data: 'menu_checks' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'check_delete_all') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: checks } = await supabase.from('smaster_checks').select('*').eq('creator_id', userId).eq('status', 'active');
      if (checks && checks.length > 0) {
        let totalRefund = 0;
        for (const c of checks) totalRefund += Number(c.amount);
        await supabase.from('smaster_checks').update({ status: 'cancelled' }).eq('creator_id', userId).eq('status', 'active');
        await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + totalRefund).toFixed(8) });
        return bot.sendMessage(chatId, `✅ Все чеки удалены! Возвращено: <code>${fmt(totalRefund)} USDT</code>`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      }
    }

    // ================= P2P МАРКЕТ =================
    if (data === 'menu_p2p') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, t.p2p_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: '💠 P2P Market', callback_data: 'p2p_open', style: 'primary' }],
          [{ text: '📈 Buy', callback_data: 'p2p_buy' }, { text: '📉 Sell', callback_data: 'p2p_create' }],
          [{ text: '🤝 My deals', callback_data: 'p2p_my' }],
          [{ text: '🏷 Create Ad', callback_data: 'p2p_create' }],
          [{ text: '⚙️ Payment & Currency', callback_data: 'p2p_settings' }],
          [{ text: '👤 Profile', callback_data: 'set_profile' }],
          [{ text: t.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data === 'p2p_settings') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '⚙️ <b>Settings</b>\n\nIn development.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' }); }
    if (data === 'p2p_open') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '💠 <b>Welcome to P2P Market!</b>', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' }); }
    if (data === 'p2p_create') { await bot.deleteMessage(chatId, query.message.message_id); states.set(userId, { type: 'p2p_amount' }); return bot.sendMessage(chatId, '➕ How much USDT to sell?', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
    
    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', userId).limit(10);
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 No active ads.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      buttons.push([{ text: t.cancel, callback_data: 'menu_p2p' }]);
      return bot.sendMessage(chatId, '🛒 Choose ad:', { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Unavailable.', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      const total = Number(ad.amount) * Number(ad.price);
      return bot.sendMessage(chatId, `📢 <b>Ad #${ad.id}</b>\n\nSeller: @${ad.seller_username || 'id'+ad.seller_id}\nUSDT: <code>${ad.amount}</code>\nPrice: <code>${ad.price} ${ad.currency}</code>\nTotal: <code>${fmt(total)} ${ad.currency}</code>`, { reply_markup: { inline_keyboard: [[{ text: '✅ Buy', callback_data: `p2p_buy_${ad.id}`, style: 'success' }], [{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Unavailable.', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      const amount = Number(ad.amount);
      const total = amount * Number(ad.price);
      if (ad.currency === 'RUB') return bot.sendMessage(chatId, `💬 Contact @${ad.seller_username || 'id'+ad.seller_id}\n\nSend ${fmt(total)} RUB.`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      
      const seller = await getWallet(ad.seller_id);
      if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, `❌ Need <code>${fmt(total)} TON</code>.`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: userId }).eq('id', ad.id);
      await logHistory(userId, 'p2p_in', amount, 'USDT');
      await logHistory(ad.seller_id, 'p2p_out', amount, 'USDT');
      
      await bot.sendMessage(chatId, `✅ <b>Deal #${ad.id} completed!</b>\n\n+<code>${amount} USDT</code>\n−<code>${fmt(total)} TON</code>`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
      bot.sendMessage(ad.seller_id, `✅ Your ad #${ad.id} bought!\n\n−<code>${amount} USDT</code>\n+<code>${fmt(total)} TON</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
    if (data === 'p2p_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('seller_id', userId).eq('status', 'active');
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🤝 No active deals.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
      for (const ad of ads) {
        await bot.sendMessage(chatId, `🤝 #${ad.id}\nUSDT: ${ad.amount}\nPrice: ${ad.price} ${ad.currency}`, { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `p2p_cancel_${ad.id}`, style: 'danger' }]] }, parse_mode: 'HTML' });
      }
      return bot.sendMessage(chatId, '⬆️ Your ads.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_cancel_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', id).eq('seller_id', userId);
      return bot.sendMessage(chatId, `✅ Ad #${id} cancelled.`, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }

    // --- АДМИНКА ---
    if (data === 'adm_users') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { count } = await supabase.from('smaster_wallets').select('*', { count: 'exact', head: true });
      return bot.sendMessage(chatId, `👥 Users: <b>${count || 0}</b>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_give') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_give_input' });
      return bot.sendMessage(chatId, '💰 Enter ID and amount (e.g. <code>8447147405 10</code>):', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'adm_broadcast') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_broadcast_input' });
      return bot.sendMessage(chatId, '📢 Enter broadcast text:', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

  } catch (e) { console.log('cb err:', e.message); }
});

async function handleDepositInput(msg, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Enter number.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  states.delete(String(msg.from.id));
  const temp = await bot.sendMessage(chatId, '⏳...');
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', amount: String(amount), description: `Deposit #${msg.from.id}`, payload: String(msg.from.id), allow_comments: false, allow_anonymous: false, expires_in: 3600 })
    });
    const data = await res.json();
    await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
    if (!data.ok) return bot.sendMessage(chatId, '❌ CryptoBot Error.', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `💳 <b>Invoice for ${amount} USDT!</b>\n\nPay: ${data.result.bot_invoice_url}`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
  } catch (e) { await bot.deleteMessage(chatId, temp.message_id).catch(() => {}); await bot.sendMessage(chatId, '❌ Error.', { ...getMainMenu(true, lang), parse_mode: 'HTML' }); }
}

async function handleSetWallet(msg, w, lang) {
  const chatId = msg.chat.id;
  const t = i18n[lang];
  const addr = msg.text.trim();
  if (addr.toLowerCase() === 'удалить' || addr.toLowerCase() === 'delete') {
    await updateWallet(String(msg.from.id), { linked_ton_wallet: null });
    states.delete(String(msg.from.id));
    return bot.sendMessage(chatId, '✅ Unlinked.', getSettingsMenu(lang));
  }
  if (addr.length < 48) return bot.sendMessage(chatId, '❌ Invalid address.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  await updateWallet(String(msg.from.id), { linked_ton_wallet: addr });
  states.delete(String(msg.from.id));
  await bot.sendMessage(chatId, t.wallet_linked.replace('{addr}', addr), getSettingsMenu(lang));
}

async function handleCreateCheckAmount(msg, w, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Enter number.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (Number(w.balance_usdt) < amount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, '❌ Low balance!', { ...getMainMenu(true, lang), parse_mode: 'HTML' }); }
  
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
  const { data } = await supabase.from('smaster_checks').insert({ creator_id: String(msg.from.id), amount: amount, status: 'active' }).select();
  states.delete(String(msg.from.id));
  
  const me = await bot.getMe();
  const link = `https://t.me/${me.username}?start=check_${data[0].id}`;
  
  await bot.sendPhoto(chatId, 'https://placehold.co/600x350/1c1c1e/ffffff?text=SMaster+Check%0A%0A' + amount + '+USDT', {
    caption: t.check_success.replace('{amount}', fmt(amount)).replace('{link}', link),
    parse_mode: 'HTML',
    ...getMainMenu(true, lang)
  });
}

async function handleCreateMultiCheck(msg, w, lang) {
  const chatId = msg.chat.id;
  const parts = msg.text.trim().split(' ');
  const t = i18n[lang];
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Format: amount count.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  
  const totalAmount = Number(parts[0].replace(',', '.'));
  const count = parseInt(parts[1]);
  if (!totalAmount || !count || totalAmount <= 0 || count <= 0 || count > 20) return bot.sendMessage(chatId, '❌ Invalid data (max 20 checks).', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (Number(w.balance_usdt) < totalAmount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, '❌ Low balance!', { ...getMainMenu(true, lang), parse_mode: 'HTML' }); }
  
  const amountPerCheck = totalAmount / count;
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) - totalAmount).toFixed(8) });
  
  let links = '';
  for (let i = 0; i < count; i++) {
    const { data } = await supabase.from('smaster_checks').insert({ creator_id: String(msg.from.id), amount: amountPerCheck, status: 'active' }).select();
    if (data) links += `https://t.me/${(await bot.getMe()).username}?start=check_${data[0].id}\n`;
  }
  states.delete(String(msg.from.id));
  await bot.sendMessage(chatId, t.check_multi_success.replace('{count}', count).replace('{amount}', fmt(amountPerCheck)).replace('{links}', links), { ...getMainMenu(true, lang), parse_mode: 'HTML' });
}

async function handleClaimCheck(msg, checkId, w) {
  const chatId = msg.chat.id;
  const w2 = await getWallet(msg.from.id);
  if (!w2) return bot.sendMessage(chatId, '🇷🇺 Сначала нажми /start!');
  
  const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(checkId)).limit(1);
  const check = arr && arr.length > 0 ? arr[0] : null;
  if (!check || check.status !== 'active') return bot.sendMessage(chatId, '❌ Check not found.', { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
  if (String(check.creator_id) === String(msg.from.id)) return bot.sendMessage(chatId, '❌ You cannot activate your own check.', { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
  
  await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: String(msg.from.id) }).eq('id', check.id);
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w2.balance_usdt) + Number(check.amount)).toFixed(8) });
  await logHistory(String(msg.from.id), 'dep', Number(check.amount), 'USDT');
  await bot.sendMessage(chatId, `🎉 <b>Check activated!</b>\n\nBalance: <code>${fmt(check.amount)} USDT</code>!`, { ...getMainMenu(true, 'ru'), parse_mode: 'HTML' });
}

async function handleP2pAmount(msg, lang) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Enter number.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  states.set(String(msg.from.id), { type: 'p2p_currency', amount });
  await bot.sendMessage(chatId, 'Currency: TON or RUB', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
}

async function handleP2pCurrency(msg, state, lang) {
  const chatId = msg.chat.id;
  const cur = msg.text.toUpperCase();
  const t = i18n[lang];
  if (cur !== 'TON' && cur !== 'RUB') return bot.sendMessage(chatId, '❌ Type TON or RUB.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  states.set(String(msg.from.id), { ...state, type: 'p2p_price', currency: cur });
  await bot.sendMessage(chatId, `Price per 1 USDT in ${cur}?`, { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
}

async function handleP2pPrice(msg, state, lang) {
  const chatId = msg.chat.id;
  const price = Number(msg.text.replace(',', '.'));
  const t = i18n[lang];
  if (!price || price <= 0) return bot.sendMessage(chatId, '❌ Enter price.', { reply_markup: { inline_keyboard: [[{ text: t.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  
  const w = await getWallet(String(msg.from.id));
  if (Number(w.balance_usdt) < state.amount) {
    states.delete(String(msg.from.id));
    return bot.sendMessage(chatId, '❌ Low balance.', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
  }
  
  const { data, error } = await supabase.from('smaster_p2p_ads').insert({ seller_id: String(msg.from.id), seller_username: msg.from.username || null, amount: state.amount, price: price, currency: state.currency }).select();
  states.delete(String(msg.from.id));
  if (error) return bot.sendMessage(chatId, '❌ Error.', { ...getMainMenu(true, lang), parse_mode: 'HTML' });
  await bot.sendMessage(chatId, `✅ Ad #${data[0].id} created!\n\nSelling: ${state.amount} USDT\nPrice: ${price} ${state.currency}`, { ...getMainMenu(true, lang), parse_mode: 'HTML' });
}

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
          await logHistory(userId, 'dep', amount, 'USDT');
          bot.sendMessage(userId, `✅ <b>Deposit!</b>\n\n+<code>${amount} USDT</code>`, { parse_mode: 'HTML' }).catch(() => {});
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
