/**
 * Scoring for the evaluation harness.
 *
 * Pure functions over recorded samples: no I/O, no clock, no network. The
 * sampling loop in `scripts/evaluate.ts` does the collecting; everything here
 * only arithmetic, which is what makes the numbers reproducible from the
 * `--out` JSON and testable in `tests/evaluation-metrics.test.ts`.
 *
 * Two comparisons are computed, and they answer different questions:
 *
 *   1. **Against the held-out reference.** Every provider and every aggregation
 *      scored against a venue none of them are. Answers "how far from a real
 *      execution is each source?" — but is affected by how structurally similar
 *      a source is to the reference venue.
 *
 *   2. **Between aggregations of the same quote set.** Median vs mean vs the
 *      full KoinMix pipeline, all fed identical inputs. The only difference is
 *      the aggregation function, so this isolates whether our algorithm earns
 *      its complexity. This is the comparison that answers the phase's actual
 *      question.
 */
import { detectOutliers } from "../../src/consensus/outliers.js";
import {
  deviationBps,
  median,
  weightedMedian,
} from "../../src/consensus/stats.js";
import { quoteWeight } from "../../src/consensus/weighting.js";
import type { QuoteExclusion } from "../../src/consensus/outliers.js";
import type { ProviderFailure } from "../../src/providers/collect.js";
import type { PriceQuote } from "../../src/providers/types.js";
import type { ReferenceObservation } from "./reference.js";

// ── Recorded data ───────────────────────────────────────────────────────────

/** The parts of a `ConsensusResult` worth persisting for scoring. */
export interface ConsensusSnapshot {
  readonly price: number;
  readonly method: string;
  readonly sourceCount: number;
  readonly sources: readonly string[];
  readonly spreadBps: number;
  readonly deviationBps: number;
  readonly confidence: number;
  readonly isStale: boolean;
  readonly excluded: readonly QuoteExclusion[];
}

/** One evaluation round: what every source said at one moment in time. */
export interface SampleRecord {
  readonly index: number;
  /** When the round was dispatched. */
  readonly capturedAt: string;
  /** The instant handed to the consensus engine as `now`. */
  readonly evaluatedAt: string;
  readonly roundMs: number;
  readonly quotes: readonly PriceQuote[];
  readonly failures: readonly ProviderFailure[];
  readonly skipped: readonly string[];
  readonly reference: ReferenceObservation | null;
  readonly referenceFailure: string | null;
  readonly consensus: ConsensusSnapshot | null;
  readonly consensusFailure: { readonly code: string; readonly message: string } | null;
}

/** Engine settings in force for the run, needed to replay the sweep. */
export interface EvaluationSettings {
  readonly minSources: number;
  readonly maxDeviationBps: number;
  readonly maxStalenessMs: number;
  readonly outlierZThreshold: number;
  readonly outlierMinDeviationBps: number;
  readonly weights: Readonly<Record<string, number>>;
  readonly freshnessHalfLifeMs: number;
  readonly unverifiedFreshnessWeight: number;
}

// ── Error series ────────────────────────────────────────────────────────────

export type SeriesKind = "provider" | "koinmix" | "baseline";

export interface ErrorSeries {
  readonly label: string;
  readonly kind: SeriesKind;
  /** Rounds in which this source produced a price AND a reference existed. */
  readonly scored: number;
  readonly meanBps: number;
  readonly medianBps: number;
  /** Worst single round. The tail is where aggregation is supposed to pay off. */
  readonly maxBps: number;
  /** Mean absolute difference, in quote-currency units. */
  readonly meanAbs: number;
  readonly meanLatencyMs: number | null;
  /** Mean age of the underlying observation at capture time. */
  readonly meanAgeMs: number | null;
  readonly failures: number;
  /** True if this source priced against a proxy quote (e.g. USDT for USD). */
  readonly quoteProxy: boolean;
}

interface Observation {
  readonly bps: number;
  readonly abs: number;
  readonly latencyMs?: number;
  readonly ageMs?: number;
}

