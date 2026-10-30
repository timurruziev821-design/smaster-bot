const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

// --- ВЕБ-СЕРВЕР ДЛЯ RENDER ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SMaster Bot is running!');
}).listen(PORT, () => console.log('Веб-сервер на порту ' + PORT));

// --- НАСТРОЙКИ (Берем из переменных Render) ---
const TOKEN = process.env.SMASTER_BOT_TOKEN;
const SUPABASE_URL = 'https://dnrbvyuoiphvkezwxbc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('SMaster запущен!');

// --- КОМАНДЫ В МЕНЮ (Автоподсказки) ---
bot.setMyCommands([
    { command: 'start', description: '🏛 Главное меню' },
    { command: 'wallet', description: '💼 Мой кошелек' },
    { command: 'deposit', description: '💳 Пополнить' },
    { command: 'send', description: '📤 Перевести' },
    { command: 'play', description: '🚀 Игра Ракета' },
    { command: 'ref', description: '🎁 Рефералка' },
    { command: 'rates', description: '📊 Курсы' },
    { command: 'help', description: '❓ Помощь' }
]);

// --- ГЛАВНОЕ МЕНЮ ---
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '💼 Мой кошелек' }, { text: '💳 Пополнить' }],
            [{ text: '📤 Перевести' }, { text: '🚀 Ракета' }],
            [{ text: '🎁 Рефералка' }, { text: '📊 Курсы' }],
            [{ text: 'ℹ️ О боте' }]
        ],
        resize_keyboard: true
    }
};

// --- /start ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'друг';

    let { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).maybeSingle();
    
    if (!wallet) {
        await sb.from('smaster_wallets').insert({
            user_id: chatId,
            username: msg.from.username || 'unknown',
            balance_usdt: 0,
            balance_ton: 0
        });
    }

    bot.sendMessage(chatId, 
        `👋 Привет, ${name}!\n\n` +
        `Добро пожаловать в **SMaster** — твой крипто-кошелек прямо в Telegram.\n\n` +
        `Здесь ты можешь хранить USDT и TON, переводить их друзьям и играть в Ракету.`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

// --- /wallet (Кошелек) ---
bot.onText(/\/wallet/, async (msg) => {
    const chatId = msg.chat.id;
    const { data: wallet } = await sb.from('smaster_wallets').select('*').eq('user_id', chatId).single();
    
    if (wallet) {
        bot.sendMessage(chatId, 
            `💼 **Твой кошелек SMaster**\n\n` +
            `💵 USDT: ${wallet.balance_usdt.toFixed(2)} $\n` +
            `💎 TON: ${wallet.balance_ton.toFixed(2)} TON\n\n` +
            `🆔 Твой ID: \`${wallet.user_id}\``,
            { parse_mode: 'Markdown', ...mainMenu }
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
    if (text === '📊 Курсы') {
        bot.sendMessage(chatId, `📊 **Курсы**\n\n1 USDT = 1$\n1 TON = 5.2$`, { parse_mode: 'Markdown', ...mainMenu });
    }
    if (text === 'ℹ️ О боте') {
        bot.sendMessage(chatId, `🦫 **SMaster** by Solo_Men Studios\nВерсия 1.0 Beta`, { parse_mode: 'Markdown', ...mainMenu });
    }
});
