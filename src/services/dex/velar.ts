import {
  makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode,
  uintCV, contractPrincipalCV, callReadOnlyFunction, cvToValue
} from '@stacks/transactions';
import { stacksNetwork, explorerChain } from '../network';

const VELAR_CORE    = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1';
const WSTX_CONTRACT = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx';
const SHARE_FEE_TO  = 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-share-fee-to';
const VELAR_FEE_NUM = 997; // 0.3% fee → multiply amountIn by 997/1000

interface VelarPool {
  id: number;
  token0: string;
  token1: string;
  reserve0: number;
  reserve1: number;
}

let poolsCache: VelarPool[] | null = null;
let poolsCacheTime = 0;

async function fetchPools(): Promise<VelarPool[]> {
  if (poolsCache && Date.now() - poolsCacheTime < 60_000) return poolsCache;
  const res = await fetch('https://api.velar.co/pools');
  if (!res.ok) throw new Error(`Velar pools API error: ${res.status}`);
  const data = await res.json();
  // data is array of pool objects; normalise field names
  poolsCache = (Array.isArray(data) ? data : data.pools ?? []).map((p: any) => ({
    id:       Number(p.id ?? p.pool_id),
    token0:   (p.token0 ?? p.tokenX ?? '').toLowerCase(),
    token1:   (p.token1 ?? p.tokenY ?? '').toLowerCase(),
    reserve0: Number(p.reserve0 ?? p.reserveX ?? 0),
    reserve1: Number(p.reserve1 ?? p.reserveY ?? 0),
  }));
  poolsCacheTime = Date.now();
  return poolsCache!;
}

function resolveContractId(token: string): string {
  // Normalise STX → wSTX for Velar
  if (token.toUpperCase() === 'STX') return WSTX_CONTRACT;
  return token;
}

function findPool(pools: VelarPool[], tokenA: string, tokenB: string): { pool: VelarPool; flipped: boolean } | null {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  for (const p of pools) {
    if (p.token0 === a && p.token1 === b) return { pool: p, flipped: false };
    if (p.token0 === b && p.token1 === a) return { pool: p, flipped: true };
  }
  return null;
}

function ammOut(reserveIn: number, reserveOut: number, amountIn: number): number {
  // constant-product with 0.3% fee
  const amountInWithFee = amountIn * VELAR_FEE_NUM;
  return (reserveOut * amountInWithFee) / (reserveIn * 1000 + amountInWithFee);
}

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getVelarQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  try {
    const pools = await fetchPools();
    const inId  = resolveContractId(tokenIn);
    const outId = resolveContractId(tokenOut);
    const match = findPool(pools, inId, outId);
    if (!match) throw new Error(`No Velar pool for ${tokenIn}/${tokenOut}`);

    const { pool, flipped } = match;
    const reserveIn  = flipped ? pool.reserve1 : pool.reserve0;
    const reserveOut = flipped ? pool.reserve0 : pool.reserve1;

    const amountOut  = ammOut(reserveIn, reserveOut, amountIn * 1_000_000) / 1_000_000;
    const price      = amountIn > 0 ? amountOut / amountIn : 0;
    const priceImpact = amountIn / (reserveIn / 1_000_000) * 100;

    return { price, route: [tokenIn, tokenOut], amountOut, priceImpact, poolId: pool.id };
  } catch (e) {
    console.error('Velar quote error:', e);
    throw e;
  }
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

    // Get pool ID on-chain for accuracy
    const [inAddr, inName]   = tokenInId.split('.');
    const [outAddr, outName] = tokenOutId.split('.');

    let poolId: number;
    try {
      const poolIdResult = await callReadOnlyFunction({
        contractAddress: VELAR_CORE,
        contractName: 'univ2-core',
        functionName: 'get-pool-id',
        functionArgs: [
          contractPrincipalCV(inAddr, inName),
          contractPrincipalCV(outAddr, outName)
        ],
        network: stacksNetwork,
        senderAddress: VELAR_CORE,
      });
      const val = cvToValue(poolIdResult as any);
      poolId = Number(val?.value ?? val);
    } catch {
      // fallback: try flipped order
      const poolIdResult2 = await callReadOnlyFunction({
        contractAddress: VELAR_CORE,
        contractName: 'univ2-core',
        functionName: 'get-pool-id',
        functionArgs: [
          contractPrincipalCV(outAddr, outName),
          contractPrincipalCV(inAddr, inName)
        ],
        network: stacksNetwork,
        senderAddress: VELAR_CORE,
      });
      const val2 = cvToValue(poolIdResult2 as any);
      poolId = Number(val2?.value ?? val2);
    }

    if (!poolId || isNaN(poolId)) throw new Error('Could not determine Velar pool ID');

    // Get quote to calculate minAmountOut with slippage
    const amountInMicro = Math.floor(amountIn * 1_000_000);
    const quote = await getVelarQuote(
      type === 'buy' ? 'STX' : tokenAddress,
      type === 'buy' ? tokenAddress : 'STX',
      amountIn
    );
    const minAmountOut = Math.floor(quote.amountOut * 1_000_000 * (1 - slippage / 100));

    const [feeAddr, feeName] = SHARE_FEE_TO.split('.');

    const txOptions = {
      contractAddress: VELAR_CORE,
      contractName: 'univ2-core',
      functionName: 'swap',
      functionArgs: [
        uintCV(poolId),
        contractPrincipalCV(inAddr, inName),
        contractPrincipalCV(outAddr, outName),
        contractPrincipalCV(feeAddr, feeName),
        uintCV(amountInMicro),
        uintCV(minAmountOut)
      ],
      senderKey: privateKey,
      validateWithAbi: false,
      network: stacksNetwork,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 3000
    };

    const transaction = await makeContractCall(txOptions);
    const broadcastResponse = await broadcastTransaction(transaction, stacksNetwork);

    if (broadcastResponse.error) {
      console.error('Velar broadcast rejected:', broadcastResponse.reason, broadcastResponse.reason_data);
      return { txid: null, status: 'failed', error: broadcastResponse.reason ?? 'Transaction rejected' };
    }

    return {
      txid: broadcastResponse.txid,
      status: 'pending',
      explorerUrl: `https://explorer.hiro.so/txid/${broadcastResponse.txid}?chain=${explorerChain}`
    };
  } catch (e: any) {
    console.error('Velar swap error:', e);
    return { txid: null, status: 'error', error: e?.message ?? String(e) };
  }
}
