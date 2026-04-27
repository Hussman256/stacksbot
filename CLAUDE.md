# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Run in development mode with ts-node (no build step)
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled output (production)

# Testnet helpers
npx ts-node deploy-mocks.ts   # Deploy mock token/router contracts to testnet
node fund.js                  # Request STX from testnet faucet
```

Docker (local PostgreSQL + Redis):
```bash
docker-compose up -d          # Start postgres:5432 and redis:6379
docker-compose down           # Stop services
```

There are no automated tests. `test_c32.ts`, `test_c32_2.ts`, and `test_st.ts` are one-off debug scripts.

## Environment Setup

Copy `.env.example` to `.env` and fill in:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `DATABASE_URL` — PostgreSQL connection string (special chars like `#` in passwords are URL-encoded automatically by `db.ts`)
- `ENCRYPTION_SECRET` — exactly 32 bytes, used for AES-256-GCM private key encryption
- `STACKS_NETWORK` — `"testnet"` or `"mainnet"`
- `REDIS_URL` — Redis connection string (optional; Redis is a dependency but not yet used in code)
- `BITFLOW_API_KEY`, `ALEX_API_KEY`, `VELAR_API_KEY` — optional; reserved for real DEX API auth
- `FEE_WALLET_ADDRESS` — optional; reserved for fee collection

**Schema migrations**: `migration.sql` contains `ALTER TABLE` statements for upgrading an existing database (e.g. adding `trading_currency` to `users`). Run it manually when upgrading a live DB; `initDb()` only creates tables with `IF NOT EXISTS` and won't add missing columns.

## Architecture

StackBot is a **Telegram trading bot** for the Stacks blockchain. Users interact entirely through Telegram commands and inline keyboard menus.

### Entry Point: `src/index.ts`
All Telegram command handlers (`/start`, `/buy`, `/sell`, `/sell`, `/limit`, `/copy`, `/cancel`, `/help`) and action callbacks (inline button presses) live here. This file also starts the two background job daemons and the HTTP health check server on port 3000 (for Render keep-alive).

**Token address mapping**: Telegram limits `callback_data` to 64 bytes, but Stacks contract addresses can exceed that. `tokenAddressMap` (`Map<number, string>`) and `getTokenId()` translate addresses to short integer IDs for button payloads. This map is in-memory and resets on restart — buttons from before a restart will fail with "Session expired."

**Withdrawal state machine**: `withdrawState` (`Map<number, {...}>`) tracks multi-step withdrawal conversations (address → amount). It is in-memory only; a production deployment should move this to Redis to survive restarts.

### Database: `src/db/db.ts`
PostgreSQL via `pg`. Schema is auto-created on startup via `initDb()`. Four tables:
- `users` — Telegram accounts with AES-256-GCM encrypted wallet private keys, plus `trading_currency` (STX/SBTC/USDCX), `referral_code`, and `referred_by`
- `transactions` — Swap history
- `limit_orders` — Pending price-triggered orders
- `copy_wallets` — Copy trading subscriptions

### Services
- **`src/services/wallet.ts`** — Stacks wallet creation (BIP39 mnemonic → keypair) and balance fetching via Stacks API
- **`src/services/crypto.ts`** — AES-256-GCM encrypt/decrypt; private keys are encrypted with `ENCRYPTION_SECRET + userId` as the key material
- **`src/services/portfolio.ts`** — Aggregates token balances and converts to USD valuation
- **`src/services/dex/router.ts`** — Queries all DEXs in parallel and routes to best price (highest `amountOut`)

### DEX Integrations (`src/services/dex/`)
All three DEX integrations currently return **simulated/hardcoded data**:
- **`bitflow.ts`** — Quote returns a fixed 1.5× price ratio with 400 ms artificial delay; swap calls the deployed testnet mock contract (`mock-bitflow-router-v6`), so real on-chain transactions do execute on testnet
- **`alex.ts`** — Fully mocked (dummy quotes and no-op swap); real integration pending
- **`velar.ts`** — Fully mocked (dummy quotes and no-op swap); real integration pending

### Background Jobs (`src/services/jobs/`)
- **`limitOrders.ts`** — Polls every 30s; checks current token prices against stored limit orders and executes when triggered
- **`copyTrading.ts`** — Polls every 60s; checks monitored wallet activity and mirrors trades

### Deployment
Configured for **Render** (`render.yaml`): build with `npm install && npm run build`, start with `node dist/index.js`. Health check endpoint at `GET /health`.

## Key Patterns

- **Private key security**: Never store raw private keys. Always use `encrypt()`/`decrypt()` from `src/services/crypto.ts` with the user's Telegram ID as part of the key derivation. Note: the mnemonic is stored in plaintext in the `users` table and is shown to users via `wallet_export`.
- **Testnet vs mainnet**: Controlled by `STACKS_NETWORK` env var. Bitflow's `executeBitflowSwap` hard-codes `StacksTestnet`; update before any mainnet deployment.
- **Menu state**: Conversation state (e.g., awaiting a token address input) is managed via in-memory `Map` objects in `src/index.ts`, keyed by Telegram chat ID.
- **DEX routing**: Always go through `router.ts` rather than calling individual DEX services directly — it handles best-price selection.
- **`handleUpdate` re-dispatch**: Several action handlers re-fire another action by calling `bot.handleUpdate(...)` with modified `callback_query.data`. This is a workaround for Telegraf lacking a native "redirect to action" API.
