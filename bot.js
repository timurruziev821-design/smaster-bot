// SMaster Telegram Bot — Node.js
// Требуются переменные окружения:
// SMaster_BOT_TOKEN (или SMASTER_BOT_TOKEN), SUPABASE_URL, SUPABASE_KEY,
// CRYPTOBOT_TOKEN, PUBLIC_URL (например https://your-app.onrender.com)

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TOKEN = process.env.SMASTER_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dnrbvyuoiiphvkezwxbc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY; // На сервере используйте service_role key, не публикуйте его.
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !CRYPTOBOT_TOKEN) {
    throw new Error('Не заданы SMASTER_BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY или CRYPTOBOT_TOKEN');
}

const bot = new TelegramBot(TOKEN, { polling: true });
const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});

const sessions = new Map();

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

function parseAmount(value) {
    const raw = String(value || '').trim().replace(',', '.');
    if (!/^(?:\d+)(?:\.\d{1,6})?$/.test(raw)) return null;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;
    return amount;
}

async function getWallet(userId, username) {
    const { data, error } = await db
        .from('smaster_wallets')
        .upsert({
            user_id: userId,
            username: username || null
        }, { onConflict: 'user_id', ignoreDuplicates: true })
        .select('*')
        .maybeSingle();

    if (error) throw error;

    // При ignoreDuplicates Supabase может вернуть null — тогда читаем существующую запись.
    if (data) return data;

    const result = await db
        .from('smaster_wallets')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (result.error) throw result.error;
    return result.data;
}

async function showWallet(chatId, userId, username) {
    try {
        const wallet = await getWallet(userId, username);
        return bot.sendMessage(
            chatId,
            `💰 Твой баланс SMaster\n\n` +
            `💵 USDT: ${Number(wallet.balance_usdt || 0).toFixed(2)} $\n` +
            `💎 TON: ${Number(wallet.balance_ton || 0).toFixed(2)} TON\n\n` +
            `🆔 ID: ${wallet.user_id}`,
            mainMenu
        );
    } catch (error) {
        console.error('showWallet:', error);
        return bot.sendMessage(chatId, '❌ Не удалось загрузить баланс. Попробуй позже.', mainMenu);
    }
}

