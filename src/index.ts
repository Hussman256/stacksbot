import { Telegraf, Markup } from 'telegraf';
import * as QRCode from 'qrcode';
import * as dotenv from 'dotenv';
import * as http from 'http';
import { makeSTXTokenTransfer, broadcastTransaction, AnchorMode } from '@stacks/transactions';
import { createWallet, getBalance } from './services/wallet';
import { stacksNetwork, explorerChain } from './services/network';
import { pool, initDb } from './db/db';
import { encryptPrivateKey, decryptPrivateKey } from './services/crypto';
import { getPortfolio } from './services/portfolio';
import { startLimitOrderMonitor } from './services/jobs/limitOrders';
import { startCopyTradeMonitor } from './services/jobs/copyTrading';
import { findBestPrice, executeBestSwap } from './services/dex/router';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'your_telegram_bot_token_here') {
  console.error('Please set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.catch((err: any, ctx) => {
  console.error(`Bot error on update ${(ctx.update as any)?.update_id}:`, err);
});

// ─── Rate limiter ────────────────────────────────────────────────────────────
const RATE_LIMIT_MS = 30_000;
const userRateLimit = new Map<number, { lastSwap: number; lastWithdraw: number }>();

function checkRateLimit(userId: number, action: 'swap' | 'withdraw'): boolean {
  const now = Date.now();
  const limits = userRateLimit.get(userId) ?? { lastSwap: 0, lastWithdraw: 0 };
  if (action === 'swap' && now - limits.lastSwap < RATE_LIMIT_MS) return false;
  if (action === 'withdraw' && now - limits.lastWithdraw < RATE_LIMIT_MS) return false;
  if (action === 'swap') limits.lastSwap = now;
  if (action === 'withdraw') limits.lastWithdraw = now;
  userRateLimit.set(userId, limits);
  return true;
}

// ─── Known tokens (mainnet addresses; testnet falls back to mock) ─────────────
const MOCK = 'ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4.mock-token-v4';
const IS_MAINNET = process.env.STACKS_NETWORK === 'mainnet';
const KNOWN_TOKENS: Record<string, string> = {
  WELSH: IS_MAINNET ? 'SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G.welshcorgicoin-token' : MOCK,
  LEO:   IS_MAINNET ? 'SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token'              : MOCK,
  DIKO:  IS_MAINNET ? 'SP2C2YFP12AJZB4MABJMJZ3G25EFBFJ5BE6SOLNKQ.arkadiko-token'        : MOCK,
};

// ─── Custom amount state (in-memory; short-lived flow) ────────────────────────
const customAmountState = new Map<number, { action: 'buy' | 'sell'; tokenId: number }>();

// ─── Token address map (DB-backed, in-memory cache) ──────────────────────────
const tokenAddressMap = new Map<number, string>(); // token_id -> address

async function getTokenId(address: string): Promise<number> {
  for (const [id, addr] of tokenAddressMap.entries()) {
    if (addr === address) return id;
  }
  const existing = await pool.query('SELECT token_id FROM token_map WHERE address = $1', [address]);
  if ((existing.rowCount ?? 0) > 0) {
    const id = existing.rows[0].token_id;
    tokenAddressMap.set(id, address);
    return id;
  }
  const ins = await pool.query(
    'INSERT INTO token_map (address) VALUES ($1) ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address RETURNING token_id',
    [address]
  );
  const id = ins.rows[0].token_id;
  tokenAddressMap.set(id, address);
  return id;
}

async function getTokenAddress(id: number): Promise<string | undefined> {
  if (tokenAddressMap.has(id)) return tokenAddressMap.get(id);
  const res = await pool.query('SELECT address FROM token_map WHERE token_id = $1', [id]);
  if ((res.rowCount ?? 0) > 0) {
    const address = res.rows[0].address;
    tokenAddressMap.set(id, address);
    return address;
  }
  return undefined;
}

