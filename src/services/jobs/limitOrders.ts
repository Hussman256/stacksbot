import { pool } from '../../db/db';
import { findBestPrice, executeBestSwap } from '../dex/router';
import { decryptPrivateKey } from '../crypto';
import { Telegraf } from 'telegraf';

export function startLimitOrderMonitor(bot: Telegraf) {
  // Run every 30 seconds
  setInterval(async () => {
    try {
      const activeOrders = await pool.query(
        "SELECT * FROM limit_orders WHERE status = 'active'"
      );
      
      for (const order of activeOrders.rows) {
        // Find best price via smart router for 1 STX worth (mock to get price quote)
        const quote = await findBestPrice(
            order.order_type === 'buy' ? 'STX' : order.token_address, 
            order.order_type === 'buy' ? order.token_address : 'STX', 
            1, 
            order.order_type
        );
        
        const currentPrice = quote?.quote?.price;
        if (!currentPrice) continue;
        
        // Check if target price reached
        // Buy order: execute if current price drops below target
        // Sell order: execute if current price goes above target
        if (
          (order.order_type === 'buy' && currentPrice <= order.target_price) ||
          (order.order_type === 'sell' && currentPrice >= order.target_price)
        ) {
          
          // Get user details to decrypt wallet
          const userRes = await pool.query(
             'SELECT telegram_id, encrypted_private_key, iv, auth_tag, enc_salt FROM users WHERE id = $1',
             [order.user_id]
          );

          if (userRes && userRes.rowCount && userRes.rowCount > 0) {
              const user = userRes.rows[0];
              const decryptedPrivKey = decryptPrivateKey({
                  encrypted: user.encrypted_private_key,
                  iv: user.iv,
                  authTag: user.auth_tag,
                  salt: user.enc_salt
              }, parseInt(user.telegram_id));
              
              // Execute order
              const tx = await executeBestSwap(
                  decryptedPrivKey, 
                  order.token_address, 
                  order.amount, 
                  1.0, // 1% slippage 
                  order.order_type
              );
              
              // Mark order as filled
              await pool.query(
                "UPDATE limit_orders SET status = 'filled', filled_amount = $1 WHERE id = $2",
                [order.amount, order.id]
              );
              
              // Notify user
              bot.telegram.sendMessage(
                user.telegram_id,
                `✅ *Limit Order Filled!*\n\n${order.order_type.toUpperCase()} ${order.amount} of \`${order.token_address}\`\nTarget: $${order.target_price}\nExecuted via: ${quote.dex.toUpperCase()}`,
                { parse_mode: 'Markdown' }
              ).catch(e => console.error('Failed to send TG message', e));
          }
        }
      }
    } catch (e) {
      console.error('Error in Limit Order Monitor:', e);
    }
  }, 30000); // 30 seconds
}
