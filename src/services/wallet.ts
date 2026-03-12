import { generateSecretKey, generateWallet } from '@stacks/wallet-sdk';
import { getAddressFromPrivateKey, TransactionVersion } from '@stacks/transactions';

export async function createWallet() {
  const secretKey = generateSecretKey(256);
  const wallet = await generateWallet({
    secretKey,
    password: 'stackbot_internal'
  });
  
  // Stacks wallet SDK generates accounts.
  // We can get the private key and then get the testnet address
  const account = wallet.accounts[0];
  const privKey = account.stxPrivateKey;
  
  const address = getAddressFromPrivateKey(privKey, TransactionVersion.Testnet);
  
  return { mnemonic: secretKey, address, privateKey: privKey };
}

export async function getBalance(address: string): Promise<{ stx: string, tokens: any[] }> {
  try {
    const res = await fetch(`https://api.testnet.hiro.so/extended/v1/address/${address}/balances`);
    if(res.ok) {
      const data = await res.json();
      
      const stxBalance = (parseInt(data.stx.balance) / 1000000).toFixed(6); // convert micro-STX to STX
      
      const tokens: any[] = [];
      if (data.fungible_tokens) {
        Object.keys(data.fungible_tokens).forEach(tokenIdentifier => {
           // Parse balance (usually micro units but depends on token)
           const amount = data.fungible_tokens[tokenIdentifier].balance;
           tokens.push({
               identifier: tokenIdentifier,
               contractAddress: tokenIdentifier.split('::')[0],
               balance: (parseFloat(amount) / 1000000).toString()
           });
        });
      }
      
      return { stx: stxBalance, tokens };
    }
  } catch (e) {
    console.error('Error fetching balance', e);
  }
  return { stx: "0.000000", tokens: [] };
}
