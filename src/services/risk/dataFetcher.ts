/**
 * Read-only mainnet token risk data fetcher.
 *
 * ISOLATION CONTRACT:
 *   - Imports nothing from wallet.ts, crypto.ts, network.ts, or any DEX execution code.
 *   - Always reads from mainnet APIs regardless of STACKS_NETWORK env var.
 *   - No signing, no broadcasting, no private key access.
 *   - null means "signal unavailable" — never a fake default.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const HIRO_MAINNET  = 'https://api.hiro.so';           // hardcoded — NEVER use hiroApiBase
const VELAR_API     = 'https://api.velar.co';
const ALEX_API      = 'https://api.alexgo.io';
const BITFLOW_API   = 'https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev';

const FETCH_TIMEOUT_MS   = 8_000;
const BULK_CACHE_TTL_MS  = 5 * 60_000;   // 5 min — Velar/ALEX/Bitflow bulk lists
const CONTRACT_CACHE_TTL_MS = 60 * 60_000; // 1 hr — contract metadata (age doesn't change)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenSignals {
  contractAddress: string;
  symbol:           string | null;

  /** Sum of all Velar pool TVL for this token, USD. null = unavailable. */
  liquidityUsd:         number | null;

  /**
   * Approximate 24h volume from ALEX (time window is undocumented by the API —
   * matches ALEX UI 24h figures but treat as approximate).
   * null = token not listed on ALEX or no volume data.
   */
  volumeApprox24hUsd:   number | null;

  /** Days since this token contract was deployed on Stacks mainnet. */
  tokenAgeDays:         number | null;

  /** Number of DEXs the token is actively listed on. */
  dexCount:   number;
  dexNames:   string[];

  /**
   * Total supply in human-readable units (raw / 10^decimals).
   * Present only as a flag for absurdly large supplies — not used in scoring weight.
   */
  totalSupply:  number | null;
  decimals:     number | null;

  /** Which signals actually returned data (false = null above, not a default) */
  availability: {
    liquidity:   boolean;
    volume:      boolean;
    tokenAge:    boolean;
    totalSupply: boolean;
  };

  fetchedAt: Date;
}

// ─── Internal cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> { data: T; ts: number; }

// Bulk caches (shared across all tokens, refreshed together)
let velarPoolsCache:   CacheEntry<VelarPool[]>    | null = null;
let alexTickersCache:  CacheEntry<AlexTicker[]>   | null = null;
let bitflowTokensCache: CacheEntry<BitflowToken[]> | null = null;

// Per-contract cache (keyed by contract address)
const contractAgeCache = new Map<string, CacheEntry<{ blockHeight: number; deployedAt: Date }>>();

// Per-block height cache (immutable on-chain data — never expires)
const blockTimestampCache = new Map<number, Date>();

// ─── Internal shape types ─────────────────────────────────────────────────────

interface VelarPool {
  symbol:                  string;
  token0ContractAddress:   string;
  token1ContractAddress:   string;
  stats?: {
    tvl_usd?:    { value: number };
    volume_usd?: { value: number };
    reserve0?:   number;
    reserve1?:   number;
  };
}

interface AlexTicker {
  tickerId:              string;
  baseVolume:            number;
  targetVolume:          number;
  lastBasePriceInUSD:    number;
  lastTargetPriceInUSD:  number;
}

