import { getBalance } from './wallet';

export async function getPortfolio(address: string) {
  const { stx: stxBalanceStr, tokens } = await getBalance(address);
  const stxBalance = parseFloat(stxBalanceStr);
  
  // Real app: fetch live STX price from Coingecko or similar
  const stxPriceUsd = 2.50; 
  let totalUsdValue = stxBalance * stxPriceUsd;

  const parsedTokens = tokens.map(t => {
      // Mock pricing logic for testing SIP-010 balances
      const mockPriceUsd = 1.25; 
      const tokenSymbol = t.identifier.split('::')[1] || t.identifier;
      const balance = parseFloat(t.balance);
      const valueUsd = balance * mockPriceUsd;
      
      totalUsdValue += valueUsd;
      
      return { symbol: tokenSymbol.toUpperCase(), balance, valueUsd };
  });

  return {
    totalUsd: totalUsdValue.toFixed(2),
    stxBalance,
    stxPriceUsd,
    tokens: [
      { symbol: 'STX', balance: stxBalance, valueUsd: stxBalance * stxPriceUsd },
      ...parsedTokens
    ]
  };
}
