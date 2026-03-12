const { generateWallet } = require('@stacks/wallet-sdk');
const { getAddressFromPrivateKey, TransactionVersion } = require('@stacks/transactions');

async function fundWallet() {
  const secretKey = 'oppose monitor wedding guilt swim make shove cry blanket entry spare answer fix mechanic pledge soup prepare cry march predict avoid august lesson drill';
  
  const wallet = await generateWallet({
      secretKey,
      password: 'deploy_password'
  });

  const senderKey = wallet.accounts[0].stxPrivateKey;
  const myAddress = getAddressFromPrivateKey(senderKey, TransactionVersion.Testnet);
  
  console.log("Requesting STX for:", myAddress);

  try {
      const res = await fetch(`https://api.testnet.hiro.so/extended/v1/faucets/stx?address=${myAddress}`, {
          method: 'POST'
      });
      const data = await res.json();
      console.log('Faucet response:', data);
  } catch(e) {
      console.error(e);
  }
}

fundWallet();
