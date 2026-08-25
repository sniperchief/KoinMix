import { ConsensusFailedError, InsufficientSourcesError } from "../errors.js";
import type { PriceQuote } from "../providers/types.js";
import { scoreConfidence, type ConfidenceBreakdown } from "./confidence.js";
import {
  detectOutliers,
  type QuoteExclusion,
} from "./outliers.js";
import { deviationBps, roundTo, weightedMedian } from "./stats.js";

/**
 * Consensus engine.
 *
 *   quotes → freshness filter → outlier detection → consensus → spread → confidence
 *
 * Pure and deterministic: no I/O, no clock reads beyond the injected `now`, no
 * randomness, and order-independent. CRYPTO_PRICE is a Tier A intent scored by
 * WASM Exact Match, so two miners handed identical quotes must produce
 * identical output.
 *
 * The engine never invents a price. Every failure path throws rather than
 * degrading to a guess.
 */

export interface ConsensusOptions {
  readonly minSources: number;
  /** Spread beyond which surviving quotes are treated as irreconcilable. */
  readonly maxDeviationBps: number;
  readonly maxStalenessMs: number;
  /** Injected for determinism in tests. */
  readonly now: Date;

  /** Modified z-score threshold for outlier detection. Default 3.5. */
  readonly outlierZThreshold?: number;
  /**
   * Minimum bps deviation before a quote can be called an outlier.
   * Defaults to `maxDeviationBps` — see OutlierOptions.minDeviationBps.
   */
  readonly outlierMinDeviationBps?: number;

  /**
   * Per-provider weights applied to the weighted median, keyed by provider name.
   *
   * Defaults to equal weighting for every provider, and that default is
   * deliberate: we have no evidence that any of these venues is systematically
   * more accurate than the others, and inventing weights without evidence would
   * bias the signal on nothing but taste. Weights become justifiable once the
   * evaluation harness produces per-provider error data.
   */
  readonly weights?: Readonly<Record<string, number>>;

  /** Providers that failed this round; lowers confidence, never the price. */
  readonly providerFailureCount?: number;
}

export interface ConsensusResult {
  readonly price: number;
  readonly priceX1e8: number;
  readonly method: "single" | "median";
  readonly sourceCount: number;
  readonly sources: readonly string[];
  /** Largest single deviation from consensus among surviving quotes, in bps. */
  readonly deviationBps: number;
  /** Peak-to-peak disagreement across surviving quotes, in bps. */
  readonly spreadBps: number;
  readonly confidence: number;
  readonly confidenceBreakdown: ConfidenceBreakdown;
  readonly asOf: string;
  readonly isStale: boolean;
  /** Providers dropped for age. Retained for backward compatibility. */
  readonly discardedStale: readonly string[];
  /** Every excluded observation, with reason and deviation. */
  readonly excluded: readonly QuoteExclusion[];
  /** True when weights were non-uniform. */
  readonly weighted: boolean;
}

const PRICE_SCALE = 1e8;

const DEFAULT_OUTLIER_Z_THRESHOLD = 3.5;

