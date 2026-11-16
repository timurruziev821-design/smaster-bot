
'use strict';

const states = new Map();

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const helmet = require('helmet');
const axios = require('axios');
const crypto = require('crypto');

const { createClient } = require('@supabase/supabase-js');

const {
    TonClient,
    WalletContractV4,
    internal,
    toNano,
    fromNano
} = require('@ton/ton');

const {
    mnemonicToPrivateKey
} = require('@ton/crypto');

const PORT = process.env.PORT || 3000;

const REQUIRED_ENV = [
    'BOT_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'ADMIN_ID',
    'MAIN_WALLET_MNEMONIC',
    'TONCENTER_API_KEY',
    'APP_URL'
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`Missing environment variable: ${key}`);
    }
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    }
);

const bot = new TelegramBot(
    process.env.BOT_TOKEN,
    { polling: true }
);

const app = express();

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'unsafe-inline'"],
            styleSrc: ["'unsafe-inline'"],
            connectSrc: ["'self'"]
        }
    }
}));

app.use(express.json({ limit: '20kb' }));

const TON_ENDPOINT = 'https://toncenter.com/api/v2';

const tonClient = new TonClient({
    endpoint: `${TON_ENDPOINT}/jsonRPC`,
    apiKey: process.env.TONCENTER_API_KEY
});

let tonWallet;
let tonKeyPair;
let tonAddress;
let tonReady = false;
let depositScanRunning = false;

const CURRENCIES = [
    'USDT', 'XROCK', 'USDC', 'GRAM',
    'TRX', 'SOL', 'BTC', 'ETH', 'BNB'
];

const DISPLAY_CURRENCIES = [
    'USD', 'RUB', 'EUR', 'UAH', 'KZT'
];

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

function escapeHTML(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]
    );
}

function newOperationKey(prefix) {
    return `${prefix}:${crypto.randomUUID()}`;
}

function validAmount(value, max = 1000000000) {
    const amount = Number(value);

    if (
        value === '' ||
        !Number.isFinite(amount) ||
        isNaN(amount) ||
        amount <= 0 ||
        amount > max
    ) {
        return null;
    }

    return amount;
}

function formatAmount(value) {
    return Number(value || 0).toFixed(4);
}

function getState(userId) {
    return states.get(String(userId)) || null;
}

function setState(userId, action, data = {}) {
    states.set(String(userId), {
        action,
        data,
        createdAt: Date.now()
    });
}

function clearState(userId) {
    states.delete(String(userId));
}

async function send(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options
        });
    } catch (e) {
        console.error('Telegram send error:', e.message);
        return null;
    }
}

async function deleteAndSend(chatId, messageId, text, options = {}) {
    try {
        if (messageId) {
            await bot.deleteMessage(chatId, messageId)
                .catch(() => {});
        }

        return await send(chatId, text, options);
    } catch (e) {
        console.error('Message replacement error:', e.message);
        return null;
    }
}

// Все ошибки БД проходят через единый обработчик.
async function dbQuery(promise) {
    const { data, error } = await promise;

    if (error) {
        throw new Error(error.message);
    }

    return data;
}

async function changeBalance(
    userId,
    currency,
    amount,
    operationType,
    operationKey
) {
    return await dbQuery(
        supabase.rpc('smaster_change_balance', {
            p_user_id: Number(userId),
            p_currency: currency,
            p_amount: amount,
            p_operation_key: operationKey,
            p_operation_type: operationType
        })
    );
}

async function getUser(userId) {
    return await dbQuery(
        supabase
            .from('smaster_wallets')
            .select('*')
            .eq('user_id', Number(userId))
            .maybeSingle()
    );
}

async function ensureUser(user) {
    try {
        const id = Number(user.id);

        let wallet = await getUser(id);

        if (!wallet) {
            wallet = await dbQuery(
                supabase
                    .from('smaster_wallets')
                    .insert({
                        user_id: id,
                        username: user.username || null,
                        balance_usdt: 0,
                        balance_ton: 0,
                        balance_xrock: 0,
                        display_currency: 'USD',
                        notifications: true,
                        language: 'RU',
                        is_verified: false
                    })
                    .select()
                    .single()
            );
        } else {
            await dbQuery(
                supabase
                    .from('smaster_wallets')
                    .update({
                        username: user.username || null
                    })
                    .eq('user_id', id)
            );
        }

        return wallet;
    } catch (e) {
        console.error('ensureUser:', e.message);
        throw e;
    }
}

// Инициализация главного TON-кошелька.
async function initTonWallet() {
    try {
        const mnemonic = process.env.MAIN_WALLET_MNEMONIC
            .trim()
            .split(/\s+/);

        if (mnemonic.length !== 24) {
            throw new Error('Mnemonic must contain 24 words');
        }

        tonKeyPair = await mnemonicToPrivateKey(mnemonic);

        tonWallet = WalletContractV4.create({
            workchain: 0,
            publicKey: tonKeyPair.publicKey
        });

        tonAddress = tonWallet.address.toString({
            bounceable: false,
            urlSafe: true
        });

        const contract = tonClient.open(tonWallet);
        await contract.getSeqno();

        tonReady = true;

        console.log('TON wallet initialized:', tonAddress);

        return contract;
    } catch (e) {
        tonReady = false;
        console.error('TON initialization failed:', e.message);
        throw e;
    }
}

function getTonContract() {
    if (!tonReady || !tonWallet) {
        throw new Error('TON wallet is not initialized');
    }

    return tonClient.open(tonWallet);
}

// Главное меню.
function getMainMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💼 Кошелёк', callback_data: 'wallet' },
                    { text: '➕ Пополнить', callback_data: 'deposit' }
                ],
                [
                    { text: '📤 Вывести', callback_data: 'withdraw' },
                    { text: '🎁 Чеки', callback_data: 'checks' }
                ],
                [
                    { text: '📄 Счета', callback_data: 'invoices' },
                    { text: '🔄 P2P', callback_data: 'p2p' }
                ],
                [
                    { text: '👥 Рефералка', callback_data: 'referral' },
                    { text: '⚙️ Настройки', callback_data: 'settings' }
                ],
                [
                    { text: '🚀 Mini App', web_app: {
                        url: process.env.APP_URL
                    }}
                ]
            ]
        }
    };
}