// ─── Withdraw state (DB-backed) ──────────────────────────────────────────────
async function setWithdrawState(telegramId: number, step: 'address' | 'amount', address?: string) {
  await pool.query(
    `INSERT INTO withdraw_state (telegram_id, step, address, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET step = $2, address = $3, updated_at = NOW()`,
    [telegramId, step, address ?? null]
  );
}

async function getWithdrawState(telegramId: number): Promise<{ step: 'address' | 'amount'; address?: string } | null> {
  const res = await pool.query(
    `SELECT step, address FROM withdraw_state
     WHERE telegram_id = $1 AND updated_at > NOW() - INTERVAL '15 minutes'`,
    [telegramId]
  );
  if ((res.rowCount ?? 0) === 0) {
    await pool.query('DELETE FROM withdraw_state WHERE telegram_id = $1', [telegramId]);
    return null;
  }
  return { step: res.rows[0].step, address: res.rows[0].address ?? undefined };
}

async function clearWithdrawState(telegramId: number) {
  await pool.query('DELETE FROM withdraw_state WHERE telegram_id = $1', [telegramId]);
}

// ─── Transaction logger ──────────────────────────────────────────────────────
async function logTransaction(opts: {
  userId: number;
  txHash: string | null;
  type: string;
  tokenIn: string;
  amountIn: number;
  tokenOut: string;
  amountOut?: number;
  dexUsed?: string;
  status: string;
}) {
  try {
    await pool.query(
      `INSERT INTO transactions (user_id, tx_hash, type, token_in, amount_in, token_out, amount_out, dex_used, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        opts.userId,
        opts.txHash,
        opts.type,
        opts.tokenIn,
        opts.amountIn,
        opts.tokenOut,
        opts.amountOut ?? null,
        opts.dexUsed ?? null,
        opts.status
      ]
    );
  } catch (e) {
    console.error('Failed to log transaction:', e);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function safeEdit(ctx: any, msg: string, extra: any) {
  try {
    await ctx.editMessageText(msg, extra);
  } catch {
    await ctx.reply(msg, extra);
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  if (!userId) return;

  let walletAddress = '';
  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);

  if (res.rowCount === 0) {
    await ctx.reply('🤖 Welcome to StackBot!\n\nGenerating your Stacks wallet... please wait ⏳');
    const wallet = await createWallet();
    const { encrypted, iv, authTag, salt } = encryptPrivateKey(wallet.privateKey, userId);

    await pool.query(
      'INSERT INTO users (telegram_id, username, address, mnemonic, encrypted_private_key, iv, auth_tag, enc_salt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [userId, username, wallet.address, wallet.mnemonic, encrypted, iv, authTag, salt]
    );
    walletAddress = wallet.address;
  } else {
    walletAddress = res.rows[0].address;
  }

  const networkLabel = process.env.STACKS_NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet';
  const msg = `🤖 Welcome to StackBot!

The fastest way to trade on Stacks DEXs 🚀

Your wallet has been created:
Address: \`${walletAddress}\`

⚠️ NEVER share your private key or mnemonic!

➡️ Deposit ${networkLabel} STX to start trading
➡️ Use /help for commands`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('💱 Trade', 'menu_trade')],
    [Markup.button.callback('📊 Portfolio', 'menu_portfolio'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
  ]);

  await ctx.replyWithMarkdown(msg, keyboard);
});

// ─── Main menu ───────────────────────────────────────────────────────────────
bot.action('menu_main', async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('💱 Trade', 'menu_trade')],
    [Markup.button.callback('📊 Portfolio', 'menu_portfolio'), Markup.button.callback('⚙️ Settings', 'menu_settings')]
  ]);
  await safeEdit(ctx, '🏠 *Main Menu*', { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
});

