const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

// --- ВЕБ-СЕРВЕР ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMaster Bot is running!');
}).listen(PORT, () => console.log('Веб-сервер на порту ' + PORT));

// --- НАСТРОЙКИ ---
const TOKEN = process.env.SMASTER_BOT_TOKEN;
const SUPABASE_URL = 'https://dnrbvyuoiiphvkezwxbc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN;
const ADMIN_ID = 8447147405;

const bot = new TelegramBot(TOKEN, { polling: true });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('SMaster запущен!');

bot.setMyCommands([
    { command: 'start', description: '🏛 Главное меню' },
    { command: 'wallet', description: '💼 Мой кошелек' },
    { command: 'deposit', description: '💳 Пополнить' },
    { command: 'send', description: '📤 Перевести' },
    { command: 'play', description: '🚀 Ракета' },
    { command: 'ref', description: '🎁 Рефералка' },
    { command: 'promo', description: '🎟 Промокод' },
    { command: 'help', description: '❓ Помощь' }
]);

const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '💼 Мой кошелек' }, { text: '💳 Пополнить' }],
            [{ text: '📤 Перевести' }, { text: '🚀 Ракета' }],
            [{ text: '🎁 Рефералка' }, { text: '🎟 Промокод' }],
            [{ text: '📊 Курсы' }, { text: '📱 Открыть App' }],
            [{ text: 'ℹ️ О боте' }]
        ],
        resize_keyboard: true
    }
};

const userStates = {};

// --- ФУНКЦИЯ КОШЕЛЬКА ---
async function showWallet(chatId) {
    let { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).maybeSingle();
    if (!wallet) {
        const { data: newWallet } = await sb.from('smaster_wallets').insert({ user_id: chatId, username: 'user', balance_usdt: 0, balance_ton: 0 }).select().single();
        wallet = newWallet;
    }
    if (wallet) {
        bot.sendMessage(chatId, `💼 Твой кошелек SMaster\n\n💵 USDT: ${wallet.balance_usdt.toFixed(2)} $\n💎 TON: ${wallet.balance_ton.toFixed(2)} TON\n\n🆔 Твой ID: ${wallet.user_id}`, mainMenu);
    }
}

// --- СТАРТ ---
bot.onText(/\/start/, async (msg) => {
    await showWallet(msg.chat.id);
    bot.sendMessage(msg.chat.id, `👋 Привет, ${msg.from.first_name || 'друг'}!\n\nДобро пожаловать в SMaster.\n\nИспользуй меню ниже.`, mainMenu);
});

// --- /wallet ---
bot.onText(/\/wallet/, (msg) => showWallet(msg.chat.id));

