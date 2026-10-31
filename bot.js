const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

// --- ВЕБ-СЕРВЕР (Чтобы Render не убивал бота) ---
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

const bot = new TelegramBot(TOKEN, { polling: true });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('SMaster запущен!');

bot.setMyCommands([
    { command: 'start', description: '🏛 Главное меню' },
    { command: 'wallet', description: '💰 Баланс' },
    { command: 'deposit', description: '💳 Пополнить' },
    { command: 'send', description: '📤 Перевести' },
    { command: 'play', description: '🚀 Ракета' },
    { command: 'help', description: '❓ Помощь' }
]);

// --- МЕНЮ ---
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 Баланс' }, { text: '💳 Пополнить' }],
            [{ text: '📤 Перевести' }, { text: '🚀 Ракета' }],
            [{ text: '🎁 Рефералка' }, { text: '📊 Курсы' }]
        ],
        resize_keyboard: true
    }
};

const sessions = {};

// --- СОЗДАНИЕ / ПРОВЕРКА КОШЕЛЬКА ---
async function ensureWallet(chatId, username) {
    let { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).maybeSingle();
    if (!wallet) {
        const { data: newWallet } = await sb.from('smaster_wallets').insert({
            user_id: chatId, username: username || 'user', balance_usdt: 0, balance_ton: 0
        }).select().single();
        return newWallet;
    }
    return wallet;
}

// --- ПОКАЗ БАЛАНСА (С индикатором загрузки) ---
async function showWallet(chatId, userId, username) {
    const msg = await bot.sendMessage(chatId, '⏳ Загружаю баланс...');
    
    try {
        let { data: wallet, error } = await sb.from('smaster_wallets').select('*').eq('user_id', userId).maybeSingle();
        
        if (error) throw new Error('Ошибка БД (select): ' + error.message);

        if (!wallet) {
            const { data: newWallet, error: insertError } = await sb.from('smaster_wallets').insert({
                user_id: userId, username: username || 'user', balance_usdt: 0, balance_ton: 0
            }).select().single();
            
            if (insertError) throw new Error('Ошибка БД (insert): ' + insertError.message);
            wallet = newWallet;
        }

        await bot.editMessageText(
            `💰 Твой Баланс SMaster\n\n` +
            `💵 USDT: ${Number(wallet.balance_usdt || 0).toFixed(2)} $\n` +
            `💎 TON: ${Number(wallet.balance_ton || 0).toFixed(2)} TON\n\n` +
            `🆔 Твой ID: ${wallet.user_id}`, 
            { chat_id: chatId, message_id: msg.message_id, ...mainMenu }
        );

    } catch (e) {
        console.error(e);
        bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: msg.message_id, ...mainMenu }).catch(() => {});
    }
}

// --- КОМАНДЫ ---
bot.onText(/\/start/, async (msg) => {
    delete sessions[msg.from.id];
    await ensureWallet(msg.from.id, msg.from.username);
    bot.sendMessage(msg.chat.id, `👋 Привет, ${msg.from.first_name || 'друг'}!\n\nДобро пожаловать в SMaster. Выбери действие на клавиатуре снизу.`, mainMenu);
});

bot.onText(/\/wallet/, async (msg) => {
    delete sessions[msg.from.id];
    await showWallet(msg.chat.id, msg.from.id, msg.from.username);
});

