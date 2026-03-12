import { Telegraf, Markup } from 'telegraf';
import * as QRCode from 'qrcode';
import * as dotenv from 'dotenv';
import * as http from 'http';
import { makeSTXTokenTransfer, broadcastTransaction, AnchorMode } from '@stacks/transactions';
import { StacksTestnet } from '@stacks/network';
import { createWallet, getBalance } from './services/wallet';
import { pool, initDb } from './db/db';
import { encryptPrivateKey, decryptPrivateKey } from './services/crypto';
import { getPortfolio } from './services/portfolio';
import { startLimitOrderMonitor } from './services/jobs/limitOrders';
import { startCopyTradeMonitor } from './services/jobs/copyTrading';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'your_telegram_bot_token_here') {
  console.error('Please set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.command('start', async (ctx) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  if (!userId) return;

  let walletAddress = '';

  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);

  if (res.rowCount === 0) {
    await ctx.reply('🤖 Welcome to StackBot!\n\nGenerating your Stacks Testnet wallet... please wait ⏳');
    const wallet = await createWallet();
    const { encrypted, iv, authTag } = encryptPrivateKey(wallet.privateKey, userId);

    await pool.query(
      'INSERT INTO users (telegram_id, username, address, mnemonic, encrypted_private_key, iv, auth_tag) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, username, wallet.address, wallet.mnemonic, encrypted, iv, authTag]
    );
    walletAddress = wallet.address;
  } else {
    walletAddress = res.rows[0].address;
  }

  const msg = `🤖 Welcome to StackBot!

The fastest way to trade on Stacks DEXs 🚀

Your wallet has been created:
Address: \`${walletAddress}\`

⚠️ NEVER share your private key or mnemonic!

➡️ Deposit testnet STX to start trading
➡️ Use /help for commands`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('💱 Trade', 'menu_trade')],
    [Markup.button.callback('📊 Portfolio', 'menu_portfolio'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
  ]);

  await ctx.replyWithMarkdown(msg, keyboard);
});



bot.action('menu_wallet', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
  if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');

  const address = res.rows[0].address;
  const { stx: stxBalance } = await getBalance(address);

  const msg = `💼 *Your Wallet*

Address: \`${address}\`
Balance: ${stxBalance} STX (Testnet)

Deposit Testnet STX to this address to begin.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📥 Deposit', 'wallet_deposit'), Markup.button.callback('📤 Withdraw', 'wallet_withdraw')],
    [Markup.button.callback('🔑 Export Key', 'wallet_export')],
    [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
  ]);

  try {
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e: any) {
    // If the message text is exactly the same, Telegram throws an error. Ignore it.
    // If message is a photo, editMessageText throws. In that case, reply instead.
    if (e.description?.includes('there is no text') || e.description?.includes('message is not modified')) {
        await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } else {
        await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    }
  }
});

bot.action('menu_main', async (ctx) => {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('💱 Trade', 'menu_trade')],
        [Markup.button.callback('📊 Portfolio', 'menu_portfolio'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
    ]);
    try {
        await ctx.editMessageText('🏠 *Main Menu*', { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (e) {}
});

bot.action('menu_portfolio', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
  if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');

  const portfolio = await getPortfolio(res.rows[0].address);

  const holdingsList = portfolio.tokens.map(t => 
       `• ${t.symbol}: ${t.balance} ($${t.valueUsd.toFixed(2)})`
  ).join('\n');

  const msg = `💼 *Your Portfolio*

Total Value: $${portfolio.totalUsd} USD

Holdings:
${holdingsList}
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'menu_portfolio'), Markup.button.callback('💱 Trade', 'menu_trade')],
    [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
  ]);

  try {
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {}
});

