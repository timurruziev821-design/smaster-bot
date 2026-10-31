const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// Переменные
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

// ============ ГЛАВНОЕ МЕНЮ ============
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      [{ text: '💰 Баланс' }, { text: '💳 Пополнить' }],
      [{ text: '📤 Перевести' }, { text: '🚀 Ракета' }],
      [{ text: '🔄 P2P Маркет' }, { text: '🎁 Рефералка' }],
      [{ text: '📈 Курсы' }, { text: '➕ Создать кошелек' }]
    ],
    resize_keyboard: true
  }
};

// ============ РАБОТА С БАЗОЙ (ЗАЩИЩЕННАЯ) ============
async function getWallet(userId) {
  try {
    const { data, error } = await supabase
      .from('smaster_wallets')
      .select('*')
      .eq('user_id', String(userId))
      .limit(1);
      
    if (error) {
      console.error('❌ ОШИБКА БАЗЫ (чтение):', error.message);
      return null;
    }
    return data && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('❌ КРИТ. ОШИБКА (чтение):', e.message);
    return null;
  }
}

async function createWallet(msg) {
  try {
    const userId = String(msg.from.id);
    const { data, error } = await supabase
      .from('smaster_wallets')
      .insert({
        user_id: userId,
        username: msg.from.username || null,
        balance_usdt: 0,
        balance_ton: 0
      })
      .select();
      
    if (error) {
      console.error('❌ ОШИБКА СОЗДАНИЯ:', error.message);
      return { error: error.message };
    }
    return { data: data[0] };
  } catch (e) {
    return { error: e.message };
  }
}

async function updateWallet(userId, patch) {
  try {
    const { error } = await supabase
      .from('smaster_wallets')
      .update(patch)
      .eq('user_id', String(userId));
    if (error) console.error('❌ ОШИБКА БАЗЫ (обновление):', error.message);
  } catch (e) {
    console.error('❌ КРИТ. ОШИБКА (обновление):', e.message);
  }
}

function fmt(n, d = 2) { return Number(n || 0).toFixed(d); }

const states = new Map();

// ============ СТАРТ ============
bot.onText(/^\/start/, async (msg) => {
  try {
    const w = await getWallet(msg.from.id);
    if (!w) await createWallet(msg); // Пытаемся создать сразу
    
    await bot.sendMessage(msg.chat.id,
      `Привет, ${msg.from.first_name || 'друг'}! 👋\n\nДобро пожаловать в SMaster.\nВыбирай действие в меню 👇`,
      MAIN_MENU
    );
  } catch (e) { console.log('start err:', e.message); }
});

// ============ ОБРАБОТЧИК ТЕКСТА ============
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    const text = msg.text;
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Машина состояний (ожидание ввода)
    const state = states.get(userId);
    if (state) {
      if (text === '⬅️ Назад' || text.toLowerCase() === 'отмена' || text === '/cancel') {
        states.delete(userId);
        return bot.sendMessage(chatId, 'Действие отменено. Главное меню.', MAIN_MENU);
      }
      if (state.type === 'p2p_create') return handleCreateInput(msg, state);
      if (state.type === 'deposit') return handleDepositInput(msg);
      if (state.type === 'transfer') return handleTransferInput(msg, state);
      return;
    }

    // Кнопки
    if (text === '💰 Баланс') return handleBalance(msg);
    if (text === '💳 Пополнить') {
      states.set(userId, { type: 'deposit' });
      return bot.sendMessage(chatId, '💳 Сколько USDT хочешь пополнить? Напиши число.\n\nИли напиши «отмена».');
    }
    if (text === '📤 Перевести') {
      states.set(userId, { type: 'transfer', step: 'recipient' });
      return bot.sendMessage(chatId, '📤 Кому перевести? Напиши ID пользователя или @username.\n\nКомиссия: 0.1 USDT.\n\nИли напиши «отмена».');
    }
    if (text === '🚀 Ракета') return handleRocket(msg);
    if (text === '🔄 P2P Маркет') return handleP2PMenu(msg);
    if (text === '🎁 Рефералка') return handleReferral(msg);
    if (text === '📈 Курсы') return handleRates(msg);
    if (text === '➕ Создать кошелек') return handleCreateWalletBtn(msg);

  } catch (e) { console.log('msg err:', e.message); }
});

