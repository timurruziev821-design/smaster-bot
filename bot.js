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

const FEE_PERCENT = 0.01; 
const MIN_FEE = 0.1;      
const SWAP_FEE = 0.02;    
const REF_BONUS = 0.05;   

const i18n = {
  ru: {
    welcome: '<b>Привет, {name}! 👋</b>\n\nДобро пожаловать в <b>SMaster</b> — твой премиальный крипто-кошелек.\n\n⚡️ Мгновенные переводы\n💎 Обмен по лучшему курсу\n🎲 Собственный P2P Маркет\n\n<i>Выбери действие в меню ниже:</i>',
    balance_text: '👛 <b>Мой кошелёк</b>\n\n🪙 Tether: <code>{usdt}</code> USDT\n🪙 USD Coin: <code>{usdc}</code> USDC\n🪙 Gram: <code>{gram}</code> GRAM\n🪙 Solana: <code>{sol}</code> SOL\n🪙 TRON: <code>{trx}</code> TRX\n🪙 Ethereum: <code>{eth}</code> ETH\n🪙 Bitcoin: <code>{btc}</code> BTC\n🪙 Binance Coin: <code>{bnb}</code> BNB\n🪙 Dogecoin: <code>{doge}</code> DOGE\n🪙 Litecoin: <code>{ltc}</code> LTC\n🪙 Tether Gold: <code>{xaut}</code> XAUT\n🪙 GGT: <code>{ggt}</code> GGT\n\n≈ <b>{total} {curr}</b>\n\n<i>Чтобы настроить отображение, нажми на кнопку "Настройки"</i>',
    balance_empty: '👛 <b>Мой кошелёк</b>\n\n💰 <i>Баланс пуст.</i>\nПополни счет, чтобы начать!',
    deposit_ask: '💳 <b>Пополнение</b>\n\nВведи сумму в USDT (например, <code>5</code>):',
    withdraw_ask_addr: '📥 <b>Вывод средств</b>\n\nВведи адрес твоего TON-кошелька:',
    withdraw_ask_amt: '📥 Адрес: <code>{addr}</code>\n\nСколько <b>TON</b> хочешь вывести?',
    withdraw_success: '✅ <b>Заявка создана!</b>\n\nСумма: <code>{amount} TON</code>\nСредства поступят в течение 24 часов.',
    transfer_ask_recipient: '📤 <b>Перевод</b>\n\nКому перевести? Напиши <b>ID</b> или <b>@username</b>.\n\n<i>Комиссия: 1% (мин. 0.1 USDT)</i>',
    transfer_ask_amount: '📤 Получатель: <b>{to}</b>\n\nСколько USDT перевести?',
    transfer_success: '✅ <b>Успешно!</b>\n\nПереведено: <code>{amount} USDT</code>\nКомиссия: <code>{fee} USDT</code>\nКому: <b>{to}</b>',
    transfer_received: '💸 <b>Входящий перевод!</b>\n\nТебе пришло: <code>{amount} USDT</code>\nОт: <b>{from}</b>',
    low_balance: '❌ <b>Недостаточно средств!</b>',
    swap_menu: '💱 <b>Обмен валют</b>\n\nВыбери направление:\n<i>(Комиссия сервиса: 2%)</i>',
    swap_ask_amount: '💱 Введи сумму <b>{currency}</b> для обмена:',
    swap_success: '✅ <b>Обмен успешен!</b>\n\nТы обменял: <code>{amount} {from}</code>\nПолучил: <code>{to_amount} {to}</code>\nКомиссия: <code>{fee} {from}</code>',
    p2p_menu: '💠 <b>Здесь вы можете купить или продать криптовалюту переводом на карту или электронный кошелёк.</b>\n\n<a href="https://t.me/Solo_Men_Studio">Смотреть видеоинструкцию ></a>',
    check_menu: '🧾 <b>Чеки SMaster</b>\n\nСоздай чек и отправь ссылку другу. Он сможет забрать крипту себе.',
    settings: '⚙️ <b>Настройки</b>\n\nУправляй своим аккаунтом и приложением:',
    profile: '👤 <b>Мой профиль</b>\n\n🆔 ID: <code>{id}</code>\n👤 Имя: {name}\n🌐 Язык: {lang}\n💱 Валюта: {curr}\n📅 В системе с: {date}\n\n🛡 Статус: <b>Verified</b>',
    balance_settings: '👁 <b>Настройки баланса</b>\n\nКак отображать твои активы?',
    bal_all: 'Показывать все', bal_hide_zero: 'Скрывать нули', bal_hide_1: 'Скрывать ниже $1',
    bot_currency: '💱 <b>Валюта отображения</b>\n\nВ какой валюте показывать общую стоимость?',
    history_menu: '📜 <b>История действий</b>\n\nВыбери нужный раздел:',
    history_empty: '📭 <i>История пуста.</i>',
    limits_menu: '📊 <b>Лимиты и комиссии</b>\n\n• Перевод: <code>1% (мин. 0.1 USDT)</code>\n• Обмен: <code>2%</code>\n• Вывод TON: <code>0%</code>\n• Пополнение: <code>0%</code>\n• P2P: <code>0%</code>',
    connect_wallet: '🔗 <b>Привязка кошелька</b>\n\nПривяжи TON-кошелек для восстановления доступа.\n\nТекущий: <code>{wallet}</code>',
    ask_wallet_addr: '🔗 Отправь адрес TON-кошелька (или напиши <code>удалить</code>):',
    wallet_linked: '✅ Кошелёк <code>{addr}</code> привязан!',
    about: 'ℹ️ <b>О SMaster</b>\n\nSMaster — это экосистема для управления криптоактивами внутри Telegram.\n\n🚀 <b>Наши фишки:</b>\n• Мгновенные переводы без границ\n• Выгодный Swap\n• P2P Маркет без комиссий\n• Подарочные чеки\n\n👨‍💻 <b>Основатель:</b> @Solo_Men\n💡 <i>Мы делаем крипту простой и доступной.</i>',
    support: '👨‍💻 <b>Поддержка</b>\n\nВозникли вопросы? Пиши нашему менеджеру: @TonRocketSupportBot',
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
  }
};

