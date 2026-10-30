```javascript
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    SUPABASE_URL: 'https://dnrbvyuoiphvkezwxbc.supabase.co',
    SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CRYPTOBOT_TOKEN: process.env.CRYPTOBOT_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    ADMIN_ID: '8447147405'
};

for (const [key, value] of Object.entries(CONFIG)) {
    if (!value) throw new Error('Missing environment variable: ' + key);
}

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: false });
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const pool = new Pool({
    connectionString: CONFIG.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const app = express();
const PORT = process.env.PORT || 10000;
const sessions = new Map();

const mainKeyboard = {
    keyboard: [
        [{ text: '💼 Мой кошелек' }, { text: '💳 Пополнить' }],
        [{ text: '💸 Перевод' }, { text: '🚀 Ракета' }],
        [{ text: '🎁 Рефералка' }]
    ],
    resize_keyboard: true
};

function validAmount(value) {
    return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(String(value))
        && Number.isFinite(Number(value))
        && Number(value) > 0;
}

function isAdmin(id) {
    return String(id) === CONFIG.ADMIN_ID;
}

async function initDatabase() {
    await pool.query(``);
        CREATE TABLE IF NOT EXISTS smaster_wallets (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            balance_usdt NUMERIC(24,8) NOT NULL DEFAULT 0,
            balance_ton NUMERIC(24,8) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS smaster_payments (
            id UUID PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES smaster_wallets(user_id),
            invoice_id BIGINT UNIQUE NOT NULL,
            amount NUMERIC(24,8) NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            paid_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS smaster_transactions (
            id BIGSERIAL PRIMARY KEY,
            sender_id BIGINT,
            receiver_id BIGINT,
            amount NUMERIC(24,8) NOT NULL,
            fee NUMERIC(24,8) NOT NULL DEFAULT 0,
            asset TEXT NOT NULL DEFAULT 'USDT',
            type TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS smaster_referrals (
            user_id BIGINT PRIMARY KEY,
            referrer_id BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS smaster_username_idx
        ON smaster_wallets (LOWER(username));
    `);
}

async function createWallet(user) {
    await pool.query(`
        INSERT INTO smaster_wallets (user_id, username)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET username = EXCLUDED.username
    `, [user.id, user.username || null]);
}

async function getWallet(id) {
    const result = await pool.query(
        'SELECT * FROM smaster_wallets WHERE user_id = $1',
        [id]
    );
    return result.rows[0];
}

async function showWallet(chatId, userId) {
    const wallet = await getWallet(userId);
    if (!wallet) return bot.sendMessage(chatId, 'Кошелек не найден.');

    return bot.sendMessage(
        chatId,
        '💼 SMASTER WALLET\n\n' +
        '💵 USDT: ' + Number(wallet.balance_usdt).toFixed(8) + '\n' +
        '💎 TON: ' + Number(wallet.balance_ton).toFixed(8) + '\n\n' +
        '🆔 ID: ' + userId,
        { reply_markup: mainKeyboard }
    );
}

async function cryptoRequest(method, params) {
    const response = await fetch(
        'https://pay.crypt.bot/api/' + method,
        {
            method: 'POST',
            headers: {
                'Crypto-Pay-API-Token': CONFIG.CRYPTOBOT_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params)
        }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(data.error?.name || 'CryptoBot error');
    }

    return data.result;
}

async function createDeposit(chatId, userId, amount) {
    if (!validAmount(amount) || Number(amount) < 1) {
        return bot.sendMessage(chatId, 'Минимум 1 USDT. Введи корректную сумму.');
    }

    try {
        const id = crypto.randomUUID();

        const invoice = await cryptoRequest('createInvoice', {
            currency_type: 'crypto',
            asset: 'USDT',
            amount: String(amount),
            description: 'SMaster wallet deposit',
            payload: JSON.stringify({
                payment_id: id,
                user_id: String(userId)
            }),
            expires_in: 3600,
            allow_comments: false,
            allow_anonymous: false
        });

        await pool.query(`
            INSERT INTO smaster_payments
            (id, user_id, invoice_id, amount)
            VALUES ($1, $2, $3, $4)
        `, [id, userId, invoice.invoice_id, amount]);

        await bot.sendMessage(
            chatId,
            '💳 СЧЕТ SMASTER\n\n' +
            'Сумма: ' + amount + ' USDT\n' +
            'Счет: ' + invoice.invoice_id,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '💳 ОПЛАТИТЬ', url: invoice.pay_url }
                    ]]
                }
            }
        );
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Ошибка создания счета.');
    }
}