// ============ КНОПКА СОЗДАНИЯ КОШЕЛЬКА ============
async function handleCreateWalletBtn(msg) {
  const chatId = msg.chat.id;
  const existing = await getWallet(msg.from.id);
  if (existing) {
    return bot.sendMessage(chatId, `✅ У тебя уже есть кошелёк!\n\n• USDT: ${fmt(existing.balance_usdt)}\n• TON: ${fmt(existing.balance_ton)}`, MAIN_MENU);
  }
  
  const temp = await bot.sendMessage(chatId, '⏳ Создаю кошелёк...');
  const res = await createWallet(msg);
  await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
  
  if (res.error) {
    return bot.sendMessage(chatId, `❌ Ошибка базы: ${res.error}\n\nУбедись, что RLS отключен и ключ правильный.`, MAIN_MENU);
  }
  await bot.sendMessage(chatId, '✅ Кошелёк успешно создан! Теперь можешь проверить баланс.', MAIN_MENU);
}

// ============ БАЛАНС ============
async function handleBalance(msg) {
  const chatId = msg.chat.id;
  try {
    const temp = await bot.sendMessage(chatId, '⏳ Загружаю...');
    const w = await getWallet(msg.from.id);
    await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
    
    if (!w) return bot.sendMessage(chatId, 'Кошелёк не найден. Нажми «➕ Создать кошелек».', MAIN_MENU);
    
    await bot.sendMessage(chatId, `💰 Твой баланс:\n\n• USDT: ${fmt(w.balance_usdt)}\n• TON: ${fmt(w.balance_ton)}`, MAIN_MENU);
  } catch (e) {
    await bot.sendMessage(chatId, 'Ошибка загрузки.', MAIN_MENU);
  }
}

// ============ ПОПОЛНЕНИЕ ============
async function handleDepositInput(msg) {
  const chatId = msg.chat.id;
  const amount = Number(msg.text.replace(',', '.'));
  if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число больше 0. Или «отмена».');
  states.delete(msg.from.id);
  if (!CRYPTOBOT_TOKEN) return bot.sendMessage(chatId, 'Временно недоступно.', MAIN_MENU);

  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'USDT', amount: String(amount), description: `Пополнение #${msg.from.id}`,
        payload: String(msg.from.id), allow_comments: false, allow_anonymous: false, expires_in: 3600
      })
    });
    const data = await res.json();
    if (!data.ok) return bot.sendMessage(chatId, 'Ошибка создания счёта.', MAIN_MENU);
    
    await bot.sendMessage(chatId, `💳 Счёт на ${data.result.amount} ${data.result.asset}.\n\nОплати:\n${data.result.bot_invoice_url}`, MAIN_MENU);
  } catch (e) {
    await bot.sendMessage(chatId, 'Ошибка.', MAIN_MENU);
  }
}

// ============ ПЕРЕВОД ============
async function handleTransferInput(msg, state) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (state.step === 'recipient') {
    const t = msg.text.trim();
    let recipient = null;
    if (t.startsWith('@')) {
      const { data } = await supabase.from('smaster_wallets').select('*').ilike('username', t.slice(1)).limit(1);
      recipient = data && data.length > 0 ? data[0] : null;
    } else {
      const rid = Number(t);
      if (rid) recipient = await getWallet(rid);
    }
    if (!recipient) return bot.sendMessage(chatId, '❌ Не найден. Введи ID или @username. Или «отмена».');
    if (String(recipient.user_id) === String(userId)) return bot.sendMessage(chatId, '❌ Нельзя себе.');
    
    states.set(userId, { type: 'transfer', step: 'amount', to: recipient.user_id, toName: recipient.username || recipient.user_id });
    return bot.sendMessage(chatId, `Кому: ${recipient.username ? '@' + recipient.username : recipient.user_id}\n\nСколько USDT? (Комиссия: 0.1)`);
  }

  if (state.step === 'amount') {
    const amount = Number(msg.text.replace(',', '.'));
    if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число. Или «отмена».');
    
    const totalDeduct = amount + TRANSFER_FEE;
    const w = await getWallet(userId);
    
    if (!w || Number(w.balance_usdt) < totalDeduct) {
      states.delete(userId);
      return bot.sendMessage(chatId, `❌ Мало USDT! Нужно: ${fmt(totalDeduct)} (вкл. комиссию)`, MAIN_MENU);
    }
    
    const to = await getWallet(state.to);
    if (!to) {
      states.delete(userId);
      return bot.sendMessage(chatId, '❌ Получатель пропал.', MAIN_MENU);
    }
    
    await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - totalDeduct).toFixed(8) });
    await updateWallet(state.to, { balance_usdt: (Number(to.balance_usdt) + amount).toFixed(8) });
    states.delete(userId);
    
    await bot.sendMessage(chatId, `✅ Переведено: ${fmt(amount)} USDT\nКомиссия: 0.1 USDT\nКому: ${state.toName}`, MAIN_MENU);
    bot.sendMessage(state.to, `💸 Тебе пришло ${fmt(amount)} USDT от ${userId}`).catch(() => {});
  }
}

