const ALEX_API = 'https://api.alexgo.io';

interface AlexTicker {
  tickerId: string;
  lastBasePriceInUSD: number;
  lastTargetPriceInUSD: number;
  base_currency: string;
}

let tickersCache: AlexTicker[] | null = null;
let tickersCacheTime = 0;

async function fetchTickers(): Promise<AlexTicker[]> {
  if (tickersCache && Date.now() - tickersCacheTime < 60_000) return tickersCache;
  const headers: Record<string, string> = {};
  if (process.env.ALEX_API_KEY) headers['x-api-key'] = process.env.ALEX_API_KEY;
  const res = await fetch(`${ALEX_API}/v1/tickers`, { headers });
  if (!res.ok) throw new Error(`ALEX tickers API ${res.status}`);
  const data = await res.json();
  tickersCache = Array.isArray(data) ? data : (data.data ?? []);
  tickersCacheTime = Date.now();
  return tickersCache!;
}

// Find the STX-paired ticker for a real token contract address.
// ALEX ticker IDs are: "<real-token-address>_stx"
async function findStxTicker(realTokenAddress: string): Promise<AlexTicker | null> {
  const tickers = await fetchTickers();
  const prefix = realTokenAddress.toLowerCase() + '_stx';
  return tickers.find(t => t.tickerId.toLowerCase() === prefix) ?? null;
}

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getAlexQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  // Determine which side is the "token" vs STX
  const isBuy  = tokenIn.toUpperCase()  === 'STX';
  const realToken = isBuy ? tokenOut : tokenIn;

  const ticker = await findStxTicker(realToken);
  if (!ticker) throw new Error(`No ALEX ticker for ${realToken}`);

  const stxPriceUsd   = ticker.lastTargetPriceInUSD;
  const tokenPriceUsd = ticker.lastBasePriceInUSD;
  if (!tokenPriceUsd || !stxPriceUsd) throw new Error(`ALEX has no price data for ${realToken}`);

  let amountOut: number;
  let price: number;

  if (isBuy) {
    // spending STX, receiving token
    amountOut = amountIn * (stxPriceUsd / tokenPriceUsd);
    price = amountIn > 0 ? amountOut / amountIn : 0;
  } else {
    // spending token, receiving STX
    amountOut = amountIn * (tokenPriceUsd / stxPriceUsd);
    price = amountIn > 0 ? amountOut / amountIn : 0;
  }

  return { price, route: [tokenIn, tokenOut], amountOut, priceImpact: 0 };
}

// ── Swap ──────────────────────────────────────────────────────────────────────
// ALEX swap execution requires ALEX's own wrapped token contracts.
// Swaps are routed through Velar (see router.ts) which uses original token addresses.
export async function executeAlexSwap(
  _privateKey: string,
  _tokenAddress: string,
  _amountIn: number,
  _slippage: number,
  _type: 'buy' | 'sell' = 'buy'
) {
  return { txid: null, status: 'error', error: 'ALEX swap not implemented — using Velar' };
}