bot.action('menu_trade', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
      const res = await pool.query('SELECT trading_currency FROM users WHERE telegram_id = $1', [userId]);
      if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');
      
      const currency = res.rows[0].trading_currency || 'STX';

      const msg = `💱 *Trade tokens on Stacks*
  
Trading with: **${currency}** 🪙

Select a popular token below to quick-buy, or paste a contract address using \`/buy <address>\` to snipe any SIP-010 token!`;

      // using the deployed mock for testing, but labeling them as real tokens for UI feel
      const mockAddr = 'ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4.mock-token-v4';
      const wId = getTokenId(mockAddr);

      const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🐶 Buy WELSH', `t_buy_${wId}`),
            Markup.button.callback('🐱 Buy LEO', `t_buy_${wId}`)
        ],
        [
            Markup.button.callback('💧 Buy DIKO', `t_buy_${wId}`),
            Markup.button.callback('🔍 Custom Token', `t_custom`)
        ],
        [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
      ]);

      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {
      console.error('Error loading trade menu', e);
  }
});

bot.action(/t_buy_(\d+)/, async (ctx) => {
    const match = ctx.match;
    if (!match) return;

    const tId = parseInt(match[1]);
    const tokenAddress = tokenAddressMap.get(tId);
    if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

    // Force TS to allow replacing the readonly message object to trick the text handler
    Object.defineProperty(ctx, 'message', {
        value: { text: `/buy ${tokenAddress}` },
        writable: true
    });
    
    // Trigger the buy command
    bot.handleUpdate({
        ...ctx.update,
        message: { text: `/buy ${tokenAddress}`, from: ctx.from, chat: ctx.chat }
    } as any);
    
    await ctx.answerCbQuery('Fetching quote...');
});

bot.action('t_custom', async (ctx) => {
    await ctx.answerCbQuery('Reply to this bot with: /buy <contract.address>', { show_alert: true });
});

bot.action('menu_settings', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
        const res = await pool.query('SELECT trading_currency FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');
        
        const currency = res.rows[0].trading_currency || 'STX';

        const msg = `⚙️ *Settings*
        
Primary Trading Currency: **${currency}**
_This currency will be used by default for all swaps and pair routing._

Select a currency below to change it:`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(currency === 'STX' ? '✅ STX' : 'STX', 'set_currency_STX'),
                Markup.button.callback(currency === 'SBTC' ? '✅ sBTC' : 'sBTC', 'set_currency_SBTC'),
                Markup.button.callback(currency === 'USDCX' ? '✅ USDCx' : 'USDCx', 'set_currency_USDCX')
            ],
            [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
        ]);

        await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } catch (e) {
        console.error('Error loading settings', e);
    }
});

const currencies = ['STX', 'SBTC', 'USDCX'];
currencies.forEach(currency => {
    bot.action(`set_currency_${currency}`, async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            await pool.query('UPDATE users SET trading_currency = $1 WHERE telegram_id = $2', [currency, userId]);
            await ctx.answerCbQuery(`Trading currency set to ${currency}`);
            
            // Reload settings menu
            bot.handleUpdate({
                ...ctx.update,
                callback_query: {
                    ...ctx.callbackQuery,
                    data: 'menu_settings'
                }
            } as any);
        } catch (e) {
            console.error('Failed to set currency', e);
            await ctx.answerCbQuery('Failed to update currency.');
        }
    });
});

bot.action('wallet_deposit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
        const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found.');

        const address = res.rows[0].address;
        const qrBuffer = await QRCode.toBuffer(address, {
             errorCorrectionLevel: 'H',
             margin: 2,
             width: 400
        });

        const msg = `📥 *Deposit STX*
        
Send STX (Testnet) only to this address:
\`${address}\`

_Note: The bot does not process deposits. Once you send STX from your wallet or faucet, you can check your updated Balance in the Wallet menu after the next Stacks block confirms._`;

        const keyboard = Markup.inlineKeyboard([
             [Markup.button.callback('🔙 Back to Wallet', 'wallet_return')]
        ]);

        await ctx.replyWithPhoto({ source: qrBuffer }, { caption: msg, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        await ctx.answerCbQuery();
    } catch (e) {
        console.error('QR Error', e);
        ctx.answerCbQuery('Failed to load deposit info.');
    }
});

