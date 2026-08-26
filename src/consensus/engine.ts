import { ConsensusFailedError, InsufficientSourcesError } from "../errors.js";
import type { PriceQuote } from "../providers/types.js";
import { scoreConfidence, type ConfidenceBreakdown } from "./confidence.js";
import {
  detectOutliers,
  type QuoteExclusion,
} from "./outliers.js";
import { deviationBps, roundTo, weightedMedian } from "./stats.js";
import {
  DEFAULT_FRESHNESS_HALF_LIFE_MS,
  DEFAULT_UNVERIFIED_FRESHNESS_WEIGHT,
  quoteWeight,
  type WeightingOptions,
} from "./weighting.js";

/**
 * Consensus engine.
 *
 *   quotes → freshness filter → outlier detection → weighting → consensus
 *          → spread → confidence
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
   * Still defaults to equal weighting for every provider, and still deliberately
   * so. The evaluation harness does now produce per-provider error data, but
   * that data is measured against a reference venue, and any reference is itself
   * just another venue — scoring against a spot exchange will always flatter
   * spot exchanges. Weighting by vendor identity on that basis would bake our
   * choice of reference into the signal. Weighting by observation age and
   * verifiability (below) needs no such appeal.
   */
  readonly weights?: Readonly<Record<string, number>>;

  /**
   * Age at which a quote's weight halves. See src/consensus/weighting.ts.
   * Zero disables freshness weighting.
   */
  readonly freshnessHalfLifeMs?: number;

  /** Weight multiplier for quotes with an unverifiable observation time. */
  readonly unverifiedFreshnessWeight?: number;

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
  /** True when the surviving quotes did not all carry the same weight. */
  readonly weighted: boolean;
  /**
   * The effective weight each surviving quote carried.
   *
   * Not part of the wire response, but logged: once weights vary per round it
   * is otherwise impossible to reconstruct after the fact why a price landed
   * where it did between its inputs.
   */
  readonly weights: ReadonlyArray<{
    readonly provider: string;
    readonly weight: number;
  }>;
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
  const weightingOptions: WeightingOptions = {
    now: options.now,
    freshnessHalfLifeMs:
      options.freshnessHalfLifeMs ?? DEFAULT_FRESHNESS_HALF_LIFE_MS,
    unverifiedFreshnessWeight:
      options.unverifiedFreshnessWeight ?? DEFAULT_UNVERIFIED_FRESHNESS_WEIGHT,
    providerWeights: options.weights ?? {},
  };

  const entries = kept.map((q) => ({
    price: q.price,
    weight: quoteWeight(q, weightingOptions),
    provider: q.provider,
  }));

  const first = entries[0]!.weight;
  const weighted = entries.some((e) => e.weight !== first);

  const price = weightedMedian(entries);

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
    // 6dp, not 4: the weight floor in weighting.ts is 1e-6, and rounding to 4
    // would render a deliberately-tiny-but-nonzero weight as a flat 0 — exactly
    // the "this source was dropped" reading the floor exists to avoid.
    weights: entries
      .map((e) => ({ provider: e.provider, weight: roundTo(e.weight, 6) }))
      .sort((a, b) => a.provider.localeCompare(b.provider)),
  };
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
