import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { URL } from 'url';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || '';

let poolConfig: any = { ssl: { rejectUnauthorized: false } };

// If there are raw `#` in the password, replace them with `%23`
let safeUrl = dbUrl;
if (safeUrl.includes('###')) {
    safeUrl = safeUrl.replace(/###/g, '%23%23%23');
} else if (safeUrl.includes('#')) {
    // A more generic replace just in case
    const parts = safeUrl.split('@');
    if (parts.length === 2) {
       parts[0] = parts[0].replace(/#/g, '%23');
       safeUrl = parts.join('@');
    }
}
// Also remove quotes if they accidentally got parsed
safeUrl = safeUrl.replace(/"/g, '');

poolConfig.connectionString = safeUrl;

export const pool = new Pool(poolConfig);

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
          trading_currency VARCHAR(10) DEFAULT 'STX',
          created_at TIMESTAMP DEFAULT NOW(),
          last_active TIMESTAMP,
          referral_code VARCHAR(20) UNIQUE,
          referred_by INTEGER REFERENCES users(id)
      );

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
    `);
    console.log('Database schema initialized.');
  } finally {
    client.release();
  }
}
