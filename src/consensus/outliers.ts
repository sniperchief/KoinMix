import type { PriceQuote } from "../providers/types.js";
import { deviationBps, median, medianAbsoluteDeviation } from "./stats.js";

/**
 * Deterministic outlier detection over provider quotes.
 *
 * Exclusion is per-observation and per-round only. A provider that produces one
 * anomalous tick is not penalised on the next request and is never blacklisted —
 * transient bad ticks are common (a thin book, a mid-update read), and a venue
 * that is wrong once is usually right immediately afterwards.
 */

export type ExclusionReason = "stale" | "outlier";

export interface QuoteExclusion {
  readonly provider: string;
  readonly price: number;
  /** Deviation from the pre-exclusion median, in basis points. */
  readonly deviationBps: number;
  readonly reason: ExclusionReason;
  /** Human-readable justification, surfaced in the response and logs. */
  readonly detail: string;
}

export interface OutlierOptions {
  /**
   * Modified z-score above which an observation is treated as anomalous.
   *
   * 3.5 is the threshold recommended by Iglewicz & Hoaglin, *Volume 16: How to
   * Detect and Handle Outliers* (ASQC, 1993) for the MAD-based modified
   * z-score. It is a published convention rather than a number chosen to make
   * our tests pass.
   */
  readonly zThreshold: number;

  /**
   * A quote is never called an outlier unless it also deviates from the median
   * by more than this many basis points.
   *
   * The floor exists because the modified z-score is scale-free: when sources
   * agree very closely the MAD collapses toward zero and *any* difference
   * produces an enormous z-score (formally infinite at MAD = 0), so ordinary
   * disagreement would be flagged as anomalous.
   *
   * It defaults to the round's own disagreement tolerance
   * (`CONSENSUS_MAX_DEVIATION_BPS`), which makes exclusion self-consistent:
   * an observation is anomalous only if it exceeds the disagreement the round
   * was already willing to accept. Below that it is legitimate cross-venue
   * spread, and discarding it would throw away real information *and*
   * artificially narrow the reported spread — which would inflate the
   * confidence score rather than lower it.
   *
   * An earlier fixed 50 bps default was wrong for exactly that reason: given
   * quotes [100, 101, 100] the MAD is zero, and 101 sits only 100 bps out, so
   * a legitimate third source was excluded and confidence rose when it should
   * have fallen.
   */
  readonly minDeviationBps: number;

  /** Consensus is never allowed to rest on fewer surviving quotes than this. */
  readonly minSources: number;
}

export interface OutlierResult {
  readonly kept: readonly PriceQuote[];
  readonly excluded: readonly QuoteExclusion[];
  /** Median used for detection, before any exclusion. */
  readonly referenceMedian: number;
}

/**
 * An exclusion decision needs a surviving majority to be credible: one quote
 * "outvoting" the rest is not evidence, it is a coin flip. Below three quotes
 * there is no majority to appeal to, so nothing is excluded.
 */
const MIN_QUOTES_FOR_DETECTION = 3;
const MIN_SURVIVORS = 2;

/** Consistency constant making the modified z-score comparable to a normal SD. */
const MAD_SCALE = 0.6745;

export function detectOutliers(
  quotes: readonly PriceQuote[],
  options: OutlierOptions,
): OutlierResult {
  const prices = quotes.map((q) => q.price);
  const referenceMedian = median(prices);

  // With one or two quotes there is no majority, so no observation can be
  // identified as the anomalous one. Two-source disagreement is instead handled
  // by the engine's spread guard, which refuses rather than guessing.
  if (quotes.length < MIN_QUOTES_FOR_DETECTION) {
    return { kept: quotes, excluded: [], referenceMedian };
  }

  const mad = medianAbsoluteDeviation(prices, referenceMedian);

  const candidates = quotes.map((quote) => {
    const absoluteDeviation = Math.abs(quote.price - referenceMedian);
    const bps = deviationBps(quote.price, referenceMedian);

    // MAD is exactly zero whenever at least half the quotes sit on the same
    // price — which is when an outlier is most obvious, not least. The
    // z-score is undefined there, so fall back to the bps floor alone.
    const modifiedZ =
      mad > 0 ? (MAD_SCALE * absoluteDeviation) / mad : Number.POSITIVE_INFINITY;

    const isOutlier = bps > options.minDeviationBps && modifiedZ > options.zThreshold;

    return { quote, bps, modifiedZ, isOutlier };
  });

  const flagged = candidates.filter((c) => c.isOutlier);
  const survivors = candidates.filter((c) => !c.isOutlier);

  // Refuse to exclude if doing so would leave too little to stand on. Better to
  // hand a wide, visibly-disagreeing set to the spread guard than to manufacture
  // false agreement by discarding most of the evidence.
  const floor = Math.max(MIN_SURVIVORS, options.minSources);
  if (flagged.length === 0 || survivors.length < floor) {
    return { kept: quotes, excluded: [], referenceMedian };
  }

  return {
    kept: survivors.map((c) => c.quote),
    excluded: flagged.map((c) => ({
      provider: c.quote.provider,
      price: c.quote.price,
      deviationBps: Math.round(c.bps),
      reason: "outlier" as const,
      detail:
        `deviates ${Math.round(c.bps)} bps from the ${survivors.length + flagged.length}-source ` +
        `median (${formatPrice(referenceMedian)})` +
        (Number.isFinite(c.modifiedZ)
          ? `, modified z-score ${c.modifiedZ.toFixed(1)} > ${options.zThreshold}`
          : ", and the surviving sources agree exactly"),
    })),
    referenceMedian,
  };
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}