function getMainMenu(hasWallet) {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }, { text: '👤 Профиль', callback_data: 'set_profile' }],
        [{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '📥 Вывести', callback_data: 'menu_withdraw', style: 'danger' }],
        [{ text: '📤 Перевести', callback_data: 'menu_transfer' }, { text: '💱 Обмен', callback_data: 'menu_swap', style: 'primary' }],
        [{ text: '📈 Курсы', callback_data: 'menu_rates' }, { text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '🎁 Рефералка', callback_data: 'menu_ref' }],
        [{ text: '💼 EARN', callback_data: 'menu_earn', style: 'primary' }, { text: '⚙️ Настройки', callback_data: 'menu_settings' }],
        [{ text: 'ℹ️ О SMaster', callback_data: 'menu_about' }]
      ]
    }
  };
}

function getSettingsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👤 Сменить ник', callback_data: 'set_nick' }, { text: '👁 Отображение', callback_data: 'set_bal' }],
        [{ text: '💱 Валюта бота', callback_data: 'set_curr' }, { text: '📊 Лимиты', callback_data: 'set_limits' }],
        [{ text: '🎲 Колесо Фортуны', callback_data: 'menu_spin', style: 'success' }],
        [{ text: '📜 История действий', callback_data: 'set_hist' }],
        [{ text: '🔗 Connect Wallet', callback_data: 'set_wallet', style: 'primary' }, { text: '🛡 Безопасность', callback_data: 'set_security' }],
        [{ text: '⬅️ Назад в меню', callback_data: 'back_to_menu', style: 'danger' }]
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
      const res = await createWallet(msg.from, referrerId);
      w = res.data;
    }

    await bot.sendMessage(chatId, i18n.ru.welcome.replace('{name}', msg.from.first_name || 'друг'), { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { console.log('start err:', e.message); }
});

// АДМИНКА
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
});

bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = String(msg.from.id);
    const state = states.get(userId);
    if (!state) return;

    const w = await getWallet(userId);
    if (state.type === 'deposit') return handleDepositInput(msg);
    if (state.type === 'withdraw_addr') return handleWithdrawAddr(msg);
    if (state.type === 'withdraw_amt') return handleWithdrawAmt(msg, state, w);
    if (state.type === 'transfer_recipient') return handleTransferRecipient(msg);
    if (state.type === 'transfer_amount') return handleTransferAmount(msg, state, w);
    if (state.type === 'swap_amount') return handleSwapAmount(msg, state, w);
    if (state.type === 'check_create_amount') return handleCreateCheckAmount(msg, w);
    if (state.type === 'check_multi_amount') return handleCreateMultiCheck(msg, w);
    if (state.type === 'check_activate_code') return handleClaimCheck(msg, msg.text.trim(), w);
    if (state.type === 'set_wallet_ask') return handleSetWallet(msg, w);
    if (state.type === 'set_nick_input') {
      if (msg.text.length > 20) return bot.sendMessage(msg.chat.id, '❌ Ник слишком длинный (макс 20 символов).');
      await updateWallet(userId, { custom_nick: msg.text });
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, i18n.ru.set_nick_success.replace('{nick}', msg.text), { ...getSettingsMenu(), parse_mode: 'HTML' });
    }
    if (state.type === 'adm_give_input') {
      const parts = msg.text.trim().split(' ');
      if (parts.length < 2) return bot.sendMessage(msg.chat.id, '❌ Формат: ID сумма');
      const targetId = parts[0];
      const amount = Number(parts[1].replace(',', '.'));
      const targetW = await getWallet(targetId);
      
      if (!targetW) return bot.sendMessage(msg.chat.id, '❌ Юзер с таким ID не найден.');
      if (!amount || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Неверная сумма.');
      
      await updateWallet(targetId, { balance_usdt: (Number(targetW.balance_usdt) + amount).toFixed(8) });
      states.delete(userId);
      
      await bot.sendMessage(msg.chat.id, `✅ Успешно выдано <code>${amount} USDT</code> юзеру <code>${targetId}</code>.`, { ...getMainMenu(true), parse_mode: 'HTML' });
      bot.sendMessage(targetId, `🎁 Тебе начислено <code>${amount} USDT</code> от администрации!`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    if (state.type === 'adm_broadcast_input') {
      states.delete(userId);
      const text = msg.text;
      await bot.sendMessage(msg.chat.id, '⏳ Начинаю рассылку...');
      
      const { data: users } = await supabase.from('smaster_wallets').select('user_id');
      let success = 0, fail = 0;
      
      for (const u of users) {
        try {
          await bot.sendMessage(u.user_id, text, { parse_mode: 'HTML' });
          success++;
          await new Promise(r => setTimeout(r, 50));
        } catch (e) { fail++; }
      }
      
      await bot.sendMessage(msg.chat.id, `✅ Рассылка завершена!\n\nДошло: <b>${success}</b>\nЗаблокировали бота: <b>${fail}</b>`, { ...getMainMenu(true), parse_mode: 'HTML' });
      return;
    }
  } catch (e) { console.log('msg err:', e.message); }
});bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    let w = await getWallet(userId);

    if (data === 'create_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await createWallet(query.from);
      return bot.sendMessage(chatId, '✅ <b>Кошелёк успешно создан!</b>', { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    if (data === 'back_to_menu' || data === 'cancel') {
      states.delete(userId);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.welcome.replace('{name}', query.from.first_name || 'друг'), { ...getMainMenu(!!w), parse_mode: 'HTML' });
    }

    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      
      let text = i18n.ru.balance_text
        .replace('{usdt}', fmt(w.balance_usdt, 6)).replace('{usdc}', fmt(w.balance_usdc)).replace('{gram}', fmt(w.balance_gram))
        .replace('{sol}', fmt(w.balance_sol)).replace('{trx}', fmt(w.balance_trx)).replace('{eth}', fmt(w.balance_eth, 4))
        .replace('{btc}', fmt(w.balance_btc, 6)).replace('{bnb}', fmt(w.balance_bnb, 4)).replace('{doge}', fmt(w.balance_doge))
        .replace('{ltc}', fmt(w.balance_ltc, 4)).replace('{xaut}', fmt(w.balance_xaut, 4)).replace('{ggt}', fmt(w.balance_ggt));
      
      const curr = w.bot_currency || 'USD';
      let totalUsd = Number(w.balance_usdt) + (Number(w.balance_ton || 0) * 5.5) + (Number(w.balance_btc) * 65000) + 
                     (Number(w.balance_eth) * 3000) + (Number(w.balance_sol) * 150) + (Number(w.balance_usdc) * 1) +
                     (Number(w.balance_bnb) * 600) + (Number(w.balance_trx) * 0.12) + (Number(w.balance_doge) * 0.15) +
                     (Number(w.balance_ltc) * 80) + (Number(w.balance_xaut) * 2400);
      
      if (curr === 'RUB') totalUsd = totalUsd * 90; 
      else if (curr === 'EUR') totalUsd = totalUsd * 0.92; 
      
      text = text.replace('{total}', fmt(totalUsd)).replace('{curr}', curr);
      
      if (w.balance_display_mode === 'hide_zero' && totalUsd === 0) text = i18n.ru.balance_empty;
      else if (w.balance_display_mode === 'hide_1' && totalUsd < 1) text = `👛 <b>Мой кошелёк</b>\n\n🙈 <i>Баланс скрыт по настройкам (меньше 1 ${curr}).</i>`;
      
      return bot.sendMessage(chatId, text, { 
        reply_markup: { inline_keyboard: [
          [{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '🔄 Обновить', callback_data: 'menu_balance' }],
          [{ text: '⚙️ Настройки', callback_data: 'set_bal' }],
          [{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML' 
      });
    }

    if (data === 'set_profile') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const d = w.created_at ? new Date(w.created_at).toLocaleDateString() : 'Неизвестно';
      const displayName = w.custom_nick ? w.custom_nick : (w.username ? '@' + w.username : 'None');
      const text = i18n.ru.profile.replace('{id}', w.user_id).replace('{name}', displayName).replace('{lang}', 'RU').replace('{curr}', w.bot_currency || 'USD').replace('{date}', d);
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.settings, { ...getSettingsMenu(), parse_mode: 'HTML' });
    }

    if (data === 'set_nick') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'set_nick_input' });
      return bot.sendMessage(chatId, i18n.ru.set_nick_ask, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_spin') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      if (Number(w.balance_usdt) < 0.1) return bot.sendMessage(chatId, '❌ Нужно минимум 0.1 USDT для спина!', { ...getMainMenu(true), parse_mode: 'HTML' });
      
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
      
      const text = winAmount > 0 
        ? i18n.ru.spin_win.replace('{amount}', fmt(winAmount)).replace('{balance}', fmt(newBalance))
        : i18n.ru.spin_lose.replace('{balance}', fmt(newBalance));
        
      return bot.sendMessage(chatId, text, { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    if (data === 'set_bal') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const mode = w.balance_display_mode || 'all';
      return bot.sendMessage(chatId, i18n.ru.balance_settings, {
        reply_markup: { inline_keyboard: [
          [{ text: `${mode === 'all' ? '✅ ' : ''}${i18n.ru.bal_all}`, callback_data: 'set_bal_all' }],
          [{ text: `${mode === 'hide_zero' ? '✅ ' : ''}${i18n.ru.bal_hide_zero}`, callback_data: 'set_bal_zero' }],
          [{ text: `${mode === 'hide_1' ? '✅ ' : ''}${i18n.ru.bal_hide_1}`, callback_data: 'set_bal_1' }],
          [{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data === 'set_bal_all') { await updateWallet(userId, { balance_display_mode: 'all' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ Обновлено.', getSettingsMenu()); }
    if (data === 'set_bal_zero') { await updateWallet(userId, { balance_display_mode: 'hide_zero' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ Обновлено.', getSettingsMenu()); }
    if (data === 'set_bal_1') { await updateWallet(userId, { balance_display_mode: 'hide_1' }); await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '✅ Обновлено.', getSettingsMenu()); }

    if (data === 'set_curr') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const curr = w.bot_currency || 'USD';
      return bot.sendMessage(chatId, i18n.ru.bot_currency, {
        reply_markup: { inline_keyboard: [
          [{ text: `${curr === 'USD' ? '✅ ' : ''}USD $`, callback_data: 'set_curr_USD' }],
          [{ text: `${curr === 'RUB' ? '✅ ' : ''}RUB ₽`, callback_data: 'set_curr_RUB' }],
          [{ text: `${curr === 'EUR' ? '✅ ' : ''}EUR €`, callback_data: 'set_curr_EUR' }],
          [{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data.startsWith('set_curr_')) {
      const newCurr = data.split('_')[2];
      await updateWallet(userId, { bot_currency: newCurr });
      await bot.deleteMessage(chatId, query.message.message_id);
      return bot.sendMessage(chatId, `✅ Валюта изменена на <b>${newCurr}</b>`, { ...getSettingsMenu(), parse_mode: 'HTML' });
    }

    if (data === 'set_hist') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.history_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: '📥 Депозиты', callback_data: 'hist_dep' }, { text: '📤 Переводы', callback_data: 'hist_tr' }],
          [{ text: '📥 Выводы', callback_data: 'hist_wd' }, { text: '💱 Обмены', callback_data: 'hist_swap' }],
          [{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data.startsWith('hist_')) {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const type = data.split('_')[1];
      const { data: hist } = await supabase.from('smaster_history').select('*').eq('user_id', userId).eq('type', type).order('created_at', { ascending: false }).limit(10);
      if (!hist || hist.length === 0) return bot.sendMessage(chatId, i18n.ru.history_empty, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'set_hist' }]] }, parse_mode: 'HTML' });
      
      let text = '📜 <b>История операций:</b>\n\n';
      for (const h of hist) text += `• <b>${h.type.toUpperCase()}</b>: <code>${fmt(h.amount)} ${h.currency}</code> (${new Date(h.created_at).toLocaleString()})\n`;
      return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'set_hist' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'set_limits') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, i18n.ru.limits_menu, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' }); }
    if (data === 'set_security') { await bot.deleteMessage(chatId, query.message.message_id); return bot.sendMessage(chatId, '🛡 <b>Безопасность</b>\n\nТвой аккаунт защищен шифрованием Telegram.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' }); }

    if (data === 'set_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const curAddr = w.linked_ton_wallet || 'Не привязан';
      return bot.sendMessage(chatId, i18n.ru.connect_wallet.replace('{wallet}', curAddr), {
        reply_markup: { inline_keyboard: [[{ text: '🔗 Привязать / Изменить', callback_data: 'ask_wallet', style: 'primary' }], [{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML'
      });
    }
    if (data === 'ask_wallet') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'set_wallet_ask' });
      return bot.sendMessage(chatId, i18n.ru.ask_wallet_addr, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_settings' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_ref') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const me = await bot.getMe();
      const link = `https://t.me/${me.username}?start=ref_${userId}`;
      const count = w.ref_count || 0;
      const earned = fmt(w.ref_earned || 0);
      const text = i18n.ru.ref_menu.replace('{count}', count).replace('{earned}', earned).replace('{link}', link);
      return bot.sendMessage(chatId, text, { 
        reply_markup: { inline_keyboard: [
          [{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${link}&text=Залетай в SMaster!`, style: 'primary' }],
          [{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML' 
      });
    }

    if (data === 'menu_earn') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.earn_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: i18n.ru.earn_task_1, url: 'https://t.me/Solo_Men_Studio' }],
          [{ text: '✅ Проверить подписку (+0.1 USDT)', callback_data: 'earn_check_sub' }],
          [{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data === 'earn_check_sub') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      try {
        const chatMember = await bot.getChatMember('@Solo_Men_Studio', userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          return bot.sendMessage(chatId, '❌ Ты не подписан на канал <b>Solo_Men Studio</b>!\n\nПодпишись и попробуй снова.', {
            reply_markup: { inline_keyboard: [
              [{ text: '📢 Подписаться', url: 'https://t.me/Solo_Men_Studio' }],
              [{ text: '✅ Проверить еще раз', callback_data: 'earn_check_sub' }],
              [{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]
            ]}, parse_mode: 'HTML'
          });
        }
        
        const { data: hist } = await supabase.from('smaster_history').select('*').eq('user_id', userId).eq('type', 'earn').limit(1);
        if (hist && hist.length > 0) {
          return bot.sendMessage(chatId, '⚠️ Ты уже получал награду за это задание!', { ...getMainMenu(true), parse_mode: 'HTML' });
        }
        
        await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + 0.1).toFixed(8) });
        await logHistory(userId, 'earn', 0.1, 'USDT');
        return bot.sendMessage(chatId, i18n.ru.earn_success.replace('{amount}', '0.1'), { ...getMainMenu(true), parse_mode: 'HTML' });
      } catch (e) {
        console.log('Earn error:', e.message);
        return bot.sendMessage(chatId, '❌ Ошибка проверки. Убедись, что бот добавлен в админы канала <b>Solo_Men Studio</b>.', { ...getMainMenu(true), parse_mode: 'HTML' });
      }
    }

    if (data === 'menu_about') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.about, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'deposit' });
      return bot.sendMessage(chatId, i18n.ru.deposit_ask, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'withdraw_addr' });
      return bot.sendMessage(chatId, i18n.ru.withdraw_ask_addr, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_transfer') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'transfer_recipient' });
      return bot.sendMessage(chatId, i18n.ru.transfer_ask_recipient, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
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
        const text = `📈 <b>Актуальные курсы:</b>\n\n• 1 USDT = <code>${fmt(usdtTon?.rate, 4)}</code> TON\n• 1 TON = <code>${fmt(tonUsdt?.rate, 2)}</code> USDT`;
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
      } catch (e) { await bot.sendMessage(chatId, '❌ Ошибка загрузки курсов.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
      return;
    }

    if (data === 'menu_swap') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.swap_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: '💵 USDT ➡️ TON', callback_data: 'swap_usdt_ton' }],
          [{ text: '💎 TON ➡️ USDT', callback_data: 'swap_ton_usdt' }],
          [{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML'
      });
    }
    if (data === 'swap_usdt_ton' || data === 'swap_ton_usdt') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const from = data === 'swap_usdt_ton' ? 'USDT' : 'TON';
      const to = data === 'swap_usdt_ton' ? 'TON' : 'USDT';
      states.set(userId, { type: 'swap_amount', from, to });
      return bot.sendMessage(chatId, i18n.ru.swap_ask_amount.replace('{currency}', from), { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    if (data === 'menu_p2p') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, i18n.ru.p2p_menu, {
        reply_markup: { inline_keyboard: [
          [{ text: '💠 Открыть P2P Маркет', callback_data: 'p2p_open', style: 'primary' }],
          [{ text: '📈 Купить', callback_data: 'p2p_buy' }, { text: '📉 Продать', callback_data: 'p2p_create' }],
          [{ text: '🤝 Мои сделки', callback_data: 'p2p_my' }],
          [{ text: '🏷 Создать объявление', callback_data: 'p2p_create' }],
          [{ text: '⚙️ Оплата и валюта', callback_data: 'p2p_settings' }],
          [{ text: '👤 Мой профиль', callback_data: 'set_profile' }],
          [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
        ]}, parse_mode: 'HTML'
      });
    }
    
    if (data === 'p2p_settings') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⚙️ <b>Оплата и валюта</b>\n\nВ разработке. Скоро вы сможете выбирать валюту P2P-сделок.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    if (data === 'p2p_open') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '💠 <b>Добро пожаловать в P2P Маркет!</b>\n\nЗдесь вы можете безопасно обменивать криптовалюту.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    
    if (data === 'p2p_create') { await bot.deleteMessage(chatId, query.message.message_id); states.set(userId, { type: 'p2p_amount' }); return bot.sendMessage(chatId, '➕ Сколько USDT хочешь продать? Напиши число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' }); }
    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', userId).limit(10);
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 Нет активных объявлений.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      buttons.push([{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]);
      return bot.sendMessage(chatId, '🛒 Выбери объявление:', { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', { ...getMainMenu(true), parse_mode: 'HTML' });
      const total = Number(ad.amount) * Number(ad.price);
      return bot.sendMessage(chatId, `📢 <b>Объявление #${ad.id}</b>\n\nПродавец: @${ad.seller_username || 'id'+ad.seller_id}\nUSDT: <code>${ad.amount}</code>\nЦена: <code>${ad.price} ${ad.currency}</code>\nИтого: <code>${fmt(total)} ${ad.currency}</code>`, { reply_markup: { inline_keyboard: [[{ text: '✅ Купить', callback_data: `p2p_buy_${ad.id}`, style: 'success' }], [{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', { ...getMainMenu(true), parse_mode: 'HTML' });
      const amount = Number(ad.amount);
      const total = amount * Number(ad.price);
      if (ad.currency === 'RUB') return bot.sendMessage(chatId, `💬 Свяжись с @${ad.seller_username || 'id'+ad.seller_id}\n\nПереведи ${fmt(total)} RUB.`, { ...getMainMenu(true), parse_mode: 'HTML' });
      
      const seller = await getWallet(ad.seller_id);
      if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, `❌ Нужно <code>${fmt(total)} TON</code>.`, { ...getMainMenu(true), parse_mode: 'HTML' });
      
      await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: userId }).eq('id', ad.id);
      
      await logHistory(userId, 'p2p_in', amount, 'USDT');
      await logHistory(ad.seller_id, 'p2p_out', amount, 'USDT');
      
      await bot.sendMessage(chatId, `✅ <b>Сделка #${ad.id} завершена!</b>\n\n+<code>${amount} USDT</code>\n−<code>${fmt(total)} TON</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
      bot.sendMessage(ad.seller_id, `✅ Твоё объявление #${ad.id} куплено!\n\n−<code>${amount} USDT</code>\n+<code>${fmt(total)} TON</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
    if (data === 'p2p_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('seller_id', userId).eq('status', 'active');
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🤝 У тебя нет активных сделок.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
      for (const ad of ads) {
        await bot.sendMessage(chatId, `🤝 #${ad.id}\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}`, { reply_markup: { inline_keyboard: [[{ text: '❌ Отменить', callback_data: `p2p_cancel_${ad.id}`, style: 'danger' }]] }, parse_mode: 'HTML' });
      }
      return bot.sendMessage(chatId, '⬆️ Твои активные объявления.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('p2p_cancel_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', id).eq('seller_id', userId);
      return bot.sendMessage(chatId, `✅ Объявление #${id} отменено.`, { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'menu_p2p' }]] }, parse_mode: 'HTML' });
    }

    // --- АДМИНКА КОЛБЭКИ ---
    if (data === 'adm_users') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { count } = await supabase.from('smaster_wallets').select('*', { count: 'exact', head: true });
      return bot.sendMessage(chatId, `👥 Всего пользователей в боте: <b>${count || 0}</b>`, {
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML'
      });
    }
    if (data === 'adm_give') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_give_input' });
      return bot.sendMessage(chatId, '💰 Введи <b>ID</b> юзера и <b>сумму</b> через пробел (например: <code>8447147405 10</code>):', {
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML'
      });
    }
    if (data === 'adm_broadcast') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'adm_broadcast_input' });
      return bot.sendMessage(chatId, '📢 Отправь текст для рассылки всем юзерам:', {
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML'
      });
    }

  } catch (e) { console.log('cb err:', e.message); }
});

async function handleDepositInput(msg) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  states.delete(String(msg.from.id));
  const temp = await bot.sendMessage(chatId, '⏳ Создаю счёт...');
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: 'USDT', amount: String(amount), description: `Deposit #${msg.from.id}`, payload: String(msg.from.id), allow_comments: false, allow_anonymous: false, expires_in: 3600 })
    });
    const data = await res.json();
    await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
    if (!data.ok) return bot.sendMessage(chatId, '❌ Ошибка CryptoBot.', { ...getMainMenu(true), parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `💳 <b>Счёт на ${amount} USDT создан!</b>\n\nОплати по ссылке:\n${data.result.bot_invoice_url}`, { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { await bot.deleteMessage(chatId, temp.message_id).catch(() => {}); await bot.sendMessage(chatId, '❌ Ошибка.', { ...getMainMenu(true), parse_mode: 'HTML' }); }
}

async function handleWithdrawAddr(msg) {
  const chatId = msg.chat.id;
  states.set(String(msg.from.id), { type: 'withdraw_amt', addr: msg.text.trim() });
  await bot.sendMessage(chatId, i18n.ru.withdraw_ask_amt.replace('{addr}', msg.text.trim()), { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
}

async function handleWithdrawAmt(msg, state, w) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (Number(w.balance_ton) < amount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, i18n.ru.low_balance, { ...getMainMenu(true), parse_mode: 'HTML' }); }
  await updateWallet(String(msg.from.id), { balance_ton: (Number(w.balance_ton) - amount).toFixed(8) });
  await logHistory(String(msg.from.id), 'wd', amount, 'TON');
  states.delete(String(msg.from.id));
  await bot.sendMessage(chatId, i18n.ru.withdraw_success.replace('{amount}', fmt(amount)), { ...getMainMenu(true), parse_mode: 'HTML' });
  if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `💸 <b>Заявка на вывод!</b>\nЮзер: <code>${msg.from.id}</code>\nСумма: <code>${amount} TON</code>\nАдрес: <code>${state.addr}</code>`, { parse_mode: 'HTML' }).catch(() => {});
}

async function handleTransferRecipient(msg) {
  const chatId = msg.chat.id;
  const tr = msg.text.trim();
  let recipient = null;
  if (tr.startsWith('@')) {
    const { data } = await supabase.from('smaster_wallets').select('*').ilike('username', tr.slice(1)).limit(1);
    recipient = data && data.length > 0 ? data[0] : null;
  } else {
    const rid = Number(tr);
    if (rid) recipient = await getWallet(rid);
  }
  if (!recipient) return bot.sendMessage(chatId, '❌ Пользователь не найден.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (String(recipient.user_id) === String(msg.from.id)) return bot.sendMessage(chatId, '❌ Нельзя перевести себе.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  states.set(String(msg.from.id), { type: 'transfer_amount', to: recipient.user_id, toName: recipient.username || recipient.user_id });
  await bot.sendMessage(chatId, i18n.ru.transfer_ask_amount.replace('{to}', recipient.username ? '@' + recipient.username : recipient.user_id), { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
}

async function handleTransferAmount(msg, state, w) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  
  let fee = amount * FEE_PERCENT;
  if (fee < MIN_FEE) fee = MIN_FEE;
  const totalDeduct = amount + fee;
  
  if (Number(w.balance_usdt) < totalDeduct) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, i18n.ru.low_balance, { ...getMainMenu(true), parse_mode: 'HTML' }); }
  
  const to = await getWallet(state.to);
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) - totalDeduct).toFixed(8) });
  await updateWallet(state.to, { balance_usdt: (Number(to.balance_usdt) + amount).toFixed(8) });
  
  if (ADMIN_ID && fee > 0) {
    const admin = await getWallet(ADMIN_ID);
    if (admin) await updateWallet(ADMIN_ID, { balance_usdt: (Number(admin.balance_usdt) + fee).toFixed(8) });
  }
  
  if (w.referrer_id) {
    const referrer = await getWallet(w.referrer_id);
    if (referrer) {
      const bonus = fee * REF_BONUS;
      await updateWallet(w.referrer_id, { balance_usdt: (Number(referrer.balance_usdt) + bonus).toFixed(8), ref_earned: (Number(referrer.ref_earned || 0) + bonus).toFixed(8) });
    }
  }
  
  await logHistory(String(msg.from.id), 'tr_out', amount, 'USDT');
  await logHistory(state.to, 'tr_in', amount, 'USDT');
  states.delete(String(msg.from.id));
  
  await bot.sendMessage(chatId, i18n.ru.transfer_success.replace('{amount}', fmt(amount)).replace('{fee}', fmt(fee)).replace('{to}', state.toName), { ...getMainMenu(true), parse_mode: 'HTML' });
  bot.sendMessage(state.to, i18n.ru.transfer_received.replace('{amount}', fmt(amount)).replace('{from}', msg.from.id), { parse_mode: 'HTML' }).catch(() => {});
}

