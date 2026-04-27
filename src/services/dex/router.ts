import { getBitflowQuote, executeBitflowSwap } from './bitflow';
import { getAlexQuote, executeAlexSwap } from './alex';
import { getVelarQuote, executeVelarSwap } from './velar';

export async function findBestPrice(tokenIn: string, tokenOut: string, amountIn: number, type: 'buy' | 'sell' = 'buy') {
  const [bitflow, alex, velar] = await Promise.all([
    getBitflowQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getAlexQuote(tokenIn, tokenOut, amountIn).catch(() => null),
    getVelarQuote(tokenIn, tokenOut, amountIn).catch(() => null)
  ]);

  const prices = [
    { dex: 'bitflow', quote: bitflow },
    { dex: 'alex',    quote: alex    },
    { dex: 'velar',   quote: velar   }
  ].filter(p => p.quote != null);

  if (prices.length === 0) throw new Error('No routes available on any DEX');

  // Highest amountOut wins
  prices.sort((a, b) => (b.quote!.amountOut) - (a.quote!.amountOut));

  // If Velar returned a real quote, prefer it even if not highest (real > simulated)
  const velarEntry = prices.find(p => p.dex === 'velar');
  if (velarEntry) return velarEntry;

  return prices[0];
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

  let result;
  if (best.dex === 'velar') {
    result = await executeVelarSwap(privateKey, tokenAddress, amountIn, slippage, type);
  } else if (best.dex === 'bitflow') {
    result = await executeBitflowSwap(privateKey, tokenAddress, amountIn, slippage, type, baseCurrency);
  } else {
    result = await executeAlexSwap(privateKey, tokenAddress, amountIn, slippage, type);
  }

  return { ...result, dex: best.dex };
}
