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

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

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

// ==========================================
// РАБОТА С ПОЛЬЗОВАТЕЛЯМИ И БАЛАНСОМ (SUPABASE)
// ==========================================

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
        throw new Error(`Валюта ${currency} не поддерживается для баланса`);
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

// ==========================================
// ИНИЦИАЛИЗАЦИЯ TON MAINNET
// ==========================================

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

// ==========================================
// МЕНЮ (ОБЪЯВЛЕНЫ ДО ВЫЗОВА)
// ==========================================

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


---

### Часть 2: Настройки, рефералка, обработчики команд/кнопок/текста, Mini App и запуск сервера

Скопируйте эту часть сразу после первой в тот же файл `index.js`:

```javascript
// ==========================================
// НАСТРОЙКИ И РЕФЕРАЛЬНАЯ ПРОГРАММА
// ==========================================

async function showSettings(chatId, messageId = null) {
    return deleteAndSend(chatId, messageId, '⚙️ <b>Настройки SMaster</b>', getSettingsMenu());
}

async function updateUserSetting(userId, field, value) {
    const allowed = ['display_currency', 'notifications', 'language', 'is_verified'];
    if (!allowed.includes(field)) {
        throw new Error('Недопустимый параметр настройки');
    }

    return await dbQuery(
        supabase
            .from('smaster_wallets')
            .update({ [field]: value })
            .eq('user_id', Number(userId))
            .select()
    );
}

async function showCurrencies(chatId, messageId = null) {
    const keyboard = DISPLAY_CURRENCIES.map(currency => [{
        text: currency,
        callback_data: `setcurrency_${currency}`
    }]);
    keyboard.push([{ text: '⬅️ Назад', callback_data: 'settings' }]);

    return deleteAndSend(chatId, messageId, '💱 <b>Выберите валюту отображения:</b>', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function toggleNotifications(chatId, userId, messageId = null) {
    try {
        const wallet = await getUser(userId);
        const next = !wallet.notifications;
        await updateUserSetting(userId, 'notifications', next);

        return deleteAndSend(
            chatId,
            messageId,
            next ? '🔔 Уведомления <b>ВКЛЮЧЕНЫ</b>.' : '🔕 Уведомления <b>ВЫКЛЮЧЕНЫ</b>.',
            getSettingsMenu()
        );
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
}

async function showLanguages(chatId, messageId = null) {
    return deleteAndSend(chatId, messageId, '🌐 <b>Выберите язык интерфейса:</b>', {
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

async function showReferral(chatId, userId, messageId = null) {
    try {
        const username = await getBotUsername();
        const link = `https://t.me{username}?start=ref_${userId}`;

        return deleteAndSend(
            chatId,
            messageId,
            `👥 <b>Реферальная программа SMaster</b>\n\n` +
            `Ваша персональная ссылка:\n<code>${escapeHTML(link)}</code>\n\n` +
            `Приглашайте друзей и развивайте экосистему SMaster!`,
            {
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'home' }]] }
            }
        );
    } catch (e) {
        return send(chatId, `❌ Ошибка: ${escapeHTML(e.message)}`);
    }
}

// ==========================================
// ОБРАБОТЧИКИ /START И DEEP LINKS
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
            if (!checkId) return send(chatId, '❌ Неверная ссылка на чек.');
            return activateCheck(chatId, userId, checkId);
        }

        if (parameter.startsWith('invoice_')) {
            const invoiceId = parameter.slice(8);
            if (!invoiceId) return send(chatId, '❌ Неверная ссылка на счёт.');
            return showInvoiceConfirmation(chatId, userId, invoiceId);
        }

        if (parameter.startsWith('ref_')) {
            return showMainMenu(chatId, userId);
        }

        return showMainMenu(chatId, userId);
    } catch (e) {
        return send(chatId, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
});

bot.onText(/^\/start$/, async msg => {
    try {
        await ensureUser(msg.from);
        clearState(msg.from.id);
        return showMainMenu(msg.chat.id, msg.from.id);
    } catch (e) {
        return send(msg.chat.id, `❌ Ошибка БД: ${escapeHTML(e.message)}`);
    }
});

bot.onText(/^\/cancel$/, async msg => {
    clearState(msg.from.id);
    await send(msg.chat.id, '❌ Текущее действие отменено.');
    return showMainMenu(msg.chat.id, msg.from.id);
});

// ==========================================
// ЕДИНЫЙ ОБРАБОТЧИК CALLBACK КНОПОК
// ==========================================