// ============ РАКЕТА, РЕФЕРАЛКА, КУРСЫ ============
async function handleRocket(msg) {
  if (Math.random() < 0.000001) {
    const w = await getWallet(msg.from.id);
    await updateWallet(msg.from.id, { balance_usdt: (Number(w?.balance_usdt || 0) + 100).toFixed(8) });
    await bot.sendMessage(msg.chat.id, '🚀🚀🚀 РАКЕТА ВЗЛЕТЕЛА!!!\n\n🎉 Ты выиграл 100 USDT!\n\n(шанс 1 на миллион)', MAIN_MENU);
  } else {
    await bot.sendMessage(msg.chat.id, '🚀 Ракета взорвалась.\n\nПовезет в следующий раз!', MAIN_MENU);
  }
}

async function handleReferral(msg) {
  try {
    const me = await bot.getMe();
    await bot.sendMessage(msg.chat.id, `🎁 Твоя ссылка:\nhttps://t.me/${me.username}?start=ref_${msg.from.id}`, MAIN_MENU);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка.', MAIN_MENU);
  }
}

async function handleRates(msg) {
  const chatId = msg.chat.id;
  try {
    const temp = await bot.sendMessage(chatId, '⏳ Загружаю...');
    const res = await fetch('https://pay.crypt.bot/api/getExchangeRates', {
      method: 'GET',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN }
    });
    const data = await res.json();
    await bot.deleteMessage(chatId, temp.message_id).catch(() => {});
    
    if (!data.ok) return bot.sendMessage(chatId, 'Ошибка курсов.', MAIN_MENU);
    
    const usdtTon = data.result.find(r => r.source === 'USDT' && r.target === 'TON');
    const tonUsdt = data.result.find(r => r.source === 'TON' && r.target === 'USDT');
    const usdtRub = data.result.find(r => r.source === 'USDT' && r.target === 'RUB');
    
    let text = '📈 Курсы CryptoBot:\n\n';
    if (usdtTon) text += `• 1 USDT = ${fmt(usdtTon.rate, 4)} TON\n`;
    if (tonUsdt) text += `• 1 TON = ${fmt(tonUsdt.rate, 2)} USDT\n`;
    if (usdtRub) text += `• 1 USDT = ${fmt(usdtRub.rate, 2)} RUB\n`;
    
    await bot.sendMessage(chatId, text, MAIN_MENU);
  } catch (e) { await bot.sendMessage(chatId, 'Ошибка.', MAIN_MENU); }
}

// ============ P2P ============
async function handleP2PMenu(msg) {
  await bot.sendMessage(msg.chat.id, '🔄 P2P Маркет SMaster\n\nВыбирай:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Купить USDT', callback_data: 'p2p_buy' }],
        [{ text: '➕ Выставить объявление', callback_data: 'p2p_create' }],
        [{ text: '📢 Мои объявления', callback_data: 'p2p_my' }]
      ]
    }
  });
}

async function handleCreateInput(msg, state) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (state.step === 'amount') {
    const amount = Number(text.replace(',', '.'));
    if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число. Или «отмена».');
    states.set(userId, { ...state, step: 'currency', amount });
    return bot.sendMessage(chatId, 'Валюта: TON или RUB');
  }

  if (state.step === 'currency') {
    const cur = text.toUpperCase();
    if (cur !== 'TON' && cur !== 'RUB') return bot.sendMessage(chatId, '❌ Напиши TON или RUB');
    states.set(userId, { ...state, step: 'price', currency: cur });
    return bot.sendMessage(chatId, `Цена за 1 USDT в ${cur}?`);
  }

  if (state.step === 'price') {
    const price = Number(text.replace(',', '.'));
    if (!price || price <= 0) return bot.sendMessage(chatId, '❌ Введи цену. Или «отмена».');
    
    const w = await getWallet(userId);
    if (!w || Number(w.balance_usdt) < state.amount) {
      states.delete(userId);
      return bot.sendMessage(chatId, '❌ Мало USDT.', MAIN_MENU);
    }
    
    const { data, error } = await supabase.from('smaster_p2p_ads').insert({
      seller_id: String(userId), seller_username: msg.from.username || null,
      amount: state.amount, price: price, currency: state.currency
    }).select();
    
    states.delete(userId);
    if (error || !data || data.length === 0) return bot.sendMessage(chatId, '❌ Ошибка.', MAIN_MENU);
    
    await bot.sendMessage(chatId, `✅ Объявление #${data[0].id} создано!\n\nПродаёшь: ${state.amount} USDT\nЦена: ${price} ${state.currency}`, MAIN_MENU);
  }
}

