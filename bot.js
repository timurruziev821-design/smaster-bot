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

async function createWallet(user) {
  try {
    const mnemonic = ethers.Mnemonic.fromPhrase(MASTER_SEED);
    const ethWallet = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${user.id % 100000}`);
    
    const tonMnemonic = MASTER_SEED.split(' ');
    const tonKey = await mnemonicToPrivateKey(tonMnemonic);
    const userSeed = tonKey.secretKey.toString('hex') + String(user.id);
    const userHash = crypto.createHash('sha256').update(userSeed).digest();
    const userPublicKey = userHash.subarray(0, 32);
    const tonWallet = WalletContractV4.create({ publicKey: userPublicKey, workchain: 0 });
    
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

function getMenu(hasWallet) {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }, { text: '👤 Профиль', callback_data: 'set_profile' }],
        [{ text: '💳 Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '🎲 P2P', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '📄 Счета', callback_data: 'menu_invoices' }],
        [{ text: '🚀 Mini App', callback_data: 'open_app', style: 'primary' }]
      ]
    }
  };
}bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  let w = await getWallet(userId);

  if (data === 'create_wallet') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const res = await createWallet(query.from);
    if (res.error) return bot.sendMessage(chatId, `❌ ${res.error}`);
    return bot.sendMessage(chatId, '✅ Кошелек создан!', { ...getMenu(true) });
  }
  if (!w) return bot.sendMessage(chatId, 'Нажми /start');

  if (data === 'back_to_menu') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, 'Меню:', { ...getMenu(true) });
  }

  // --- ЧЕКИ ---
  if (data === 'menu_checks') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, '🧾 <b>Чеки SMaster</b>\n\nВыбери тип:', {
      reply_markup: { inline_keyboard: [
        [{ text: '🎁 Создать чек', callback_data: 'check_create' }],
        [{ text: '🎫 Активировать', callback_data: 'check_activate' }],
        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
      ]}, parse_mode: 'HTML'
    });
  }

  if (data === 'check_create') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    states.set(userId, { type: 'check_amount' });
    return bot.sendMessage(chatId, 'Введи сумму в USDT для чека:');
  }

  if (data === 'check_activate') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    states.set(userId, { type: 'check_activate_id' });
    return bot.sendMessage(chatId, 'Введи ID чека или ссылку:');
  }
});

// Создание чека (с красивой картинкой)
bot.on('message', async (msg) => {
  const userId = String(msg.from.id);
  const state = states.get(userId);
  if (!state) return;

  if (state.type === 'check_amount') {
    const amount = Number(msg.text.replace(',', '.'));
    if (!amount || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Введи число.');
    
    const w = await getWallet(userId);
    if (Number(w.balance_usdt) < amount) {
      states.delete(userId);
      return bot.sendMessage(msg.chat.id, '❌ Недостаточно средств.', { ...getMenu(true) });
    }

    await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
    const { data } = await supabase.from('smaster_checks').insert({ creator_id: Number(userId), amount, type: 'personal', limit_activations: 1 }).select();
    states.delete(userId);

    const me = await bot.getMe();
    const link = `https://t.me/${me.username}?start=check_${data[0].id}`;

    // Генерируем картинку через Placehold (или можно использовать Canvas)
    const imageUrl = `https://placehold.co/600x400/0f0715/ff007f/png?text=SMaster+Check%0A%0A${amount}+USDT%0A%0AСсылка:+${link}`;

    await bot.sendPhoto(msg.chat.id, imageUrl, {
      caption: `🎁 <b>Чек на ${amount} USDT создан!</b>\n\nОтправь эту ссылку другу:\n${link}`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${link}` }], [{ text: '⬅️ В меню', callback_data: 'back_to_menu' }]] }
    });
  }

  if (state.type === 'check_activate_id') {
    states.delete(userId);
    const checkId = msg.text.trim().split('_').pop();
    const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(checkId)).limit(1);
    const check = arr && arr.length > 0 ? arr[0] : null;
    
    if (!check || check.status !== 'active') return bot.sendMessage(msg.chat.id, '❌ Чек не найден.');
    if (String(check.creator_id) === userId) return bot.sendMessage(msg.chat.id, '❌ Нельзя активировать свой чек.');

    await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: Number(userId) }).eq('id', check.id);
    const w = await getWallet(userId);
    await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + Number(check.amount)).toFixed(8) });
    
    return bot.sendMessage(msg.chat.id, `🎉 <b>Чек активирован!</b>\n\n+${check.amount} USDT`, { ...getMenu(true), parse_mode: 'HTML' });
  }
});bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  // P2P
  if (data === 'menu_p2p') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, '🎲 <b>P2P Маркет</b>', {
      reply_markup: { inline_keyboard: [
        [{ text: '🛒 Купить USDT', callback_data: 'p2p_buy' }],
        [{ text: '➕ Продать USDT', callback_data: 'p2p_create' }],
        [{ text: '📢 Мои объявления', callback_data: 'p2p_my' }],
        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
      ]}, parse_mode: 'HTML'
    });
  }

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
    if (!ad) return bot.sendMessage(chatId, '❌ Ошибка.');
    const total = Number(ad.amount) * Number(ad.price);
    return bot.sendMessage(chatId, `📢 <b>Объявление #${ad.id}</b>\n\nUSDT: ${ad.amount}\nЦена: ${ad.price} ${ad.currency}\nИтого: ${total}`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Купить', callback_data: `p2p_buy_${ad.id}`, style: 'success' }], [{ text: '⬅️ Назад', callback_data: 'p2p_buy' }]] }
    });
  }

  if (data.startsWith('p2p_buy_')) {
    const id = Number(data.split('_')[2]);
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    const { data: arr } = await supabase.from('smaster_p2p_ads').select('*').eq('id', id).limit(1);
    const ad = arr && arr.length > 0 ? arr[0] : null;
    const w = await getWallet(userId);
    const seller = await getWallet(ad.seller_id);
    const amount = Number(ad.amount);
    const total = amount * Number(ad.price);
    
    if (Number(w.balance_ton) < total) return bot.sendMessage(chatId, '❌ Мало TON.');
    
    await updateWallet(userId, { balance_ton: (Number(w.balance_ton) - total).toFixed(8), balance_usdt: (Number(w.balance_usdt) + amount).toFixed(8) });
    await updateWallet(ad.seller_id, { balance_ton: (Number(seller.balance_ton) + total).toFixed(8), balance_usdt: (Number(seller.balance_usdt) - amount).toFixed(8) });
    await supabase.from('smaster_p2p_ads').update({ status: 'completed', buyer_id: userId }).eq('id', ad.id);
    
    return bot.sendMessage(chatId, `✅ Сделка завершена! +${amount} USDT`, { ...getMenu(true) });
  }

  if (data === 'p2p_create') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    states.set(userId, { type: 'p2p_amount' });
    return bot.sendMessage(chatId, 'Сколько USDT продаешь?');
  }

  // Инвойсы (Счета)
  if (data === 'menu_invoices') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    return bot.sendMessage(chatId, '📄 <b>Счета (Инвойсы)</b>\n\nСоздай счет для приема оплаты.', {
      reply_markup: { inline_keyboard: [[{ text: '➕ Создать счет', callback_data: 'inv_create' }], [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }
    });
  }
  if (data === 'inv_create') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    states.set(userId, { type: 'inv_amount' });
    return bot.sendMessage(chatId, 'Введи сумму для счета:');
  }
});const app = express();
app.use(helmet());
app.use(express.json());

