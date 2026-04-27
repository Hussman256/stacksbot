import {
  makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode,
  uintCV, contractPrincipalCV, callReadOnlyFunction, cvToValue
} from '@stacks/transactions';
import { stacksNetwork, explorerChain } from '../network';

const VELAR_CORE    = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1';
const WSTX_CONTRACT = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx';
const SHARE_FEE_TO  = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-share-fee-to';
const FEE_NUM = 997; // 0.3% fee

interface VelarPool {
  token0: string;
  token1: string;
  reserve0: number;
  reserve1: number;
}

let poolsCache: VelarPool[] | null = null;
let poolsCacheTime = 0;

async function fetchPools(): Promise<VelarPool[]> {
  if (poolsCache && Date.now() - poolsCacheTime < 60_000) return poolsCache;
  const res = await fetch('https://api.velar.co/pools?limit=100');
  if (!res.ok) throw new Error(`Velar pools API ${res.status}`);
  const data = await res.json();
  const raw: any[] = data.data ?? (Array.isArray(data) ? data : []);
  poolsCache = raw.map((p: any) => ({
    token0:   (p.token0ContractAddress ?? '').toLowerCase(),
    token1:   (p.token1ContractAddress ?? '').toLowerCase(),
    reserve0: Number((p.stats || {}).reserve0 ?? 0),
    reserve1: Number((p.stats || {}).reserve1 ?? 0),
  })).filter(p => p.token0 && p.token1);
  poolsCacheTime = Date.now();
  return poolsCache!;
}

function stxToWstx(token: string): string {
  return token.toUpperCase() === 'STX' ? WSTX_CONTRACT : token;
}

function findPool(pools: VelarPool[], a: string, b: string): { pool: VelarPool; flipped: boolean } | null {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  for (const p of pools) {
    if (p.token0 === al && p.token1 === bl) return { pool: p, flipped: false };
    if (p.token0 === bl && p.token1 === al) return { pool: p, flipped: true };
  }
  return null;
}

function ammOut(reserveIn: number, reserveOut: number, amountIn: number): number {
  const inWithFee = amountIn * FEE_NUM;
  return (reserveOut * inWithFee) / (reserveIn * 1000 + inWithFee);
}

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getVelarQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  const pools  = await fetchPools();
  const inId   = stxToWstx(tokenIn);
  const outId  = stxToWstx(tokenOut);
  const match  = findPool(pools, inId, outId);
  if (!match) throw new Error(`No Velar pool for ${tokenIn}/${tokenOut}`);

  const { pool, flipped } = match;
  const reserveIn  = flipped ? pool.reserve1 : pool.reserve0;
  const reserveOut = flipped ? pool.reserve0 : pool.reserve1;

  const amountOut   = ammOut(reserveIn, reserveOut, amountIn * 1_000_000) / 1_000_000;
  const price       = amountIn > 0 ? amountOut / amountIn : 0;
  const priceImpact = (amountIn / (reserveIn / 1_000_000)) * 100;

  return { price, route: [tokenIn, tokenOut], amountOut, priceImpact };
}

// ── Swap ──────────────────────────────────────────────────────────────────────
export async function executeVelarSwap(
  privateKey: string,
  tokenAddress: string,
  amountIn: number,
  slippage: number,
  type: 'buy' | 'sell' = 'buy'
) {
  try {
    const tokenInId  = type === 'buy' ? WSTX_CONTRACT : tokenAddress;
    const tokenOutId = type === 'buy' ? tokenAddress   : WSTX_CONTRACT;

    const [inAddr,  inName]  = tokenInId.split('.');
    const [outAddr, outName] = tokenOutId.split('.');

    // Get pool ID on-chain — try both orderings
    let poolId = 0;
    for (const [a, b, aName, bName] of [
      [inAddr, outAddr, inName, outName],
      [outAddr, inAddr, outName, inName]
    ] as [string, string, string, string][]) {
      try {
        const r = await callReadOnlyFunction({
          contractAddress: VELAR_CORE,
          contractName:   'univ2-core',
          functionName:   'get-pool-id',
          functionArgs:   [contractPrincipalCV(a, aName), contractPrincipalCV(b, bName)],
          network:         stacksNetwork,
          senderAddress:   VELAR_CORE,
        });
        const v = cvToValue(r as any);
        poolId = Number(v?.value ?? v);
        if (poolId && !isNaN(poolId)) break;
      } catch { /* try flipped */ }
    }
    if (!poolId || isNaN(poolId)) throw new Error('Could not find Velar pool on-chain');

    const quote = await getVelarQuote(
      type === 'buy' ? 'STX' : tokenAddress,
      type === 'buy' ? tokenAddress : 'STX',
      amountIn
    );
    const minAmountOut = Math.floor(quote.amountOut * 1_000_000 * (1 - slippage / 100));
    const amountInMicro = Math.floor(amountIn * 1_000_000);

    const [feeAddr, feeName] = SHARE_FEE_TO.split('.');

    const txOptions = {
      contractAddress: VELAR_CORE,
      contractName:   'univ2-core',
      functionName:   'swap',
      functionArgs: [
        uintCV(poolId),
        contractPrincipalCV(inAddr, inName),
        contractPrincipalCV(outAddr, outName),
        contractPrincipalCV(feeAddr, feeName),
        uintCV(amountInMicro),
        uintCV(minAmountOut)
      ],
      senderKey:         privateKey,
      validateWithAbi:   false,
      network:           stacksNetwork,
      anchorMode:        AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 3000
    };

    const transaction = await makeContractCall(txOptions);
    const broadcastResponse = await broadcastTransaction(transaction, stacksNetwork);

    if (broadcastResponse.error) {
      console.error('Velar broadcast rejected:', broadcastResponse.reason);
      return { txid: null, status: 'failed', error: broadcastResponse.reason ?? 'Transaction rejected' };
    }

    return {
      txid:        broadcastResponse.txid,
      status:      'pending',
      explorerUrl: `https://explorer.hiro.so/txid/${broadcastResponse.txid}?chain=${explorerChain}`
    };
  } catch (e: any) {
    console.error('Velar swap error:', e);
    return { txid: null, status: 'error', error: e?.message ?? String(e) };
  }
}