bot.on('callback_query', async query => {
    // ОБЯЗАТЕЛЬНО вызываем первым действием
    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) {
        console.error('answerCallbackQuery error:', e.message);
    }

    const userId = query.from.id;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (!chatId) return;

    const data = query.data || '';

    try {
        await ensureUser(query.from);

        if (data === 'home') {
            clearState(userId);
            return showMainMenu(chatId, userId, messageId);
        }

        if (data === 'wallet') return showWallet(chatId, userId, messageId);
        if (data === 'deposit') return showDeposit(chatId, userId, messageId);

        if (data === 'withdraw') {
            setState(userId, 'withdraw_address');
            return deleteAndSend(chatId, messageId, '📤 Введите <b>TON-адрес</b> получателя (48 символов):', {
                reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'home' }]] }
            });
        }

        // ЧЕКИ
        if (data === 'checks') return showChecks(chatId, messageId);

        if (data === 'check_create') {
            setState(userId, 'check_amount');
            return deleteAndSend(chatId, messageId, '💵 Введите сумму чека в <b>USDT</b>:', {
                reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'checks' }]] }
            });
        }

        if (data === 'check_activate') {
            setState(userId, 'check_id');
            return deleteAndSend(chatId, messageId, '🎁 Введите <b>ID чека</b> для активации:', {
                reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'checks' }]] }
            });
        }

        // СЧЕТА
        if (data === 'invoices') return showInvoiceMenu(chatId, messageId);
        if (data === 'invoice_create') return showInvoiceCurrencies(chatId, messageId);
        if (data === 'invoice_mine') return showMyInvoices(chatId, userId, messageId);

        if (data.startsWith('invcur_')) {
            const currency = data.slice(7);
            if (!CURRENCIES.includes(currency)) return send(chatId, '❌ Неподдерживаемая валюта.');
            return showInvoiceAmount(chatId, currency, userId, messageId);
        }

        if (data.startsWith('invamount_')) {
            const amount = Number(data.slice(10));
            if (isNaN(amount) || !validAmount(amount)) return send(chatId, '❌ Некорректная сумма.');

            const state = getState(userId);
            if (!state || state.action !== 'invoice_amount') {
                return deleteAndSend(chatId, messageId, '❌ Сессия устарела.', getMainMenu());
            }

            clearState(userId);
            if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
            return createInvoice(chatId, userId, amount, state.data.currency);
        }

        if (data === 'invoice_yes') return payInvoice(chatId, userId, messageId);

        if (data === 'invoice_no') {
            clearState(userId);
            return deleteAndSend(chatId, messageId, '❌ Оплата счёта отменена.', getMainMenu());
        }

        // P2P
        if (data === 'p2p') return showP2P(chatId, messageId);
        if (data === 'p2p_buy') return showP2PAds(chatId, messageId);
        if (data === 'p2p_mine') return showMyAds(chatId, userId, messageId);

        if (data === 'p2p_sell') {
            setState(userId, 'p2p_amount');
            return deleteAndSend(chatId, messageId, '📦 Введите <b>количество монет</b> для продажи:', {
                reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'p2p' }]] }
            });
        }

        if (data.startsWith('p2pcurrency_')) {
            const currency = data.slice(12);
            if (!['USDT', 'TON'].includes(currency)) return send(chatId, '❌ Неверная валюта.');

            const state = getState(userId);
            if (!state || state.action !== 'p2p_currency') {
                return deleteAndSend(chatId, messageId, '❌ Сессия устарела.', getMainMenu());
            }

            const { amount, price } = state.data;
            clearState(userId);
            if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
            return createP2PAd(chatId, userId, amount, price, currency);
        }

        if (data.startsWith('p2p_offer_')) {
            return buyP2PAd(chatId, userId, data.slice(10));
        }

        // НАСТРОЙКИ И РЕФЕРАЛКА
        if (data === 'settings') return showSettings(chatId, messageId);
        if (data === 'currency') return showCurrencies(chatId, messageId);
        if (data === 'notifications') return toggleNotifications(chatId, userId, messageId);
        if (data === 'language') return showLanguages(chatId, messageId);
        if (data === 'referral') return showReferral(chatId, userId, messageId);

        if (data.startsWith('setcurrency_')) {
            const currency = data.slice(12);
            if (!DISPLAY_CURRENCIES.includes(currency)) return send(chatId, '❌ Неверная валюта.');
            await updateUserSetting(userId, 'display_currency', currency);
