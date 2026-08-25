/**
 * Deterministic statistical primitives.
 *
 * Pure functions only: no I/O, no clock, no randomness. Given the same inputs
 * in any order they must produce byte-identical outputs, because CRYPTO_PRICE
 * is a Tier A intent scored by WASM Exact Match.
 */

export interface WeightedPrice {
  readonly price: number;
  readonly weight: number;
  /** Tie-breaker so equal prices sort deterministically. */
  readonly provider: string;
}

/** Classic median of an unsorted list. Averages the middle pair when even. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("median requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Weighted median: the price at which cumulative weight reaches half the total.
 *
 * With uniform weights this reduces exactly to `median()` above, including the
 * even-count averaging — so enabling weighting cannot silently shift results
 * for the default equal-weight configuration.
 *
 * When cumulative weight lands exactly on the halfway point the two straddling
 * prices are averaged, which is what makes the uniform case agree with the
 * classic definition.
 */
export function weightedMedian(entries: readonly WeightedPrice[]): number {
  if (entries.length === 0) {
    throw new RangeError("weightedMedian requires at least one entry");
  }

  // Sort by price, then provider, so ties resolve identically on every run.
  const sorted = [...entries].sort(
    (a, b) => a.price - b.price || a.provider.localeCompare(b.provider),
  );

  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) {
    throw new RangeError("weightedMedian requires a positive total weight");
  }

  const half = total / 2;
  let cumulative = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    cumulative += sorted[i]!.weight;

    if (cumulative > half) {
      return sorted[i]!.price;
    }

    // Exactly half: the median sits between this price and the next.
    if (cumulative === half) {
      const next = sorted[i + 1];
      return next ? (sorted[i]!.price + next.price) / 2 : sorted[i]!.price;
    }
  }

  return sorted[sorted.length - 1]!.price;
}

/**
 * Median Absolute Deviation about a given centre.
 *
 * MAD is used instead of standard deviation because it has a breakdown point of
 * 50%: up to half the observations can be arbitrarily corrupt without moving
 * it. Standard deviation is dragged by the very outlier we are trying to find,
 * which makes it self-defeating for this job.
 */
export function medianAbsoluteDeviation(
  values: readonly number[],
  centre: number,
): number {
  if (values.length === 0) {
    throw new RangeError("medianAbsoluteDeviation requires at least one value");
  }
  return median(values.map((v) => Math.abs(v - centre)));
}

/** Relative deviation from a reference price, in basis points (1 bp = 0.01%). */
export function deviationBps(value: number, reference: number): number {
  if (reference <= 0) {
    throw new RangeError("deviationBps requires a positive reference");
  }
  return Math.abs(value - reference) / reference * 10_000;
}

/** Round to a fixed number of decimals so output cannot drift across runs. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
