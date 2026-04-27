import * as dotenv from 'dotenv';
import { StacksTestnet, StacksMainnet } from '@stacks/network';
import { TransactionVersion } from '@stacks/transactions';

dotenv.config();

const isMainnet = process.env.STACKS_NETWORK === 'mainnet';

export const stacksNetwork = isMainnet ? new StacksMainnet() : new StacksTestnet();
export const transactionVersion = isMainnet ? TransactionVersion.Mainnet : TransactionVersion.Testnet;
export const hiroApiBase = isMainnet ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so';
export const explorerChain = isMainnet ? 'mainnet' : 'testnet';
