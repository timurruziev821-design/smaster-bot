const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

// --- ВЕБ-СЕРВЕР ДЛЯ RENDER ---
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

// --- КОМАНДЫ В МЕНЮ ---
bot.setMyCommands([
    { command: 'start', description: '🏛 Главное меню' },
    { command: 'wallet', description: '💼 Мой кошелек' },
    { command: 'deposit', description: '💳 Пополнить' },
    { command: 'send', description: '📤 Перевести' },
    { command: 'play', description: '🚀 Игра Ракета' },
    { command: 'ref', description: '🎁 Рефералка' },
    { command: 'help', description: '❓ Помощь' }
]);

// --- МЕНЮ ---
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

// --- ФУНКЦИЯ ДЛЯ КОШЕЛЬКА (С АВТОСОЗДАНИЕМ) ---
async function showWallet(chatId) {
    let { data: wallet, error } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).maybeSingle();
    
    if (!wallet) {
        const { data: newWallet, error: createError } = await sb.from('smaster_wallets').insert({
            user_id: chatId, username: 'user', balance_usdt: 0, balance_ton: 0
        }).select().single();
        
        if (createError) {
            bot.sendMessage(chatId, '⚠️ Ошибка базы. Попробуй /start', mainMenu);
            return;
        }
        wallet = newWallet;
    }

    bot.sendMessage(chatId, 
        `💼 Твой кошелек SMaster\n\n` +
        `💵 USDT: ${wallet.balance_usdt.toFixed(2)} $\n` +
        `💎 TON: ${wallet.balance_ton.toFixed(2)} TON\n\n` +
        `🆔 Твой ID: ${wallet.user_id}`,
        mainMenu
    );
}

// --- /start ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'друг';

    await showWallet(chatId);
    bot.sendMessage(chatId, `👋 Привет, ${name}!\n\nДобро пожаловать в SMaster.\n\nИспользуй меню ниже.`, mainMenu);
});

// --- /wallet ---
bot.onText(/\/wallet/, (msg) => showWallet(msg.chat.id));

// --- /rates ---
bot.onText(/\/rates/, (msg) => {
    bot.sendMessage(msg.chat.id, `📊 Курсы\n\n1 USDT = 1$\n1 TON = 5.2$`, mainMenu);
});

// --- /help ---
bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `❓ Помощь\n\n/wallet — кошелек\n/deposit — пополнить\n/send — перевести\n/play — ракета`, mainMenu);
});

// --- ОБРАБОТКА КНОПОК ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '💼 Мой кошелек') showWallet(chatId);
    if (text === '📊 Курсы') bot.sendMessage(chatId, `📊 Курсы\n\n1 USDT = 1$\n1 TON = 5.2$`, mainMenu);
    if (text === 'ℹ️ О боте') bot.sendMessage(chatId, `🦫 SMaster by Solo_Men Studios\nВерсия 1.0 Beta`, mainMenu);
    if (text === '📱 Открыть App') bot.sendMessage(chatId, '📱 Скоро здесь будет мини-приложение!', mainMenu);

    // Пополнение
    if (text === '💳 Пополнить' || text === '/deposit') {
        userStates[chatId] = { step: 'deposit_amount' };
        bot.sendMessage(chatId, '💳 Введи сумму пополнения в USDT:\n\n/cancel — отмена');
    }

    // Перевод
    if (text === '📤 Перевести' || text === '/send') {
        userStates[chatId] = { step: 'send_username' };
        bot.sendMessage(chatId, '📤 Введи username получателя (без @):\n\n/cancel — отмена');
    }

    // Ракета
    if (text === '🚀 Ракета' || text === '/play') {
        userStates[chatId] = { step: 'rocket_bet' };
        bot.sendMessage(chatId, '🚀 Введи сумму ставки в USDT:\n\n/cancel — отмена');
    }

    // Рефералка
    if (text === '🎁 Рефералка') {
        bot.sendMessage(chatId, `🎁 Твоя реферальная ссылка:\n\nt.me/SMasterWallet_bot?start=ref_${chatId}`, mainMenu);
    }

    // Обработка состояний
    if (!userStates[chatId]) return;
    const state = userStates[chatId];

    if (state.step === 'deposit_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Введи корректную сумму:'); return; }
        bot.sendMessage(chatId, '⏳ Создаю счет...');
        const invoice = await createCryptoInvoice(amount, 'Пополнение SMaster');
        if (invoice && invoice.bot_invoice_url) {
            bot.sendMessage(chatId, `💳 Счет на ${amount} USDT создан!\n\nНажми кнопку чтобы оплатить:`, 
                { reply_markup: { inline_keyboard: [[{ text: `Оплатить ${amount} USDT`, url: invoice.bot_invoice_url }]] } }
            );
        } else { bot.sendMessage(chatId, '❌ Ошибка создания счета.', mainMenu); }
        delete userStates[chatId];
        return;
    }

    if (state.step === 'send_username') {
        state.targetUser = text.toLowerCase().replace('@', '');
        state.step = 'send_amount';
        bot.sendMessage(chatId, '💰 Введи сумму перевода в USDT:');
        return;
    }

    if (state.step === 'send_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Введи корректную сумму:'); return; }

        const { data: sender } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
        if (!sender || sender.balance_usdt < amount) { bot.sendMessage(chatId, '❌ Недостаточно средств.', mainMenu); delete userStates[chatId]; return; }

        const { data: receiver } = await sb.from('smaster_wallets').select('*').eq('username', state.targetUser).maybeSingle();
        if (!receiver) { bot.sendMessage(chatId, '❌ Пользователь не найден.', mainMenu); delete userStates[chatId]; return; }

        const fee = amount * 0.01;
        const totalToReceive = amount - fee;

        await sb.from('smaster_wallets').update({ balance_usdt: sender.balance_usdt - amount }).eq('user_id', chatId);
        await sb.from('smaster_wallets').update({ balance_usdt: receiver.balance_usdt + totalToReceive }).eq('user_id', receiver.user_id);
        
        bot.sendMessage(chatId, `✅ Перевод выполнен!\n\nОтправлено: ${amount} USDT\nКомиссия: ${fee.toFixed(2)} USDT`, mainMenu);
        delete userStates[chatId];
        return;
    }

    if (state.step === 'rocket_bet') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Введи корректную сумму:'); return; }

        const { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
        if (!wallet || wallet.balance_usdt < amount) { bot.sendMessage(chatId, '❌ Недостаточно средств.', mainMenu); delete userStates[chatId]; return; }

        // Шанс выигрыша 1 на миллион
        const isWin = Math.random() < 0.000001;
        
        if (isWin) {
            const winAmount = amount * 100;
            await sb.from('smaster_wallets').update({ balance_usdt: wallet.balance_usdt + winAmount }).eq('user_id', chatId);
            bot.sendMessage(chatId, `🚀 ДЖЕКПОТ! Ты выиграл ${winAmount} USDT!`, mainMenu);
        } else {
            await sb.from('smaster_wallets').update({ balance_usdt: wallet.balance_usdt - amount }).eq('user_id', chatId);
            bot.sendMessage(chatId, `💥 Ракета взорвалась! Ты потерял ${amount} USDT.`, mainMenu);
        }
        delete userStates[chatId];
        return;
    }
});

// --- ФУНКЦИЯ ДЛЯ CRYPTOBOT ---
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
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) resolve(json.result);
                    else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

// --- ОТМЕНА ---
bot.onText(/\/cancel/, (msg) => {
    delete userStates[msg.chat.id];
    bot.sendMessage(msg.chat.id, '❌ Отменено.', mainMenu);
});