// ─── Wallet menu ─────────────────────────────────────────────────────────────
bot.action('menu_wallet', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
  if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');

  const address = res.rows[0].address;
  const { stx: stxBalance } = await getBalance(address, true);
  const networkLabel = process.env.STACKS_NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet';

  const msg = `💼 *Your Wallet*

Address: \`${address}\`
Balance: ${stxBalance} STX (${networkLabel})

Deposit STX to this address to begin.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📥 Deposit', 'wallet_deposit'), Markup.button.callback('📤 Withdraw', 'wallet_withdraw')],
    [Markup.button.callback('🔑 Export Key', 'wallet_export')],
    [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
  ]);

  await safeEdit(ctx, msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
});

// ─── Portfolio ───────────────────────────────────────────────────────────────
bot.action('menu_portfolio', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
  if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');

  const portfolio = await getPortfolio(res.rows[0].address);

  const holdingsList = portfolio.tokens.map(t => {
    const usdPart = t.valueUsd !== null ? ` ($${(t.valueUsd as number).toFixed(2)})` : '';
    return `• ${t.symbol}: ${t.balance}${usdPart}`;
  }).join('\n');

  const msg = `💼 *Your Portfolio*

Total Value: $${portfolio.totalUsd} USD
STX Price: $${portfolio.stxPriceUsd.toFixed(4)}

Holdings:
${holdingsList}
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'menu_portfolio'), Markup.button.callback('💱 Trade', 'menu_trade')],
    [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
  ]);

  await safeEdit(ctx, msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
});

// ─── Trade menu ──────────────────────────────────────────────────────────────
bot.action('menu_trade', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const res = await pool.query('SELECT trading_currency FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start');

    const currency = res.rows[0].trading_currency || 'STX';
    const [welshId, leoId, dikoId] = await Promise.all([
      getTokenId(KNOWN_TOKENS.WELSH),
      getTokenId(KNOWN_TOKENS.LEO),
      getTokenId(KNOWN_TOKENS.DIKO),
    ]);

    const networkNote = IS_MAINNET ? '' : '\n_Testnet: quick-buy tokens use a mock contract._';
    const msg = `💱 *Trade tokens on Stacks*

Trading with: **${currency}** 🪙

Select a popular token below to quick-buy, or paste a contract address using \`/buy <address>\` to snipe any SIP-010 token!${networkNote}`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🐶 Buy WELSH', `t_buy_${welshId}`),
        Markup.button.callback('🐱 Buy LEO',   `t_buy_${leoId}`)
      ],
      [
        Markup.button.callback('💧 Buy DIKO', `t_buy_${dikoId}`),
        Markup.button.callback('🔍 Custom Token', 't_custom')
      ],
      [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
    ]);

    await safeEdit(ctx, msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {
    console.error('Error loading trade menu', e);
  }
});

bot.action(/t_buy_(\d+)/, async (ctx) => {
  const tId = parseInt(ctx.match[1]);
  const tokenAddress = await getTokenAddress(tId);
  if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

  bot.handleUpdate({
    ...ctx.update,
    message: { text: `/buy ${tokenAddress}`, from: ctx.from, chat: ctx.chat }
  } as any);

  await ctx.answerCbQuery('Fetching quote...');
});

bot.action('t_custom', async (ctx) => {
  await ctx.answerCbQuery('Reply with: /buy <contract.address>', { show_alert: true });
});

// ─── Settings ────────────────────────────────────────────────────────────────
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
      [Markup.button.callback('✅ STX', 'set_currency_STX')],
      [Markup.button.callback('🔙 Back to Menu', 'menu_main')]
    ]);

    await safeEdit(ctx, msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {
    console.error('Error loading settings', e);
  }
});

const currencies = ['STX'];
currencies.forEach(currency => {
  bot.action(`set_currency_${currency}`, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      await pool.query('UPDATE users SET trading_currency = $1 WHERE telegram_id = $2', [currency, userId]);
      await ctx.answerCbQuery(`Trading currency set to ${currency}`);
      bot.handleUpdate({
        ...ctx.update,
        callback_query: { ...ctx.callbackQuery, data: 'menu_settings' }
      } as any);
    } catch (e) {
      await ctx.answerCbQuery('Failed to update currency.');
    }
  });
});

