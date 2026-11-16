const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { WalletContractV4, internal, toNano, TonClient } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const { ethers } = require('ethers');
const TronWeb = require('tronweb');
const axios = require('axios');
const helmet = require('helmet');

process.on('uncaughtException', (err) => console.error('КРИТ. ОШИБКА:', err.message));
process.on('unhandledRejection', (err) => console.error('ОШИБКА ПРОМИСА:', err.message));

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_ID = String(process.env.ADMIN_ID);
const MASTER_SEED = process.env.MASTER_SEED || 'apple banana cherry dog elephant frog grape house ice jam kite lion';
const MAIN_WALLET_MNEMONIC = (process.env.MAIN_WALLET_MNEMONIC || '').split(' ');
const states = new Map();

// Клиенты для блокчейнов
const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY });
const ethProvider = new ethers.JsonRpcProvider(process.env.WEB3_PROVIDER_URL || 'https://bsc-dataseed.binance.org/');
const tronWeb = new TronWeb({ fullHost: process.env.TRON_PROVIDER_URL || 'https://api.trongrid.io' });

function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

async function getWallet(userId) {
  const { data } = await supabase.from('smaster_wallets').select('*').eq('user_id', Number(userId)).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function updateWallet(userId, patch) {
  await supabase.from('smaster_wallets').update(patch).eq('user_id', Number(userId));
}

// ГЕНЕРАЦИЯ ВСЕХ АДРЕСОВ (TON, ETH, TRON)
async function createWallet(user) {
  try {
    // TON
    const tonMnemonic = MASTER_SEED.split(' ');
    const tonKey = await mnemonicToWalletKey(tonMnemonic);
    const userHash = require('crypto').createHash('sha256').update(tonKey.secretKey.toString('hex') + String(user.id)).digest();
    const tonWallet = WalletContractV4.create({ publicKey: userHash.subarray(0, 32), workchain: 0 });
    const tonAddr = tonWallet.address.toString({ bounceable: false });

    // EVM (ETH/BSC)
    const hdNode = ethers.HDNodeWallet.fromPhrase(MASTER_SEED);
    const ethWallet = hdNode.derivePath(`m/44'/60'/0'/0/${user.id % 100000}`);
    
    // TRON (TRC20)
    const tronAccount = tronWeb.utils.accounts.generateAccount();

    await supabase.from('smaster_wallets').insert({
      user_id: Number(user.id),
      username: user.username || null,
      ton_deposit_address: tonAddr,
      erc20_address: ethWallet.address,
      trc20_address: tronAccount.address.base58
    });
    return true;
  } catch (e) { console.error('Wallet Gen Error:', e.message); return false; }
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
  } catch (e) {}
}
setInterval(checkTonDeposits, 60000);

function getMainMenu(hasWallet) {
  if (!hasWallet) return { reply_markup: { inline_keyboard: [[{ text: '➕ Создать кошелек', callback_data: 'create_wallet', style: 'success' }]] } };
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👛 Кошелёк', callback_data: 'menu_balance' }],
        [{ text: '⬇️ Пополнить', callback_data: 'menu_deposit', style: 'success' }, { text: '⬆️ Вывести', callback_data: 'menu_withdraw', style: 'danger' }],
        [{ text: '🎲 P2P Маркет', callback_data: 'menu_p2p' }],
        [{ text: '🧾 Чеки', callback_data: 'menu_checks' }, { text: '📄 Счета', callback_data: 'menu_invoices' }],
        [{ text: '⚙️ Настройки', callback_data: 'menu_settings' }],
        [{ text: '📱 Открыть приложение', web_app: { url: process.env.APP_URL } }]
      ]
    }
  };
}

// ГЕНЕРАТОР КНОПОК СУММ (1-10, 10-100, 100-1000)
function getAmountKeyboard(page, callbackPrefix) {
  let buttons = [];
  if (page === 1) {
    for (let i = 1; i <= 10; i++) buttons.push({ text: i.toString(), callback_data: `${callbackPrefix}_${i}` });
    buttons.push({ text: '➡️ Следующие', callback_data: `${callbackPrefix}_page_2` });
  } else if (page === 2) {
    for (let i = 20; i <= 100; i += 10) buttons.push({ text: i.toString(), callback_data: `${callbackPrefix}_${i}` });
    buttons.push({ text: '⬅️ Назад', callback_data: `${callbackPrefix}_page_1` }, { text: '➡️ Следующие', callback_data: `${callbackPrefix}_page_3` });
  } else if (page === 3) {
    for (let i = 200; i <= 1000; i += 100) buttons.push({ text: i.toString(), callback_data: `${callbackPrefix}_${i}` });
    buttons.push({ text: '⬅️ Назад', callback_data: `${callbackPrefix}_page_2` });
  }
  
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 5) {
    keyboard.push(buttons.slice(i, i + 5));
  }
  return keyboard;
}

