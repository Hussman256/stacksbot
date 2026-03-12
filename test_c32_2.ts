import { standardPrincipalCV } from '@stacks/transactions';

try {
    standardPrincipalCV('SP31DA6FTSJX2WGVZAV6PRNIFW9M3Q41V6X6Q2J4F'); // The hardcoded mock bitflow router address
    console.log("Mock router Ok.");
} catch(e: any) {
    console.log("Mock router fails: " + e.message);
}