function cryptoRequest(path, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'pay.crypt.bot',
            path,
            method: 'POST',
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 15000
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    return reject(new Error('CryptoBot вернул некорректный ответ'));
                }
                if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.ok) {
                    return reject(new Error(parsed.error?.name || 'Ошибка CryptoBot API'));
                }
                resolve(parsed.result);
            });
        });

        req.on('timeout', () => req.destroy(new Error('Тайм-аут CryptoBot')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function createDepositInvoice(userId, amount) {
    const invoice = await cryptoRequest('/api/createInvoice', {
        asset: 'USDT',
        amount: String(amount),
        description: `SMaster deposit for ${userId}`,
        payload: String(userId)
    });

    if (!invoice?.invoice_id || !invoice?.bot_invoice_url) {
        throw new Error('CryptoBot не вернул данные счёта');
    }

    const { error } = await db.from('smaster_deposits').insert({
        invoice_id: String(invoice.invoice_id),
        user_id: userId,
        amount: amount,
        asset: 'USDT',
        status: 'pending'
    });

    if (error) throw error;
    return invoice;
}

function verifyCryptoSignature(rawBody, signature) {
    if (!signature || !CRYPTOBOT_TOKEN) return false;

    const secret = crypto.createHash('sha256').update(CRYPTOBOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(signature, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

async function handleCryptoWebhook(rawBody, signature) {
    if (!verifyCryptoSignature(rawBody, signature)) {
        throw new Error('Неверная подпись CryptoBot');
    }

    const update = JSON.parse(rawBody.toString('utf8'));
    const invoice = update?.payload;

    if (update?.update_type !== 'invoice_paid' || !invoice) {
        return { ignored: true };
    }

    if (invoice.status !== 'paid' || invoice.asset !== 'USDT') {
        throw new Error('Статус или валюта счёта не подходят');
    }

    const invoiceId = String(invoice.invoice_id || '');
    const amount = parseAmount(invoice.amount);

    if (!invoiceId || amount === null) {
        throw new Error('Некорректные данные счёта');
    }

    const { data, error } = await db.rpc('credit_smaster_deposit', {
        p_invoice_id: invoiceId,
        p_amount: amount,
        p_asset: 'USDT'
    });

    if (error) throw error;
    return data;
}

bot.setMyCommands([
    { command: 'start', description: '🏛 Главное меню' },
    { command: 'wallet', description: '💰 Баланс' },
    { command: 'deposit', description: '💳 Пополнить' },
    { command: 'send', description: '📤 Перевести' },
    { command: 'play', description: '🚀 Ракета (демо)' },
    { command: 'help', description: '❓ Помощь' }
]).catch(console.error);

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    sessions.delete(msg.from.id);
    try {
        await getWallet(msg.from.id, msg.from.username);
        const ref = match?.[1];
        bot.sendMessage(
            msg.chat.id,
            `👋 Привет, ${msg.from.first_name || 'друг'}!\nДобро пожаловать в SMaster.`,
            mainMenu
        );

        // Реферальный параметр пока только распознаётся.
        // Начисление бонусов следует добавлять отдельной защищённой SQL-транзакцией.
        if (ref?.startsWith('ref_')) {
            console.log(`Referral start: user=${msg.from.id}, ref=${ref.slice(4)}`);
        }
    } catch (error) {
        console.error('/start:', error);
        bot.sendMessage(msg.chat.id, '❌ Не удалось создать кошелёк. Попробуй позже.');
    }
});

bot.onText(/^\/wallet$/, msg => {
    sessions.delete(msg.from.id);
    showWallet(msg.chat.id, msg.from.id, msg.from.username);
});

bot.onText(/^\/deposit$/, msg => {
    sessions.set(msg.from.id, { action: 'deposit' });
    bot.sendMessage(msg.chat.id, '💳 Введи сумму пополнения в USDT:');
});

bot.onText(/^\/send$/, msg => {
    sessions.set(msg.from.id, { action: 'send_user' });
    bot.sendMessage(msg.chat.id, '📤 Введи username получателя без @:');
});

bot.onText(/^\/play$/, msg => {
    sessions.set(msg.from.id, { action: 'rocket_demo' });
    bot.sendMessage(msg.chat.id, '🚀 Демо-режим ракеты: введи виртуальную ставку (баланс не меняется):');
});

bot.onText(/^\/help$/, msg => {
    bot.sendMessage(
        msg.chat.id,
        'Команды:\n/start — меню\n/wallet — баланс\n/deposit — пополнение\n/send — перевод\n/play — демо-ракета',
        mainMenu
    );
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    if (text === '💰 Баланс') {
        sessions.delete(userId);
        return showWallet(chatId, userId, msg.from.username);
    }

    if (text === '💳 Пополнить') {
        sessions.set(userId, { action: 'deposit' });
        return bot.sendMessage(chatId, '💳 Введи сумму пополнения в USDT:');
    }

    if (text === '📤 Перевести') {
        sessions.set(userId, { action: 'send_user' });
        return bot.sendMessage(chatId, '📤 Введи username получателя без @:');
    }

    if (text === '🚀 Ракета') {
        sessions.set(userId, { action: 'rocket_demo' });
        return bot.sendMessage(chatId, '🚀 Демо-режим: введи виртуальную ставку:');
    }

    if (text === '🎁 Рефералка') {
        sessions.delete(userId);
        return bot.sendMessage(
            chatId,
            `🎁 Твоя ссылка:\nhttps://t.me/${(await bot.getMe()).username}?start=ref_${userId}`,
            mainMenu
        );
    }

    if (text === '📊 Курсы') {
        sessions.delete(userId);
        return bot.sendMessage(chatId, '📊 Информационные курсы:\n1 USDT = 1 USD\nКурс TON уточняй перед обменом.', mainMenu);
    }

    const session = sessions.get(userId);
    if (!session) return;

    if (session.action === 'deposit') {
        const amount = parseAmount(text);
        if (amount === null) return bot.sendMessage(chatId, '❌ Введи корректную сумму, например 10 или 10.50.');

        sessions.delete(userId);
        try {
            const invoice = await createDepositInvoice(userId, amount);
            return bot.sendMessage(chatId, `💳 Счёт на ${amount.toFixed(2)} USDT создан.\nЗачисление произойдёт после подтверждения оплаты.`, {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Оплатить', url: invoice.bot_invoice_url }]]
                }
            });
        } catch (error) {
            console.error('create invoice:', error);
            return bot.sendMessage(chatId, '❌ Не удалось создать счёт. Попробуй позже.', mainMenu);
        }
    }

    if (session.action === 'send_user') {
        const username = text.replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9_]{5,32}$/.test(username)) {
            return bot.sendMessage(chatId, '❌ Введи корректный Telegram username без @.');
        }
        session.targetUsername = username;
        session.action = 'send_amount';
        return bot.sendMessage(chatId, '💰 Введи сумму перевода в USDT:');
    }

    if (session.action === 'send_amount') {
        const amount = parseAmount(text);
        if (amount === null) return bot.sendMessage(chatId, '❌ Введи корректную сумму.');

        try {
            const { data: receiver, error: receiverError } = await db
                .from('smaster_wallets')
                .select('user_id, username')
                .ilike('username', session.targetUsername)
                .maybeSingle();

            if (receiverError) throw receiverError;
            if (!receiver) return bot.sendMessage(chatId, '❌ Получатель не найден. Он должен хотя бы раз запустить бота.');

            const { data, error } = await db.rpc('transfer_smaster_usdt', {
                p_sender: userId,
                p_receiver: receiver.user_id,
                p_amount: amount
            });

            if (error) throw error;
            sessions.delete(userId);

            bot.sendMessage(
                chatId,
                `✅ Перевод выполнен!\nОтправлено: ${amount.toFixed(2)} USDT\nКомиссия: ${Number(data.fee).toFixed(2)} USDT`,
                mainMenu
            );

            bot.sendMessage(receiver.user_id, `💰 Тебе поступил перевод ${Number(data.received).toFixed(2)} USDT.`).catch(() => {});
        } catch (error) {
            console.error('transfer:', error);
            return bot.sendMessage(chatId, `❌ Перевод не выполнен: ${error.message || 'ошибка'}`, mainMenu);
        }
        return;
    }

    if (session.action === 'rocket_demo') {
        const amount = parseAmount(text);
        if (amount === null) return bot.sendMessage(chatId, '❌ Введи корректное число.');
        sessions.delete(userId);

        // Это только демонстрация. Реальные средства не списываются и не начисляются.
        const multiplier = 1 + Math.random() * 4;
        return bot.sendMessage(
            chatId,
            `🚀 Демо-раунд завершён!\nУсловный коэффициент: x${multiplier.toFixed(2)}\nВиртуальная ставка: ${amount.toFixed(2)}\n💡 Реальный баланс не изменён.`,
            mainMenu
        );
    }
});

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));
bot.on('error', error => console.error('Telegram bot error:', error.message));

// Один HTTP-сервер обслуживает Render health-check и CryptoBot webhook.
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('SMaster Bot is running');
    }

    if (req.method === 'POST' && req.url === '/cryptobot-webhook') {
        let body = Buffer.alloc(0);

        req.on('data', chunk => {
            body = Buffer.concat([body, chunk]);
            if (body.length > 1024 * 1024) {
                res.writeHead(413);
                res.end('Payload too large');
                req.destroy();
            }
        });

        req.on('end', async () => {
            try {
                const signature = req.headers['crypto-pay-api-signature'];
                const result = await handleCryptoWebhook(body, signature);
                console.log('CryptoBot webhook processed:', result);
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } catch (error) {
                console.error('CryptoBot webhook error:', error.message);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid webhook');
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});