async function handleSwapAmount(msg, state, w) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  
  const { from, to } = state;
  let available = from === 'USDT' ? Number(w.balance_usdt) : Number(w.balance_ton);
  if (available < amount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, i18n.ru.low_balance, { ...getMainMenu(true), parse_mode: 'HTML' }); }
  
  try {
    const res = await fetch('https://pay.crypt.bot/api/getExchangeRates', { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN } });
    const data = await res.json();
    const rateObj = data.result.find(r => r.source === from && r.target === to);
    if (!rateObj) throw new Error('Rate');
    
    const rate = Number(rateObj.rate);
    const fee = amount * SWAP_FEE;
    const amountAfterFee = amount - fee;
    const receive = amountAfterFee * rate;
    
    if (from === 'USDT') await updateWallet(String(msg.from.id), { balance_usdt: (available - amount).toFixed(8), balance_ton: (Number(w.balance_ton) + receive).toFixed(8) });
    else await updateWallet(String(msg.from.id), { balance_ton: (available - amount).toFixed(8), balance_usdt: (Number(w.balance_usdt) + receive).toFixed(8) });
    
    if (ADMIN_ID && fee > 0) {
      const admin = await getWallet(ADMIN_ID);
      if (from === 'USDT') await updateWallet(ADMIN_ID, { balance_usdt: (Number(admin?.balance_usdt || 0) + fee).toFixed(8) });
      else await updateWallet(ADMIN_ID, { balance_ton: (Number(admin?.balance_ton || 0) + fee).toFixed(8) });
    }
    
    await logHistory(String(msg.from.id), 'swap', amount, from);
    states.delete(String(msg.from.id));
    await bot.sendMessage(chatId, i18n.ru.swap_success.replace('{amount}', fmt(amount)).replace('{from}', from).replace('{to_amount}', fmt(receive)).replace('{to}', to).replace('{fee}', fmt(fee)), { ...getMainMenu(true), parse_mode: 'HTML' });
  } catch (e) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, '❌ Ошибка курса.', { ...getMainMenu(true), parse_mode: 'HTML' }); }
}

