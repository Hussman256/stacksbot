import { standardPrincipalCV } from '@stacks/transactions';

function test() {
    try {
        standardPrincipalCV('SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM');
        console.log("SP102V... OK!");
    } catch(e: any) {
        console.log("Failed: " + e.message);
    }
}
test();
