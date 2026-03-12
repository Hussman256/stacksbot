import { pool } from '../../db/db';
import { executeBestSwap } from '../dex/router';
import { decryptPrivateKey } from '../crypto';
import { Telegraf } from 'telegraf';

// In a real production setup you'd hook into the Stacks node websocket/BNS streaming
// For now, we mock a quick polling mechanism that simulates tracking a target wallet's txs
export function startCopyTradeMonitor(bot: Telegraf) {
  // Mock tracking of "already seen" txs
  const processedTxs = new Set<string>();

  setInterval(async () => {
    try {
      const activeCopySettings = await pool.query(
        "SELECT * FROM copy_wallets WHERE is_active = true"
      );

      for (const setting of activeCopySettings.rows) {
        // MOCK: Fetch recent transactions for `setting.wallet_to_copy`
        // In real app: call `hiroApi.getAccountTransactions(setting.wallet_to_copy)`
        const mockRecentTransactions = [
            { 
                tx_id: 'mock_tx_hash_' + Math.floor(Math.random() * 1000000), 
                is_swap: true, 
                token_address: 'SP123...MockToken', 
                amount: 100 
            }
        ];

        for (const tx of mockRecentTransactions) {
          if (tx.is_swap && !processedTxs.has(tx.tx_id) && setting.copy_buys) {
            processedTxs.add(tx.tx_id);

            // Fetch user to decrypt private key
            const userRes = await pool.query(
              'SELECT telegram_id, encrypted_private_key, iv, auth_tag FROM users WHERE id = $1',
              [setting.user_id]
            );

            if (userRes && userRes.rowCount && userRes.rowCount > 0) {
              const user = userRes.rows[0];
              const decryptedPrivKey = decryptPrivateKey({
                  encrypted: user.encrypted_private_key,
                  iv: user.iv,
                  authTag: user.auth_tag
              }, parseInt(user.telegram_id));

              // Copy the trade! Limit by user's max allocation
              const tradeAmount = Math.min(tx.amount, parseFloat(setting.max_amount_per_trade));
              
              const swapRes = await executeBestSwap(
                  decryptedPrivKey, 
                  tx.token_address, 
                  tradeAmount, 
                  1.0, 
                  'buy'
              );

              // Notify the user
              bot.telegram.sendMessage(
                user.telegram_id,
                `🔄 *Copy Trade Executed!*\n\nMirrored a trade from \`${setting.wallet_to_copy.slice(0, 8)}...\`\n\nBought ${tradeAmount} of \`${tx.token_address}\`\nStatus: ${swapRes.status}`,
                { parse_mode: 'Markdown' }
              ).catch(e => console.error('TG Send error:', e));

            }
          }
        }
      }
    } catch(e) {
      console.error('Error in Copy Trade monitor:', e);
    }
  }, 60000); // 60 seconds
}
