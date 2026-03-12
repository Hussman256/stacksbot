import { createWallet } from './src/services/wallet';
import { standardPrincipalCV } from '@stacks/transactions';

async function test() {
    const w = await createWallet();
    console.log("Testnet Address:", w.address);
    try {
        standardPrincipalCV(w.address);
        console.log("Valid for principalCV!");
    } catch(e: any) {
        console.log("Error:", e.message);
    }
}
test();
