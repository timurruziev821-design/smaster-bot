const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMaster Bot is running!');
}).listen(PORT, () => console.log('Веб-сервер на порту ' + PORT));

const TOKEN = process.env.SMASTER_BOT_TOKEN;
const SUPABASE_URL = 'https://dnrbvyuoiphvkezwxbc.supabase.co';
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
    { command: 'help', description: '❓ Помощь' }
]);

const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '💼 Мой кошелек' }, { text: '💳 Пополнить' }],
            [{ text: '📤 Перевести' }, { text: '🚀 Ракета' }],
            [{ text: '🎁 Рефералка' }, { text: '📊 Курсы' }],
            [{ text: '📱 Открыть App' }, { text: 'ℹ️ О боте' }]
        ],
        resize_keyboard: true
    }
};

const userStates = {};

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

bot.onText(/\/start/, async (msg) => {
    await showWallet(msg.chat.id);
    bot.sendMessage(msg.chat.id, `👋 Привет, ${msg.from.first_name || 'друг'}!\n\nДобро пожаловать в SMaster.`, mainMenu);
});

bot.onText(/\/wallet/, (msg) => showWallet(msg.chat.id));

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '💼 Мой кошелек') return showWallet(chatId);
    if (text === '📊 Курсы') return bot.sendMessage(chatId, `📊 Курсы\n\n1 USDT = 1$\n1 TON = 5.2$`, mainMenu);
    if (text === 'ℹ️ О боте') return bot.sendMessage(chatId, `🦫 SMaster by Solo_Men Studios`, mainMenu);
    if (text === '📱 Открыть App') return bot.sendMessage(chatId, `📱 Скоро будет мини-приложение!`, mainMenu);

    if (text === '💳 Пополнить' || text === '/deposit') {
        userStates[chatId] = { step: 'deposit_amount' };
        return bot.sendMessage(chatId, '💳 Введи сумму пополнения в USDT:');
    }

    if (text === '📤 Перевести' || text === '/send') {
        userStates[chatId] = { step: 'send_username' };
        return bot.sendMessage(chatId, '📤 Введи username получателя (без @):');
    }

    if (text === '🚀 Ракета' || text === '/play') {
        userStates[chatId] = { step: 'rocket_bet' };
        return bot.sendMessage(chatId, '🚀 Введи сумму ставки в USDT:');
    }

    if (text === '🎁 Рефералка') {
        return bot.sendMessage(chatId, `🎁 Твоя ссылка:\nt.me/SMasterWallet_bot?start=ref_${chatId}`, mainMenu);
    }

    if (!userStates[chatId]) return;
    const state = userStates[chatId];

    if (state.step === 'deposit_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи корректную сумму:');
        const invoice = await createCryptoInvoice(amount, 'Пополнение SMaster');
        if (invoice && invoice.bot_invoice_url) {
            bot.sendMessage(chatId, `💳 Счет на ${amount} USDT:`, { reply_markup: { inline_keyboard: [[{ text: 'Оплатить', url: invoice.bot_invoice_url }]] } });
        } else {
            bot.sendMessage(chatId, '❌ Ошибка.', mainMenu);
        }
        delete userStates[chatId];
        return;
    }

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
});

function createCryptoInvoice(amount, description) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ asset: 'USDT', amount: String(amount), description: description, payload: 'smaster_' + Date.now() });
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

bot.onText(/\/cancel/, (msg) => {
    delete userStates[msg.chat.id];
    bot.sendMessage(msg.chat.id, '❌ Отменено.', mainMenu);
});

bot.onText(/\/admin_addbalance (\d+) (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const id = match[1], amount = parseFloat(match[2]);
    await sb.from('smaster_wallets').update({ balance_usdt: amount }).eq('user_id', id);
    bot.sendMessage(msg.chat.id, `✅ Выдано ${amount} USDT пользователю ${id}`);
});