// Меню настроек.
function getSettingsMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💱 Валюта', callback_data: 'currency' }
                ],
                [
                    { text: '🔔 Уведомления', callback_data: 'notifications' }
                ],
                [
                    { text: '🌐 Язык', callback_data: 'language' }
                ],
                [
                    { text: '🪪 Верификация KYC', callback_data: 'kyc' }
                ],
                [
                    { text: '⬅️ Назад', callback_data: 'home' }
                ]
            ]
        }
    };
}

async function showMainMenu(chatId, userId) {
    try {
        const wallet = await getUser(userId);

        if (!wallet) {
            return send(chatId, '❌ Кошелёк не найден. Напишите /start');
        }

        return send(
            chatId,
            `👋 <b>Добро пожаловать в SMaster!</b>\n\n` +
            `💵 USDT: <b>${formatAmount(wallet.balance_usdt)}</b>\n` +
            `💎 TON: <b>${formatAmount(wallet.balance_ton)}</b>\n\n` +
            `Выберите действие:`,
            getMainMenu()
        );
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

// Получение баланса.
async function showWallet(chatId, userId) {
    try {
        const wallet = await getUser(userId);

        if (!wallet) {
            throw new Error('Wallet not found');
        }

        const text =
            `💼 <b>Ваш кошелёк SMaster</b>\n\n` +
            `💵 USDT: <b>${formatAmount(wallet.balance_usdt)}</b>\n` +
            `💎 TON: <b>${formatAmount(wallet.balance_ton)}</b>\n` +
            `🪙 XROCK: <b>${formatAmount(wallet.balance_xrock)}</b>\n\n` +
            `💱 Валюта отображения: ${escapeHTML(wallet.display_currency)}\n` +
            `🆔 ID: <code>${userId}</code>`;

        return send(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Пополнить', callback_data: 'deposit' }],
                    [{ text: '📤 Вывести', callback_data: 'withdraw' }],
                    [{ text: '⬅️ Назад', callback_data: 'home' }]
                ]
            }
        });
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

// Создание TON-депозита.
async function showDeposit(chatId, userId) {
    try {
        if (!tonReady) {
            throw new Error('TON wallet unavailable');
        }

        await send(
            chatId,
            `➕ <b>Пополнение TON</b>\n\n` +
            `Адрес главного кошелька:\n` +
            `<code>${escapeHTML(tonAddress)}</code>\n\n` +
            `Комментарий (обязательно):\n` +
            `<code>${userId}</code>\n\n` +
            `Отправьте TON на указанный адрес.\n` +
            `Без правильного комментария автоматическое зачисление невозможно.\n\n` +
            `⚠️ Зачисление выполняется после подтверждения транзакции в сети TON.`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⬅️ Назад', callback_data: 'home' }
                    ]]
                }
            }
        );
    } catch (e) {
        await send(chatId, `❌ Ошибка: ${escapeHTML(e.message)}`);
    }
}

// ==========================================
// TON DEPOSIT MONITOR
// ==========================================

async function checkTonDeposits() {
    if (depositScanRunning || !tonReady) return;

    depositScanRunning = true;

    try {
        const response = await axios.get(
            `${TON_ENDPOINT}/getTransactions`,
            {
                params: {
                    address: tonAddress,
                    limit: 50,
                    archival: true
                },
                headers: {
                    'X-API-Key': process.env.TONCENTER_API_KEY
                },
                timeout: 15000
            }
        );

        if (!response.data?.ok) {
            throw new Error('TONCenter returned unsuccessful response');
        }

        const transactions = response.data.result || [];

        for (const tx of transactions) {
            try {
                const incoming = tx.in_msg;

                if (!incoming || !incoming.value) continue;

                const destination = incoming.destination;

                if (!destination) continue;

                // Комментарий TON должен быть ровно Telegram user_id.
                const comment = String(incoming.message || '').trim();

                if (!/^\d{5,15}$/.test(comment)) continue;

                const userId = Number(comment);

                const amount = Number(fromNano(
                    BigInt(incoming.value)
                ));

                if (!Number.isFinite(amount) || amount <= 0) continue;

                const txHash = String(
                    tx.transaction_id?.hash || ''
                );

                if (!txHash) continue;

                // Проверяем адрес назначения.
                const normalizedDestination = destination.toLowerCase();
                const normalizedWallet = tonAddress.toLowerCase();

                if (
                    normalizedDestination !== normalizedWallet &&
                    normalizedDestination !== tonWallet.address.toRawString().toLowerCase()
                ) {
                    continue;
                }

                // Защита от повторного начисления выполняется в SQL.
                const result = await dbQuery(
                    supabase.rpc('smaster_credit_ton_deposit', {
                        p_tx_hash: txHash,
                        p_user_id: userId,
                        p_amount: amount
                    })
                );

                if (result?.success) {
                    await send(
                        userId,
                        `✅ <b>Пополнение успешно!</b>\n\n` +
                        `💎 Получено: <b>${formatAmount(amount)} TON</b>\n` +
                        `🔗 TX: <code>${escapeHTML(txHash)}</code>`
                    );
                }

            } catch (e) {
                console.error(
                    'Deposit transaction processing:',
                    e.message
                );
            }
        }

    } catch (e) {
        console.error('checkTonDeposits:', e.message);
    } finally {
        depositScanRunning = false;
    }
}

// ==========================================
// TON WITHDRAWAL
// ==========================================

