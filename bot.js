const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');

// --- ВЕБ-СЕРВЕР (чтобы Render не убивал бота) ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMaster Bot is running!');
}).listen(PORT, () => console.log('Веб-сервер на порту ' + PORT));

// --- НАСТРОЙКИ ---
const TOKEN = process.env.SMASTER_BOT_TOKEN;
const SUPABASE_URL = 'https://dnrbvyuoiphvkezwxbc.supabase.co';
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

// --- ГЛАВНОЕ МЕНЮ (Добавил кнопку App) ---
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

// --- ФУНКЦИЯ СОЗДАНИЯ КОШЕЛЬКА (если его нет) ---
async function ensureWallet(chatId, username) {
    let { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).maybeSingle();
    if (!wallet) {
        const { data: newWallet, error } = await sb.from('smaster_wallets').insert({
            user_id: chatId,
            username: username || 'unknown',
            balance_usdt: 0,
            balance_ton: 0
        }).select().single();
        if (error) console.log('Ошибка создания кошелька:', error);
        return newWallet;
    }
    return wallet;
}

// --- /start (и кнопка Кошелек) ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'друг';
    const username = msg.from.username || 'unknown';

    await ensureWallet(chatId, username);

    bot.sendMessage(chatId, 
        `👋 Привет, ${name}!\n\nДобро пожаловать в SMaster.\n\n` +
        `Здесь ты можешь хранить USDT и TON, переводить друзьям и играть в Ракету.`,
        mainMenu
    );
});

// --- /wallet ---
bot.onText(/\/wallet/, async (msg) => {
    const chatId = msg.chat.id;
    const wallet = await ensureWallet(chatId, msg.from.username);
    if (wallet) {
        bot.sendMessage(chatId, 
            `💼 Твой кошелек SMaster\n\n` +
            `💵 USDT: ${wallet.balance_usdt.toFixed(2)} $\n` +
            `💎 TON: ${wallet.balance_ton.toFixed(2)} TON\n\n` +
            `🆔 Твой ID: ${wallet.user_id}`,
            mainMenu
        );
    }
});

// --- КНОПКИ ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '💼 Мой кошелек') {
        bot.emit('text', { ...msg, text: '/wallet' });
    }
    
    if (text === '📱 Открыть App') {
        bot.sendMessage(chatId, '📱 Скоро здесь будет мини-приложение (WebApp)!', mainMenu);
    }

    // Остальные кнопки (Пополнение, Перевод, Ракета) добавим после проверки
});