export function reachConsensus(
  quotes: readonly PriceQuote[],
  options: ConsensusOptions,
): ConsensusResult {
  const nowMs = options.now.getTime();

  // ── 1. Freshness ─────────────────────────────────────────────────────────
  const staleExclusions: QuoteExclusion[] = [];
  const fresh = quotes.filter((q) => {
    const ageMs = nowMs - Date.parse(q.asOf);
    if (ageMs <= options.maxStalenessMs) return true;

    staleExclusions.push({
      provider: q.provider,
      price: q.price,
      deviationBps: 0,
      reason: "stale",
      detail:
        `observation is ${Math.round(ageMs / 1000)}s old, beyond the ` +
        `${Math.round(options.maxStalenessMs / 1000)}s staleness bound`,
    });
    return false;
  });

  if (fresh.length < options.minSources) {
    throw new InsufficientSourcesError(
      `need at least ${options.minSources} fresh provider quote(s), got ${fresh.length}`,
      {
        required: options.minSources,
        received: fresh.length,
        excluded: staleExclusions,
      },
    );
  }

  // ── 2. Outlier detection ─────────────────────────────────────────────────
  const { kept, excluded: outlierExclusions } = detectOutliers(fresh, {
    zThreshold: options.outlierZThreshold ?? DEFAULT_OUTLIER_Z_THRESHOLD,
    // Only exclude what the round would not have tolerated anyway.
    minDeviationBps: options.outlierMinDeviationBps ?? options.maxDeviationBps,
    minSources: options.minSources,
  });

  const excluded = [...staleExclusions, ...outlierExclusions];

  // Removing outliers can drop the surviving count below the configured floor.
  if (kept.length < options.minSources) {
    throw new InsufficientSourcesError(
      `only ${kept.length} quote(s) remained after excluding ${outlierExclusions.length} outlier(s)`,
      { required: options.minSources, received: kept.length, excluded },
    );
  }

  // ── 3. Consensus ─────────────────────────────────────────────────────────
  const weights = options.weights ?? {};
  const weighted = kept.some((q) => (weights[q.provider] ?? 1) !== 1);

  const price = weightedMedian(
    kept.map((q) => ({
      price: q.price,
      weight: resolveWeight(weights, q.provider),
      provider: q.provider,
    })),
  );

  // ── 4. Spread ────────────────────────────────────────────────────────────
  // Two complementary views of disagreement, both relative to the consensus:
  //   spreadBps    = (max - min) / consensus × 10 000  — full disagreement band
  //   deviationBps = max|xᵢ − consensus| / consensus × 10 000  — worst single source
  // For symmetric data spread ≈ 2 × deviation; they diverge when quotes cluster
  // on one side of the consensus.
  const prices = kept.map((q) => q.price);
  const spread = (Math.max(...prices) - Math.min(...prices)) / price * 10_000;
  const worstDeviation = Math.max(...prices.map((p) => deviationBps(p, price)));

  const spreadBps = Math.round(spread);
  const maxDeviation = Math.round(worstDeviation);

  // Surviving quotes that still disagree beyond tolerance are irreconcilable:
  // with no majority to identify a culprit, refusing beats guessing.
  if (spreadBps > options.maxDeviationBps) {
    throw new ConsensusFailedError(
      `surviving quotes span ${spreadBps} bps, exceeding the ` +
        `${options.maxDeviationBps} bps tolerance`,
      {
        spreadBps,
        maxDeviationBps: options.maxDeviationBps,
        quotes: kept.map((q) => ({ provider: q.provider, price: q.price })),
        excluded,
      },
    );
  }

  // ── 5. Confidence ────────────────────────────────────────────────────────
  const oldestAsOfMs = Math.min(...kept.map((q) => Date.parse(q.asOf)));
  const oldestAgeMs = Math.max(0, nowMs - oldestAsOfMs);

  const confidenceBreakdown = scoreConfidence({
    sourceCount: kept.length,
    spreadBps,
    maxDeviationBps: options.maxDeviationBps,
    oldestAgeMs,
    maxStalenessMs: options.maxStalenessMs,
    outlierCount: outlierExclusions.length,
    failureCount: options.providerFailureCount ?? 0,
    unverifiedFreshnessCount: kept.filter(
      (q) => q.timestampProvenance === "response",
    ).length,
  });

  return {
    price,
    priceX1e8: toScaledInteger(price),
    method: kept.length === 1 ? "single" : "median",
    sourceCount: kept.length,
    sources: kept.map((q) => q.provider).sort(),
    deviationBps: maxDeviation,
    spreadBps,
    confidence: confidenceBreakdown.score,
    confidenceBreakdown,
    asOf: new Date(oldestAsOfMs).toISOString(),
    isStale: oldestAgeMs > options.maxStalenessMs,
    discardedStale: staleExclusions.map((e) => e.provider),
    excluded,
    weighted,
  };
}

/**
 * Look up a provider's weight, ignoring anything not usable as one. A
 * misconfigured weight must not silently zero out a source.
 */
function resolveWeight(
  weights: Readonly<Record<string, number>>,
  provider: string,
): number {
  const weight = weights[provider];
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : 1;
}

/**
 * Scale to 1e8 for on-chain `integers[]` storage.
 *
 * Refuses to silently truncate: a price whose scaled value exceeds
 * `Number.MAX_SAFE_INTEGER` would lose precision, which for an
 * exact-match-scored intent is worse than an error.
 */
function toScaledInteger(price: number): number {
  const scaled = Math.round(price * PRICE_SCALE);
  if (!Number.isSafeInteger(scaled)) {
    throw new ConsensusFailedError(
      "consensus price exceeds the precision representable at 1e8 scale",
      { price },
    );
  }
  return scaled;
}

/** Re-exported so consumers need only import from the engine. */
export type { QuoteExclusion } from "./outliers.js";
export { roundTo };
