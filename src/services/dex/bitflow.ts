import {
  makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode,
  uintCV, contractPrincipalCV
} from '@stacks/transactions';
import { stacksNetwork, explorerChain } from '../network';

const TESTNET_SURROGATE = 'ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4';
const IS_MAINNET = process.env.STACKS_NETWORK === 'mainnet';
const BITFLOW_API = 'https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev';

interface BitflowToken {
  tokenContract: string;
  priceData: { last_price: number };
}

let tokensCache: BitflowToken[] | null = null;
let tokensCacheTime = 0;

async function fetchBitflowTokens(): Promise<BitflowToken[]> {
  if (tokensCache && Date.now() - tokensCacheTime < 60_000) return tokensCache;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${BITFLOW_API}/getAllTokensAndPools`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Bitflow tokens API ${res.status}`);
    const data = await res.json();
    tokensCache = (data.tokens ?? []) as BitflowToken[];
    tokensCacheTime = Date.now();
    return tokensCache;
  } finally {
    clearTimeout(id);
  }
}

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getBitflowQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  if (!IS_MAINNET) {
    // Testnet: simulated response (no real Bitflow pool on testnet)
    return { price: 1.5, route: [tokenIn, tokenOut], amountOut: amountIn * 1.5, priceImpact: 0.2 };
  }

  const tokens = await fetchBitflowTokens();
  const isBuy = tokenIn.toUpperCase() === 'STX';
  const realToken = isBuy ? tokenOut : tokenIn;

  const stxEntry  = tokens.find(t => t.tokenContract?.toLowerCase().includes('token-stx') ||
                                     (t as any)['token-id'] === 'token-stx');
  const tokenEntry = tokens.find(t => t.tokenContract?.toLowerCase() === realToken.toLowerCase());

  if (!tokenEntry) throw new Error(`No Bitflow listing for ${realToken}`);

  const stxPrice   = stxEntry?.priceData?.last_price ?? 0;
  const tokenPrice = tokenEntry.priceData?.last_price ?? 0;
  if (!stxPrice || !tokenPrice) throw new Error(`Bitflow has no price data for ${realToken}`);

  const amountOut = isBuy
    ? amountIn * (stxPrice / tokenPrice)
    : amountIn * (tokenPrice / stxPrice);

  return {
    price: amountIn > 0 ? amountOut / amountIn : 0,
    route: [tokenIn, tokenOut],
    amountOut,
    priceImpact: 0
  };
}

// ── Swap ──────────────────────────────────────────────────────────────────────
export async function executeBitflowSwap(
  privateKey: string,
  tokenAddress: string,
  amountIn: number,
  _slippage: number,
  type: 'buy' | 'sell' = 'buy',
  _baseCurrency: string = 'STX'
) {
  try {
    // On testnet the mock router only accepts mock-token-v4.
    // On mainnet use the actual token address the user specified.
    let tokenX: ReturnType<typeof contractPrincipalCV>;
    if (IS_MAINNET) {
      if (!tokenAddress.includes('.')) throw new Error('Invalid token contract address — must be in format address.contract-name');
      const [addr, name] = tokenAddress.split('.');
      tokenX = contractPrincipalCV(addr, name);
    } else {
      tokenX = contractPrincipalCV(TESTNET_SURROGATE, 'mock-token-v4');
    }

    const stxToken = contractPrincipalCV(TESTNET_SURROGATE, 'mock-token-v4');

    // swap-x-for-y: spends x, receives y
    // buy  → spend STX (stxToken as x), receive target token (tokenX as y)
    // sell → spend target token (tokenX as x), receive STX (stxToken as y)
    const functionArgs = [
      uintCV(Math.floor(amountIn * 1_000_000)),
      type === 'buy' ? stxToken : tokenX,  // x (input / what you spend)
      type === 'buy' ? tokenX   : stxToken, // y (output / what you receive)
      uintCV(0)                             // min-amount-out (0 = no slippage guard)
    ];

    const txOptions = {
      contractAddress: TESTNET_SURROGATE,
      contractName: IS_MAINNET ? 'bitflow-core' : 'mock-bitflow-router-v6',
      functionName: 'swap-x-for-y',
      functionArgs,
      senderKey: privateKey,
      validateWithAbi: false,
      network: stacksNetwork,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Allow,
      fee: 2000
    };

    const transaction = await makeContractCall(txOptions);
    const broadcastResponse = await broadcastTransaction(transaction, stacksNetwork);

    if (broadcastResponse.error) {
      console.error('Bitflow broadcast rejected:', broadcastResponse.reason, broadcastResponse.reason_data);
      return { txid: null, status: 'failed', error: broadcastResponse.reason ?? 'Transaction rejected by network' };
    }

    return {
      txid: broadcastResponse.txid,
      status: 'pending',
      explorerUrl: `https://explorer.hiro.so/txid/${broadcastResponse.txid}?chain=${explorerChain}`
    };
  } catch (e: any) {
    console.error('Bitflow swap error:', e);
    return { txid: null, status: 'error', error: e?.message ?? String(e) };
  }
}