async function withdrawTon(chatId, userId, address, amount) {
    let reserved = false;

    try {
        if (!tonReady) {
            throw new Error('TON wallet unavailable');
        }

        if (
            typeof address !== 'string' ||
            address.length > 100 ||
            !/^[A-Za-z0-9_-]{40,50}$/.test(address)
        ) {
            throw new Error('Invalid TON address');
        }

        if (!validAmount(amount) || amount < 0.02) {
            throw new Error('Minimum withdrawal is 0.02 TON');
        }

        // Резервирование средств до отправки.
        const operationKey = newOperationKey('withdraw');

        await changeBalance(
            userId,
            'TON',
            -amount,
            'withdrawal',
            operationKey
        );

        reserved = true;

        const contract = getTonContract();

        const seqno = await contract.getSeqno();

        await contract.sendTransfer({
            seqno,
            secretKey: tonKeyPair.secretKey,
            messages: [
                internal({
                    to: address,
                    value: toNano(amount.toString()),
                    bounce: false
                })
            ]
        });

        // Отправка сообщения в сеть не означает,
        // что получатель уже получил средства.
        // Оставляем операцию на подтверждении.
        await dbQuery(
            supabase
                .from('smaster_operations')
                .update({
                    status: 'submitted',
                    metadata: {
                        address,
                        amount,
                        submitted_at: new Date().toISOString()
                    }
                })
                .eq('operation_key', operationKey)
        );

        await send(
            chatId,
            `📤 <b>Транзакция отправлена!</b>\n\n` +
            `Сумма: ${amount} TON\n` +
            `Адрес: <code>${escapeHTML(address)}</code>\n\n` +
            `Статус: ожидает подтверждения сети.`
        );

    } catch (e) {
        console.error('Withdrawal:', e.message);

        // При ошибке с неопределенным результатом отправки
        // автоматически возвращать деньги опасно:
        // транзакция могла попасть в сеть.
        await send(
            chatId,
            `❌ Вывод не завершён автоматически.\n` +
            `${escapeHTML(e.message)}\n\n` +
            (reserved
                ? 'Средства зарезервированы. Требуется проверка операции администратором.'
                : 'Средства не были зарезервированы.')
        );
    }
}

// ==========================================
// CHECKS
// ==========================================

async function createCheck(chatId, userId, amount) {
    try {
        if (!validAmount(amount)) {
            throw new Error('Некорректная сумма');
        }

        const key = newOperationKey('check-create');

        await changeBalance(
            userId,
            'USDT',
            -amount,
            'check_create',
            key
        );

        const check = await dbQuery(
            supabase
                .from('smaster_checks')
                .insert({
                    creator_id: userId,
                    amount,
                    status: 'active',
                    claimed_by: null,
                    limit_activations: 1
                })
                .select()
                .single()
        );

        const link =
            `https://t.me/${await getBotUsername()}?start=check_${check.id}`;

        await send(
            chatId,
            `🎁 <b>Чек создан!</b>\n\n` +
            `💵 Сумма: ${amount} USDT\n` +
            `🔗 Ссылка:\n${escapeHTML(link)}\n\n` +
            `Отправьте её получателю.`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: '🎁 Открыть чек',
                            url: link
                        }
                    ]]
                }
            }
        );

    } catch (e) {
        await send(
            chatId,
            `❌ ${escapeHTML(e.message)}`
        );
    }
}

async function activateCheck(chatId, userId, checkId) {
    try {
        const check = await dbQuery(
            supabase
                .from('smaster_checks')
                .select('*')
                .eq('id', checkId)
                .maybeSingle()
        );

        if (!check) {
            return send(chatId, '❌ Чек не найден.');
        }

        if (Number(check.creator_id) === Number(userId)) {
            return send(chatId, '❌ Нельзя активировать собственный чек.');
        }

        if (check.status !== 'active') {
            return send(chatId, '❌ Этот чек уже использован или недоступен.');
        }

        // Условное обновление предотвращает двойную активацию.
        const claimed = await dbQuery(
            supabase
                .from('smaster_checks')
                .update({
                    status: 'claimed',
                    claimed_by: userId
                })
                .eq('id', checkId)
                .eq('status', 'active')
                .select()
        );

        if (!claimed || claimed.length === 0) {
            return send(chatId, '❌ Чек уже активирован другим пользователем.');
        }

        // Кредитуем получателя.
        try {
            await changeBalance(
                userId,
                'USDT',
                Number(check.amount),
                'check_claim',
                `check-claim:${checkId}`
            );
        } catch (e) {
            // Компенсация: возвращаем чек в активное состояние,
            // если начисление не состоялось.
            await dbQuery(
                supabase
                    .from('smaster_checks')
                    .update({
                        status: 'active',
                        claimed_by: null
                    })
                    .eq('id', checkId)
                    .eq('claimed_by', userId)
            );

            throw e;
        }

        await send(
            chatId,
            `🎉 <b>Чек успешно активирован!</b>\n\n` +
            `Получено: <b>${formatAmount(check.amount)} USDT</b>`
        );

        await send(
            check.creator_id,
            `🎁 Ваш чек активирован пользователем ${userId}.`
        );

    } catch (e) {
        await send(
            chatId,
            `❌ Ошибка: ${escapeHTML(e.message)}`
        );
    }
}

async function getBotUsername() {
    const me = await bot.getMe();
    return me.username;
}

// ==========================================
// INVOICES
// ==========================================

