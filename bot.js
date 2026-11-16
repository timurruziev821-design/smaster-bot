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
            `💎 TON: <b>${formatAmount(wallet.balance_ton)}</b>\n\n` +