function verifySignature(body, signature) {
    if (!signature) return false;

    const secret = crypto.createHash('sha256')
        .update(CONFIG.CRYPTOBOT_TOKEN)
        .digest();

    const expected = crypto.createHmac('sha256', secret)
        .update(body)
        .digest('hex');

    if (signature.length !== expected.length) return false;

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
    );
}

app.post(
    '/cryptobot-webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        try {
            if (!verifySignature(
                req.body,
                req.headers['crypto-pay-api-signature']
            )) {
                return res.sendStatus(401);
            }

            const event = JSON.parse(req.body.toString());

            if (event.update_type !== 'invoice_paid') {
                return res.sendStatus(200);
            }

            const invoice = event.payload;
            const payload = JSON.parse(invoice.payload || '{}');

            if (invoice.status !== 'paid' || invoice.asset !== 'USDT') {
                return res.sendStatus(400);
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                const result = await client.query(`
                    SELECT * FROM smaster_payments
                    WHERE id = $1 AND invoice_id = $2
                    FOR UPDATE
                `, [payload.payment_id, invoice.invoice_id]);

                if (!result.rows.length) throw new Error('Payment not found');

                const payment = result.rows[0];

                if (String(payment.user_id) !== String(payload.user_id)) {
                    throw new Error('User mismatch');
                }

                if (payment.status === 'paid') {
                    await client.query('COMMIT');
                    return res.sendStatus(200);
                }

                if (Number(invoice.amount) !== Number(payment.amount)) {
                    throw new Error('Amount mismatch');
                }

                await client.query(`
                    UPDATE smaster_wallets
                    SET balance_usdt = balance_usdt + $1
                    WHERE user_id = $2
                `, [payment.amount, payment.user_id]);

                await client.query(`
                    UPDATE smaster_payments
                    SET status = 'paid', paid_at = NOW()
                    WHERE id = $1
                `, [payment.id]);

                await client.query(`
                    INSERT INTO smaster_transactions
                    (receiver_id, amount, asset, type)
                    VALUES ($1, $2, 'USDT', 'deposit')
                `, [payment.user_id, payment.amount]);

                await client.query('COMMIT');

                await bot.sendMessage(
                    payment.user_id,
                    '✅ Пополнение успешно!\nЗачислено: ' +
                    payment.amount + ' USDT'
                );
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            res.sendStatus(200);
        } catch (error) {
            console.error('Webhook:', error);
            res.sendStatus(500);
        }
    }
);