async function createInvoice(chatId, userId, amount, currency) {
    try {
        if (!CURRENCIES.includes(currency)) {
            throw new Error('Неподдерживаемая валюта');
        }

        if (!validAmount(amount)) {
            throw new Error('Некорректная сумма');
        }

        const invoice = await dbQuery(
            supabase
                .from('smaster_invoices')
                .insert({
                    creator_id: userId,
                    amount,
                    currency,
                    payment_currency: currency,
                    description: 'SMaster invoice',
                    status: 'pending',
                    paid_by: null
                })
                .select()
                .single()
        );

        const link =
            `https://t.me/${await getBotUsername()}?start=invoice_${invoice.id}`;

        await send(
            chatId,
            `📄 <b>Счёт создан!</b>\n\n` +
            `Сумма: ${amount} ${currency}\n` +
            `ID: <code>${escapeHTML(invoice.id)}</code>\n` +
            `Ссылка:\n${escapeHTML(link)}`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '📄 Открыть счёт', url: link }
                    ]]
                }
            }
        );

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showInvoice(chatId, userId, invoiceId) {
    try {
        const invoice = await dbQuery(
            supabase
                .from('smaster_invoices')
                .select('*')
                .eq('id', invoiceId)
                .maybeSingle()
        );

        if (!invoice) {
            return send(chatId, '❌ Счёт не найден.');
        }

        if (invoice.status !== 'pending') {
            return send(chatId, '❌ Счёт уже оплачен или отменён.');
        }

        if (Number(invoice.creator_id) === Number(userId)) {
            return send(chatId, '❌ Нельзя оплатить собственный счёт.');
        }

        const currency = invoice.payment_currency || invoice.currency;

        if (!['USDT', 'TON', 'XROCK'].includes(currency)) {
            return send(
                chatId,
                `⚠️ Оплата ${escapeHTML(currency)} пока недоступна: ` +
                `для этой валюты не подключён реальный или внутренний баланс.`
            );
        }

        // Важно: здесь только запрос подтверждения.
        // Списание произойдет исключительно после нажатия «Да».
        setState(userId, 'invoice_confirm', {
            invoiceId: String(invoice.id)
        });

        await send(
            chatId,
            `📄 <b>Подтверждение оплаты</b>\n\n` +
            `Сумма: <b>${invoice.amount} ${escapeHTML(currency)}</b>\n\n` +
            `Вы действительно хотите оплатить этот счёт?`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Да, оплатить', callback_data: 'invoice_yes' },
                            { text: '❌ Нет', callback_data: 'invoice_no' }
                        ]
                    ]
                }
            }
        );

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function payInvoice(chatId, userId) {
    try {
        const state = getState(userId);

        if (!state || state.action !== 'invoice_confirm') {
            return send(chatId, '❌ Подтверждение устарело.');
        }

        const invoiceId = state.data.invoiceId;

        const invoice = await dbQuery(
            supabase
                .from('smaster_invoices')
                .select('*')
                .eq('id', invoiceId)
                .maybeSingle()
        );

        if (!invoice || invoice.status !== 'pending') {
            clearState(userId);
            return send(chatId, '❌ Счёт больше недоступен.');
        }

        if (Number(invoice.creator_id) === Number(userId)) {
            clearState(userId);
            return send(chatId, '❌ Нельзя оплатить собственный счёт.');
        }

        const currency = invoice.payment_currency || invoice.currency;

        if (!['USDT', 'TON', 'XROCK'].includes(currency)) {
            clearState(userId);
            return send(chatId, '❌ Валюта пока не поддерживается.');
        }

        // Защищаем оплату от повторного запуска.
        // Уникальный ключ не позволяет повторить операцию.
        const lock = await dbQuery(
            supabase
                .from('smaster_invoices')
                .update({
                    status: 'processing'
                })
                .eq('id', invoiceId)
                .eq('status', 'pending')
                .select()
        );

        if (!lock || lock.length === 0) {
            clearState(userId);
            return send(chatId, '❌ Счёт уже обрабатывается.');
        }

        try {
            const paymentKey = `invoice-payment:${invoiceId}`;

            await changeBalance(
                userId,
                currency,
                -Number(invoice.amount),
                'invoice_payment',
                paymentKey
            );

            await changeBalance(
                Number(invoice.creator_id),
                currency,
                Number(invoice.amount),
                'invoice_received',
                `invoice-received:${invoiceId}`
            );

            await dbQuery(
                supabase
                    .from('smaster_invoices')
                    .update({
                        status: 'paid',
                        paid_by: userId
                    })
                    .eq('id', invoiceId)
                    .eq('status', 'processing')
            );

            clearState(userId);

            await send(
                chatId,
                `✅ <b>Счёт оплачен!</b>\n\n` +
                `${invoice.amount} ${currency}`
            );

            await send(
                invoice.creator_id,
                `💰 Ваш счёт оплачен пользователем ${userId}.\n` +
                `Сумма: ${invoice.amount} ${currency}`
            );

        } catch (e) {
            // Счёт не возвращаем в pending автоматически:
            // при частичном выполнении нужен аудит операции.
            await send(
                chatId,
                `❌ Ошибка оплаты: ${escapeHTML(e.message)}\n\n` +
                `Операция требует проверки.`
            );

            throw e;
        }

    } catch (e) {
        console.error('payInvoice:', e.message);
        clearState(userId);
    }
}

// ==========================================
// P2P
// ==========================================

async function showP2P(chatId) {
    await send(chatId, '🔄 <b>SMaster P2P</b>\n\nВыберите действие:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🛒 Купить', callback_data: 'p2p_buy' }],
                [{ text: '💰 Продать', callback_data: 'p2p_sell' }],
                [{ text: '📋 Мои объявления', callback_data: 'p2p_mine' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    });
}

