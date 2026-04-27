import { callReadOnlyFunction, cvToValue, contractPrincipalCV, uintCV } from '@stacks/transactions';
import { stacksNetwork } from '../network';

const ALEX_AMM   = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const ALEX_WSTX  = `${ALEX_AMM}.token-wstx-v2`;
const ALEX_PAIRS = 'https://api.alexlab.co/v1/public/pairs';

interface AlexPool { poolId: number; tokenX: string; tokenY: string; wrappedX: string; wrappedY: string; }

let alexPairsCache: AlexPool[] | null = null;
let alexPairsCacheTime = 0;

async function fetchAlexPairs(): Promise<AlexPool[]> {
  if (alexPairsCache && Date.now() - alexPairsCacheTime < 120_000) return alexPairsCache;
  const res = await fetch(ALEX_PAIRS);
  if (!res.ok) throw new Error(`ALEX pairs API ${res.status}`);
  const data = await res.json();
  const raw: any[] = data.data ?? [];
  alexPairsCache = raw.map((p: any) => ({
    poolId:   Number(p.pool_id),
    tokenX:   (p.token_x ?? '').toLowerCase(),
    tokenY:   (p.token_y ?? '').toLowerCase(),
    wrappedX: (p.wrapped_token_x ?? '').toLowerCase(),
    wrappedY: (p.wrapped_token_y ?? '').toLowerCase(),
  }));
  alexPairsCacheTime = Date.now();
  return alexPairsCache!;
}

// Map original token address to ALEX wrapped token address + pool ID
async function findAlexPool(realTokenIn: string, realTokenOut: string): Promise<{ poolId: number; alexIn: string; alexOut: string } | null> {
  const pairs = await fetchAlexPairs();
  const inLower  = realTokenIn.toLowerCase();
  const outLower = realTokenOut.toLowerCase();
  const wstxLower = ALEX_WSTX.toLowerCase();

  for (const p of pairs) {
    // wrappedX/Y = original token addresses from ALEX pairs
    const xIsIn  = p.wrappedX === inLower  || (inLower  === 'stx' && p.tokenX === wstxLower);
    const yIsOut = p.wrappedY === outLower || (outLower === 'stx' && p.tokenY === wstxLower);
    if (xIsIn && yIsOut) return { poolId: p.poolId, alexIn: p.tokenX, alexOut: p.tokenY };

    const xIsOut = p.wrappedX === outLower || (outLower === 'stx' && p.tokenX === wstxLower);
    const yIsIn  = p.wrappedY === inLower  || (inLower  === 'stx' && p.tokenY === wstxLower);
    if (xIsOut && yIsIn) return { poolId: p.poolId, alexIn: p.tokenY, alexOut: p.tokenX };
  }
  return null;
}

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getAlexQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  try {
    const match = await findAlexPool(tokenIn, tokenOut);
    if (!match) throw new Error(`No ALEX pool for ${tokenIn}/${tokenOut}`);

    const [inAddr,  inName]  = match.alexIn.split('.');
    const [outAddr, outName] = match.alexOut.split('.');

    const result = await callReadOnlyFunction({
      contractAddress: ALEX_AMM,
      contractName:    'amm-pool-v2-01',
      functionName:    'get-y-given-x',
      functionArgs:    [
        contractPrincipalCV(inAddr, inName),
        contractPrincipalCV(outAddr, outName),
        uintCV(Math.floor(amountIn * 1_000_000))
      ],
      network:       stacksNetwork,
      senderAddress: ALEX_AMM,
    });

    const raw = cvToValue(result as any);
    const amountOut = Number(raw?.value ?? raw) / 1_000_000;
    const price = amountIn > 0 ? amountOut / amountIn : 0;
    return { price, route: [tokenIn, tokenOut], amountOut, priceImpact: 0 };
  } catch (e) {
    console.error('ALEX quote error:', e);
    throw e;
  }
}

// ── Swap ──────────────────────────────────────────────────────────────────────
export async function executeAlexSwap(
  _privateKey: string,
  _tokenAddress: string,
  _amountIn: number,
  _slippage: number,
  _type: 'buy' | 'sell' = 'buy'
) {
  // ALEX swap execution — use Velar for now (router will prefer Velar)
  return { txid: null, status: 'error', error: 'ALEX swap not yet implemented — using Velar' };
}