// ─── Deposit ─────────────────────────────────────────────────────────────────
bot.action('wallet_deposit', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const res = await pool.query('SELECT address FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found.');

    const address = res.rows[0].address;
    const qrBuffer = await QRCode.toBuffer(address, { errorCorrectionLevel: 'H', margin: 2, width: 400 });
    const networkLabel = process.env.STACKS_NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet';

    const msg = `📥 *Deposit STX*

Send STX (${networkLabel}) only to this address:
\`${address}\`

_Note: The bot does not process deposits. Once you send STX from your wallet or faucet, you can check your updated balance in the Wallet menu after the next Stacks block confirms._`;

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Wallet', 'wallet_return')]]);

    await ctx.replyWithPhoto({ source: qrBuffer }, { caption: msg, parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('QR Error', e);
    ctx.answerCbQuery('Failed to load deposit info.');
  }
});

// ─── Export key ──────────────────────────────────────────────────────────────
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

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🗑️ Delete Message', 'delete_msg')]]);
    await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    await ctx.answerCbQuery();
  } catch {
    ctx.answerCbQuery('Failed to export key.');
  }
});

bot.action('delete_msg', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await ctx.answerCbQuery('Message deleted.').catch(() => {});
});

bot.action('wallet_return', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  bot.handleUpdate({
    ...ctx.update,
    callback_query: { ...ctx.callbackQuery, data: 'menu_wallet' }
  } as any);
});

// ─── Withdraw ─────────────────────────────────────────────────────────────────
bot.action('wallet_withdraw', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await setWithdrawState(userId, 'address');

  const msg = `📤 *Withdraw STX*

Please reply to this message with the **destination Stacks address**:

_(Type /cancel at any time to abort)_`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const state = await getWithdrawState(userId);
  if (state) {
    await clearWithdrawState(userId);
    await ctx.reply('❌ Withdrawal cancelled.');
  } else {
    await ctx.reply('Nothing to cancel.');
  }
});