function summarise(
  label: string,
  kind: SeriesKind,
  observations: readonly Observation[],
  failures: number,
  quoteProxy: boolean,
): ErrorSeries {
  if (observations.length === 0) {
    return {
      label,
      kind,
      scored: 0,
      meanBps: Number.NaN,
      medianBps: Number.NaN,
      maxBps: Number.NaN,
      meanAbs: Number.NaN,
      meanLatencyMs: null,
      meanAgeMs: null,
      failures,
      quoteProxy,
    };
  }

  const bps = observations.map((o) => o.bps);
  const latencies = observations
    .map((o) => o.latencyMs)
    .filter((v): v is number => typeof v === "number");
  const ages = observations
    .map((o) => o.ageMs)
    .filter((v): v is number => typeof v === "number");

  return {
    label,
    kind,
    scored: observations.length,
    meanBps: mean(bps),
    medianBps: median(bps),
    maxBps: Math.max(...bps),
    meanAbs: mean(observations.map((o) => o.abs)),
    meanLatencyMs: latencies.length > 0 ? mean(latencies) : null,
    meanAgeMs: ages.length > 0 ? mean(ages) : null,
    failures,
    quoteProxy,
  };
}

/** Rounds usable for accuracy scoring: a fresh reference is a precondition. */
export function scorableSamples(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
): readonly SampleRecord[] {
  return samples.filter(
    (s) => s.reference !== null && s.reference.ageMs <= settings.maxStalenessMs,
  );
}

/**
 * Per-provider accuracy against the reference.
 *
 * Note that a provider is scored only on the rounds it actually answered, so a
 * flaky provider is not penalised in this table — its unreliability shows up in
 * the `N` and `FAIL` columns instead. Conflating the two would hide which of the
 * two problems a provider actually has.
 */
export function providerSeries(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
): readonly ErrorSeries[] {
  const scorable = scorableSamples(samples, settings);
  const names = new Set<string>();
  for (const sample of samples) {
    for (const q of sample.quotes) names.add(q.provider);
    for (const f of sample.failures) names.add(f.provider);
  }

  return [...names].sort().map((name) => {
    const observations: Observation[] = [];
    let quoteProxy = false;

    for (const sample of scorable) {
      const quote = sample.quotes.find((q) => q.provider === name);
      if (!quote || !sample.reference) continue;
      if (quote.isQuoteProxy) quoteProxy = true;

      observations.push({
        bps: deviationBps(quote.price, sample.reference.price),
        abs: Math.abs(quote.price - sample.reference.price),
        latencyMs: quote.latencyMs,
        ageMs: Math.max(
          0,
          Date.parse(sample.evaluatedAt) - Date.parse(quote.asOf),
        ),
      });
    }

    const failures = samples.reduce(
      (n, s) => n + s.failures.filter((f) => f.provider === name).length,
      0,
    );

    return summarise(name, "provider", observations, failures, quoteProxy);
  });
}

/**
 * KoinMix's own output, plus the two naive aggregations a simpler miner would
 * have shipped, over the identical quote sets.
 */
export function aggregationSeries(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
): readonly ErrorSeries[] {
  const scorable = scorableSamples(samples, settings);

  const koinmix: Observation[] = [];
  const naiveMedian: Observation[] = [];
  const naiveMean: Observation[] = [];

  for (const sample of scorable) {
    const reference = sample.reference;
    if (!reference) continue;

    if (sample.consensus) {
      koinmix.push({
        bps: deviationBps(sample.consensus.price, reference.price),
        abs: Math.abs(sample.consensus.price - reference.price),
        latencyMs: sample.roundMs,
      });
    }

    if (sample.quotes.length > 0) {
      const prices = sample.quotes.map((q) => q.price);
      naiveMedian.push({
        bps: deviationBps(median(prices), reference.price),
        abs: Math.abs(median(prices) - reference.price),
      });
      naiveMean.push({
        bps: deviationBps(mean(prices), reference.price),
        abs: Math.abs(mean(prices) - reference.price),
      });
    }
  }

  const consensusFailures = samples.filter((s) => s.consensusFailure).length;

  return [
    summarise("KoinMix consensus", "koinmix", koinmix, consensusFailures, false),
    summarise("· plain median", "baseline", naiveMedian, 0, false),
    summarise("· plain mean", "baseline", naiveMean, 0, false),
  ];
}

// ── Pipeline attribution ────────────────────────────────────────────────────

export interface PipelineEffect {
  /** Rounds where KoinMix's price differed at all from a plain median. */
  readonly roundsChanged: number;
  readonly roundsCompared: number;
  /** Mean size of that difference, in bps, over the rounds where it happened. */
  readonly meanShiftBps: number;
  readonly staleExclusions: number;
  readonly outlierExclusions: number;
}

