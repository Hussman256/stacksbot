import { getBitflowQuote, executeBitflowSwap } from './bitflow';
import { getAlexQuote } from './alex';
import { getVelarQuote, executeVelarSwap } from './velar';

const IS_MAINNET = process.env.STACKS_NETWORK === 'mainnet';
const REAL_DEXES = new Set(['velar', 'alex']);

export async function findBestPrice(tokenIn: string, tokenOut: string, amountIn: number, _type: 'buy' | 'sell' = 'buy') {
  const [bitflow, alex, velar] = await Promise.allSettled([
    getBitflowQuote(tokenIn, tokenOut, amountIn),
    getAlexQuote(tokenIn, tokenOut, amountIn),
    getVelarQuote(tokenIn, tokenOut, amountIn)
  ]);

  const bfResult  = bitflow.status  === 'fulfilled' ? bitflow.value  : null;
  const alexResult = alex.status    === 'fulfilled' ? alex.value     : null;
  const velarResult = velar.status  === 'fulfilled' ? velar.value    : null;

  if (alex.status   === 'rejected') console.error('ALEX quote failed:', (alex.reason as any)?.message ?? alex.reason);
  if (velar.status  === 'rejected') console.error('Velar quote failed:', (velar.reason as any)?.message ?? velar.reason);

  const all = [
    { dex: 'bitflow', quote: bfResult   },
    { dex: 'alex',    quote: alexResult  },
    { dex: 'velar',   quote: velarResult }
  ].filter(p => p.quote != null);

  if (all.length === 0) throw new Error('No routes available on any DEX');

  const realOnes   = all.filter(p => REAL_DEXES.has(p.dex));
  const candidates = realOnes.length > 0 ? realOnes : all;

  candidates.sort((a, b) => (b.quote!.amountOut) - (a.quote!.amountOut));
  const winner = candidates[0];
  console.log(`Best quote: ${winner.dex.toUpperCase()} — amountOut: ${winner.quote!.amountOut}`);
  return winner;
}

export async function executeBestSwap(
  privateKey: string,
  tokenAddress: string,
  amountIn: number,
  slippage: number,
  type: 'buy' | 'sell' = 'buy',
  baseCurrency: string = 'STX'
) {
  const best = await findBestPrice(
    type === 'buy' ? baseCurrency : tokenAddress,
    type === 'buy' ? tokenAddress : baseCurrency,
    amountIn,
    type
  );

  // On testnet: Velar contracts don't exist — use Bitflow's mock router
  // On mainnet: use Velar for real on-chain swaps
  let result;
  if (IS_MAINNET) {
    result = await executeVelarSwap(privateKey, tokenAddress, amountIn, slippage, type);
  } else {
    result = await executeBitflowSwap(privateKey, tokenAddress, amountIn, slippage, type, baseCurrency);
  }

  return { ...result, dex: best.dex };
}