// ─── Text listener (withdrawal + custom amount state machines) ───────────────
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return next();

  // ── Custom buy/sell amount flow ──
  if (customAmountState.has(userId)) {
    const custom = customAmountState.get(userId)!;
    const value = parseFloat(text);
    if (isNaN(value) || value <= 0) {
      return ctx.reply('❌ Invalid number. Please enter a positive number or /cancel.');
    }
    customAmountState.delete(userId);

    if (!checkRateLimit(userId, 'swap')) {
      return ctx.reply('⏳ Please wait 30 seconds between swaps.');
    }

    const tokenAddress = await getTokenAddress(custom.tokenId);
    if (!tokenAddress) return ctx.reply('❌ Session expired. Please request a new quote.');

    const loadMsg = await ctx.reply(`Executing swap... ⏳`);
    try {
      const res = await pool.query(
        'SELECT id, trading_currency, encrypted_private_key, iv, auth_tag, enc_salt FROM users WHERE telegram_id = $1',
        [userId]
      );
      if (res.rowCount === 0) return;
      const user = res.rows[0];
      const currency = user.trading_currency || 'STX';
      const decryptedPrivKey = decryptPrivateKey({
        encrypted: user.encrypted_private_key,
        iv: user.iv,
        authTag: user.auth_tag,
        salt: user.enc_salt
      }, userId);

      let amountToUse = value;
      if (custom.action === 'sell') {
        const { tokens } = await getBalance(user.address);
        const held = tokens.find(t => t.contractAddress === tokenAddress);
        const bal = parseFloat(held?.balance ?? '0');
        if (bal === 0) {
          if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
          return ctx.reply('❌ You do not hold any balance of this token.');
        }
        amountToUse = bal * (value / 100);
      }

      const swapResult: any = await executeBestSwap(decryptedPrivKey, tokenAddress, amountToUse, 1.0, custom.action, currency);
      if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});

      if (swapResult.status === 'pending') {
        await logTransaction({
          userId: user.id,
          txHash: swapResult.txid,
          type: custom.action,
          tokenIn: custom.action === 'buy' ? currency : tokenAddress,
          amountIn: amountToUse,
          tokenOut: custom.action === 'buy' ? tokenAddress : currency,
          dexUsed: swapResult.dex,
          status: 'pending'
        });
        await ctx.reply(
          `✅ *Swap Submitted!*\n\nTxID: [${swapResult.txid}](${swapResult.explorerUrl || '#'})\n\nTokens will arrive once confirmed on-chain!`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
        );
      } else {
        await ctx.reply(`❌ Swap Failed: ${swapResult.error}`);
      }
    } catch (e: any) {
      if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      await ctx.reply(`❌ An error occurred: ${e.message}`);
    }
    return;
  }

  // ── Withdrawal state machine ──
  const state = await getWithdrawState(userId);
  if (!state) return next();

  if (state.step === 'address') {
    if (!text.startsWith('S') || text.length < 35) {
      return ctx.reply('❌ Invalid Stacks address. Please try again or /cancel.');
    }
    await setWithdrawState(userId, 'amount', text);
    await ctx.reply(`Address saved: \`${text}\`\n\nHow much STX would you like to withdraw? (e.g. 5.5)`, { parse_mode: 'Markdown' });
    return;
  }

  if (state.step === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Invalid amount. Must be a number greater than 0.');
    }

    if (!checkRateLimit(userId, 'withdraw')) {
      await clearWithdrawState(userId);
      return ctx.reply('⏳ Please wait 30 seconds between withdrawals.');
    }

    await clearWithdrawState(userId);
    const loadMsg = await ctx.reply(`Processing withdrawal of ${amount} STX to \`${state.address}\`... ⏳`, { parse_mode: 'Markdown' });

    try {
      const res = await pool.query(
        'SELECT id, address, encrypted_private_key, iv, auth_tag, enc_salt FROM users WHERE telegram_id = $1',
        [userId]
      );
      if (res.rowCount === 0) return ctx.reply('Error: wallet not found.');

      const user = res.rows[0];
      const decryptedPrivKey = decryptPrivateKey({
        encrypted: user.encrypted_private_key,
        iv: user.iv,
        authTag: user.auth_tag,
        salt: user.enc_salt
      }, userId);

      const { stx } = await getBalance(user.address, true);
      if (parseFloat(stx) < amount) {
        return ctx.reply(`❌ Insufficient balance. You only have ${stx} STX.`);
      }

      const amountMicroStx = BigInt(Math.round(amount * 1_000_000));

      const txOptions = {
        recipient: state.address!,
        amount: amountMicroStx,
        senderKey: decryptedPrivKey,
        network: stacksNetwork,
        memo: 'StackBot Withdraw',
        anchorMode: AnchorMode.Any
      };

      const tx = await makeSTXTokenTransfer(txOptions);
      const broadcastRes = await broadcastTransaction(tx, stacksNetwork);

      if (broadcastRes.error) {
        await ctx.reply(`❌ *Withdrawal Failed!*\n\nReason: \`${broadcastRes.error}\``, { parse_mode: 'Markdown' });
      } else {
        const txid = typeof broadcastRes === 'string' ? broadcastRes : broadcastRes.txid;
        await logTransaction({
          userId: user.id,
          txHash: txid,
          type: 'withdraw',
          tokenIn: 'STX',
          amountIn: amount,
          tokenOut: 'STX',
          status: 'pending'
        });
        await ctx.reply(
          `✅ *Withdrawal Submitted!*\n\nTxID: [${txid}](https://explorer.hiro.so/txid/${txid}?chain=${explorerChain})\n\nFunds will arrive in the destination wallet shortly.`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
        );
      }
    } catch (e: any) {
      console.error('Withdrawal error:', e);
      await ctx.reply(`❌ An error occurred during withdrawal: ${e.message}`);
    } finally {
      if (ctx.chat?.id && loadMsg.message_id) {
        if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      }
    }
    return;
  }
});

