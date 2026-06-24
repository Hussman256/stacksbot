/**
 * Rules-based token risk scorer for Stacks mainnet tokens.
 *
 * Thresholds are calibrated to Stacks reality, not Ethereum/Solana scale.
 * Every score is fully transparent: inputs and thresholds are always shown.
 *
 * ISOLATION CONTRACT: same as dataFetcher.ts — no wallet, no execution imports.
 */

import { TokenSignals } from './dataFetcher';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SignalScore {
  signal:    string;
  value:     string;          // human-readable value shown to user
  points:    number;
  band:      string;          // label for the band this value fell into
  flagged:   boolean;         // true when data was unavailable
}

export interface RiskScore {
  level:          RiskLevel;
  totalPoints:    number;
  bumped:         boolean;    // true if unavailable-data rule raised the level
  unavailCount:   number;
  signals:        SignalScore[];
  supplyNote:     string | null;  // non-scored supply flag
  summary:        string;         // one-line human summary
}

// ─── Thresholds (documented) ─────────────────────────────────────────────────
//
// LIQUIDITY — Stacks DEX TVL is genuinely low vs other chains. Even major
//   tokens trade at $400–$2,000 TVL. We use absolute USD bands that reflect
//   real trading risk (thin liquidity = price impact on any meaningful trade).
//     ≥ $1,000 → 0 pts  (relatively deep for Stacks)
//      $300–$999 → 1 pt  (moderate)
//      $100–$299 → 2 pts (thin — real price impact)
//       < $100   → 3 pts (very thin — extremely high impact)
//     unavailable → 2 pts + flag
//
// TOKEN AGE — rug-pull / abandonment risk concentrates in first weeks.
//     ≥ 90 days → 0 pts  (survived long enough to de-risk)
//     14–89 d   → 1 pt   (new but not brand new)
//      < 14 d   → 2 pts  (brand new — rug window)
//
// DEX COUNT — single exit point is a concentration risk; presence on all
//   three major Stacks DEXs (Velar, ALEX, Bitflow) is the healthy baseline.
//     ≥ 3 DEXs → 0 pts
//     2 DEXs   → 1 pt
//     1 DEX    → 2 pts (single exit point)
//     0 DEXs   → 3 pts (not listed anywhere)
//
// VOLUME (~24h ALEX, approx) — proxy for real demand / community activity.
//     ≥ $50   → 0 pts  (real activity)
//      $1–$49 → 1 pt   (light)
//       < $1  → 2 pts  (essentially none)
//     unavailable → 1 pt + flag
//
// LEVEL THRESHOLDS:
//     0–1 pts → LOW
//     2–3 pts → MEDIUM
//     4+  pts → HIGH
//     Rule: 2+ unavailable signals → bump one level up
//       (missing data is a risk, not a safe default)
//
// SUPPLY FLAG (non-scored): supply > 1 trillion is noted in output.
//   Some tokens legitimately have large supplies; we flag it for awareness
//   without adding score points.

// ─── Scorer ──────────────────────────────────────────────────────────────────