bot.action('wallet_export', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
        const res = await pool.query('SELECT mnemonic, address FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found.');

        const user = res.rows[0];

        const msg = `⚠️ *CRITICAL SECURITY WARNING* ⚠️

Anyone with this mnemonic phrase has full control over your funds. 
Never share this with anyone, including admins.

*Your 24-Word Mnemonic Phrase:*
\`\`\`
${user.mnemonic}
\`\`\`

*Public Address:*
\`${user.address}\`

_Please write this down and delete this message._`;

        const keyboard = Markup.inlineKeyboard([
             [Markup.button.callback('🗑️ Delete Message', 'delete_msg')]
        ]);

        await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
        await ctx.answerCbQuery();
    } catch (e) {
         ctx.answerCbQuery('Failed to export key.');
    }
});

bot.action('delete_msg', async (ctx) => {
    try {
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCbQuery('Message deleted.').catch(() => {});
    } catch (e) {
        await ctx.answerCbQuery('Could not delete message.').catch(() => {});
    }
});

bot.action('wallet_return', async (ctx) => {
    try {
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCbQuery().catch(() => {});
    } catch (e) {}

    // Trigger the wallet menu cleanly
    bot.handleUpdate({
        ...ctx.update,
        callback_query: {
            ...ctx.callbackQuery,
            data: 'menu_wallet'
        }
    } as any);
});

// Simple in-memory state machine for the withdrawal flow
// In a production environment, this should be in Redis to survive restarts
const withdrawState = new Map<number, { step: 'address' | 'amount', address?: string }>();

bot.action('wallet_withdraw', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    withdrawState.set(userId, { step: 'address' });

    const msg = `📤 *Withdraw STX*

Please reply to this message with the **destination Stacks address**:

_(Type /cancel at any time to abort)_`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});

bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (withdrawState.has(userId!)) {
        withdrawState.delete(userId!);
        await ctx.reply('❌ Withdrawal cancelled.');
    } else {
        await ctx.reply('Nothing to cancel.');
    }
});

// Global text listener to catch the conversational states
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (!withdrawState.has(userId)) return next();
    if (text.startsWith('/')) return next(); // Let commands passthrough

    const state = withdrawState.get(userId)!;

    if (state.step === 'address') {
        // Very basic STX address validation
        if (!text.startsWith('S') || text.length < 35) {
             return ctx.reply('❌ Invalid Stacks address. Please try again or /cancel.');
        }

        state.address = text;
        state.step = 'amount';
        withdrawState.set(userId, state);

        await ctx.reply(`Address saved: \`${text}\`\n\nHow much STX would you like to withdraw? (e.g. 5.5)`, { parse_mode: 'Markdown' });
        return;
    }

    if (state.step === 'amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
             return ctx.reply('❌ Invalid amount. Must be a number greater than 0.');
        }

        withdrawState.delete(userId); // Consume state

        const loadMsg = await ctx.reply(`Processing withdrawal of ${amount} STX to \`${state.address}\`... ⏳`, { parse_mode: 'Markdown' });

        try {
            const res = await pool.query('SELECT address, encrypted_private_key, iv, auth_tag FROM users WHERE telegram_id = $1', [userId]);
            if (res.rowCount === 0) return ctx.reply('Error: wallet not found.');

            const user = res.rows[0];
            const decryptedPrivKey = decryptPrivateKey({
                encrypted: user.encrypted_private_key,
                iv: user.iv,
                authTag: user.auth_tag
            }, userId);

            // Fetch balance to verify funds
            const { stx } = await getBalance(user.address);
            if (parseFloat(stx) < amount) {
                return ctx.reply(`❌ Insufficient balance. You only have ${stx} STX.`);
            }

            // Convert STX string decimal to microSTX integer payload
            const amountMicroStx = Math.floor(amount * 1000000);

            const txOptions = {
              recipient: state.address!,
              amount: amountMicroStx,
              senderKey: decryptedPrivKey,
              network: new StacksTestnet(),
              memo: 'StackBot Withdraw',
              anchorMode: AnchorMode.Any
            };

            const tx = await makeSTXTokenTransfer(txOptions);
            const broadcastRes = await broadcastTransaction(tx, new StacksTestnet());

            if (broadcastRes.error) {
                await ctx.reply(`❌ **Withdrawal Failed!**\n\nReason: \`${broadcastRes.error}\``, { parse_mode: 'Markdown' });
            } else {
                const txid = typeof broadcastRes === 'string' ? broadcastRes : broadcastRes.txid;
                await ctx.reply(`✅ **Withdrawal Submitted!**\n\nTxID: [${txid}](https://explorer.hiro.so/txid/${txid}?chain=testnet)\n\nFunds will arrive in the destination wallet shortly.`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
            }
        } catch (e: any) {
            console.error('Withdrawal error:', e);
            await ctx.reply(`❌ An error occurred during withdrawal: ${e.message}`);
        } finally {
            if (ctx.chat?.id && loadMsg.message_id) {
                 await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
            }
        }
        return;
    }
});