// ─── Limit orders ─────────────────────────────────────────────────────────────
bot.command('limit', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message.text.split(' ');
  if (text.length < 5) return ctx.reply('Usage: /limit <buy/sell> <token_address> <target_price> <amount>');

  const orderType = text[1].toLowerCase();
  const tokenAddr = text[2];
  const targetPrice = parseFloat(text[3]);
  const amount = parseFloat(text[4]);

  if (orderType !== 'buy' && orderType !== 'sell') return ctx.reply('Type must be buy or sell');
  if (isNaN(targetPrice) || isNaN(amount)) return ctx.reply('Invalid price or amount');

  try {
    const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');

    await pool.query(
      "INSERT INTO limit_orders (user_id, token_address, order_type, target_price, amount, status) VALUES ($1, $2, $3, $4, $5, 'active')",
      [res.rows[0].id, tokenAddr, orderType, targetPrice, amount]
    );

    await ctx.reply(`✅ Limit order set!\n\nWill ${orderType} ${amount} of \`${tokenAddr}\` when price reaches $${targetPrice}.`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Error saving limit order', e);
    ctx.reply('Failed to save limit order.');
  }
});

// ─── Copy trading ─────────────────────────────────────────────────────────────
bot.command('copy', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message.text.split(' ');
  if (text.length < 3) return ctx.reply('Usage: /copy <wallet_address> <max_amount_per_trade_STX>');

  const targetWallet = text[1];
  const maxAmount = parseFloat(text[2]);
  if (isNaN(maxAmount)) return ctx.reply('Invalid max amount');

  try {
    const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');

    await pool.query(
      'INSERT INTO copy_wallets (user_id, wallet_to_copy, max_amount_per_trade, is_active) VALUES ($1, $2, $3, true)',
      [res.rows[0].id, targetWallet, maxAmount]
    );

    await ctx.reply(`✅ Copy Trading Started!\n\nMonitoring \`${targetWallet.slice(0, 8)}...\` for swaps.\nMax trade size: ${maxAmount} STX.`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Error saving copy wallet', e);
    ctx.reply('Failed to set up copy trading.');
  }
});

