'use strict';

const states = new Map();
const processedTxHashes = new Set();

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const helmet = require('helmet');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { TonClient, WalletContractV4, internal, toNano, fromNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'unsafe-inline'", "https://telegram.org"],
            styleSrc: ["'unsafe-inline'"],
            connectSrc: ["'self'"]
        }
    }
}));
app.use(express.json({ limit: '20kb' }));

const TON_ENDPOINT = 'https://toncenter.com';
const tonClient = new TonClient({
    endpoint: `${TON_ENDPOINT}/jsonRPC`,
    apiKey: process.env.TONCENTER_API_KEY
});

let tonWallet;
let tonKeyPair;
let tonAddress;
let tonReady = false;
let depositScanRunning = false;
let cachedBotUsername = null;

const CURRENCIES = ['USDT', 'XROCK', 'USDC', 'GRAM', 'TRX', 'SOL', 'BTC', 'ETH', 'BNB'];
const DISPLAY_CURRENCIES = ['USD', 'RUB', 'EUR', 'UAH', 'KZT'];
const CURRENCY_RATES = { USD: 1, RUB: 92.5, EUR: 0.92, UAH: 41.2, KZT: 485.0 };

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function validAmount(value, max = 1000000000) {
    const amount = Number(value);
    if (value === '' || !Number.isFinite(amount) || isNaN(amount) || amount <= 0 || amount > max) {
        return null;
    }
    return Number(amount.toFixed(6));
}

function formatAmount(value) {
    return Number(value || 0).toFixed(4);
}

function formatFiat(usdAmount, displayCurrency) {
    const rate = CURRENCY_RATES[displayCurrency] || 1;
    return `${(Number(usdAmount || 0) * rate).toFixed(2)} ${displayCurrency}`;
}

function getState(userId) {
    return states.get(String(userId)) || null;
}

function setState(userId, action, data = {}) {
    states.set(String(userId), { action, data, createdAt: Date.now() });
}

function clearState(userId) {
    states.delete(String(userId));
}

async function getBotUsername() {
    if (!cachedBotUsername) {
        const me = await bot.getMe();
        cachedBotUsername = me.username;
    }
    return cachedBotUsername;
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
    if (messageId) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
    }
    return send(chatId, text, options);
}

async function dbQuery(promise) {
    const { data, error } = await promise;
    if (error) {
        throw new Error(error.message);
    }
    return data;
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
                    display_currency: 'USD',
                    notifications: true,
                    language: 'RU',
                    is_verified: false
                })
                .select()
                .single()
        );
    } else if (user.username && wallet.username !== user.username) {
        await dbQuery(
            supabase
                .from('smaster_wallets')
                .update({ username: user.username })
                .eq('user_id', id)
        );
    }
    return wallet;
}

async function logHistory(userId, type, amount, currency) {
    await dbQuery(
        supabase
            .from('smaster_history')
            .insert({
                user_id: Number(userId),
                type: String(type),
                amount: Number(amount),
                currency: String(currency)
            })
    );
}

async function updateBalance(userId, currency, delta, historyType) {
    const col = currency === 'TON' ? 'balance_ton' : currency === 'USDT' ? 'balance_usdt' : null;
    if (!col) {
        throw new Error(`Валюта ${currency} не поддерживается`);
    }

    const wallet = await getUser(userId);
    if (!wallet) {
        throw new Error('Кошелёк пользователя не найден');
    }

    const currentBalance = Number(wallet[col] || 0);
    const nextBalance = Number((currentBalance + Number(delta)).toFixed(6));

    if (nextBalance < 0) {
        throw new Error(`Недостаточно средств (${currency})`);
    }

    await dbQuery(
        supabase
            .from('smaster_wallets')
            .update({ [col]: nextBalance })
            .eq('user_id', Number(userId))
    );

    if (historyType) {
        await logHistory(userId, historyType, delta, currency);
    }

    return nextBalance;
}

async function initTonWallet() {
    try {
        const mnemonic = process.env.MAIN_WALLET_MNEMONIC.trim().split(/\s+/);
        if (mnemonic.length !== 24) {
            throw new Error('MAIN_WALLET_MNEMONIC должен содержать 24 слова');
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
        console.log('TON Mainnet wallet ready:', tonAddress);
    } catch (e) {
        tonReady = false;
        console.error('TON initialization failed:', e.message);
        throw e;
    }
}

function getTonContract() {
    if (!tonReady || !tonWallet) {
        throw new Error('TON-кошелёк не инициализирован');
    }
    return tonClient.open(tonWallet);
}

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
                    { text: '🚀 Mini App', web_app: { url: process.env.APP_URL } }
                ]
            ]
        }
    };
}

function getSettingsMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💱 Валюта отображения', callback_data: 'currency' }],
                [{ text: '🔔 Уведомления', callback_data: 'notifications' }],
                [{ text: '🌐 Язык (RU/EN)', callback_data: 'language' }],
                [{ text: '🪪 Верификация KYC', callback_data: 'kyc' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    };
}

async function showMainMenu(chatId, userId, messageId = null) {
    try {
        const wallet = await getUser(userId);
        if (!wallet) {
            return deleteAndSend(chatId, messageId, '❌ Кошелёк не найден. Нажмите /start');
        }

        const approxFiat = formatFiat(wallet.balance_usdt, wallet.display_currency);
        const text =
            `👋 <b>Добро пожаловать в SMaster!</b>\n\n` +
            `💵 USDT: <b>${formatAmount(wallet.balance_usdt)}</b> (~${escapeHTML(approxFiat)})\n` +
            `💎 TON: <b>${formatAmount(wallet.balance_ton)}</b>\n\n` +
            `Выберите раздел:`;

        return deleteAndSend(chatId, messageId, text, getMainMenu());
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showWallet(chatId, userId, messageId = null) {
    try {
        const wallet = await getUser(userId);
        if (!wallet) throw new Error('Кошелёк не найден');

        const approxFiat = formatFiat(wallet.balance_usdt, wallet.display_currency);
        const text =
            `💼 <b>Ваш кошелёк SMaster</b>\n\n` +
            `💵 USDT: <b>${formatAmount(wallet.balance_usdt)}</b> (~${escapeHTML(approxFiat)})\n` +

```javascript
async function showChecks(chatId, messageId = null) {
    return deleteAndSend(chatId, messageId, '🎁 <b>Чеки SMaster</b>\n\nСоздавайте чеки в USDT и делитесь ими по ссылке:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Создать чек (USDT)', callback_data: 'check_create' }],
                [{ text: '🎁 Активировать по ID', callback_data: 'check_activate' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    });
}

async function createCheck(chatId, userId, amount) {
    let deducted = false;
    try {
        await updateBalance(userId, 'USDT', -amount, 'check_create');
        deducted = true;

        const check = await dbQuery(
            supabase
                .from('smaster_checks')
                .insert({
                    creator_id: Number(userId),
                    amount: Number(amount),
                    status: 'active',
                    claimed_by: null,
                    limit_activations: 1
                })
                .select()
                .single()
        );

        const botUsername = await getBotUsername();
        const link = `https://t.me{botUsername}?start=check_${check.id}`;
        const imageUrl = `https://placehold.co{amount}+USDT`;

        await bot.sendPhoto(chatId, imageUrl, {
            caption:
                `🎁 <b>Чек SMaster создан!</b>\n\n` +
                `💵 Номинал: <b>${formatAmount(amount)} USDT</b>\n` +
                `🆔 ID чека: <code>${escapeHTML(check.id)}</code>\n` +
                `🔗 Ссылка для активации:\n<code>${escapeHTML(link)}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎁 Активировать чек', url: link }],
                    [{ text: '⬅️ В меню', callback_data: 'home' }]
                ]
            }
        });
    } catch (e) {
        if (deducted) {
            await updateBalance(userId, 'USDT', amount, 'check_refund').catch(() => {});
        }
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`, getMainMenu());
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
            return send(chatId, '❌ Чек не найден.', getMainMenu());
        }
        if (Number(check.creator_id) === Number(userId)) {
            return send(chatId, '❌ Нельзя активировать собственный чек.', getMainMenu());
        }
        if (check.status !== 'active') {
            return send(chatId, '❌ Этот чек уже активирован или недействителен.', getMainMenu());
        }

        const updated = await dbQuery(
            supabase
                .from('smaster_checks')
                .update({ status: 'claimed', claimed_by: Number(userId) })
                .eq('id', checkId)
                .eq('status', 'active')
                .select()
        );

        if (!updated || updated.length === 0) {
            return send(chatId, '❌ Чек уже успел забрать другой пользователь.', getMainMenu());
        }

        await updateBalance(userId, 'USDT', Number(check.amount), 'check_claim');

        await send(
            chatId,
            `🎉 <b>Чек успешно активирован!</b>\n\n💵 Зачислено: <b>+${formatAmount(check.amount)} USDT</b>`,
            getMainMenu()
        );

        const creator = await getUser(check.creator_id);
        if (creator?.notifications) {
            await send(check.creator_id, `🎁 Ваш чек #${escapeHTML(check.id)} на <b>${formatAmount(check.amount)} USDT</b> был активирован!`);
        }
    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`, getMainMenu());
    }
}

async function showInvoiceMenu(chatId, messageId = null) {
    return deleteAndSend(chatId, messageId, '📄 <b>Счета SMaster</b>', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Создать счёт', callback_data: 'invoice_create' }],
                [{ text: '📄 Мои счета', callback_data: 'invoice_mine' }],
                [{ text: '⬅️ Назад', callback_data: 'home' }]
            ]
        }
    });
}

async function showInvoiceCurrencies(chatId, messageId = null) {
    const keyboard = [];
    for (let i = 0; i < CURRENCIES.length; i += 3) {
        keyboard.push(
            CURRENCIES.slice(i, i + 3).map(currency => ({
                text: currency,
                callback_data: `invcur_${currency}`
            }))
        );
    }
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'invoices' }]);

    return deleteAndSend(chatId, messageId, '💱 <b>Выберите валюту счёта:</b>', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function showInvoiceAmount(chatId, currency, userId, messageId = null) {
    setState(userId, 'invoice_amount', { currency });
    return deleteAndSend(
        chatId,
        messageId,
        `💵 Выбрана валюта: <b>${escapeHTML(currency)}</b>\n\nВыберите быструю сумму или введите её числом вручную:`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '1', callback_data: 'invamount_1' },
                        { text: '2', callback_data: 'invamount_2' }
                    ],
                    [{ text: '⬅️ Назад', callback_data: 'invoice_create' }]
                ]
            }
        }
    );
}

async function createInvoice(chatId, userId, amount, currency) {
    try {
        const invoice = await dbQuery(
            supabase
                .from('smaster_invoices')
                .insert({
                    creator_id: Number(userId),
                    amount: Number(amount),
                    currency: String(currency),
                    status: 'pending',
                    paid_by: null
                })
                .select()
                .single()
        );

        const botUsername = await getBotUsername();
        const link = `https://t.me{botUsername}?start=invoice_${invoice.id}`;

        await send(
            chatId,
            `📄 <b>Счёт создан!</b>\n\n` +
            `💰 Сумма: <b>${formatAmount(amount)} ${escapeHTML(currency)}</b>\n` +
            `🆔 ID: <code>${escapeHTML(invoice.id)}</code>\n` +
            `🔗 Ссылка на оплату:\n<code>${escapeHTML(link)}</code>`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📄 Открыть счёт', url: link }],
                        [{ text: '⬅️ В меню', callback_data: 'home' }]
                    ]
                }
            }
        );
    } catch (e) {
        await send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`, getMainMenu());
    }
}

async function showMyInvoices(chatId, userId, messageId = null) {
    try {
        const invoices = await dbQuery(
            supabase
                .from('smaster_invoices')
                .select('*')
                .eq('creator_id', Number(userId))
                .order('created_at', { ascending: false })
                .limit(15)
        );

        if (!invoices.length) {
            return deleteAndSend(chatId, messageId, '📄 У вас пока нет созданных счетов.', {
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'invoices' }]] }
            });
        }

        const list = invoices.map(inv => {
            const st = inv.status === 'paid' ? '✅ Оплачен' : '⏳ Ожидает';
            return `• <b>#${escapeHTML(inv.id)}</b> — ${formatAmount(inv.amount)} ${escapeHTML(inv.currency)} (${st})`;
        }).join('\n');

        return deleteAndSend(chatId, messageId, `📄 <b>Мои счета:</b>\n\n${list}`, {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'invoices' }]] }
        });
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showInvoiceConfirmation(chatId, userId, invoiceId) {
    try {
        const invoice = await dbQuery(
            supabase
                .from('smaster_invoices')
                .select('*')
                .eq('id', invoiceId)
                .maybeSingle()
        );

        if (!invoice) {
            return send(chatId, '❌ Счёт не найден.', getMainMenu());
        }
        if (invoice.status !== 'pending') {
            return send(chatId, '❌ Этот счёт уже оплачен или отменён.', getMainMenu());
        }
        if (Number(invoice.creator_id) === Number(userId)) {
            return send(chatId, '❌ Нельзя оплатить собственный счёт.', getMainMenu());
        }

        setState(userId, 'invoice_confirm', { invoiceId: String(invoice.id) });

        return send(
            chatId,
            `📄 <b>Подтверждение оплаты счёта #${escapeHTML(invoice.id)}</b>\n\n` +
            `💰 Сумма к списанию: <b>${formatAmount(invoice.amount)} ${escapeHTML(invoice.currency)}</b>\n\n` +
            `Вы подтверждаете оплату?`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Да, оплатить', callback_data: 'invoice_yes' },
                            { text: '❌ Нет, отмена', callback_data: 'invoice_no' }
                        ]
                    ]
                }
            }
        );
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function payInvoice(chatId, userId, messageId = null) {
    try {
        const state = getState(userId);
        if (!state || state.action !== 'invoice_confirm') {