bot.command('limit', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Expected format: /limit buy SP123...MockToken 0.005 100
    const text = ctx.message.text.split(' ');
    if (text.length < 5) return ctx.reply('Usage: /limit <buy/sell> <token_address> <target_price> <amount>');

    const orderType = text[1].toLowerCase();
    const token = text[2];
    const targetPrice = parseFloat(text[3]);
    const amount = parseFloat(text[4]);

    if (orderType !== 'buy' && orderType !== 'sell') return ctx.reply('Type must be buy or sell');
    if (isNaN(targetPrice) || isNaN(amount)) return ctx.reply('Invalid price or amount');

    try {
        const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');
        
        const internalUserId = res.rows[0].id;
        
        await pool.query(
          "INSERT INTO limit_orders (user_id, token_address, order_type, target_price, amount, status) VALUES ($1, $2, $3, $4, $5, 'active')",
          [internalUserId, token, orderType, targetPrice, amount]
        );
        
        await ctx.reply(`✅ Limit order set!\n\nWill ${orderType} ${amount} of \`${token}\` when price reaches $${targetPrice}.`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Error saving limit order', e);
        ctx.reply('Failed to save limit order.');
    }
});

bot.command('copy', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Expected format: /copy SP123...TargetWallet 50
    const text = ctx.message.text.split(' ');
    if (text.length < 3) return ctx.reply('Usage: /copy <wallet_address> <max_amount_per_trade_STX>');

    const targetWallet = text[1];
    const maxAmount = parseFloat(text[2]);
    if (isNaN(maxAmount)) return ctx.reply('Invalid max amount');

    try {
        const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');
        
        const internalUserId = res.rows[0].id;
        
        await pool.query(
          "INSERT INTO copy_wallets (user_id, wallet_to_copy, max_amount_per_trade, is_active) VALUES ($1, $2, $3, true)",
          [internalUserId, targetWallet, maxAmount]
        );
        
        await ctx.reply(`✅ Copy Trading Started!\n\nMonitoring \`${targetWallet.slice(0, 8)}...\` for swaps.\nMax trade size: ${maxAmount} STX.`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Error saving copy wallet', e);
        ctx.reply('Failed to set up copy trading.');
    }
});

import { findBestPrice, executeBestSwap } from './services/dex/router';

// Telegram strictly limits callback_data to 64 bytes.
// Stacks Contract Addresses can be 60+ chars. We'll use a fast mapped ID.
const tokenAddressMap = new Map<number, string>();
let nextTokenId = 1;

function getTokenId(address: string): number {
    for (const [id, addr] of tokenAddressMap.entries()) {
        if (addr === address) return id;
    }
    const id = nextTokenId++;
    tokenAddressMap.set(id, address);
    return id;
}

