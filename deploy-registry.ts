import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { generateWallet } from '@stacks/wallet-sdk';
import { makeContractDeploy, AnchorMode } from '@stacks/transactions';
import { StacksMainnet } from '@stacks/network';
import { Pool } from 'pg';

dotenv.config();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Get mnemonic from DB (stored in plaintext for wallet recovery)
  const res = await pool.query(
    'SELECT mnemonic, address FROM users ORDER BY id DESC LIMIT 1'
  );
  await pool.end();

  if (res.rowCount === 0) {
    console.error('No user found in DB. Run /start in the bot first.');
    process.exit(1);
  }

  const { mnemonic, address } = res.rows[0];
  console.log(`Deploying from wallet: ${address}`);

  const wallet = await generateWallet({ secretKey: mnemonic, password: 'stackbot_internal' });
  const privateKey = wallet.accounts[0].stxPrivateKey;

  const contractCode = fs.readFileSync(
    path.join(__dirname, 'contracts', 'stackbot-registry.clar'),
    'utf8'
  ).replace(/\r/g, '').replace(/[^\x00-\x7F]/g, '');

  const network = new StacksMainnet();

  const txOptions = {
    contractName: 'stackbot-registry',
    codeBody: contractCode,
    senderKey: privateKey,
    network,
    anchorMode: AnchorMode.Any,
    fee: 10000, // 0.01 STX
  };

  console.log('Broadcasting contract deployment...');
  const tx = await makeContractDeploy(txOptions);

  // Broadcast manually so we can log the raw API response on failure
  const serialized = tx.serialize();
  const broadcastRes = await fetch('https://api.mainnet.hiro.so/v2/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(serialized),
  });
  const responseText = await broadcastRes.text();
  console.log(`API status: ${broadcastRes.status}`);
  console.log(`API response: ${responseText}`);

  let result: any;
  try { result = JSON.parse(responseText); } catch { result = { error: responseText }; }

  if (!broadcastRes.ok || result.error) {
    console.error('Deployment failed:', result.reason ?? result.error ?? responseText);
    process.exit(1);
  }

  console.log('\n✅ Contract deployed!');
  console.log(`TxID:     ${result.txid}`);
  console.log(`Explorer: https://explorer.hiro.so/txid/${result.txid}?chain=mainnet`);
  console.log(`\nContract address: ${address}.stackbot-registry`);
  console.log('\nAdd this contract address on talent.app to complete registration.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
