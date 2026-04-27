import { getBalance } from './wallet';
import { getAlexQuote } from './dex/alex';

let cachedStxPrice: number | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function fetchWithTimeout(url: string, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

async function getStxPriceUsd(): Promise<number> {
  if (cachedStxPrice !== null && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedStxPrice;
  }
  // Try Binance first (fast, no rate limit), fall back to CoinGecko
  try {
    const res = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=STXUSDT');
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data?.price);
      if (!isNaN(price) && price > 0) {
        cachedStxPrice = price;
        cacheTime = Date.now();
        return cachedStxPrice;
      }
    }
  } catch { /* try fallback */ }

  try {
    const res = await fetchWithTimeout(
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
    console.error('Failed to fetch STX price:', e);
  }
  return cachedStxPrice ?? 0;
}

async function getTokenPriceUsd(contractAddress: string, stxPriceUsd: number): Promise<number | null> {
  try {
    const quote = await getAlexQuote('STX', contractAddress, 1);
    if (quote.amountOut > 0 && stxPriceUsd > 0) {
      return stxPriceUsd / quote.amountOut;
    }
  } catch { /* no price available */ }
  return null;
}

export async function getPortfolio(address: string) {
  const [{ stx: stxBalanceStr, tokens: rawTokens }, stxPriceUsd] = await Promise.all([
    getBalance(address),
    getStxPriceUsd()
  ]);

  const stxBalance = parseFloat(stxBalanceStr);
  const stxValueUsd = stxBalance * stxPriceUsd;

  const tokenEntries = await Promise.all(rawTokens.map(async (t) => {
    const balance = parseFloat(t.balance);
    if (balance <= 0) return null;
    const priceUsd = await getTokenPriceUsd(t.contractAddress, stxPriceUsd);
    const valueUsd = priceUsd !== null ? balance * priceUsd : null;
    const symbol = t.identifier.split('::')[1] ?? t.contractAddress.split('.')[1] ?? 'TOKEN';
    return { symbol, balance, valueUsd };
  }));

  const tokens = [
    { symbol: 'STX', balance: stxBalance, valueUsd: stxValueUsd },
    ...tokenEntries.filter((t): t is NonNullable<typeof t> => t !== null)
  ];

  const totalUsd = tokens.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0);

  return {
    totalUsd: totalUsd.toFixed(2),
    stxBalance,
    stxPriceUsd,
    tokens
  };
}
