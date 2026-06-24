/**
 * Phase 2 test: fetch signals + compute risk scores for 4 tokens.
 * Run: npx ts-node --transpile-only test-risk.ts
 */
import { fetchTokenSignals } from './src/services/risk/dataFetcher';
import { scoreToken, formatRiskScore } from './src/services/risk/scorer';

const TOKENS = [
  { label: 'WELSH (liquid)',     address: 'SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G.welshcorgicoin-token' },
  { label: 'LEO (mid-tier)',     address: 'SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token' },
  { label: 'nakamoto (thin)',    address: 'SP3R4MHK99JAAM0N3T0CBZRZVSVQFG1N75DQ08JSD.nakamoto' },
  // FROG: single-DEX (Bitflow only), no Velar pool, low volume — genuine thin/sketchy profile
  { label: 'FROG (sketchy)',     address: 'SP2C2YFP12AJZB4MABJMJZ3G25EFBFJ5BE6SOLNKQ.frog-token' },
];

async function main() {
  console.log('Fetching mainnet risk signals (read-only)...\n');
  const start = Date.now();

  const signals = await Promise.all(TOKENS.map(t => fetchTokenSignals(t.address)));

  console.log(`Completed in ${Date.now() - start}ms\n`);
  console.log('='.repeat(70));

  for (let i = 0; i < TOKENS.length; i++) {
    const t = TOKENS[i];
    const s = signals[i];
    const score = scoreToken(s);

    console.log(`\n── ${t.label} ──`);
    console.log(`  Raw signals:`);
    console.log(`    Liquidity: ${s.liquidityUsd !== null ? '$' + s.liquidityUsd.toFixed(2) : 'unavailable'}`);
    console.log(`    Volume ~24h: ${s.volumeApprox24hUsd !== null ? '$' + s.volumeApprox24hUsd.toFixed(2) : 'unavailable'}`);
    console.log(`    Age: ${s.tokenAgeDays !== null ? s.tokenAgeDays + ' days' : 'unavailable'}`);
    console.log(`    DEXs: ${s.dexCount} (${s.dexNames.join(', ') || 'none'})`);
    console.log(`    Supply: ${s.totalSupply !== null ? s.totalSupply.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'unavailable'}`);
    console.log(`  Score breakdown:`);
    for (const sig of score.signals) {
      const flag = sig.flagged ? ' ⚠' : '';
      console.log(`    ${sig.signal}: ${sig.value}${flag}  →  ${sig.points} pt (${sig.band})`);
    }
    console.log(`  Total: ${score.totalPoints} pts${score.bumped ? ' → bumped (2+ unavailable)' : ''}`);
    console.log(`  ► LEVEL: ${score.level}`);
    if (score.supplyNote) console.log(`  ${score.supplyNote}`);
    if (score.unavailCount >= 2) console.log(`  ⚠ Limited data — treat with extra caution`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Not available on Stacks mainnet APIs: holder count, supply concentration.');
}

main().catch(console.error);