/**
 * How much work the pipeline actually did.
 *
 * With uniform weights `weightedMedian` reduces exactly to `median`, so the
 * only things that can move KoinMix's answer away from a plain median of all
 * quotes are the staleness filter, outlier exclusion, and non-uniform weights.
 * If none of them fire, KoinMix *is* the plain median and any accuracy
 * difference between the two rows above is noise, not algorithm.
 */
export function pipelineEffect(
  samples: readonly SampleRecord[],
): PipelineEffect {
  let roundsChanged = 0;
  let roundsCompared = 0;
  let shiftTotal = 0;
  let staleExclusions = 0;
  let outlierExclusions = 0;

  for (const sample of samples) {
    for (const excluded of sample.consensus?.excluded ?? []) {
      if (excluded.reason === "stale") staleExclusions += 1;
      if (excluded.reason === "outlier") outlierExclusions += 1;
    }

    if (!sample.consensus || sample.quotes.length === 0) continue;
    roundsCompared += 1;

    const naive = median(sample.quotes.map((q) => q.price));
    if (naive !== sample.consensus.price) {
      roundsChanged += 1;
      shiftTotal += deviationBps(sample.consensus.price, naive);
    }
  }

  return {
    roundsChanged,
    roundsCompared,
    meanShiftBps: roundsChanged > 0 ? shiftTotal / roundsChanged : 0,
    staleExclusions,
    outlierExclusions,
  };
}

// ── Threshold sweep ─────────────────────────────────────────────────────────

export interface SweepRow {
  readonly floorBps: number;
  readonly exclusions: number;
  readonly roundsAffected: number;
  readonly meanBps: number;
  readonly maxBps: number;
  readonly isCurrent: boolean;
}

/**
 * Replay every round at different values of `OUTLIER_MIN_DEVIATION_BPS`.
 *
 * The floor is the knob that decides whether outlier detection can fire at all:
 * the modified z-score is scale-free, so without a floor ordinary cross-venue
 * spread reads as anomalous, but set the floor too high and nothing a real
 * market produces can ever reach it. This sweep is what turns that trade-off
 * into an empirical question instead of a taste one.
 *
 * The real `detectOutliers` and `weightedMedian` are used, not reimplementations,
 * so what is measured is what production would have done.
 */
export function sweepOutlierFloor(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
  floors: readonly number[],
): readonly SweepRow[] {
  const scorable = scorableSamples(samples, settings);

  return floors.map((floorBps) => {
    const errors: number[] = [];
    let exclusions = 0;
    let roundsAffected = 0;

    for (const sample of scorable) {
      const reference = sample.reference;
      if (!reference) continue;

      const fresh = freshQuotes(sample, settings.maxStalenessMs);
      if (fresh.length < settings.minSources || fresh.length === 0) continue;

      const { kept, excluded } = detectOutliers(fresh, {
        zThreshold: settings.outlierZThreshold,
        minDeviationBps: floorBps,
        minSources: settings.minSources,
      });

      if (excluded.length > 0) {
        exclusions += excluded.length;
        roundsAffected += 1;
      }

      const price = weightedMedian(
        kept.map((q) => ({
          price: q.price,
          weight: settings.weights[q.provider] ?? 1,
          provider: q.provider,
        })),
      );

      errors.push(deviationBps(price, reference.price));
    }

    return {
      floorBps,
      exclusions,
      roundsAffected,
      meanBps: errors.length > 0 ? mean(errors) : Number.NaN,
      maxBps: errors.length > 0 ? Math.max(...errors) : Number.NaN,
      isCurrent: floorBps === settings.outlierMinDeviationBps,
    };
  });
}

/** Freshness recomputed exactly as the engine did, from the same instant. */
function freshQuotes(
  sample: SampleRecord,
  maxStalenessMs: number,
): readonly PriceQuote[] {
  const nowMs = Date.parse(sample.evaluatedAt);
  return sample.quotes.filter(
    (q) => nowMs - Date.parse(q.asOf) <= maxStalenessMs,
  );
}

// ── Lag analysis ────────────────────────────────────────────────────────────

export interface LagRow {
  readonly provider: string;
  readonly meanAgeMs: number;
  /** Error against the reference captured in the same round. */
  readonly errorNowBps: number;
  /** Error against the reference observation nearest the quote's own `asOf`. */
  readonly errorAlignedBps: number;
  /** Rounds where a reference close enough in time existed to align against. */
  readonly aligned: number;
}

/**
 * How much reference drift separates two observations before we refuse to call
 * them contemporaneous. Half a default sampling interval: close enough that the
 * comparison means something, loose enough to find a match most rounds.
 */
const ALIGN_TOLERANCE_MS = 3000;