async function showP2PAds(chatId) {
    try {
        const ads = await dbQuery(
            supabase
                .from('smaster_p2p_ads')
                .select('*')
                .eq('status', 'active')
                .order('created_at', { ascending: false })
                .limit(20)
        );

        if (!ads.length) {
            return send(chatId, 'Пока нет активных объявлений.');
        }

        for (const ad of ads) {
            await send(
                chatId,
                `🔄 <b>Объявление #${escapeHTML(ad.id)}</b>\n\n` +
                `Сумма: ${ad.amount}\n` +
                `Цена: ${ad.price}\n` +
                `Валюта: ${escapeHTML(ad.currency)}`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            {
                                text: '🛒 Купить',
                                callback_data: `p2p_offer_${ad.id}`
                            }
                        ]]
                    }
                }
            );
        }
    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function createP2PAd(chatId, userId, amount, price, currency) {
    try {
        if (!validAmount(amount) || !validAmount(price)) {
            throw new Error('Неверная сумма или цена');
        }

        if (!['USDT', 'TON', 'XROCK'].includes(currency)) {
            throw new Error('Валюта пока не поддерживается');
        }

        if (currency === 'TON') {
            throw new Error(
                'Продажа TON требует отдельного escrow-механизма. ' +
                'Не публикуйте объявление до его подключения.'
            );
        }

        const ad = await dbQuery(
            supabase
                .from('smaster_p2p_ads')
                .insert({
                    seller_id: userId,
                    amount,
                    price,
                    currency,
                    status: 'active',
                    buyer_id: null
                })
                .select()
                .single()
        );

        await send(
            chatId,
            `✅ <b>Объявление создано!</b>\n\n` +
            `ID: ${escapeHTML(ad.id)}\n` +
            `Сумма: ${amount} ${currency}\n` +
            `Цена: ${price}`
        );

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function buyP2PAd(chatId, userId, adId) {
    try {
        const ad = await dbQuery(
            supabase
                .from('smaster_p2p_ads')
                .select('*')
                .eq('id', adId)
                .maybeSingle()
        );

        if (!ad || ad.status !== 'active') {
            return send(chatId, '❌ Объявление недоступно.');
        }

        if (Number(ad.seller_id) === Number(userId)) {
            return send(chatId, '❌ Нельзя купить собственное объявление.');
        }

        if (ad.currency !== 'TON') {
            return send(
                chatId,
                '⚠️ Для этой сделки ещё не подключён безопасный escrow.'
            );
        }

        return send(
            chatId,
            '❌ Автоматическая P2P-сделка пока отключена. ' +
            'Для неё требуется отдельная атомарная escrow-транзакция.'
        );

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showMyAds(chatId, userId) {
    try {
        const ads = await dbQuery(
            supabase
                .from('smaster_p2p_ads')
                .select('*')
                .eq('seller_id', userId)
                .order('created_at', { ascending: false })
                .limit(20)
        );

        if (!ads.length) {
            return send(chatId, 'У вас пока нет объявлений.');
        }

        const text = ads.map(ad =>
            `#${escapeHTML(ad.id)} — ${ad.amount} ${escapeHTML(ad.currency)}\n` +
            `Цена: ${ad.price}\n` +
            `Статус: ${escapeHTML(ad.status)}`
        ).join('\n\n');

        await send(chatId, `📋 <b>Мои объявления</b>\n\n${text}`);

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

// ==========================================
// SETTINGS
// ==========================================

async function showSettings(chatId) {
    await send(chatId, '⚙️ <b>Настройки SMaster</b>', getSettingsMenu());
}

async function updateUserSetting(userId, field, value) {
    const allowed = [
        'display_currency',
        'notifications',
        'language',
        'is_verified'
    ];

    if (!allowed.includes(field)) {
        throw new Error('Invalid setting');
    }

    return await dbQuery(
        supabase
            .from('smaster_wallets')
            .update({ [field]: value })
            .eq('user_id', Number(userId))
            .select()
    );
}

async function showCurrencies(chatId) {
    const keyboard = DISPLAY_CURRENCIES.map(currency => [{
        text: currency,
        callback_data: `setcurrency_${currency}`
    }]);

    keyboard.push([{
        text: '⬅️ Назад',
        callback_data: 'settings'
    }]);

    await send(chatId, '💱 <b>Выберите валюту отображения:</b>', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function toggleNotifications(chatId, userId) {
    try {
        const wallet = await getUser(userId);
        const next = !wallet.notifications;

        await updateUserSetting(userId, 'notifications', next);

        await send(
            chatId,
            next
                ? '🔔 Уведомления включены.'
                : '🔕 Уведомления отключены.'
        );

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showLanguages(chatId) {
    await send(chatId, '🌐 <b>Выберите язык:</b>', {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🇷🇺 Русский', callback_data: 'lang_RU' },
                    { text: '🇬🇧 English', callback_data: 'lang_EN' }
                ],
                [{ text: '⬅️ Назад', callback_data: 'settings' }]
            ]
        }
    });
}

async function showReferral(chatId, userId) {
    try {
        const username = await getBotUsername();

        const link =
            `https://t.me/${username}?start=ref_${userId}`;

        await send(
            chatId,
            `👥 <b>Реферальная программа</b>\n\n` +
            `Ваша ссылка:\n${escapeHTML(link)}\n\n` +
            `Приглашайте друзей в SMaster!`
        );
    } catch (e) {
        await send(chatId, `❌ ${escapeHTML(e.message)}`);
    }
}

// ==========================================
// INVOICE MENUS
// ==========================================

async function showInvoiceMenu(chatId) {
    await send(chatId, '📄 <b>Счета</b>', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Создать счёт', callback_data: 'invoice_create' }],
                [{ text: '📄 Мои счета', callback_data: 'invoice_mine' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    });
}

async function showInvoiceCurrencies(chatId) {
    const keyboard = [];

    for (let i = 0; i < CURRENCIES.length; i += 3) {
        keyboard.push(
            CURRENCIES.slice(i, i + 3).map(currency => ({
                text: currency,
                callback_data: `invcur_${currency}`
            }))
        );
    }

    keyboard.push([{
        text: '⬅️ Назад',
        callback_data: 'invoices'
    }]);

    await send(chatId, '💱 <b>Выберите валюту счёта:</b>', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function showInvoiceAmount(chatId, currency, userId) {
    setState(userId, 'invoice_amount', { currency });

    await send(chatId, `Введите сумму счёта в ${currency}:`, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '1', callback_data: 'invamount_1' },
                    { text: '2', callback_data: 'invamount_2' }
                ],
                [{ text: '⬅️ Назад', callback_data: 'invoice_create' }]
            ]
        }
    });
}

async function showMyInvoices(chatId, userId) {
    try {
        const invoices = await dbQuery(
            supabase
                .from('smaster_invoices')
                .select('*')
                .eq('creator_id', userId)
                .order('created_at', { ascending: false })
                .limit(20)
        );

        if (!invoices.length) {
            return send(chatId, '📄 У вас пока нет счетов.');
        }

        for (const invoice of invoices) {
            await send(
                chatId,
                `📄 <b>Счёт #${escapeHTML(invoice.id)}</b>\n\n` +
                `Сумма: ${invoice.amount} ${escapeHTML(invoice.currency)}\n` +
                `Статус: ${escapeHTML(invoice.status)}`
            );
        }

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

// ==========================================
// CHECK MENUS
// ==========================================

async function showChecks(chatId) {
    await send(chatId, '🎁 <b>Чеки SMaster</b>', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Создать чек', callback_data: 'check_create' }],
                [{ text: '🎁 Активировать чек', callback_data: 'check_activate' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    });
}

// ==========================================
// START COMMANDS / DEEP LINKS
// ==========================================

bot.onText(/^\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const parameter = String(match[1] || '').trim();

    try {
        await ensureUser(msg.from);

        clearState(userId);

        if (parameter.startsWith('check_')) {
            const checkId = parameter.slice(6);

            if (!checkId) {
                return send(chatId, '❌ Неверная ссылка на чек.');
            }

            return activateCheck(chatId, userId, checkId);
        }

        if (parameter.startsWith('invoice_')) {
            const invoiceId = parameter.slice(8);

            if (!invoiceId) {
                return send(chatId, '❌ Неверная ссылка на счёт.');
            }

            return showInvoice(chatId, userId, invoiceId);
        }

        if (parameter.startsWith('ref_')) {
            const referrerId = Number(parameter.slice(4));

            if (
                Number.isSafeInteger(referrerId) &&
                referrerId !== userId
            ) {
                console.log(
                    `Referral: ${userId} invited by ${referrerId}`
                );
            }

            return showMainMenu(chatId, userId);
        }

        return showMainMenu(chatId, userId);

    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
});

bot.onText(/^\/start$/, async msg => {
    try {
        await ensureUser(msg.from);
        clearState(msg.from.id);
        await showMainMenu(msg.chat.id, msg.from.id);
    } catch (e) {
        await send(
            msg.chat.id,
            `❌ Ошибка БД: ${escapeHTML(e.message)}`
        );
    }
});

bot.onText(/^\/cancel$/, async msg => {
    clearState(msg.from.id);
    await send(msg.chat.id, '❌ Действие отменено.');
    await showMainMenu(msg.chat.id, msg.from.id);
});

// ==========================================
// CALLBACK HANDLER
// ==========================================

bot.on('callback_query', async query => {
    // ОБЯЗАТЕЛЬНО первым действием отвечаем Telegram.
    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) {
        console.error('answerCallbackQuery:', e.message);
    }

    const userId = query.from.id;
    const chatId = query.message?.chat?.id;

    if (!chatId) return;

    const data = query.data || '';

    try {
        // Проверка регистрации.
        await ensureUser(query.from);

        if (data === 'home') {
            clearState(userId);
            return showMainMenu(chatId, userId);
        }

        if (data === 'wallet') {
            return showWallet(chatId, userId);
        }

        if (data === 'deposit') {
            return showDeposit(chatId, userId);
        }

        if (data === 'withdraw') {
            setState(userId, 'withdraw_address');
            return send(
                chatId,
                '📤 Введите TON-адрес получателя:'
            );
        }

        if (data === 'checks') {
            return showChecks(chatId);
        }

        if (data === 'check_create') {
            setState(userId, 'check_amount');
            return send(chatId, 'Введите сумму чека в USDT:');
        }

        if (data === 'check_activate') {
            setState(userId, 'check_id');
            return send(chatId, 'Введите ID чека:');
        }

        if (data === 'invoices') {
            return showInvoiceMenu(chatId);
        }

        if (data === 'invoice_create') {
            return showInvoiceCurrencies(chatId);
        }

        if (data === 'invoice_mine') {
            return showMyInvoices(chatId, userId);
        }

        if (data.startsWith('invcur_')) {
            const currency = data.slice(7);

            if (!CURRENCIES.includes(currency)) {
                return send(chatId, '❌ Неверная валюта.');
            }

            return showInvoiceAmount(chatId, currency, userId);
        }

        if (data.startsWith('invamount_')) {
            const amount = Number(data.slice(10));

            if (isNaN(amount) || !validAmount(amount)) {
                return send(chatId, '❌ Некорректная сумма.');
            }

            const state = getState(userId);

            if (!state || state.action !== 'invoice_amount') {
                return send(chatId, '❌ Сессия устарела.');
            }

            clearState(userId);

            return createInvoice(
                chatId,
                userId,
                amount,
                state.data.currency
            );
        }

        if (data === 'invoice_yes') {
            await payInvoice(chatId, userId);
            return;
        }

        if (data === 'invoice_no') {
            clearState(userId);
            return send(chatId, '❌ Оплата отменена.');
        }

        if (data === 'p2p') {
            return showP2P(chatId);
        }

        if (data === 'p2p_buy') {
            return showP2PAds(chatId);
        }

        if (data === 'p2p_sell') {
            setState(userId, 'p2p_amount');
            return send(chatId, 'Введите сумму объявления:');
        }

        if (data === 'p2p_mine') {
            return showMyAds(chatId, userId);
        }

        if (data.startsWith('p2p_offer_')) {
            return buyP2PAd(
                chatId,
                userId,
                data.slice(10)
            );
        }

        if (data === 'settings') {
            return showSettings(chatId);
        }

        if (data === 'currency') {
            return showCurrencies(chatId);
        }

        if (data.startsWith('setcurrency_')) {
            const currency = data.slice(12);

            if (!DISPLAY_CURRENCIES.includes(currency)) {
                return send(chatId, '❌ Неверная валюта.');
            }

            await updateUserSetting(
                userId,
                'display_currency',
                currency
            );

            return send(
                chatId,
                `✅ Валюта изменена на ${currency}.`
            );
        }

        if (data === 'notifications') {
            return toggleNotifications(chatId, userId);
        }

        if (data === 'language') {
            return showLanguages(chatId);
        }

        if (data.startsWith('lang_')) {
            const language = data.slice(5);

            if (!['RU', 'EN'].includes(language)) {
                return send(chatId, '❌ Неверный язык.');
            }

            await updateUserSetting(
                userId,
                'language',
                language
            );

            return send(
                chatId,
                language === 'RU'
                    ? '✅ Язык изменён на русский.'
                    : '✅ Language changed to English.'
            );
        }

        if (data === 'kyc') {
            await updateUserSetting(userId, 'is_verified', true);
            return send(
                chatId,
                '🪪 Статус KYC отмечен.\n\n' +
                'Важно: это демонстрационный флаг, а не реальная проверка личности.'
            );
        }

        if (data === 'referral') {
            return showReferral(chatId, userId);
        }

    } catch (e) {
        console.error('Callback error:', e.message);

        await send(
            chatId,
            `❌ Ошибка БД: ${escapeHTML(e.message)}`
        );
    }
});

// ==========================================
// TEXT INPUT HANDLER
// ==========================================

bot.on('message', async msg => {
    try {
        if (!msg.text) return;

        if (msg.text.startsWith('/')) return;

        const userId = msg.from.id;
        const chatId = msg.chat.id;

        const state = getState(userId);

        if (!state) return;

        const input = msg.text.trim();

        if (state.action === 'withdraw_address') {
            if (!/^[A-Za-z0-9_-]{40,50}$/.test(input)) {
                return send(chatId, '❌ Неверный TON-адрес. Введите заново.');
            }

            setState(userId, 'withdraw_amount', {
                address: input
            });

            return send(chatId, 'Введите сумму вывода в TON:');
        }

        if (state.action === 'withdraw_amount') {
            const amount = Number(input);

            if (isNaN(amount) || !validAmount(amount)) {
                return send(chatId, '❌ Введите корректное число.');
            }

            const address = state.data.address;

            clearState(userId);

            return withdrawTon(
                chatId,
                userId,
                address,
                amount
            );
        }

        if (state.action === 'check_amount') {
            const amount = Number(input);

            if (isNaN(amount) || !validAmount(amount)) {
                return send(chatId, '❌ Введите число, например 10 или 25.5.');
            }

            clearState(userId);

            return createCheck(chatId, userId, amount);
        }

        if (state.action === 'check_id') {
            if (!/^[a-zA-Z0-9-]{1,100}$/.test(input)) {
                return send(chatId, '❌ Некорректный ID чека.');
            }

            clearState(userId);

            return activateCheck(chatId, userId, input);
        }

        if (state.action === 'invoice_amount') {
            const amount = Number(input);

            if (isNaN(amount) || !validAmount(amount)) {
                return send(chatId, '❌ Введите корректное число.');
            }

            const currency = state.data.currency;

            clearState(userId);

            return createInvoice(
                chatId,
                userId,
                amount,
                currency
            );
        }

        if (state.action === 'p2p_amount') {
            const amount = Number(input);

            if (isNaN(amount) || !validAmount(amount)) {
                return send(chatId, '❌ Введите корректную сумму.');
            }

            setState(userId, 'p2p_price', { amount });

            return send(chatId, 'Введите цену объявления:');
        }

        if (state.action === 'p2p_price') {
            const price = Number(input);

            if (isNaN(price) || !validAmount(price)) {
                return send(chatId, '❌ Введите корректную цену.');
            }

            setState(userId, 'p2p_currency', {
                amount: state.data.amount,
                price
            });

            return send(chatId, 'Выберите валюту:', {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'USDT', callback_data: 'p2pcurrency_USDT' },
                            { text: 'XROCK', callback_data: 'p2pcurrency_XROCK' }
                        ],
                        [{ text: 'TON', callback_data: 'p2pcurrency_TON' }]
                    ]
                }
            });
        }

    } catch (e) {
        console.error('Text handler:', e.message);

        await send(
            msg.chat.id,
            `❌ Ошибка БД: ${escapeHTML(e.message)}`
        );
    }
});

// Обработка выбора валюты P2P.
bot.on('callback_query', async query => {
    const data = query.data || '';

    if (!data.startsWith('p2pcurrency_')) return;

    try {
        await bot.answerCallbackQuery(query.id);

        const currency = data.slice(12);
        const userId = query.from.id;
        const chatId = query.message?.chat?.id;

        if (!chatId) return;

        if (!['USDT', 'XROCK', 'TON'].includes(currency)) {
            return send(chatId, '❌ Неверная валюта.');
        }

        const state = getState(userId);

        if (!state || state.action !== 'p2p_currency') {
            return send(chatId, '❌ Сессия устарела.');
        }

        const { amount, price } = state.data;

        clearState(userId);

        await createP2PAd(
            chatId,
            userId,
            amount,
            price,
            currency
        );

    } catch (e) {
        await send(
            query.message.chat.id,
            `❌ Ошибка БД: ${escapeHTML(e.message)}`
        );
    }
});

        if (data.startsWith('p2pcurrency_')) {
            const currency = data.slice(12);

            if (!['USDT', 'XROCK', 'TON'].includes(currency)) {
                return send(chatId, '❌ Неверная валюта.');
            }

            const state = getState(userId);

            if (!state || state.action !== 'p2p_currency') {
                return send(chatId, '❌ Сессия устарела.');
            }

            const { amount, price } = state.data;

            clearState(userId);

            return createP2PAd(
                chatId,
                userId,
                amount,
                price,
                currency
            );
        }

// ==========================================
// TELEGRAM MINI APP AUTH
// ==========================================

function verifyTelegramInitData(initData) {
    try {
        if (!initData || typeof initData !== 'string') {
            return null;
        }

        if (initData.length > 4096) return null;

        const params = new URLSearchParams(initData);

        const receivedHash = params.get('hash');

        if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
            return null;
        }

        params.delete('hash');

        const authDate = Number(params.get('auth_date'));

        if (
            !Number.isFinite(authDate) ||
            Math.floor(Date.now() / 1000) - authDate > 300 ||
            authDate > Math.floor(Date.now() / 1000) + 30
        ) {
            return null;
        }

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(process.env.BOT_TOKEN)
            .digest();

        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        const a = Buffer.from(receivedHash, 'hex');
        const b = Buffer.from(calculatedHash, 'hex');

        if (
            a.length !== b.length ||
            !crypto.timingSafeEqual(a, b)
        ) {
            return null;
        }

        const user = JSON.parse(params.get('user') || '{}');

        if (!Number.isSafeInteger(Number(user.id))) {
            return null;
        }

        return user;

    } catch (e) {
        console.error('Mini App auth:', e.message);
        return null;
    }
}

function requireTelegramAuth(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];

    const user = verifyTelegramInitData(initData);

    if (!user) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    req.telegramUser = user;
    next();
}

// ==========================================
// MINI APP
// ==========================================

app.get('/app', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f0715">

<title>SMaster Wallet</title>

<script src="https://telegram.org/js/telegram-web-app.js"></script>

<style>
* {
    box-sizing: border-box;
}

body {
    margin: 0;
    padding: 20px;
    min-height: 100vh;
    font-family: Arial, sans-serif;
    color: #fff;
    background: #0f0715;
}

.container {
    max-width: 480px;
    margin: auto;
}

.logo {
    font-size: 28px;
    font-weight: 800;
    color: #ff007f;
    margin: 15px 0 25px;
}

.card {
    background: #1c102b;
    border: 1px solid #392044;
    border-radius: 20px;
    padding: 22px;
    margin-bottom: 16px;
}

.balance-title {
    color: #bba7c9;
    font-size: 14px;
}

.balance {
    font-size: 32px;
    font-weight: bold;
    margin: 12px 0;
}

.currency {
    color: #ff007f;
    font-weight: bold;
}

.actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}

button {
    border: none;
    border-radius: 14px;
    padding: 16px 10px;
    background: #ff007f;
    color: white;
    font-size: 15px;
    font-weight: bold;
}

.secondary {
    background: #352040;
}

.item {
    padding: 15px;
    border-radius: 13px;
    background: #291737;
    margin-top: 10px;
}

.muted {
    color: #bba7c9;
    font-size: 13px;
}

#status {
    margin-top: 15px;
    color: #ff007f;
}
</style>
</head>