// ─── Buy ──────────────────────────────────────────────────────────────────────
bot.command('buy', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message.text.split(' ');
  if (text.length < 2) return ctx.reply('Usage: /buy <token_contract_address>');

  const tokenAddress = text[1];

  try {
    const res = await pool.query('SELECT id, address, trading_currency FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');

    const userAddress = res.rows[0].address;
    const currency = res.rows[0].trading_currency || 'STX';

    const loadMsg = await ctx.reply('Fetching live token data... ⏳');
    const [{ stx: stxBalance }, quote] = await Promise.all([
      getBalance(userAddress, true),
      findBestPrice(currency, tokenAddress, 10, 'buy')
    ]);

    const detailsMsg = `🟢 *Buy Token*

Token: \`${tokenAddress}\`
Current Price: ${quote.quote?.price || 'N/A'} ${currency}
Est. Price Impact: ${quote.quote?.priceImpact || 'N/A'}%
Source: ${quote.dex.toUpperCase()}

Wallet Balance: ${stxBalance} STX`;

    const tId = await getTokenId(tokenAddress);

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

    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    await ctx.reply(detailsMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {
    console.error('Error initiating buy', e);
    ctx.reply('❌ No liquidity pool found for this token. It may not be listed on any supported DEX (Velar, Bitflow).');
  }
});

bot.action(/b_(\d+)_(\d+)/, async (ctx) => {
  const tId = parseInt(ctx.match[1]);
  const tokenAddress = await getTokenAddress(tId);
  if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

  const amountInStx = parseFloat(ctx.match[2]);
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!checkRateLimit(userId, 'swap')) {
    return ctx.answerCbQuery('⏳ Please wait 30 seconds between swaps.', { show_alert: true });
  }

  await ctx.answerCbQuery('Initiating swap...').catch(() => {});
  const loadMsg = await ctx.reply(`Executing Swap for ${amountInStx} STX... ⏳`);

  try {
    const res = await pool.query(
      'SELECT id, trading_currency, encrypted_private_key, iv, auth_tag, enc_salt FROM users WHERE telegram_id = $1',
      [userId]
    );
    if (res.rowCount === 0) return;

    const user = res.rows[0];
    const currency = user.trading_currency || 'STX';
    const decryptedPrivKey = decryptPrivateKey({
      encrypted: user.encrypted_private_key,
      iv: user.iv,
      authTag: user.auth_tag,
      salt: user.enc_salt
    }, userId);

    const swapResult: any = await executeBestSwap(decryptedPrivKey, tokenAddress, amountInStx, 1.0, 'buy', currency);

    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});

    if (swapResult.status === 'pending') {
      await logTransaction({
        userId: user.id,
        txHash: swapResult.txid,
        type: 'buy',
        tokenIn: currency,
        amountIn: amountInStx,
        tokenOut: tokenAddress,
        dexUsed: swapResult.dex,
        status: 'pending'
      });
      await ctx.reply(
        `✅ *Swap Submitted!*\n\nTxID: [${swapResult.txid}](${swapResult.explorerUrl || '#'})\n\nTokens will arrive in your wallet once confirmed on-chain!`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      );
    } else {
      await ctx.reply(`❌ Swap Failed: ${swapResult.error}`);
    }
  } catch (e: any) {
    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    const msg = e?.message ?? String(e);
    const isDecryptError = msg.includes('unable to authenticate') || msg.includes('Unsupported state');
    await ctx.reply(
      isDecryptError
        ? '❌ Wallet decryption failed. Your ENCRYPTION_SECRET may have changed.\n\nRun /resetwallet then /start to create a fresh wallet.'
        : `❌ Transaction error: ${msg}`
    );
  }
});