/**
 * Separates "this provider is wrong" from "this provider is late".
 *
 * A provider's error against the reference captured *now* conflates two very
 * different faults: reporting the wrong price, and reporting a right price from
 * a while ago. They call for opposite responses — the first means distrusting a
 * source, the second means discounting an observation — so telling them apart
 * matters before changing anything.
 *
 * The trick is that we recorded a reference time series, not just point values.
 * A quote stamped 118 seconds ago can be scored against the reference we
 * ourselves observed 118 seconds ago. If a provider's error collapses under
 * that alignment, it was never inaccurate: it was correct about an earlier
 * moment, and the fix belongs in how much weight its age earns it.
 */
export function lagAnalysis(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
): readonly LagRow[] {
  const timeline = samples
    .map((s) => s.reference)
    .filter((r): r is ReferenceObservation => r !== null)
    .map((r) => ({ atMs: Date.parse(r.asOf), price: r.price }))
    .sort((a, b) => a.atMs - b.atMs);

  const scorable = scorableSamples(samples, settings);
  const byProvider = new Map<
    string,
    { now: number[]; aligned: number[]; ages: number[] }
  >();

  for (const sample of scorable) {
    const reference = sample.reference;
    if (!reference) continue;

    for (const quote of sample.quotes) {
      const bucket = byProvider.get(quote.provider) ?? {
        now: [],
        aligned: [],
        ages: [],
      };

      const quoteAtMs = Date.parse(quote.asOf);
      bucket.now.push(deviationBps(quote.price, reference.price));
      bucket.ages.push(
        Math.max(0, Date.parse(sample.evaluatedAt) - quoteAtMs),
      );

      const contemporary = nearest(timeline, quoteAtMs);
      if (contemporary) {
        bucket.aligned.push(deviationBps(quote.price, contemporary.price));
      }

      byProvider.set(quote.provider, bucket);
    }
  }

  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, bucket]) => ({
      provider,
      meanAgeMs: mean(bucket.ages),
      errorNowBps: mean(bucket.now),
      errorAlignedBps:
        bucket.aligned.length > 0 ? mean(bucket.aligned) : Number.NaN,
      aligned: bucket.aligned.length,
    }));
}

function nearest(
  timeline: ReadonlyArray<{ atMs: number; price: number }>,
  targetMs: number,
): { atMs: number; price: number } | null {
  let best: { atMs: number; price: number } | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const point of timeline) {
    const gap = Math.abs(point.atMs - targetMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = point;
    }
  }

  return bestGap <= ALIGN_TOLERANCE_MS ? best : null;
}

// ── Weighting candidates ────────────────────────────────────────────────────

export interface WeightingCandidate {
  readonly label: string;
  readonly freshnessHalfLifeMs: number;
  readonly unverifiedFreshnessWeight: number;
}

/**
 * Replay every round under alternative weighting schemes.
 *
 * Identical inputs, identical freshness filter, identical outlier detection —
 * the only thing that varies is the weight each surviving quote carries into
 * the weighted median. That isolation is what lets the resulting table justify
 * a change to the engine rather than merely coincide with one.
 *
 * `quoteWeight` is the real production function, so a candidate that wins here
 * is a candidate we can ship unchanged.
 */
export function weightingSweep(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
  candidates: readonly WeightingCandidate[],
): readonly ErrorSeries[] {
  const scorable = scorableSamples(samples, settings);

  return candidates.map((candidate) => {
    const observations: Observation[] = [];

    for (const sample of scorable) {
      const reference = sample.reference;
      if (!reference) continue;

      const now = new Date(Date.parse(sample.evaluatedAt));
      const fresh = freshQuotes(sample, settings.maxStalenessMs);
      if (fresh.length === 0 || fresh.length < settings.minSources) continue;

      const { kept } = detectOutliers(fresh, {
        zThreshold: settings.outlierZThreshold,
        minDeviationBps: settings.outlierMinDeviationBps,
        minSources: settings.minSources,
      });

      const price = weightedMedian(
        kept.map((q) => ({
          price: q.price,
          weight: quoteWeight(q, {
            now,
            freshnessHalfLifeMs: candidate.freshnessHalfLifeMs,
            unverifiedFreshnessWeight: candidate.unverifiedFreshnessWeight,
            providerWeights: settings.weights,
          }),
          provider: q.provider,
        })),
      );

      observations.push({
        bps: deviationBps(price, reference.price),
        abs: Math.abs(price - reference.price),
      });
    }

    return summarise(candidate.label, "baseline", observations, 0, false);
  });
}

