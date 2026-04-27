import {
  makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode,
  uintCV, contractPrincipalCV
} from '@stacks/transactions';
import { stacksNetwork, explorerChain } from '../network';

const TESTNET_SURROGATE = 'ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4';
const IS_MAINNET = process.env.STACKS_NETWORK === 'mainnet';

// ── Quote ─────────────────────────────────────────────────────────────────────
export async function getBitflowQuote(tokenIn: string, tokenOut: string, amountIn: number) {
  try {
    if (IS_MAINNET) {
      const url = `https://api.bitflow.finance/v1/swap/quote?tokenIn=${encodeURIComponent(tokenIn)}&tokenOut=${encodeURIComponent(tokenOut)}&amount=${Math.floor(amountIn * 1_000_000)}`;
      const res = await fetch(url, {
        headers: { 'x-api-key': process.env.BITFLOW_API_KEY || '' }
      });
      if (res.ok) {
        const data = await res.json();
        const amountOut = (data.amountOut ?? 0) / 1_000_000;
        return {
          price: amountIn > 0 ? amountOut / amountIn : 0,
          route: data.route ?? [tokenIn, tokenOut],
          amountOut,
          priceImpact: data.priceImpact ?? 0
        };
      }
    }
    // Testnet: simulated response
    await new Promise(r => setTimeout(r, 300));
    return { price: 1.5, route: [tokenIn, tokenOut], amountOut: amountIn * 1.5, priceImpact: 0.2 };
  } catch (e) {
    console.error('Error fetching Bitflow quote', e);
    throw e;
  }
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