// --- ОСНОВНОЙ ОБРАБОТЧИК ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Кнопки
    if (text === '💼 Мой кошелек') return showWallet(chatId);
    if (text === '📊 Курсы') return bot.sendMessage(chatId, `📊 Курсы\n\n1 USDT = 1$\n1 TON = 5.2$`, mainMenu);
    if (text === 'ℹ️ О боте') return bot.sendMessage(chatId, `🦫 SMaster by Solo_Men Studios`, mainMenu);
    if (text === '📱 Открыть App') return bot.sendMessage(chatId, `📱 Скоро здесь будет мини-приложение!`, mainMenu);

    // ПОПОЛНЕНИЕ
    if (text === '💳 Пополнить' || text === '/deposit') {
        userStates[chatId] = { step: 'deposit_amount' };
        return bot.sendMessage(chatId, '💳 Введи сумму пополнения в USDT:');
    }

    // ПЕРЕВОД
    if (text === '📤 Перевести' || text === '/send') {
        userStates[chatId] = { step: 'send_username' };
        return bot.sendMessage(chatId, '📤 Введи username получателя (без @):');
    }

    // РАКЕТА
    if (text === '🚀 Ракета' || text === '/play') {
        userStates[chatId] = { step: 'rocket_bet' };
        return bot.sendMessage(chatId, '🚀 Введи сумму ставки в USDT:');
    }

    // РЕФЕРАЛКА
    if (text === '🎁 Рефералка') {
        return bot.sendMessage(chatId, `🎁 Твоя ссылка:\nt.me/SMasterWallet_bot?start=ref_${chatId}`, mainMenu);
    }

    // ПРОМОКОД
    if (text === '🎟 Промокод') {
        userStates[chatId] = { step: 'promo_code' };
        return bot.sendMessage(chatId, '🎟 Введи промокод:');
    }

    // Обработка состояний
    if (!userStates[chatId]) return;
    const state = userStates[chatId];

    // --- ПОПОЛНЕНИЕ ---
    if (state.step === 'deposit_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи сумму:');
        const invoice = await createCryptoInvoice(amount, 'Пополнение SMaster');
        if (invoice) {
            bot.sendMessage(chatId, `💳 Счет на ${amount} USDT:`, { reply_markup: { inline_keyboard: [[{ text: `Оплатить`, url: invoice.bot_invoice_url }]] } });
        } else {
            bot.sendMessage(chatId, '❌ Ошибка.', mainMenu);
        }
        delete userStates[chatId];
        return;
    }

    // --- ПЕРЕВОД ---
    if (state.step === 'send_username') {
        state.targetUser = text.toLowerCase().replace('@', '');
        state.step = 'send_amount';
        return bot.sendMessage(chatId, '💰 Введи сумму перевода в USDT:');
    }
    if (state.step === 'send_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи сумму:');
        const { data: sender } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
        if (!sender || sender.balance_usdt < amount) return bot.sendMessage(chatId, '❌ Мало денег.', mainMenu);
        const { data: receiver } = await sb.from('smaster_wallets').select('*').eq('username', state.targetUser).maybeSingle();
        if (!receiver) return bot.sendMessage(chatId, '❌ Не найден.', mainMenu);
        const fee = amount * 0.01;
        await sb.from('smaster_wallets').update({ balance_usdt: sender.balance_usdt - amount }).eq('user_id', chatId);
        await sb.from('smaster_wallets').update({ balance_usdt: receiver.balance_usdt + (amount - fee) }).eq('user_id', receiver.user_id);
        bot.sendMessage(chatId, `✅ Перевод выполнен!`, mainMenu);
        delete userStates[chatId];
        return;
    }

    // --- РАКЕТА ---
    if (state.step === 'rocket_bet') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи сумму:');
        const { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
        if (!wallet || wallet.balance_usdt < amount) return bot.sendMessage(chatId, '❌ Мало денег.', mainMenu);
        const isWin = Math.random() < 0.000001;
        if (isWin) {
            await sb.from('smaster_wallets').update({ balance_usdt: wallet.balance_usdt + (amount * 100) }).eq('user_id', chatId);
            bot.sendMessage(chatId, `🚀 ДЖЕКПОТ! +${amount * 100} USDT!`, mainMenu);
        } else {
            await sb.from('smaster_wallets').update({ balance_usdt: wallet.balance_usdt - amount }).eq('user_id', chatId);
            bot.sendMessage(chatId, `💥 Взрыв! -${amount} USDT.`, mainMenu);
        }
        delete userStates[chatId];
        return;
    }

    // --- ПРОМОКОД ---
    if (state.step === 'promo_code') {
        const code = text.toUpperCase();
        const { data: promo } = await sb.from('promo_codes').select('*').eq('code', code).eq('active', true).maybeSingle();
        if (!promo) return bot.sendMessage(chatId, '❌ Неверный промокод.', mainMenu);
        const { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
        await sb.from('smaster_wallets').update({ balance_usdt: wallet.balance_usdt + promo.bonus }).eq('user_id', chatId);
        await sb.from('promo_codes').update({ active: false }).eq('id', promo.id);
        bot.sendMessage(chatId, `🎉 Промокод активирован! +${promo.bonus} USDT`, mainMenu);
        delete userStates[chatId];
        return;
    }
});// --- ФУНКЦИЯ СОЗДАНИЯ СЧЕТА ---
function createCryptoInvoice(amount, description) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ asset: 'USDT', amount: String(amount), description: description });
        const req = https.request({
            hostname: 'pay.crypt.bot', path: '/api/createInvoice', method: 'POST',
            headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { const j = JSON.parse(data); resolve(j.ok ? j.result : null); } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

// --- АДМИН-ПАНЕЛЬ ---
bot.onText(/\/admin/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, `👑 Админка:\n/admin_addbalance ID сумма\n/admin_broadcast текст\n/admin_addpromo КОД БОНУС`);
});

bot.onText(/\/admin_addbalance (\d+) (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const id = match[1], amount = parseFloat(match[2]);
    await sb.from('smaster_wallets').update({ balance_usdt: amount }).eq('user_id', id);
    bot.sendMessage(msg.chat.id, `✅ Выдано ${amount} USDT пользователю ${id}`);
});

bot.onText(/\/admin_broadcast (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const allUsers = await sb.from('smaster_wallets').select('user_id');
    allUsers.data.forEach(u => bot.sendMessage(u.user_id, match[1]).catch(() => {}));
    bot.sendMessage(msg.chat.id, '✅ Рассылка отправлена!');
});

bot.onText(/\/admin_addpromo (\S+) (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const code = match[1].toUpperCase(), bonus = parseFloat(match[2]);
    await sb.from('promo_codes').insert({ code: code, bonus: bonus, active: true });
    bot.sendMessage(msg.chat.id, `✅ Промокод ${code} создан!`);

