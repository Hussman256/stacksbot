import { makeContractDeploy, broadcastTransaction, AnchorMode, PostConditionMode, getAddressFromPrivateKey, TransactionVersion, getNonce } from '@stacks/transactions';
import { StacksTestnet } from '@stacks/network';
import { generateWallet } from '@stacks/wallet-sdk';

const STACKS_NETWORK = new StacksTestnet();

async function deployMocks() {
    // ⚠️ PASTE YOUR 24 WORD SECRET KEY (SEED PHRASE) HERE
    const secretKey = 'oppose monitor wedding guilt swim make shove cry blanket entry spare answer fix mechanic pledge soup prepare cry march predict avoid august lesson drill';

    console.log("Deriving wallet from Secret Key...");
    const wallet = await generateWallet({
        secretKey,
        password: 'deploy_password'
    });

    const senderKey = wallet.accounts[0].stxPrivateKey;
    const myAddress = getAddressFromPrivateKey(senderKey, TransactionVersion.Testnet);
    console.log(`Deploying from: ${myAddress}`);

    let currentNonce = await getNonce(myAddress, STACKS_NETWORK);
    console.log(`Current Nonce: ${currentNonce}`);

    const traitCode = `
(define-trait mock-token-trait
  (
    (mint-for-testnet (uint principal) (response bool uint))
  )
)
`;

    const tokenCode = `
;; Mock Token Contract with Minting
(impl-trait '${myAddress}.mock-token-trait.mock-token-trait')
(define-fungible-token mock-token)

(define-public (mint-for-testnet (amount uint) (recipient principal))
    (begin
        (try! (ft-mint? mock-token amount recipient))
        (print "Minted Mock Tokens for user")
        (ok true)
    )
)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
    (begin
        (try! (ft-transfer? mock-token amount sender recipient))
        (print "Transferring Mock Token")
        (ok true)
    )
)`;

    const routerCode = `
;; Mock DEX Router for Telegram Testing (with real transfers)  
(use-trait mock-token-trait '${myAddress}.mock-token-trait.mock-token-trait')

(define-public (swap-x-for-y (amount-in uint) (x-token principal) (y-token <mock-token-trait>) (min-amount-out uint))
    (begin
        ;; Take STX from user and give to contract
        (try! (stx-transfer? amount-in tx-sender (as-contract tx-sender)))
        ;; Mint fake tokens back to the user to simulate swap success
        ;; Since this is called via contract-call?, tx-sender here becomes the router contract.
        ;; We need to pass the INITIAL sender (the user) who initiated the top-level transaction.
        (try! (contract-call? y-token mint-for-testnet amount-in contract-caller))
        (print "Mock Swap X for Y Executed with real STX deposit")
        (ok true)
    )
)

(define-public (swap-y-for-x (amount-in uint) (x-token <mock-token-trait>) (y-token principal) (min-amount-out uint))
    (begin
        ;; Return STX to user simulating a sell
        (try! (as-contract (stx-transfer? amount-in tx-sender tx-sender)))
        (print "Mock Swap Y for X Executed")
        (ok true)
    )
)`;

    console.log("\nDeploying mock-token-trait...");
    const tx1 = await makeContractDeploy({
        contractName: 'mock-token-trait',
        codeBody: traitCode,
        senderKey,
        network: STACKS_NETWORK,
        anchorMode: AnchorMode.Any,
        fee: 500000,
        nonce: currentNonce++
    });
    const res1 = await broadcastTransaction(tx1, STACKS_NETWORK);
    console.log("Trait: ", res1.txid || res1);

    console.log("\nDeploying mock-token-v4...");
    const tx2 = await makeContractDeploy({
        contractName: 'mock-token-v4',
        codeBody: tokenCode,
        senderKey,
        network: STACKS_NETWORK,
        anchorMode: AnchorMode.Any,
        fee: 500000,
        nonce: currentNonce++
    });
    const res2 = await broadcastTransaction(tx2, STACKS_NETWORK);
    console.log("Token: ", res2.txid || res2);

    console.log("\nDeploying mock-bitflow-router-v6...");
    const tx3 = await makeContractDeploy({
        contractName: 'mock-bitflow-router-v6',
        codeBody: routerCode,
        senderKey,
        network: STACKS_NETWORK,
        anchorMode: AnchorMode.Any,
        fee: 500000,
        nonce: currentNonce++
    });
    const res3 = await broadcastTransaction(tx3, STACKS_NETWORK);
    console.log("Router: ", res3.txid || res3);
    
    console.log("\nAll broadcasts complete.");
}

deployMocks().catch(console.error);
