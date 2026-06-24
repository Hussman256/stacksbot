import { makeContractDeploy, AnchorMode, getAddressFromPrivateKey, TransactionVersion, getNonce } from '@stacks/transactions';
import { StacksTestnet } from '@stacks/network';
import { generateWallet } from '@stacks/wallet-sdk';

const STACKS_NETWORK = new StacksTestnet();
const BROADCAST_URL = 'https://api.testnet.hiro.so/v2/transactions';

const routerCode = `
;; mock-bitflow-router-v7
;; Minimal testnet swap: accepts STX, emits event, returns ok.
;; No traits, no cross-contract calls.

(define-public (swap-x-for-y
  (amount-in uint)
  (token-x principal)
  (token-y principal)
  (min-amount-out uint))
  (let ((simulated-out (/ (* amount-in u3) u2)))
    (try! (stx-transfer? amount-in tx-sender (as-contract tx-sender)))
    (print { event: "swap-x-for-y", caller: tx-sender, amount-in: amount-in, simulated-out: simulated-out })
    (ok simulated-out)
  )
)

(define-public (swap-y-for-x
  (amount-in uint)
  (token-x principal)
  (token-y principal)
  (min-amount-out uint))
  (let ((simulated-out (/ (* amount-in u2) u3)))
    (print { event: "swap-y-for-x", caller: tx-sender, amount-in: amount-in, simulated-out: simulated-out })
    (ok simulated-out)
  )
)
`;

async function rawBroadcast(tx: any): Promise<void> {
    const serialized = tx.serialize();
    const body = Buffer.from(serialized);

    const httpRes = await fetch(BROADCAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
    });

    const rawText = await httpRes.text();

    console.log(`\n--- RAW NODE RESPONSE (HTTP ${httpRes.status}) ---`);
    console.log(rawText);
    console.log('------------------------------------------------');

    // Try to parse as JSON for structured display, but never hide the raw text
    let parsed: any = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        console.log('(Response is not JSON — shown as plain text above)');
    }

    if (!httpRes.ok || parsed?.error) {
        console.error('\n❌ BROADCAST REJECTED');
        if (parsed) {
            console.error('  error:       ', parsed.error);
            console.error('  reason:      ', parsed.reason);
            console.error('  reason_data: ', JSON.stringify(parsed.reason_data, null, 2));
        }
        process.exit(1);
    }

    const txid = parsed?.txid ?? rawText.replace(/"/g, '').trim();
    console.log(`\n✅ Broadcast accepted — txid: ${txid}`);
    console.log(`   Explorer: https://explorer.hiro.so/txid/${txid}?chain=testnet`);
    console.log('\nWait ~30s then check the explorer link above.');
}

async function deployMocks() {
    const secretKey = 'oppose monitor wedding guilt swim make shove cry blanket entry spare answer fix mechanic pledge soup prepare cry march predict avoid august lesson drill';

    console.log('Deriving wallet from secret key...');
    const wallet = await generateWallet({ secretKey, password: 'deploy_password' });

    const senderKey = wallet.accounts[0].stxPrivateKey;
    const myAddress = getAddressFromPrivateKey(senderKey, TransactionVersion.Testnet);
    console.log(`Deploying from: ${myAddress}`);
    console.log(`Expected:       ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4`);
    console.log(`Match: ${myAddress === 'ST3EJF744V1TGZR3Q8H1K6ZNMZTEH5T07SPAG3D4' ? '✅ YES' : '❌ NO — TESTNET_SURROGATE in bitflow.ts needs updating'}`);

    const currentNonce = await getNonce(myAddress, STACKS_NETWORK);
    console.log(`\nNext nonce: ${currentNonce}`);
    console.log('Deploying: mock-bitflow-router-v7 (single contract, no trait deps)\n');

    const tx = await makeContractDeploy({
        contractName: 'mock-bitflow-router-v7',
        codeBody: routerCode,
        senderKey,
        network: STACKS_NETWORK,
        anchorMode: AnchorMode.Any,
        fee: 500000,
        nonce: currentNonce,
    });

    await rawBroadcast(tx);
}

deployMocks().catch(console.error);