async function transferMoney(senderId, username, amount) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const found = await client.query(`
            SELECT * FROM smaster_wallets
            WHERE LOWER(username) = LOWER($1)
            LIMIT 1
        `, [username.replace(/^@/, '')]);

        if (!found.rows.length) throw new Error('Пользователь не найден');

        const receiver = found.rows[0];

        if (String(receiver.user_id) === String(senderId)) {
            throw new Error('Нельзя переводить самому себе');
        }

        const ids = [String(senderId), String(receiver.user_id)].sort();

        const locked = await client.query(`
            SELECT * FROM smaster_wallets
            WHERE user_id = ANY($1::bigint[])
            ORDER BY user_id FOR UPDATE
        `, [ids]);

        const sender = locked.rows.find(
            w => String(w.user_id) === String(senderId)
        );

        if (!sender) throw new Error('Кошелек не найден');

        const fee = Number(amount) * 0.01;
        const total = Number(amount) + fee;

        if (Number(sender.balance_usdt) < total) {
            throw new Error('Недостаточно средств с учетом комиссии 1%');
        }

        await client.query(`
            UPDATE smaster_wallets
            SET balance_usdt = balance_usdt - $1
            WHERE user_id = $2
        `, [total, senderId]);

        await client.query(`
            UPDATE smaster_wallets
            SET balance_usdt = balance_usdt + $1
            WHERE user_id = $2
        `, [amount, receiver.user_id]);

        await client.query(`
            INSERT INTO smaster_transactions
            (sender_id, receiver_id, amount, fee, type)
            VALUES ($1, $2, $3, $4, 'transfer')
        `, [senderId, receiver.user_id, amount, fee]);

        await client.query('COMMIT');

        return {
            receiverId: receiver.user_id,
            username: receiver.username,
            amount: Number(amount),
            fee
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function playRocket(userId, amount) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(`
            SELECT * FROM smaster_wallets
            WHERE user_id = $1 FOR UPDATE
        `, [userId]);

        if (!result.rows.length) throw new Error('Кошелек не найден');

        if (Number(result.rows[0].balance_usdt) < Number(amount)) {
            throw new Error('Недостаточно средств');
        }

        await client.query(`
            UPDATE smaster_wallets
            SET balance_usdt = balance_usdt - $1
            WHERE user_id = $2
        `, [amount, userId]);

        const won = crypto.randomInt(0, 1000000) === 0;
        const payout = won ? Number(amount) * 100 : 0;

        if (won) {
            await client.query(`
                UPDATE smaster_wallets
                SET balance_usdt = balance_usdt + $1
                WHERE user_id = $2
            `, [payout, userId]);
        }

        await client.query(`
            INSERT INTO smaster_transactions
            (sender_id, receiver_id, amount, type)
            VALUES ($1, $1, $2, $3)
        `, [userId, amount, won ? 'rocket_win' : 'rocket_loss']);

        await client.query('COMMIT');
        return { won, payout };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function referralLink(userId) {
    const me = await bot.getMe();
    return 'https://t.me/' + me.username + '?start=ref_' + userId;
}

async function registerReferral(userId, referrerId) {
    if (!referrerId || String(referrerId) === String(userId)) return;

    if (!(await getWallet(referrerId))) return;

    await pool.query(`
        INSERT INTO smaster_referrals (user_id, referrer_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO NOTHING
    `, [userId, referrerId]);
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    try {
        await createWallet(msg.from);

        const arg = match[1] || '';

        if (arg.startsWith('ref_')) {
            const id = arg.substring(4);
            if (/^\d+$/.test(id)) {
                await registerReferral(msg.from.id, id);
            }
        }

        await bot.sendMessage(
            msg.chat.id,
            '🚀 Добро пожаловать в SMASTER!\n\nТвой кошелек создан.',
            { reply_markup: mainKeyboard }
        );
    } catch (error) {
        console.error(error);
        bot.sendMessage(msg.chat.id, 'Ошибка запуска.');
    }
});

bot.onText(/^\/wallet$/, msg => showWallet(msg.chat.id, msg.from.id));

bot.onText(/^\/admin$/, msg => {
    if (!isAdmin(msg.from.id)) return;

    bot.sendMessage(
        msg.chat.id,
        '👑 SMASTER ADMIN\n\n' +
        '/admin_addbalance USER_ID AMOUNT USDT|TON\n' +
        '/admin_broadcast ТЕКСТ'
    );
});

bot.onText(
    /^\/admin_addbalance\s+(\d+)\s+([\d.]+)(?:\s+(USDT|TON))?$/i,
    async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;

        const userId = match[1];
        const amount = match[2];
        const asset = (match[3] || 'USDT').toUpperCase();

        if (!validAmount(amount) || !['USDT', 'TON'].includes(asset)) {
            return bot.sendMessage(msg.chat.id, 'Неверная сумма или валюта.');
        }

        const column = asset === 'TON' ? 'balance_ton' : 'balance_usdt';

        try {
            const result = await pool.query(`
                UPDATE smaster_wallets
                SET ${column} = ${column} + $1
                WHERE user_id = $2
                RETURNING user_id
            `, [amount, userId]);

            if (!result.rows.length) {
                return bot.sendMessage(msg.chat.id, 'Пользователь не найден.');
            }

            await pool.query(`
                INSERT INTO smaster_transactions
                (sender_id, receiver_id, amount, asset, type)
                VALUES ($1, $2, $3, $4, 'admin_credit')
            `, [msg.from.id, userId, amount, asset]);

            await bot.sendMessage(msg.chat.id, '✅ Баланс начислен.');
            await bot.sendMessage(
                userId,
                '🎉 Администратор начислил ' + amount + ' ' + asset
            );
        } catch (error) {
            console.error(error);
            bot.sendMessage(msg.chat.id, 'Ошибка начисления.');
        }
    }
);