<body>
<div class="container">

    <div class="logo">💎 SMaster</div>

    <div class="card">
        <div class="balance-title">Общий баланс</div>
        <div class="balance" id="total">Загрузка...</div>

        <div class="item">
            <span>💵 USDT</span>
            <b id="usdt">0</b>
        </div>

        <div class="item">
            <span>💎 TON</span>
            <b id="ton">0</b>
        </div>

        <div class="item">
            <span>🪙 XROCK</span>
            <b id="xrock">0</b>
        </div>
    </div>

    <div class="card">
        <h3>Быстрые действия</h3>

        <div class="actions">
            <button onclick="openBot('deposit')">
                ➕ Пополнить
            </button>

            <button onclick="openBot('withdraw')">
                📤 Вывести
            </button>

            <button class="secondary" onclick="openBot('checks')">
                🎁 Чеки
            </button>

            <button class="secondary" onclick="openBot('invoices')">
                📄 Счета
            </button>
        </div>

        <div id="status"></div>
    </div>

    <div class="muted">
        SMaster Wallet • TON Network
    </div>

</div>

<script>
const tg = window.Telegram.WebApp;

tg.ready();
tg.expand();

const statusEl = document.getElementById('status');

function openBot(action) {
    tg.sendData(JSON.stringify({
        action: action
    }));
}

