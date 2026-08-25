import { roundTo } from "./stats.js";

/**
 * Reliability indicator.
 *
 * This is NOT a probability. It does not estimate the chance that the price is
 * correct, and it is not calibrated against any outcome distribution. It is a
 * bounded, deterministic score summarising how much corroboration stood behind
 * a given answer, so that a consumer can tell a four-source tight agreement
 * from a lone unverified quote. Treating it as a statistical confidence level
 * would be unsupported by the methodology.
 *
 * Construction: a corroboration base set by how many independent sources
 * survived, multiplied by penalty factors in [0,1] for the things that should
 * reduce trust. Multiplicative rather than additive so that several mild
 * problems compound instead of cancelling out.
 */

export interface ConfidenceInputs {
  /** Independent sources contributing to the final consensus. */
  readonly sourceCount: number;
  /** Peak-to-peak disagreement across surviving quotes, in bps. */
  readonly spreadBps: number;
  /** Disagreement budget; spread is scored as a fraction of this. */
  readonly maxDeviationBps: number;
  /** Age of the oldest surviving observation, in milliseconds. */
  readonly oldestAgeMs: number;
  /** Bound beyond which a quote would have been discarded as stale. */
  readonly maxStalenessMs: number;
  /** Observations excluded as anomalous this round. */
  readonly outlierCount: number;
  /** Providers that errored, timed out, or returned something unusable. */
  readonly failureCount: number;
  /**
   * Surviving quotes whose timestamp is a response time rather than a genuine
   * observation time (see PriceQuote.timestampProvenance).
   */
  readonly unverifiedFreshnessCount: number;
}

export interface ConfidenceBreakdown {
  readonly score: number;
  readonly base: number;
  readonly agreementFactor: number;
  readonly freshnessFactor: number;
  readonly outlierFactor: number;
  readonly failureFactor: number;
  readonly provenanceFactor: number;
}

/**
 * Corroboration base by surviving source count.
 *
 * Deliberately capped below 1.0: four venues agreeing is strong evidence, but
 * they can still be jointly wrong (a shared upstream, a market-wide bad print),
 * so the score never asserts certainty.
 */
function corroborationBase(sourceCount: number): number {
  if (sourceCount <= 0) return 0;
  if (sourceCount === 1) return 0.5; // single unverified source
  if (sourceCount === 2) return 0.7; // agreement, but no majority to arbitrate
  if (sourceCount === 3) return 0.85; // a majority can outvote one bad tick
  return 0.95; // four or more independent venues
}

/**
 * Penalty weights. Each is the *most* that factor can subtract, so the worst
 * case for any single factor is a multiplier of (1 - weight).
 *
 * Ordered by how directly each signals that the price itself may be wrong:
 * disagreement between sources is the strongest such signal, so it carries the
 * largest weight; an upstream simply being down says comparatively little about
 * the correctness of the sources that did answer.
 */
const AGREEMENT_WEIGHT = 0.3;
const FRESHNESS_WEIGHT = 0.2;
const OUTLIER_WEIGHT_EACH = 0.1;
const FAILURE_WEIGHT_EACH = 0.05;
const UNVERIFIED_FRESHNESS_WEIGHT_EACH = 0.05;

export function scoreConfidence(inputs: ConfidenceInputs): ConfidenceBreakdown {
  const base = corroborationBase(inputs.sourceCount);

  // How much of the allowed disagreement budget was consumed.
  const budgetUsed =
    inputs.maxDeviationBps <= 0
      ? 0
      : clamp01(inputs.spreadBps / inputs.maxDeviationBps);
  const agreementFactor = 1 - AGREEMENT_WEIGHT * budgetUsed;

  // How far through the staleness window the oldest surviving quote sits.
  const ageUsed =
    inputs.maxStalenessMs <= 0
      ? 0
      : clamp01(inputs.oldestAgeMs / inputs.maxStalenessMs);
  const freshnessFactor = 1 - FRESHNESS_WEIGHT * ageUsed;

  // An excluded outlier means the sources materially disagreed, even though we
  // could identify which one to drop.
  const outlierFactor = clamp01(1 - OUTLIER_WEIGHT_EACH * inputs.outlierCount);

  const failureFactor = clamp01(1 - FAILURE_WEIGHT_EACH * inputs.failureCount);

  // A quote we cannot age-verify might be arbitrarily stale behind a fresh
  // response timestamp.
  const provenanceFactor = clamp01(
    1 - UNVERIFIED_FRESHNESS_WEIGHT_EACH * inputs.unverifiedFreshnessCount,
  );

  const score =
    base *
    agreementFactor *
    freshnessFactor *
    outlierFactor *
    failureFactor *
    provenanceFactor;

  return {
    // 4dp keeps the value stable across runs for exact-match scoring.
    score: roundTo(clamp01(score), 4),
    base,
    agreementFactor: roundTo(agreementFactor, 4),
    freshnessFactor: roundTo(freshnessFactor, 4),
    outlierFactor: roundTo(outlierFactor, 4),
    failureFactor: roundTo(failureFactor, 4),
    provenanceFactor: roundTo(provenanceFactor, 4),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