// ── Round-level reliability ─────────────────────────────────────────────────

export interface ReliabilityStats {
  readonly rounds: number;
  readonly roundsScored: number;
  readonly roundsFailed: number;
  readonly totalFailures: number;
  readonly failuresByProvider: ReadonlyArray<readonly [string, number]>;
  readonly sourceCountHistogram: ReadonlyArray<readonly [number, number]>;
  readonly singleSourceRounds: number;
  readonly meanSpreadBps: number;
  readonly maxSpreadBps: number;
  readonly p90SpreadBps: number;
  readonly meanConfidence: number;
  readonly minConfidence: number;
  readonly meanRoundMs: number;
  readonly meanReferenceAgeMs: number;
}

export function reliability(
  samples: readonly SampleRecord[],
  settings: EvaluationSettings,
): ReliabilityStats {
  const scorable = scorableSamples(samples, settings);
  const consensuses = samples
    .map((s) => s.consensus)
    .filter((c): c is ConsensusSnapshot => c !== null);

  const failureCounts = new Map<string, number>();
  for (const sample of samples) {
    for (const failure of sample.failures) {
      failureCounts.set(
        failure.provider,
        (failureCounts.get(failure.provider) ?? 0) + 1,
      );
    }
  }

  const histogram = new Map<number, number>();
  for (const c of consensuses) {
    histogram.set(c.sourceCount, (histogram.get(c.sourceCount) ?? 0) + 1);
  }

  const spreads = consensuses.map((c) => c.spreadBps);
  const confidences = consensuses.map((c) => c.confidence);
  const referenceAges = samples
    .map((s) => s.reference?.ageMs)
    .filter((v): v is number => typeof v === "number");

  return {
    rounds: samples.length,
    roundsScored: scorable.length,
    roundsFailed: samples.filter((s) => s.consensusFailure !== null).length,
    totalFailures: samples.reduce((n, s) => n + s.failures.length, 0),
    failuresByProvider: [...failureCounts.entries()].sort((a, b) => b[1] - a[1]),
    sourceCountHistogram: [...histogram.entries()].sort((a, b) => a[0] - b[0]),
    singleSourceRounds: consensuses.filter((c) => c.sourceCount === 1).length,
    meanSpreadBps: spreads.length > 0 ? mean(spreads) : Number.NaN,
    maxSpreadBps: spreads.length > 0 ? Math.max(...spreads) : Number.NaN,
    p90SpreadBps: spreads.length > 0 ? percentile(spreads, 90) : Number.NaN,
    meanConfidence: confidences.length > 0 ? mean(confidences) : Number.NaN,
    minConfidence: confidences.length > 0 ? Math.min(...confidences) : Number.NaN,
    meanRoundMs: samples.length > 0 ? mean(samples.map((s) => s.roundMs)) : Number.NaN,
    meanReferenceAgeMs: referenceAges.length > 0 ? mean(referenceAges) : Number.NaN,
  };
}

// ── Market context ──────────────────────────────────────────────────────────

export interface MarketContext {
  readonly low: number;
  readonly high: number;
  readonly rangeBps: number;
  /** Mean absolute move between consecutive reference observations, in bps. */
  readonly meanMoveBps: number;
  readonly windowMs: number;
}

/**
 * How much the market moved while we were sampling.
 *
 * Without this the accuracy table is unreadable: in a flat market every source
 * looks accurate, and a lagged source only looks wrong when the price is
 * actually moving. The mean per-sample move is roughly the error budget that
 * staleness alone buys a provider, so it says which part of a provider's error
 * is lag rather than inaccuracy.
 */
export function marketContext(
  samples: readonly SampleRecord[],
): MarketContext | null {
  const references = samples
    .map((s) => s.reference)
    .filter((r): r is ReferenceObservation => r !== null);

  if (references.length < 2) return null;

  const prices = references.map((r) => r.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);

  const moves: number[] = [];
  for (let i = 1; i < references.length; i += 1) {
    moves.push(deviationBps(prices[i]!, prices[i - 1]!));
  }

  return {
    low,
    high,
    rangeBps: deviationBps(high, low),
    meanMoveBps: mean(moves),
    windowMs:
      Date.parse(references[references.length - 1]!.receivedAt) -
      Date.parse(references[0]!.receivedAt),
  };
}

// ── Primitives ──────────────────────────────────────────────────────────────

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile. Small sample sizes make anything fancier theatre. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