bot.onText(/^\/start$/, async (msg) => {
  let w = await getWallet(msg.from.id);
  if (!w) { await createWallet(msg.from); }
  await bot.sendMessage(msg.chat.id, '👋 Добро пожаловать в <b>SMaster</b>!', { ...getMainMenu(true), parse_mode: 'HTML' });
});bot.on('callback_query', async (query) => {
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

    // ================= ЧЕКИ =================
    if (data === 'menu_checks') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🧾 <b>Чеки</b>\nВыбери сумму (Страница 1):', { reply_markup: { inline_keyboard: [...getAmountKeyboard(1, 'chk_amt'), [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('chk_page_')) {
      const page = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `🧾 <b>Чеки</b>\nВыбери сумму (Страница ${page}):`, { reply_markup: { inline_keyboard: [...getAmountKeyboard(page, 'chk_amt'), [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('chk_amt_')) {
      const amount = Number(data.split('_')[2]);
      if (!amount) return;
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      
      if (Number(w.balance_usdt) < amount) return bot.sendMessage(chatId, '❌ Мало USDT на балансе!');
      
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - amount).toFixed(8) });
      const { data: chk, error } = await supabase.from('smaster_checks').insert({ creator_id: Number(userId), amount }).select();
      if (error) return bot.sendMessage(chatId, `❌ Ошибка БД: ${error.message}`);
      
      const link = `https://t.me/${(await bot.getMe()).username}?start=check_${chk[0].id}`;
      return bot.sendPhoto(chatId, `https://placehold.co/600x400/0f0715/ff007f/png?text=SMaster+Check%0A%0A${amount}+USDT`, { caption: `🎁 <b>Чек на ${amount} USDT создан!</b>\n\nСсылка:\n<code>${link}</code>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${link}` }]] } });
    }

    // ================= СЧЕТА =================
    if (data === 'menu_invoices') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '📄 <b>Счета</b>\nВыбери сумму (Страница 1):', { reply_markup: { inline_keyboard: [...getAmountKeyboard(1, 'inv_amt'), [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('inv_page_')) {
      const page = Number(data.split('_')[2]);
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `📄 <b>Счета</b>\nВыбери сумму (Страница ${page}):`, { reply_markup: { inline_keyboard: [...getAmountKeyboard(page, 'inv_amt'), [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }
    if (data.startsWith('inv_amt_')) {
      const amount = Number(data.split('_')[2]);
      if (!amount) return;
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      
      const { data: inv, error } = await supabase.from('smaster_invoices').insert({ creator_id: Number(userId), amount, currency: 'USDT' }).select();
      if (error) return bot.sendMessage(chatId, `❌ Ошибка БД: ${error.message}`);
      
      const link = `https://t.me/${(await bot.getMe()).username}?start=invoice_${inv[0].id}`;
      return bot.sendMessage(chatId, `📄 <b>Счет на ${amount} USDT создан!</b>\n\nСсылка для оплаты:\n<code>${link}</code>`, { ...getMainMenu(true), parse_mode: 'HTML' });
    }

    // ================= ПОПОЛНЕНИЕ (Все сети) =================
    if (data === 'menu_deposit') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '⬇️ <b>Пополнение</b>\nВыбери сеть:', { reply_markup: { inline_keyboard: [
        [{ text: '💎 TON (Toncoin)', callback_data: 'dep_ton' }],
        [{ text: '💵 USDT (TRC20)', callback_data: 'dep_trc20' }],
        [{ text: '💵 USDT (ERC20/BEP20)', callback_data: 'dep_erc20' }],
        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]
      ]}, parse_mode: 'HTML' });
    }
    if (data === 'dep_ton') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); return bot.sendMessage(chatId, `💎 <b>TON Адрес:</b>\n<code>${w.ton_deposit_address}</code>\n\n⚠️ В комментарии укажи: <code>${userId}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }
    if (data === 'dep_trc20') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); return bot.sendMessage(chatId, `💵 <b>USDT TRC20 Адрес:</b>\n<code>${w.trc20_address}</code>\n\n⚠️ Отправляй только USDT в сети TRON (TRC20).`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }
    if (data === 'dep_erc20') { await bot.deleteMessage(chatId, query.message.message_id).catch(() => {}); return bot.sendMessage(chatId, `💵 <b>USDT ERC20/BEP20 Адрес:</b>\n<code>${w.erc20_address}</code>\n\n⚠️ Отправляй только USDT в сети Ethereum или BSC.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu_deposit' }]] }, parse_mode: 'HTML' }); }

    // ================= БАЛАНС =================
    if (data === 'menu_balance') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, `👛 <b>Баланс</b>\n\nUSDT: <code>${Number(w.balance_usdt).toFixed(2)}</code>\nTON: <code>${Number(w.balance_ton).toFixed(2)}</code>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] }, parse_mode: 'HTML' });
    }

    // Заглушки для остальных кнопок
    if (data === 'menu_p2p' || data === 'menu_settings' || data === 'menu_withdraw') {
      await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      return bot.sendMessage(chatId, '🚧 Раздел в разработке...', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back_to_menu' }]] } });
    }

  } catch (e) { console.error(e); bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
});

// Deep Links (Счета и Чеки)
bot.onText(/^\/start (.+)/, async (msg, match) => {
  const param = match[1];
  const userId = String(msg.from.id);
  try {
    if (param.startsWith('invoice_')) {
      const id = param.split('_')[1];
      const { data: arr } = await supabase.from('smaster_invoices').select('*').eq('id', Number(id)).limit(1);
      const inv = arr && arr.length > 0 ? arr[0] : null;
      if (!inv || inv.status === 'paid') return bot.sendMessage(msg.chat.id, '❌ Счет не найден или оплачен.');
      if (String(inv.creator_id) === userId) return bot.sendMessage(msg.chat.id, '❌ Нельзя оплатить свой счет.');
      
      const w = await getWallet(userId);
      if (Number(w.balance_usdt) < Number(inv.amount)) return bot.sendMessage(msg.chat.id, `❌ Недостаточно USDT.`);
      
      return bot.sendMessage(msg.chat.id, `📄 <b>Счет на оплату</b>\nСумма: ${inv.amount} ${inv.currency}\n\nВы уверены?`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ Оплатить', callback_data: `confirm_inv_${inv.id}`, style: 'success' }], [{ text: '❌ Отмена', callback_data: 'back_to_menu' }]] },
        parse_mode: 'HTML'
      });
    }
    
    if (param.startsWith('check_')) {
      const id = param.split('_')[1];
      const { data: arr } = await supabase.from('smaster_checks').select('*').eq('id', Number(id)).limit(1);
      const check = arr && arr.length > 0 ? arr[0] : null;
      if (!check || check.status !== 'active') return bot.sendMessage(msg.chat.id, '❌ Чек не найден.');
      if (String(check.creator_id) === userId) return bot.sendMessage(msg.chat.id, '❌ Нельзя активировать свой чек.');
      
      await supabase.from('smaster_checks').update({ status: 'claimed', claimed_by: Number(userId) }).eq('id', check.id);
      const w = await getWallet(userId);
      await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) + Number(check.amount)).toFixed(8) });
      return bot.sendMessage(msg.chat.id, `🎉 Чек активирован! +${check.amount} USDT`, { ...getMainMenu(true) });
    }
  } catch (e) { console.error(e); }
});

// Кнопка "Оплатить" счет
bot.on('callback_query', async (query) => {
  if (!query.data.startsWith('confirm_inv_')) return;
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const invId = Number(query.data.split('_')[2]);
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  const { data: arr } = await supabase.from('smaster_invoices').select('*').eq('id', invId).limit(1);
  const inv = arr && arr.length > 0 ? arr[0] : null;
  if (!inv || inv.status === 'paid') return bot.sendMessage(chatId, '❌ Счет уже оплачен.');
  
  const w = await getWallet(userId);
  if (Number(w.balance_usdt) < Number(inv.amount)) return bot.sendMessage(chatId, '❌ Недостаточно USDT.');
  
  await updateWallet(userId, { balance_usdt: (Number(w.balance_usdt) - Number(inv.amount)).toFixed(8) });
  const creator = await getWallet(inv.creator_id);
  if (creator) await updateWallet(inv.creator_id, { balance_usdt: (Number(creator.balance_usdt) + Number(inv.amount)).toFixed(8) });
  
  await supabase.from('smaster_invoices').update({ status: 'paid', paid_by: Number(userId) }).eq('id', inv.id);
  await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
  return bot.sendMessage(chatId, `✅ <b>Счет успешно оплачен!</b>\nСписано: ${inv.amount} USDT`, { ...getMainMenu(true), parse_mode: 'HTML' });
});

// СЕРВЕР
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
