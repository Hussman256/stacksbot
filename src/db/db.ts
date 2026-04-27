import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || '';

let safeUrl = dbUrl;
if (safeUrl.includes('###')) {
  safeUrl = safeUrl.replace(/###/g, '%23%23%23');
} else if (safeUrl.includes('#')) {
  const parts = safeUrl.split('@');
  if (parts.length === 2) {
    parts[0] = parts[0].replace(/#/g, '%23');
    safeUrl = parts.join('@');
  }
}
safeUrl = safeUrl.replace(/"/g, '');

export const pool = new Pool({ connectionString: safeUrl, ssl: { rejectUnauthorized: false } });

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          telegram_id BIGINT UNIQUE NOT NULL,
          username VARCHAR(255),
          address VARCHAR(255) NOT NULL,
          mnemonic TEXT NOT NULL,
          encrypted_private_key TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          enc_salt VARCHAR(64),
          trading_currency VARCHAR(10) DEFAULT 'STX',
          created_at TIMESTAMP DEFAULT NOW(),
          last_active TIMESTAMP,
          referral_code VARCHAR(20) UNIQUE,
          referred_by INTEGER REFERENCES users(id)
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS enc_salt VARCHAR(64);

      CREATE TABLE IF NOT EXISTS transactions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          tx_hash VARCHAR(255) UNIQUE,
          type VARCHAR(50),
          token_in VARCHAR(100),
          amount_in NUMERIC,
          token_out VARCHAR(100),
          amount_out NUMERIC,
          dex_used VARCHAR(50),
          gas_paid NUMERIC,
          status VARCHAR(20),
          created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS limit_orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          token_address VARCHAR(255),
          order_type VARCHAR(10),
          target_price NUMERIC,
          amount NUMERIC,
          filled_amount NUMERIC DEFAULT 0,
          status VARCHAR(20),
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_wallets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          wallet_to_copy VARCHAR(255),
          max_amount_per_trade NUMERIC,
          copy_buys BOOLEAN DEFAULT TRUE,
          copy_sells BOOLEAN DEFAULT TRUE,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS token_map (
          token_id SERIAL PRIMARY KEY,
          address TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS withdraw_state (
          telegram_id BIGINT PRIMARY KEY,
          step VARCHAR(10) NOT NULL,
          address TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database schema initialized.');
  } finally {
    client.release();
  }
}
