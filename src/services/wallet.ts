import { generateSecretKey, generateWallet } from '@stacks/wallet-sdk';
import { getAddressFromPrivateKey, callReadOnlyFunction, cvToValue } from '@stacks/transactions';
import { hiroApiBase, stacksNetwork, transactionVersion } from './network';

const decimalsCache = new Map<string, number>();

async function getTokenDecimals(contractId: string): Promise<number> {
  if (decimalsCache.has(contractId)) return decimalsCache.get(contractId)!;
  try {
    const [address, name] = contractId.split('.');
    const result = await callReadOnlyFunction({
      contractAddress: address,
      contractName: name,
      functionName: 'get-decimals',
      functionArgs: [],
      network: stacksNetwork,
      senderAddress: address,
    });
    const decimals = Number(cvToValue(result as any));
    if (!isNaN(decimals)) {
      decimalsCache.set(contractId, decimals);
      return decimals;
    }
  } catch {
    // fallthrough to default
  }
  decimalsCache.set(contractId, 6);
  return 6;
}

export async function createWallet() {
  const secretKey = generateSecretKey(256);
  const wallet = await generateWallet({
    secretKey,
    password: 'stackbot_internal'
  });

  const account = wallet.accounts[0];
  // stxPrivateKey is 66-char hex (32 bytes + 01 compression byte) — strip the suffix
  const rawKey = account.stxPrivateKey;
  const privKey = rawKey.length === 66 && rawKey.endsWith('01') ? rawKey.slice(0, 64) : rawKey;
  const address = getAddressFromPrivateKey(privKey, transactionVersion);

  return { mnemonic: secretKey, address, privateKey: privKey };
}

export async function getBalance(address: string, stxOnly = false): Promise<{ stx: string, tokens: any[] }> {
  try {
    const res = await fetch(`${hiroApiBase}/extended/v1/address/${address}/balances`);
    if (res.ok) {
      const data = await res.json();
      const stxBalance = (parseInt(data.stx.balance) / 1_000_000).toFixed(6);

      if (stxOnly) return { stx: stxBalance, tokens: [] };

      const tokens: any[] = [];
      if (data.fungible_tokens) {
        const entries = Object.entries(data.fungible_tokens) as [string, any][];
        await Promise.all(entries.map(async ([tokenIdentifier, tokenData]) => {
          const contractId = tokenIdentifier.split('::')[0];
          const decimals = await getTokenDecimals(contractId);
          const divisor = Math.pow(10, decimals);
          tokens.push({
            identifier: tokenIdentifier,
            contractAddress: contractId,
            balance: (parseFloat(tokenData.balance) / divisor).toString()
          });
        }));
      }

      return { stx: stxBalance, tokens };
    }
  } catch (e) {
    console.error('Error fetching balance', e);
  }
  return { stx: '0.000000', tokens: [] };
}