function fmt(n: number, prefix = '$'): string {
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${prefix}${(n / 1_000).toFixed(1)}K`;
  return `${prefix}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function scoreLiquidity(usd: number | null): SignalScore {
  const signal = 'Liquidity (Velar TVL)';
  if (usd === null) {
    return { signal, value: 'unavailable', points: 2, band: 'unavailable', flagged: true };
  }
  const value = fmt(usd);
  if (usd >= 1_000) return { signal, value, points: 0, band: '≥ $1,000 — relatively deep', flagged: false };
  if (usd >= 300)   return { signal, value, points: 1, band: '$300–$999 — moderate',        flagged: false };
  if (usd >= 100)   return { signal, value, points: 2, band: '$100–$299 — thin',             flagged: false };
  return               { signal, value, points: 3, band: '< $100 — very thin',              flagged: false };
}

function scoreAge(days: number | null): SignalScore {
  const signal = 'Token age';
  if (days === null) {
    return { signal, value: 'unavailable', points: 1, band: 'unavailable', flagged: true };
  }
  const value = `${days} days`;
  if (days >= 90) return { signal, value, points: 0, band: '≥ 90 days — established', flagged: false };
  if (days >= 14) return { signal, value, points: 1, band: '14–89 days — new',        flagged: false };
  return              { signal, value, points: 2, band: '< 14 days — brand new (rug window)', flagged: false };
}

function scoreDex(count: number, names: string[]): SignalScore {
  const signal = 'DEX listings';
  const value  = count === 0 ? 'none' : `${count} (${names.join(', ')})`;
  if (count >= 3) return { signal, value, points: 0, band: '≥ 3 DEXs — well-listed', flagged: false };
  if (count === 2) return { signal, value, points: 1, band: '2 DEXs — moderate',      flagged: false };
  if (count === 1) return { signal, value, points: 2, band: '1 DEX — single exit',    flagged: false };
  return               { signal, value, points: 3, band: '0 DEXs — not listed',       flagged: false };
}

function scoreVolume(usd: number | null): SignalScore {
  const signal = '~24h volume (ALEX, approx)';
  if (usd === null) {
    return { signal, value: 'unavailable', points: 1, band: 'unavailable', flagged: true };
  }
  const value = fmt(usd);
  if (usd >= 50) return { signal, value, points: 0, band: '≥ $50 — active',       flagged: false };
  if (usd >= 1)  return { signal, value, points: 1, band: '$1–$49 — light',        flagged: false };
  return             { signal, value, points: 2, band: '< $1 — essentially none', flagged: false };
}

function levelFromPoints(pts: number): RiskLevel {
  if (pts <= 1) return 'LOW';
  if (pts <= 3) return 'MEDIUM';
  return 'HIGH';
}

function bumpLevel(level: RiskLevel): RiskLevel {
  if (level === 'LOW')    return 'MEDIUM';
  if (level === 'MEDIUM') return 'HIGH';
  return 'HIGH';
}

export function scoreToken(signals: TokenSignals): RiskScore {
  const liq = scoreLiquidity(signals.liquidityUsd);
  const age = scoreAge(signals.tokenAgeDays);
  const dex = scoreDex(signals.dexCount, signals.dexNames);
  const vol = scoreVolume(signals.volumeApprox24hUsd);

  const scored   = [liq, age, dex, vol];
  const total    = scored.reduce((acc, s) => acc + s.points, 0);
  const unavail  = scored.filter(s => s.flagged).length;

  const rawLevel = levelFromPoints(total);
  const bumped   = unavail >= 2 && rawLevel !== 'HIGH';
  const level    = bumped ? bumpLevel(rawLevel) : rawLevel;

  const supplyNote =
    signals.totalSupply !== null && signals.totalSupply > 1_000_000_000_000
      ? `⚠ Supply unusually large: ${signals.totalSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })} (not scored — verify token design)`
      : null;

  const symbol = signals.symbol ?? signals.contractAddress.split('.').pop() ?? 'token';
  const unavailNote = unavail >= 2
    ? ` — limited data (${unavail} signals unavailable), treat with extra caution`
    : unavail === 1 ? ` — 1 signal unavailable` : '';

  const summary = `${level} RISK — ${symbol}: ${total} pt${total !== 1 ? 's' : ''} across ${scored.length} signals${bumped ? ' (bumped from ' + rawLevel + ' — missing data)' : ''}${unavailNote}`;

  return { level, totalPoints: total, bumped, unavailCount: unavail, signals: scored, supplyNote, summary };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const LEVEL_EMOJI: Record<RiskLevel, string> = {
  LOW:    '🟢',
  MEDIUM: '🟡',
  HIGH:   '🔴',
};

export function formatRiskScore(score: RiskScore): string {
  const emoji = LEVEL_EMOJI[score.level];
  const lines: string[] = [];

  lines.push(`${emoji} *${score.level} RISK* (${score.totalPoints} pts)`);

  if (score.bumped) {
    lines.push(`_⬆ Bumped from ${score.level === 'HIGH' ? 'MEDIUM' : 'LOW'}: 2+ data signals unavailable_`);
  }

  lines.push('');
  lines.push('*Signals:*');
  for (const s of score.signals) {
    const flag = s.flagged ? ' ⚠' : '';
    lines.push(`  • ${s.signal}: ${s.value}${flag}`);
    lines.push(`    _${s.band} → ${s.points} pt${s.points !== 1 ? 's' : ''}_`);
  }

  if (score.unavailCount >= 2) {
    lines.push('');
    lines.push('⚠ _Limited data — treat with extra caution._');
  }

  if (score.supplyNote) {
    lines.push('');
    lines.push(score.supplyNote);
  }

  return lines.join('\n');
}

/**
 * Compact one-or-two-line risk block for the buy quote message.
 * Only shows the band label on signals that cost points (not on GREEN signals).
 */
export function formatRiskInline(score: RiskScore): string {
  const emoji = LEVEL_EMOJI[score.level];
  const pts = score.totalPoints;

  // Build compact signal tokens
  const parts = score.signals.map(s => {
    if (s.flagged) {
      // Shorten signal name to first word for compactness
      const short = s.signal.split(' ')[0];
      return `${short} unavailable ⚠`;
    }
    // For zero-point signals show value only; for scoring signals add the band label
    const shortName: Record<string, string> = {
      'Liquidity (Velar TVL)': 'Liq',
      'Token age':             'Age',
      'DEX listings':          'DEXs',
      '~24h volume (ALEX, approx)': 'Vol',
    };
    const label = shortName[s.signal] ?? s.signal.split(' ')[0];
    if (s.points === 0) {
      // Green — clean value, no label noise
      return s.signal === 'DEX listings'
        ? `${s.value}`            // "3 (Velar, ALEX, Bitflow)" already self-explanatory
        : `${label} ${s.value}`;
    }
    // Amber/red — show value + short band label so user sees WHY it costs points
    const bandShort = s.band.split(' — ')[1] ?? s.band; // take part after em-dash
    return `${label} ${s.value} (${bandShort})`;
  });

  const line1 = `${emoji} *${score.level} RISK* · ${pts} pt${pts !== 1 ? 's' : ''}`;
  const line2 = parts.join(' · ');

  const lines = [line1, line2];

  if (score.unavailCount >= 2) {
    lines.push('⚠ _Limited data — treat this trade with extra caution_');
  }
  if (score.supplyNote) {
    // Trim the note for inline use
    const shortNote = score.supplyNote.replace('(not scored — verify token design)', '').trim();
    lines.push(`_${shortNote}_`);
  }

  return lines.join('\n');
}