// ============ CALLBACK'И ============
bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (data === 'p2p_create') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      states.set(userId, { type: 'p2p_create', step: 'amount' });
      return bot.sendMessage(chatId, '➕ Сколько USDT продаёшь?\n\nИли «отмена».');
    }

    if (data === 'p2p_buy') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('status', 'active').neq('seller_id', String(userId)).limit(10);
      
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '🛒 Нет объявлений.', MAIN_MENU);
      
      const buttons = ads.map(ad => [{ text: `#${ad.id} · ${ad.amount} USDT · ${ad.price} ${ad.currency}`, callback_data: `p2p_view_${ad.id}` }]);
      return bot.sendMessage(chatId, '🛒 Объявления:', { reply_markup: { inline_keyboard: buttons } });
    }

    if (data.startsWith('p2p_view_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', MAIN_MENU);
      
      const total = Number(ad.amount) * Number(ad.price);
      let extra = ad.currency === 'RUB' ? '\n\n⚠️ Свяжись с продавцом.' : '';
      
      return bot.sendMessage(chatId,
        `📢 #${ad.id}\n\nПродавец: @${ad.seller_username || 'id'+ad.seller_id}\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}\nИтого: ${fmt(total)} ${ad.currency}${extra}`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Купить', callback_data: `p2p_buy_${ad.id}` }], [{ text: '↩️ Назад', callback_data: 'p2p_buy' }]] } }
      );
    }

    if (data.startsWith('p2p_buy_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
      const ad = arr && arr.length > 0 ? arr[0] : null;
      
      if (!ad || ad.status !== 'active') return bot.sendMessage(chatId, '❌ Недоступно.', MAIN_MENU);
      if (String(ad.seller_id) === String(userId)) return bot.sendMessage(chatId, '❌ Нельзя купить своё.', MAIN_MENU);

      const amount = Number(ad.amount);
      const price = Number(ad.price);
      const total = amount * price;

      if (ad.currency === 'RUB') {
        return bot.sendMessage(chatId, `💬 Свяжись с @${ad.seller_username || 'id'+ad.seller_id}\n\nПереведи ${fmt(total)} RUB.`, MAIN_MENU);
      }

      const buyer = await getWallet(userId);
      const seller = await getWallet(ad.seller_id);
      
      if (!buyer) return bot.sendMessage(chatId, '❌ Кошелёк не найден.', MAIN_MENU);
      if (!seller) {
        await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', ad.id);
        return bot.sendMessage(chatId, '❌ Продавец пропал.', MAIN_MENU);
      }
      
      if (Number(buyer.balance_ton) < total) return bot.sendMessage(chatId, `❌ Нужно ${fmt(total)} TON.`, MAIN_MENU);
      if (Number(seller.balance_usdt) < amount) {
        await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', ad.id);
        return bot.sendMessage(chatId, '❌ У продавца нет USDT.', MAIN_MENU);
      }

      await updateWallet(userId, { balance_ton: (Number(buyer.balance_ton) - total).toFixed(8), balance_usdt: (Number(buyer.balance_usdt) + amount).toFixed(8) });
      await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
      await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: String(userId) }).eq('id', ad.id);

      await bot.sendMessage(chatId, `✅ Сделка #${ad.id}!\n\n+${amount} USDT\n−${fmt(total)} TON`, MAIN_MENU);
      bot.sendMessage(ad.seller_id, `✅ Твоё объявление #${ad.id} куплено!\n\n−${amount} USDT\n+${fmt(total)} TON`).catch(() => {});
    }

    if (data === 'p2p_my') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const { data: ads } = await supabase.from('smaster_p2p_ads').select('*').eq('seller_id', String(userId)).eq('status', 'active');
      if (!ads || ads.length === 0) return bot.sendMessage(chatId, '📢 Нет объявлений.', MAIN_MENU);
      
      for (const ad of ads) {
        await bot.sendMessage(chatId, `📢 #${ad.id}\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}`, {
          reply_markup: { inline_keyboard: [[{ text: '❌ Отменить', callback_data: `p2p_cancel_${ad.id}` }]] }
        });
      }
      return bot.sendMessage(chatId, '⬆️ Твои объявления.', MAIN_MENU);
    }

    if (data.startsWith('p2p_cancel_')) {
      const id = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      await supabase.from('smaster_p2p_ads').update({ status: 'cancelled' }).eq('id', id).eq('seller_id', String(userId));
      return bot.sendMessage(chatId, `✅ Отменено.`, MAIN_MENU);
    }

  } catch (e) { console.log('cb err:', e.message); }
});

// ============ ВЕБХУК CRYPTOBOT ============
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
          bot.sendMessage(userId, `✅ Пополнение +${amount} USDT!`).catch(() => {});
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