// --- ОБРАБОТКА СООБЩЕНИЙ И КНОПОК ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    const menuButtons = ['💰 Баланс', '💳 Пополнить', '📤 Перевести', '🚀 Ракета', '🎁 Рефералка', '📊 Курсы'];
    if (menuButtons.includes(text)) {
        delete sessions[userId];
    }

    if (text === '💰 Баланс') return await showWallet(chatId, userId, msg.from.username);
    if (text === '📊 Курсы') return bot.sendMessage(chatId, `📊 Курсы\n\n1 USDT = 1$\n1 TON = 5.2$`, mainMenu);
    if (text === '🎁 Рефералка') return bot.sendMessage(chatId, `🎁 Твоя ссылка:\nt.me/SMasterWallet_bot?start=ref_${userId}`, mainMenu);

    if (text === '💳 Пополнить') {
        sessions[userId] = { action: 'deposit' };
        return bot.sendMessage(chatId, '💳 Введи сумму пополнения в USDT:');
    }

    if (text === '📤 Перевести') {
        sessions[userId] = { action: 'send_user' };
        return bot.sendMessage(chatId, '📤 Введи username получателя (без @):');
    }

    if (text === '🚀 Ракета') {
        sessions[userId] = { action: 'rocket' };
        return bot.sendMessage(chatId, '🚀 Введи сумму ставки в USDT:');
    }

    const session = sessions[userId];
    if (!session) return; 

    if (session.action === 'deposit') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число:');
        delete sessions[userId];
        bot.sendMessage(chatId, '⏳ Создаю счет...');
        const invoice = await createCryptoInvoice(amount);
        if (invoice && invoice.bot_invoice_url) {
            bot.sendMessage(chatId, `💳 Счет на ${amount} USDT:`, { reply_markup: { inline_keyboard: [[{ text: 'Оплатить', url: invoice.bot_invoice_url }]] } });
        } else {
            bot.sendMessage(chatId, '❌ Ошибка CryptoBot.', mainMenu);
        }
        return;
    }

    if (session.action === 'send_user') {
        session.targetUser = text.toLowerCase().replace('@', '');
        session.action = 'send_amount';
        return bot.sendMessage(chatId, '💰 Введи сумму перевода в USDT:');
    }

    if (session.action === 'send_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число:');
        const { data: sender } = await sb.from('smaster_wallets').select('*').eq('user_id', userId).single();
        if (!sender || Number(sender.balance_usdt) < amount) return bot.sendMessage(chatId, '❌ Недостаточно средств.', mainMenu);
        const { data: receiver } = await sb.from('smaster_wallets').select('*').eq('username', session.targetUser).maybeSingle();
        if (!receiver) return bot.sendMessage(chatId, '❌ Пользователь не найден.', mainMenu);
        const fee = amount * 0.01;
        await sb.from('smaster_wallets').update({ balance_usdt: Number(sender.balance_usdt) - amount }).eq('user_id', userId);
        await sb.from('smaster_wallets').update({ balance_usdt: Number(receiver.balance_usdt) + (amount - fee) }).eq('user_id', receiver.user_id);
        delete sessions[userId];
        bot.sendMessage(chatId, `✅ Перевод выполнен!\nОтправлено: ${amount} USDT\nКомиссия: ${fee.toFixed(2)} USDT`, mainMenu);
        return;
    }

    if (session.action === 'rocket') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи число:');
        const { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', userId).single();
        if (!wallet || Number(wallet.balance_usdt) < amount) return bot.sendMessage(chatId, '❌ Недостаточно средств.', mainMenu);
        delete sessions[userId];
        const isWin = Math.random() < 0.000001;
        if (isWin) {
            await sb.from('smaster_wallets').update({ balance_usdt: Number(wallet.balance_usdt) + (amount * 100) }).eq('user_id', userId);
            bot.sendMessage(chatId, `🚀 ДЖЕКПОТ! Ты выиграл ${amount * 100} USDT!`, mainMenu);
        } else {
            await sb.from('smaster_wallets').update({ balance_usdt: Number(wallet.balance_usdt) - amount }).eq('user_id', userId);
            bot.sendMessage(chatId, `💥 Ракета взорвалась! Ты потерял ${amount} USDT.`, mainMenu);
        }
        return;
    }
});

// --- CRYPTOBOT ---
function createCryptoInvoice(amount) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ asset: 'USDT', amount: String(amount), description: 'SMaster deposit' });
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

process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('uncaughtException', (err) => console.error('Ошибка:', err));
