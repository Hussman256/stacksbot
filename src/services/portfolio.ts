import { getBalance } from './wallet';

let cachedStxPrice: number | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getStxPriceUsd(): Promise<number> {
  if (cachedStxPrice !== null && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedStxPrice;
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=blockstack&vs_currencies=usd'
    );
    if (res.ok) {
      const data = await res.json();
      const price = data?.blockstack?.usd;
      if (typeof price === 'number' && price > 0) {
        cachedStxPrice = price;
        cacheTime = Date.now();
        return cachedStxPrice;
      }
    }
  } catch (e) {
    console.error('Failed to fetch STX price from CoinGecko:', e);
  }
  return cachedStxPrice ?? 0;
}

export async function getPortfolio(address: string) {
  const [{ stx: stxBalanceStr, tokens }, stxPriceUsd] = await Promise.all([
    getBalance(address),
    getStxPriceUsd()
  ]);

  const stxBalance = parseFloat(stxBalanceStr);
  const stxValueUsd = stxBalance * stxPriceUsd;
  const totalUsdValue = stxValueUsd;

  return {
    totalUsd: totalUsdValue.toFixed(2),
    stxBalance,
    stxPriceUsd,
    tokens: [
      { symbol: 'STX', balance: stxBalance, valueUsd: stxValueUsd }
    ]
  };
}