// API для Mini App
app.get('/api/user/:id', async (req, res) => {
  const w = await getWallet(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ balance_usdt: w.balance_usdt, balance_ton: w.balance_ton, ton_address: w.ton_deposit_address, eth_address: w.eth_deposit_address });
});

app.get('/app', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://telegram.org/js/telegram-web-app.js"></script>
      <style>
        body { background: #0f0715; color: white; font-family: sans-serif; padding: 20px; }
        .card { background: #1c102b; padding: 20px; border-radius: 20px; margin-bottom: 15px; border: 1px solid #ff007f; }
        .btn { background: #ff007f; color: white; padding: 15px; border-radius: 10px; text-align: center; margin-top: 10px; }
        .addr { background: #000; padding: 10px; font-family: monospace; border-radius: 5px; color: #00ff88; word-break: break-all; }
        h1 { color: #ff007f; }
      </style>
    </head>
    <body>
      <h1>SMaster</h1>
      <div class="card"><div>Баланс USDT</div><div style="font-size:30px;color:#00ff88;" id="usdt">0.00</div></div>
      <div class="card"><div>TON Адрес</div><div class="addr" id="ton">Загрузка...</div></div>
      <div class="card"><div>ETH Адрес</div><div class="addr" id="eth">Загрузка...</div></div>
      <script>
        const tg = window.Telegram.WebApp; tg.expand();
        fetch('/api/user/' + tg.initDataUnsafe.user.id).then(r => r.json()).then(data => {
          document.getElementById('usdt').innerText = data.balance_usdt || 0;
          document.getElementById('ton').innerText = data.ton_address || 'Нет';
          document.getElementById('eth').innerText = data.eth_address || 'Нет';
        });
      </script>
    </body>
    </html>
  `);
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server ready'));
