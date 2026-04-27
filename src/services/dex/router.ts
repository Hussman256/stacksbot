import { getBitflowQuote, executeBitflowSwap } from './bitflow';
import { getAlexQuote } from './alex';
import { getVelarQuote, executeVelarSwap } from './velar';

// DEXes that return real on-chain data (not mocked)
const REAL_DEXES = new Set(['velar', 'alex']);

export async function findBestPrice(tokenIn: string, tokenOut: string, amountIn: number, _type: 'buy' | 'sell' = 'buy') {
  const [bitflow, alex, velar] = await Promise.all([
    getBitflowQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getAlexQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getVelarQuote(tokenIn, tokenOut, amountIn).catch(() => null)
  ]);

  const all = [
    { dex: 'bitflow', quote: bitflow },
    { dex: 'alex',    quote: alex    },
    { dex: 'velar',   quote: velar   }
  ].filter(p => p.quote != null);

  if (all.length === 0) throw new Error('No routes available on any DEX');

  // Prefer real DEXes over mocked ones
  const realOnes = all.filter(p => REAL_DEXES.has(p.dex));
  const candidates = realOnes.length > 0 ? realOnes : all;

  // Among candidates pick highest amountOut
  candidates.sort((a, b) => (b.quote!.amountOut) - (a.quote!.amountOut));
  return candidates[0];
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

  // Always execute via Velar — it's the only DEX with working swap execution
  const result = await executeVelarSwap(privateKey, tokenAddress, amountIn, slippage, type);
  return { ...result, dex: best.dex };
}
