const ALEX_API = 'https://api.alexgo.io';

function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

interface AlexTicker {
  tickerId: string;
  lastBasePriceInUSD: number;
  lastTargetPriceInUSD: number;
  base_currency: string;
}

let tickersCache: AlexTicker[] | null = null;
let tickersCacheTime = 0;

async function fetchTickers(): Promise<AlexTicker[]> {
  if (tickersCache && Date.now() - tickersCacheTime < 60_000) {
    console.log(`[DIAG-ALEX:${Date.now()}] fetchTickers: cache hit`);
    return tickersCache;
  }
  console.log(`[DIAG-ALEX:${Date.now()}] fetchTickers: cache miss, fetching...`);
  const res = await fetchWithTimeout(`${ALEX_API}/v1/tickers`);
  console.log(`[DIAG-ALEX:${Date.now()}] fetchTickers: fetch returned ok=${res.ok}`);
  if (!res.ok) throw new Error(`ALEX tickers API ${res.status}`);
  const data = await res.json();
  tickersCache = Array.isArray(data) ? data : (data.data ?? []);
  tickersCacheTime = Date.now();
  console.log(`[DIAG-ALEX:${Date.now()}] fetchTickers: cached ${tickersCache!.length} tickers`);
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
  const isBuy  = tokenIn.toUpperCase()  === 'STX';
  const realToken = isBuy ? tokenOut : tokenIn;
  console.log(`[DIAG-ALEX:${Date.now()}] getAlexQuote entered, realToken=${realToken}`);

  const ticker = await findStxTicker(realToken);
  console.log(`[DIAG-ALEX:${Date.now()}] ticker found=${!!ticker}`);
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