async function handleCreateCheckAmount(msg, w) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (Number(w.balance_usdt) < amount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, i18n.ru.low_balance, { ...getMainMenu(true), parse_mode: 'HTML' }); }
  
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
  const { data } = await supabase.from('smaster_checks').insert({ creator_id: String(msg.from.id), amount: amount, status: 'active' }).select();
  states.delete(String(msg.from.id));
  
  const me = await bot.getMe();
  const link = `https://t.me/${me.username}?start=check_${data[0].id}`;
  
  await bot.sendPhoto(chatId, 'https://placehold.co/600x350/1c1c1e/ffffff?text=SMaster+Check%0A%0A' + amount + '+USDT', {
    caption: i18n.ru.check_success.replace('{amount}', fmt(amount)).replace('{link}', link),
    parse_mode: 'HTML',
    ...getMainMenu(true)
  });
}

async function handleCreateMultiCheck(msg, w) {
  const chatId = msg.chat.id;
  const parts = msg.text.trim().split(' ');
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Формат: сумма количество.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  
  const totalAmount = Number(parts[0].replace(',', '.'));
  const count = parseInt(parts[1]);
  if (!totalAmount || !count || totalAmount <= 0 || count <= 0 || count > 20) return bot.sendMessage(chatId, '❌ Неверные данные (макс 20 чеков).', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  if (Number(w.balance_usdt) < totalAmount) { states.delete(String(msg.from.id)); return bot.sendMessage(chatId, i18n.ru.low_balance, { ...getMainMenu(true), parse_mode: 'HTML' }); }
  
  const amountPerCheck = totalAmount / count;
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) - totalAmount).toFixed(8) });
  
  let links = '';
  for (let i = 0; i < count; i++) {
    const { data } = await supabase.from('smaster_checks').insert({ creator_id: String(msg.from.id), amount: amountPerCheck, status: 'active' }).select();
    if (data) links += `https://t.me/${(await bot.getMe()).username}?start=check_${data[0].id}\n`;
  }
  states.delete(String(msg.from.id));
  await bot.sendMessage(chatId, i18n.ru.check_multi_success.replace('{count}', count).replace('{amount}', fmt(amountPerCheck)).replace('{links}', links), { ...getMainMenu(true), parse_mode: 'HTML' });
}