bot.action(/b_(\d+)_custom/, async (ctx) => {
  const tId = parseInt(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  customAmountState.set(userId, { action: 'buy', tokenId: tId });
  await ctx.answerCbQuery();
  await ctx.reply('Enter the amount of STX you want to spend (e.g. 25):');
});

bot.action(/s_(\d+)_custom/, async (ctx) => {
  const tId = parseInt(ctx.match[1]);
  const userId = ctx.from?.id;
  if (!userId) return;
  customAmountState.set(userId, { action: 'sell', tokenId: tId });
  await ctx.answerCbQuery();
  await ctx.reply('Enter the percentage of your balance to sell (e.g. 75):');
});

// ─── Sell ─────────────────────────────────────────────────────────────────────
bot.command('sell', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message.text.split(' ');
  if (text.length < 2) return ctx.reply('Usage: /sell <token_contract_address>');

  const tokenAddress = text[1];

  try {
    const res = await pool.query('SELECT id, address, trading_currency FROM users WHERE telegram_id = $1', [userId]);
    if (res.rowCount === 0) return ctx.reply('Wallet not found, use /start first');

    const userAddress = res.rows[0].address;
    const currency = res.rows[0].trading_currency || 'STX';

    const loadMsg = await ctx.reply('Fetching live token data... ⏳');
    const { tokens } = await getBalance(userAddress);
    let tokenBalance = 0;
    for (const t of tokens) {
      if (t.contractAddress === tokenAddress) tokenBalance += parseFloat(t.balance);
    }

    const quote = await findBestPrice(tokenAddress, currency, 10, 'sell');

    const detailsMsg = `🔴 *Sell Token*

Token: \`${tokenAddress}\`
Current Price Quote: ${quote.quote?.amountOut || 'N/A'} ${currency} per 10 Tokens
Est. Price Impact: ${quote.quote?.priceImpact || 'N/A'}%
Source: ${quote.dex.toUpperCase()}

Wallet Balance: ${tokenBalance} Tokens`;

    const tId = await getTokenId(tokenAddress);

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

    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    await ctx.reply(detailsMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } catch (e) {
    console.error('Error initiating sell', e);
    ctx.reply('Failed to fetch token data.');
  }
});

bot.action(/s_(\d+)_(\d+)/, async (ctx) => {
  const tId = parseInt(ctx.match[1]);
  const tokenAddress = await getTokenAddress(tId);
  if (!tokenAddress) return ctx.answerCbQuery('Session expired. Please request a new quote.', { show_alert: true });

  const percentage = parseFloat(ctx.match[2]);
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!checkRateLimit(userId, 'swap')) {
    return ctx.answerCbQuery('⏳ Please wait 30 seconds between swaps.', { show_alert: true });
  }

  await ctx.answerCbQuery(`Calculating ${percentage}% sell...`).catch(() => {});
  const loadMsg = await ctx.reply(`Executing Swap for ${percentage}% of balance... ⏳`);

  try {
    const res = await pool.query(
      'SELECT id, address, trading_currency, encrypted_private_key, iv, auth_tag, enc_salt FROM users WHERE telegram_id = $1',
      [userId]
    );
    if (res.rowCount === 0) return;

    const user = res.rows[0];
    const { tokens } = await getBalance(user.address);
    let trueBalance = 0;
    for (const t of tokens) {
      if (t.contractAddress === tokenAddress) trueBalance += parseFloat(t.balance);
    }

    if (trueBalance === 0) {
      if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      return ctx.reply('❌ You do not hold any balance of this token to sell.');
    }

    const amountToSell = trueBalance * (percentage / 100);
    const currency = user.trading_currency || 'STX';
    const decryptedPrivKey = decryptPrivateKey({
      encrypted: user.encrypted_private_key,
      iv: user.iv,
      authTag: user.auth_tag,
      salt: user.enc_salt
    }, userId);

    const swapResult: any = await executeBestSwap(decryptedPrivKey, tokenAddress, amountToSell, 1.0, 'sell', currency);

    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});

    if (swapResult.status === 'pending') {
      await logTransaction({
        userId: user.id,
        txHash: swapResult.txid,
        type: 'sell',
        tokenIn: tokenAddress,
        amountIn: amountToSell,
        tokenOut: currency,
        dexUsed: swapResult.dex,
        status: 'pending'
      });
      await ctx.reply(
        `✅ *Swap Submitted!*\n\nTxID: [${swapResult.txid}](${swapResult.explorerUrl || '#'})\n\n${currency} will arrive in your wallet once confirmed on-chain!`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      );
    } else {
      await ctx.reply(`❌ Swap Failed: ${swapResult.error}`);
    }
  } catch (e: any) {
    if (ctx.chat?.id) await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    const msg = e?.message ?? String(e);
    const isDecryptError = msg.includes('unable to authenticate') || msg.includes('Unsupported state');
    await ctx.reply(
      isDecryptError
        ? '❌ Wallet decryption failed. Your ENCRYPTION_SECRET may have changed.\n\nRun /resetwallet then /start to create a fresh wallet.'
        : `❌ Transaction error: ${msg}`
    );
  }
});

// ─── Reset wallet ─────────────────────────────────────────────────────────────
bot.command('resetwallet', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  try {
    await pool.query('DELETE FROM users WHERE telegram_id = $1', [userId]);
    await ctx.reply(
      '🗑️ Your wallet has been deleted.\n\nRun /start to generate a fresh wallet.\n\n⚠️ Make sure you saved your previous mnemonic if you had funds — they are NOT recoverable without it.'
    );
  } catch (e: any) {
    ctx.reply(`❌ Reset failed: ${e?.message}`);
  }
});

// ─── Help ─────────────────────────────────────────────────────────────────────
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

// ─── Start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  bot.launch().then(() => {
    console.log('Bot is running!');
    startLimitOrderMonitor(bot);
    startCopyTradeMonitor(bot);
    console.log('Background monitors active.');
  });
});

// Keep-alive HTTP server for Render
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
