import { Telegraf } from 'telegraf';

// Copy trading requires hooking into real Stacks transaction streaming.
// The previous mock generated random tx IDs every 60s, causing real swaps to fire continuously.
// This monitor is intentionally disabled until a real Stacks API integration is built.
export function startCopyTradeMonitor(_bot: Telegraf) {
  console.log('Copy trade monitor: disabled pending real Stacks API integration.');
}