bot.onText(/^\/admin_broadcast\s+([\s\S]+)$/i, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    try {
        const { data, error } = await supabase
            .from('smaster_wallets')
            .select('user_id');

        if (error) throw error;

        let sent = 0;
        let failed = 0;

        for (const user of data || []) {
            try {
                await bot.sendMessage(user.user_id, match[1]);
                sent++;
            } catch {
                failed++;
            }

            await new Promise(resolve => setTimeout(resolve, 40));
        }

        bot.sendMessage(
            msg.chat.id,
            'Рассылка завершена.\nОтправлено: ' + sent +
            '\nОшибок: ' + failed
        );
    } catch (error) {
        console.error(error);
        bot.sendMessage(msg.chat.id, 'Ошибка рассылки.');
    }
});

bot.on('message', async msg => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    try {
        const session = sessions.get(userId);

        if (session) {
            sessions.delete(userId);

            if (session.action === 'deposit') {
                return createDeposit(chatId, userId, text);
            }

            if (session.action === 'transfer') {
                const parts = text.split(/\s+/);

                if (parts.length !== 2 || !validAmount(parts[1])) {
                    return bot.sendMessage(
                        chatId,
                        'Формат: @username 10'
                    );
                }

                const result = await transferMoney(
                    userId, parts[0], parts[1]
                );

                await bot.sendMessage(
                    chatId,
                    '✅ ПЕРЕВОД ВЫПОЛНЕН\n\n' +
                    'Получатель: @' + result.username + '\n' +
                    'Сумма: ' + result.amount + ' USDT\n' +
                    'Комиссия: ' + result.fee.toFixed(8) + ' USDT'
                );

                await bot.sendMessage(
                    result.receiverId,
                    '💸 Получен перевод: ' + result.amount + ' USDT'
                );

                return;
            }

            if (session.action === 'rocket') {
                if (!validAmount(text)) {
                    return bot.sendMessage(chatId, 'Неверная ставка.');
                }

                const result = await playRocket(userId, text);

                return bot.sendMessage(
                    chatId,
                    result.won
                        ? '🚀 ПОБЕДА! Выплата: ' + result.payout + ' USDT (x100)'
                        : '💥 Ракета упала. Потеряно: ' + text + ' USDT'
                );
            }
        }

        if (text === '💼 Мой кошелек') {
            return showWallet(chatId, userId);
        }

        if (text === '💳 Пополнить') {
            sessions.set(userId, { action: 'deposit' });
            return bot.sendMessage(chatId, 'Введи сумму пополнения в USDT.');
        }

        if (text === '💸 Перевод') {
            sessions.set(userId, { action: 'transfer' });
            return bot.sendMessage(chatId, 'Введи @username и сумму. Например: @user 10');
        }

        if (text === '🚀 Ракета') {
            sessions.set(userId, { action: 'rocket' });
            return bot.sendMessage(chatId, 'Введи ставку в USDT.');
        }

        if (text === '🎁 Рефералка') {
            const link = await referralLink(userId);
            return bot.sendMessage(
                chatId,
                '🎁 Твоя реферальная ссылка:\n' + link
            );
        }
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Ошибка: ' + error.message);
    }
});

app.use(express.json());

app.get('/', (req, res) => res.send('SMaster is running.'));
app.get('/health', (req, res) => res.json({ status: 'online' }));

app.listen(PORT, '0.0.0.0', () => {
    console.log('HTTP server running on port ' + PORT);
});

(async () => {
    try {
        await initDatabase();
        await bot.startPolling();
        console.log('🚀 SMASTER STARTED');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
```