bot.command('buy', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Expected format: /buy SP123...TokenTarget
    const text = ctx.message.text.split(' ');
    if (text.length < 2) return ctx.reply('Usage: /buy <token_contract_address>');

    const tokenAddress = text[1];

    try {
        const res = await pool.query('SELECT id, address, trading_currency FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');
        
        const userAddress = res.rows[0].address;
        const currency = res.rows[0].trading_currency || 'STX';
        
        // Let user know we are fetching data
        const loadMsg = await ctx.reply('Fetching live token data... ⏳');

        // Fetch balances & quote 
        const { stx: stxBalance } = await getBalance(userAddress);
        const quote = await findBestPrice(currency, tokenAddress, 10, 'buy'); // Predict for 10 BASE

        const detailsMsg = `🟢 *Buy Token*
        
Token: \`${tokenAddress}\`
Current Price: ${quote.quote?.price || 'N/A'} ${currency}
Est. Price Impact: ${quote.quote?.priceImpact || 'N/A'}%
Source: ${quote.dex.toUpperCase()}

Wallet Balance: ${stxBalance} STX`;

        const tId = getTokenId(tokenAddress);

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(`Buy 10 ${currency}`, `b_${tId}_10`),
            Markup.button.callback(`Buy 50 ${currency}`, `b_${tId}_50`)
          ],
          [
             Markup.button.callback(`Buy 100 ${currency}`, `b_${tId}_100`),
             Markup.button.callback('Buy Custom Amount', `b_${tId}_custom`)
          ],
          [Markup.button.callback('🔙 Cancel', 'menu_main')]
        ]);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id);
        await ctx.reply(detailsMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

    } catch (e) {
        console.error('Error initiating buy', e);
        ctx.reply('Failed to fetch token data. Does the token exist on Bitflow/ALEX?');
    }
});

bot.action(/b_(\d+)_(\d+)/, async (ctx) => {
    const match = ctx.match;
    if (!match) return;

    const tId = parseInt(match[1]);
    const tokenAddress = tokenAddressMap.get(tId);
    if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

    const amountInStx = parseFloat(match[2]);
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery(`Initiating swap...`).catch(() => {});
    const loadMsg = await ctx.reply(`Executing Swap for ${amountInStx}... ⏳`);

    try {
        const res = await pool.query('SELECT telegram_id, trading_currency, encrypted_private_key, iv, auth_tag FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return;

        const user = res.rows[0];
        const currency = user.trading_currency || 'STX';
        const decryptedPrivKey = decryptPrivateKey({
            encrypted: user.encrypted_private_key,
            iv: user.iv,
            authTag: user.auth_tag
        }, userId);

        const swapResult: any = await executeBestSwap(decryptedPrivKey, tokenAddress, amountInStx, 1.0, 'buy', currency);

        if (ctx.chat?.id && loadMsg.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
        }

        if (swapResult.status === 'pending') {
            await ctx.reply(`✅ *Swap Submitted!*\n\nTxID: [${swapResult.txid}](${swapResult.explorerUrl || '#'})\n\nTokens will arrive in your wallet once confirmed on-chain!`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
        } else {
            await ctx.reply(`❌ Swap Failed: ${swapResult.error}`);
        }

    } catch(e) {
        if (ctx.chat?.id && loadMsg.message_id) {
             await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
        }
        await ctx.reply('❌ An error occurred executing the transaction.');
    }
});

bot.command('sell', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Expected format: /sell SP123...TokenTarget
    const text = ctx.message.text.split(' ');
    if (text.length < 2) return ctx.reply('Usage: /sell <token_contract_address>');

    const tokenAddress = text[1];

    try {
        const res = await pool.query('SELECT id, address, trading_currency FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');
        
        const userAddress = res.rows[0].address;
        const currency = res.rows[0].trading_currency || 'STX';
        
        const loadMsg = await ctx.reply('Fetching live token data... ⏳');

        // Fetch balances & quote 
        // Our getBalance returns { stx: string, tokens: any[] }
        const { tokens } = await getBalance(userAddress);
        let tokenBalance = 0;
        
        // Match the token address in the user's fetched SIP-010 balances
        for (const t of tokens) {
             if (t.contractAddress === tokenAddress) tokenBalance += parseFloat(t.balance);
        }

        const quote = await findBestPrice(tokenAddress, currency, 10, 'sell'); // Predict for selling 10 Tokens

        const detailsMsg = `🔴 *Sell Token*
        
Token: \`${tokenAddress}\`
Current Price Quote: ${quote.quote?.amountOut || 'N/A'} ${currency} per 10 Tokens
Est. Price Impact: ${quote.quote?.priceImpact || 'N/A'}%
Source: ${quote.dex.toUpperCase()}

Wallet Balance: ${tokenBalance} Tokens`;

        const tId = getTokenId(tokenAddress);

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('Sell 25%', `s_${tId}_25`),
            Markup.button.callback('Sell 50%', `s_${tId}_50`)
          ],
          [
             Markup.button.callback('Sell 100%', `s_${tId}_100`),
             Markup.button.callback('Sell Custom', `s_${tId}_custom`)
          ],
          [Markup.button.callback('🔙 Cancel', 'menu_main')]
        ]);

        if (ctx.chat?.id && loadMsg.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
        }
        await ctx.reply(detailsMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });

    } catch (e) {
        console.error('Error initiating sell', e);
        ctx.reply('Failed to fetch token data. Does the token exist on Bitflow/ALEX?');
    }
});