async function handleClaimCheck(msg, checkId, w) {
  const chatId = msg.chat.id;
  if (!w) return bot.sendMessage(chatId, '🇷🇺 Сначала нажми /start, чтобы создать кошелек!');
  
  const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(checkId)).limit(1);
  const check = arr && arr.length > 0 ? arr[0] : null;
  if (!check || check.status !== 'active') return bot.sendMessage(chatId, i18n.ru.check_error, { ...getMainMenu(true), parse_mode: 'HTML' });
  if (String(check.creator_id) === String(msg.from.id)) return bot.sendMessage(chatId, '❌ Ты не можешь активировать свой же чек.', { ...getMainMenu(true), parse_mode: 'HTML' });
  
  await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: String(msg.from.id) }).eq('id', check.id);
  await updateWallet(String(msg.from.id), { balance_usdt: (Number(w.balance_usdt) + Number(check.amount)).toFixed(8) });
  await logHistory(String(msg.from.id), 'dep', Number(check.amount), 'USDT');
  await bot.sendMessage(chatId, i18n.ru.check_claimed.replace('{amount}', fmt(check.amount)), { ...getMainMenu(true), parse_mode: 'HTML' });
}

async function handleSetWallet(msg, w) {
  const chatId = msg.chat.id;
  const addr = msg.text.trim();
  if (addr.toLowerCase() === 'удалить' || addr.toLowerCase() === 'delete') {
    await updateWallet(String(msg.from.id), { linked_ton_wallet: null });
    states.delete(String(msg.from.id));
    return bot.sendMessage(chatId, '✅ Кошелек отвязан.', getSettingsMenu());
  }
  if (addr.length < 48) return bot.sendMessage(chatId, '❌ Неверный адрес.', { reply_markup: { inline_keyboard: [[{ text: i18n.ru.cancel, callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
  await updateWallet(String(msg.from.id), { linked_ton_wallet: addr });
  states.delete(String(msg.from.id));
  await bot.sendMessage(chatId, i18n.ru.wallet_linked.replace('{addr}', addr), getSettingsMenu());
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
          bot.sendMessage(userId, `✅ <b>Пополнение!</b>\n\n+<code>${amount} USDT</code> зачислено на баланс.`, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }
    res.sendStatus(200);
  } catch (e) { res.sendStatus(200); }
});
app.get('/', (req, res) => res.send('SMaster Premium is running'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP listening'));
bot.on('polling_error', (err) => console.log('polling_error:', err.message));
console.log('🤖 SMaster Premium bot started');
