import type { PriceQuote } from "../providers/types.js";

/**
 * Evidence weighting for consensus.
 *
 * The question a weight answers is narrow: *how much should this observation
 * count as evidence about the price right now?* Two properties of a quote bear
 * on that, and neither is the vendor's name.
 *
 * **Age.** A price observed two minutes ago is a weaker statement about the
 * current price than one observed a second ago, because the market moved in
 * between. Under a random walk the variance of that drift grows linearly with
 * elapsed time, and the standard way to combine estimates of differing variance
 * is inverse-variance weighting — the weight of an estimate is 1/σ². Writing
 * σ²(age) = σ₀²(1 + age/τ) and normalising gives
 *
 *     freshness(age) = τ / (τ + age)
 *
 * which is 1 at age zero, ½ at age τ, and decays toward zero thereafter. τ is
 * therefore the age at which an observation counts for half of a fresh one.
 *
 * **Verifiability.** A quote whose timestamp is the provider's *response* time
 * rather than an observation time (see `PriceQuote.timestampProvenance`) has an
 * age we cannot see. Scoring it on its reported age is the worst available
 * assumption: it awards the highest freshness weight to the one source whose
 * freshness is unproven. Such quotes take a flat penalty instead.
 *
 * Deliberately not weighted: provider identity. Per-provider weights remain
 * configurable and default to uniform, because "this venue is more accurate"
 * cannot be established without a reference, and any reference is itself just
 * another venue — measuring against a spot exchange would inevitably conclude
 * that spot exchanges are the most accurate. Age and provenance need no such
 * appeal: they are properties of the observation, true regardless of who
 * reported it, and a provider that starts publishing fresher data earns its
 * weight back automatically.
 *
 * Pure and deterministic, like everything else consensus depends on.
 */

/**
 * Age at which a quote counts for half of a fresh one.
 *
 * Chosen from measurement, not taste. `npm run evaluate` replays real rounds
 * under a grid of half-lives (see WEIGHTING_CANDIDATES in scripts/evaluate.ts);
 * across BTC and ETH every value between 5s and 30s produced the same
 * improvement, and 10s sat in the middle of that plateau. A value inside a flat
 * region is what we want: it means the result does not hinge on the constant
 * being exactly right.
 */
export const DEFAULT_FRESHNESS_HALF_LIFE_MS = 10_000;

/**
 * What an unverifiable observation time is worth: half a source.
 *
 * Also measured. Freshness decay *on its own* made accuracy slightly worse in
 * evaluation, because discounting the one provider with an honestly-reported
 * old timestamp simply moved weight onto the provider whose timestamp could not
 * be checked — and which the lag analysis showed was the further off. The two
 * corrections only work together, which is why neither is enabled alone.
 */
export const DEFAULT_UNVERIFIED_FRESHNESS_WEIGHT = 0.5;

export interface WeightingOptions {
  /** Instant the round is evaluated at. Injected; never read from the clock. */
  readonly now: Date;
  /**
   * Age at which a quote's weight halves, in milliseconds.
   *
   * Zero disables freshness weighting entirely, which makes uniform weighting
   * reachable as a configuration rather than a separate code path.
   */
  readonly freshnessHalfLifeMs: number;
  /** Multiplier applied to quotes with an unverifiable observation time. */
  readonly unverifiedFreshnessWeight: number;
  /** Optional per-provider multipliers. Absent or invalid entries mean 1. */
  readonly providerWeights: Readonly<Record<string, number>>;
}

/**
 * A weight must stay strictly positive: `weightedMedian` requires a positive
 * total, and a zero would silently delete a source rather than discount it.
 * Exclusion is the outlier detector's job, and it says so explicitly.
 */
const MIN_WEIGHT = 1e-6;

export function quoteWeight(
  quote: PriceQuote,
  options: WeightingOptions,
): number {
  const provider = resolveProviderWeight(
    options.providerWeights,
    quote.provider,
  );

  const ageMs = Math.max(0, options.now.getTime() - Date.parse(quote.asOf));

  const freshness =
    options.freshnessHalfLifeMs > 0 && Number.isFinite(ageMs)
      ? options.freshnessHalfLifeMs / (options.freshnessHalfLifeMs + ageMs)
      : 1;

  const provenance =
    quote.timestampProvenance === "observed"
      ? 1
      : clampUnitInterval(options.unverifiedFreshnessWeight);

  return Math.max(MIN_WEIGHT, provider * freshness * provenance);
}

/**
 * Look up a provider's configured weight, ignoring anything unusable as one.
 * A misconfigured entry must not silently zero out a source.
 */
function resolveProviderWeight(
  weights: Readonly<Record<string, number>>,
  provider: string,
): number {
  const weight = weights[provider];
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : 1;
}

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