async function loadBalance() {
    try {
        const user = tg.initDataUnsafe?.user;

        if (!user?.id || !tg.initData) {
            throw new Error('Откройте приложение через Telegram');
        }

        const response = await fetch(
            '/api/user/' + encodeURIComponent(user.id),
            {
                headers: {
                    'X-Telegram-Init-Data': tg.initData
                }
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Ошибка загрузки');
        }

        document.getElementById('usdt').textContent =
            Number(data.balance_usdt).toFixed(4);

        document.getElementById('ton').textContent =
            Number(data.balance_ton).toFixed(4);

        document.getElementById('xrock').textContent =
            Number(data.balance_xrock).toFixed(4);

        document.getElementById('total').textContent =
            Number(data.balance_usdt).toFixed(2) + ' USDT';

    } catch (e) {
        statusEl.textContent = '❌ ' + e.message;
    }
}

loadBalance();
</script>

</body>
</html>`);
});

// ==========================================
// MINI APP API
// ==========================================

app.get('/api/user/:id', requireTelegramAuth, async (req, res) => {
    try {
        const requestedId = Number(req.params.id);
        const authenticatedId = Number(req.telegramUser.id);

        if (
            !Number.isSafeInteger(requestedId) ||
            requestedId !== authenticatedId
        ) {
            return res.status(403).json({
                error: 'Forbidden'
            });
        }

        const wallet = await getUser(authenticatedId);

        if (!wallet) {
            return res.status(404).json({
                error: 'Wallet not found'
            });
        }

        return res.json({
            balance_usdt: Number(wallet.balance_usdt || 0),
            balance_ton: Number(wallet.balance_ton || 0),
            balance_xrock: Number(wallet.balance_xrock || 0),
            display_currency: wallet.display_currency,
            language: wallet.language
        });

    } catch (e) {
        console.error('Mini App API:', e.message);

        return res.status(500).json({
            error: 'Database error'
        });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'SMaster',
        ton_ready: tonReady,
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// ERROR HANDLING
// ==========================================

bot.on('polling_error', error => {
    console.error('Telegram polling error:', error.message);
});

bot.on('webhook_error', error => {
    console.error('Telegram webhook error:', error.message);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);

    // Не продолжаем работу с потенциально поврежденным
    // состоянием финансового сервиса.
    process.exit(1);
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
    try {
        await initTonWallet();

        app.listen(PORT, () => {
            console.log(`SMaster server running on port ${PORT}`);
            console.log(`Mini App: ${process.env.APP_URL}`);
        });

        // Первая проверка после запуска.
        await checkTonDeposits();

        // Последующие проверки раз в 60 секунд.
        setInterval(() => {
            checkTonDeposits().catch(e => {
                console.error('Deposit scheduler:', e.message);
            });
        }, 60_000);

    } catch (e) {
        console.error('SMaster startup failed:', e.message);
        process.exit(1);
    }
}

startServer();
await bot.sendPhoto(
    chatId,
    'https://placehold.co/800x450/1c102b/ff007f.png?text=SMaster+Check',
    {
        caption: `🎁 SMaster Check\n${amount} USDT`,
        parse_mode: 'HTML'
    }
);bot.on('message', async msg => {
    try {
        if (!msg.web_app_data?.data) return;

        const data = JSON.parse(msg.web_app_data.data);

        const actions = {
            deposit: showDeposit,
            withdraw: async chatId => {
                setState(msg.from.id, 'withdraw_address');
                await send(chatId, 'Введите TON-адрес:');
            },
            checks: showChecks,
            invoices: showInvoiceMenu
        };

        if (actions[data.action]) {
            await actions[data.action](msg.chat.id, msg.from.id);
        }

    } catch (e) {
        await send(
            msg.chat.id,
            `❌ Ошибка: ${escapeHTML(e.message)}`
        );
    }
});