interface BitflowToken {
  tokenContract: string;
  status:        string;
  symbol:        string;
  priceData?:    { last_price: number | null };
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function timed(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function fetchJson<T>(url: string, debug = false): Promise<T | null> {
  try {
    const res = await timed(url);
    if (!res.ok) { if (debug) console.error(`[risk] ${url} → HTTP ${res.status}`); return null; }
    return await res.json() as T;
  } catch (e: any) {
    if (debug) console.error(`[risk] ${url} → ${e?.name}: ${e?.message}`);
    return null;
  }
}

// ─── Bulk data fetchers (cached) ──────────────────────────────────────────────

async function getVelarPools(): Promise<VelarPool[]> {
  if (velarPoolsCache && Date.now() - velarPoolsCache.ts < BULK_CACHE_TTL_MS) {
    return velarPoolsCache.data;
  }
  const data = await fetchJson<{ data: VelarPool[] } | VelarPool[]>(`${VELAR_API}/pools?limit=200`);
  const pools: VelarPool[] = Array.isArray(data) ? data : (data as any)?.data ?? [];
  velarPoolsCache = { data: pools, ts: Date.now() };
  return pools;
}

async function getAlexTickers(): Promise<AlexTicker[]> {
  if (alexTickersCache && Date.now() - alexTickersCache.ts < BULK_CACHE_TTL_MS) {
    return alexTickersCache.data;
  }
  const data = await fetchJson<AlexTicker[]>(`${ALEX_API}/v1/tickers`);
  const tickers = data ?? [];
  alexTickersCache = { data: tickers, ts: Date.now() };
  return tickers;
}

async function getBitflowTokens(): Promise<BitflowToken[]> {
  if (bitflowTokensCache && Date.now() - bitflowTokensCache.ts < BULK_CACHE_TTL_MS) {
    return bitflowTokensCache.data;
  }
  const data = await fetchJson<{ tokens: BitflowToken[] }>(`${BITFLOW_API}/getAllTokensAndPools`);
  const tokens = data?.tokens ?? [];
  bitflowTokensCache = { data: tokens, ts: Date.now() };
  return tokens;
}

// ─── Contract age (two-step: contract → block height → block timestamp) ───────

async function getContractAge(contractAddress: string): Promise<{ blockHeight: number; deployedAt: Date } | null> {
  const cached = contractAgeCache.get(contractAddress);
  if (cached && Date.now() - cached.ts < CONTRACT_CACHE_TTL_MS) return cached.data;

  const info = await fetchJson<{ block_height: number }>(`${HIRO_MAINNET}/extended/v1/contract/${contractAddress}`);
  if (!info?.block_height) return null;

  const blockHeight = info.block_height;
  let deployedAt = blockTimestampCache.get(blockHeight);

  if (!deployedAt) {
    const block = await fetchJson<{ burn_block_time_iso: string }>(`${HIRO_MAINNET}/extended/v1/block/by_height/${blockHeight}`);
    if (!block?.burn_block_time_iso) return null;
    deployedAt = new Date(block.burn_block_time_iso);
    blockTimestampCache.set(blockHeight, deployedAt); // immutable — never expires
  }

  const result = { blockHeight, deployedAt };
  contractAgeCache.set(contractAddress, { data: result, ts: Date.now() });
  return result;
}

// ─── Per-signal extractors ────────────────────────────────────────────────────

/** Sum all Velar pool TVL in USD for this token (may appear in multiple pools). */
function extractLiquidity(pools: VelarPool[], contractAddress: string): number | null {
  const addr = contractAddress.toLowerCase();
  const matching = pools.filter(p =>
    p.token0ContractAddress?.toLowerCase() === addr ||
    p.token1ContractAddress?.toLowerCase() === addr
  );
  if (matching.length === 0) return null;

  let total = 0;
  for (const p of matching) {
    total += p.stats?.tvl_usd?.value ?? 0;
  }
  return total;
}

/**
 * ALEX ~24h volume in USD.
 * Time window undocumented — labeled "approx" throughout.
 * Match by tickerId prefix: "<contractAddress>_<anything>"
 * Use whichever price side is non-zero to compute USD.
 */
function extractAlexVolume(tickers: AlexTicker[], contractAddress: string): number | null {
  const prefix = contractAddress.toLowerCase() + '_';
  const ticker = tickers.find(t => t.tickerId.toLowerCase().startsWith(prefix));
  if (!ticker) return null;

  // Compute USD from both sides and take the larger.
  // For STX-paired tickers the token price is tiny (~0.00004) so fromBase understates;
  // the STX side gives the correct USD volume. Taking max() handles both pair types.
  const fromBase   = (ticker.baseVolume   ?? 0) * (ticker.lastBasePriceInUSD   ?? 0);
  const fromTarget = (ticker.targetVolume ?? 0) * (ticker.lastTargetPriceInUSD ?? 0);
  const usdVol = Math.max(fromBase, fromTarget);
  return usdVol > 0 ? usdVol : null;
}

/** Count distinct DEXs and list names. */
function extractDexPresence(
  pools: VelarPool[],
  tickers: AlexTicker[],
  bitflowTokens: BitflowToken[],
  contractAddress: string
): { dexCount: number; dexNames: string[] } {
  const addr = contractAddress.toLowerCase();
  const names: string[] = [];

  const onVelar = pools.some(p =>
    p.token0ContractAddress?.toLowerCase() === addr ||
    p.token1ContractAddress?.toLowerCase() === addr
  );
  if (onVelar) names.push('Velar');

  const onAlex = tickers.some(t => t.tickerId.toLowerCase().startsWith(addr + '_'));
  if (onAlex) names.push('ALEX');

  const onBitflow = bitflowTokens.some(t =>
    t.tokenContract?.toLowerCase() === addr &&
    t.status === 'active' &&
    (t.priceData?.last_price ?? 0) > 0
  );
  if (onBitflow) names.push('Bitflow');

  return { dexCount: names.length, dexNames: names };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all available risk signals for a SIP-010 token on Stacks mainnet.
 *
 * Always returns a complete TokenSignals object.
 * Individual signals are null when the API returned no data — never a fake value.
 * All three bulk fetches run in parallel to minimise latency.
 */
export async function fetchTokenSignals(contractAddress: string): Promise<TokenSignals> {
  // Normalise: strip asset identifier suffix if present (e.g. "::welshcorgicoin")
  const cleanAddress = contractAddress.split('::')[0];

  // Fetch all bulk data in parallel; contract age is a serial two-step
  const [pools, tickers, bitflowTokens, contractAge, metadata] = await Promise.all([
    getVelarPools(),
    getAlexTickers(),
    getBitflowTokens(),
    getContractAge(cleanAddress),
    fetchJson<{ symbol: string; total_supply: string; decimals: number }>(
      `${HIRO_MAINNET}/metadata/v1/ft/${cleanAddress}`
    ),
  ]);

  // ── Liquidity ──
  const liquidityUsd = extractLiquidity(pools, cleanAddress);

  // ── Volume ──
  const volumeApprox24hUsd = extractAlexVolume(tickers, cleanAddress);

  // ── Token age ──
  let tokenAgeDays: number | null = null;
  if (contractAge) {
    const msAgo = Date.now() - contractAge.deployedAt.getTime();
    tokenAgeDays = Math.floor(msAgo / (1000 * 60 * 60 * 24));
  }

  // ── DEX presence ──
  const { dexCount, dexNames } = extractDexPresence(pools, tickers, bitflowTokens, cleanAddress);

  // ── Total supply ──
  let totalSupply: number | null = null;
  const decimals: number | null = metadata?.decimals ?? null;
  if (metadata?.total_supply && decimals != null) {
    totalSupply = Number(metadata.total_supply) / Math.pow(10, decimals);
  }

  // ── Symbol ──
  const symbol = metadata?.symbol ??
    bitflowTokens.find(t => t.tokenContract?.toLowerCase() === cleanAddress.toLowerCase())?.symbol ??
    null;

  return {
    contractAddress: cleanAddress,
    symbol,
    liquidityUsd,
    volumeApprox24hUsd,
    tokenAgeDays,
    dexCount,
    dexNames,
    totalSupply,
    decimals,
    availability: {
      liquidity:   liquidityUsd       !== null,
      volume:      volumeApprox24hUsd !== null,
      tokenAge:    tokenAgeDays       !== null,
      totalSupply: totalSupply        !== null,
    },
    fetchedAt: new Date(),
  };
}