bot.action(/s_(\d+)_(\d+)/, async (ctx) => {
    const match = ctx.match;
    if (!match) return;

    const tId = parseInt(match[1]);
    const tokenAddress = tokenAddressMap.get(tId);
    if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

    const percentage = parseFloat(match[2]);
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery(`Calculating ${percentage}% sell chunk...`).catch(() => {});
    const loadMsg = await ctx.reply(`Executing Swap for ${percentage}% of balance... ⏳`);

    try {
        const res = await pool.query('SELECT telegram_id, address, trading_currency, encrypted_private_key, iv, auth_tag FROM users WHERE telegram_id = $1', [userId]);
        if (res.rowCount === 0) return;

        const user = res.rows[0];
        
        // Calculate the exact amount out of their balance
        const { tokens } = await getBalance(user.address);
        let trueBalance = 0;
        for (const t of tokens) {
             if (t.contractAddress === tokenAddress) trueBalance += parseFloat(t.balance);
        }
        
        if (trueBalance === 0) {
             if (ctx.chat?.id && loadMsg.message_id) {
                await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
             }
             return ctx.reply('❌ You do not hold any balance of this token to sell.');
        }

        const amountToSell = trueBalance * (percentage / 100.0);

        const currency = user.trading_currency || 'STX';
        const decryptedPrivKey = decryptPrivateKey({
            encrypted: user.encrypted_private_key,
            iv: user.iv,
            authTag: user.auth_tag
        }, userId);

        const swapResult: any = await executeBestSwap(decryptedPrivKey, tokenAddress, amountToSell, 1.0, 'sell', currency);

        if (ctx.chat?.id && loadMsg.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
        }

        if (swapResult.status === 'pending') {
            await ctx.reply(`✅ *Swap Submitted!*\n\nTxID: [${swapResult.txid}](${swapResult.explorerUrl || '#'})\n\n${currency} will arrive in your wallet once confirmed on-chain!`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
        } else {
            await ctx.reply(`❌ Swap Failed: ${swapResult.error}`);
        }

    } catch(e) {
        if (ctx.chat?.id && loadMsg.message_id) {
             await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
        }
        await ctx.reply('❌ An error occurred executing the transaction.');
    }
});

bot.command('help', async (ctx) => {
    const msg = `🤖 *StackBot Help*

Here are the commands you can use:
/start \\- Start the bot, create or load your wallet, and see the main menu
/help \\- Show this help message
/buy \`<token_address>\` \\- Get a quote and buy a token
/sell \`<token_address>\` \\- Get a quote and sell a token
/limit \`<buy/sell> <address> <target_price> <amount>\` \\- Place a limit order
/copy \`<wallet_address> <max_amount>\` \\- Start copy trading a wallet`;

    try {
        await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
    } catch (e) {
        console.error('Help command error:', e);
    }
});

// Start the bot
initDb().then(() => {
  bot.launch().then(() => {
     console.log('Bot is running!');
     
     // Start Daemons
     startLimitOrderMonitor(bot);
     startCopyTradeMonitor(bot);
     console.log('Background monitors active.');
  });
});

// Keep-alive HTTP server for Render (prevents free tier from sleeping)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('StackBot is running!');
    }
});
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
