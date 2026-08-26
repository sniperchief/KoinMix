import { describe, expect, it } from "vitest";
import {
  aggregationSeries,
  marketContext,
  pipelineEffect,
  providerSeries,
  reliability,
  scorableSamples,
  sweepOutlierFloor,
  type EvaluationSettings,
  type SampleRecord,
} from "../scripts/evaluation/metrics.js";
import type { ReferenceObservation } from "../scripts/evaluation/reference.js";
import type { ProviderFailure } from "../src/providers/collect.js";
import { quote } from "./helpers.js";

/**
 * Scoring arithmetic for the evaluation harness.
 *
 * The harness itself only makes sense if its maths is right — a report that
 * mis-computes an error is worse than no report, because it looks authoritative.
 * The fixtures here are constructed inputs to pure functions and, as everywhere
 * else in this suite, never touch a production code path or a live API.
 */

const AT = "2026-08-25T12:00:00.000Z";
const FRESH = "2026-08-25T11:59:55.000Z";

const settings: EvaluationSettings = {
  minSources: 1,
  maxDeviationBps: 200,
  maxStalenessMs: 300_000,
  outlierZThreshold: 3.5,
  outlierMinDeviationBps: 200,
  weights: {},
  // Uniform, so the scoring assertions below isolate the metric arithmetic
  // rather than also exercising the weighting scheme.
  freshnessHalfLifeMs: 0,
  unverifiedFreshnessWeight: 1,
};

function reference(price: number, ageMs = 1000): ReferenceObservation {
  return {
    source: "kraken",
    instrument: "XBTUSD",
    price,
    asOf: new Date(Date.parse(AT) - ageMs).toISOString(),
    receivedAt: AT,
    latencyMs: 200,
    ageMs,
  };
}

function sample(
  index: number,
  prices: Readonly<Record<string, number>>,
  overrides: Partial<SampleRecord> = {},
): SampleRecord {
  const quotes = Object.entries(prices).map(([provider, price]) =>
    quote(provider, price, FRESH),
  );

  return {
    index,
    capturedAt: AT,
    evaluatedAt: AT,
    roundMs: 500,
    quotes,
    failures: [],
    skipped: [],
    reference: reference(100),
    referenceFailure: null,
    consensus: {
      price: 100,
      method: "median",
      sourceCount: quotes.length,
      sources: Object.keys(prices).sort(),
      spreadBps: 0,
      deviationBps: 0,
      confidence: 0.9,
      isStale: false,
      excluded: [],
    },
    consensusFailure: null,
    ...overrides,
  };
}

describe("evaluation — scorable rounds", () => {
  it("drops rounds with no reference", () => {
    const samples = [
      sample(0, { alpha: 100 }),
      sample(1, { alpha: 100 }, { reference: null, referenceFailure: "429" }),
    ];
    expect(scorableSamples(samples, settings)).toHaveLength(1);
  });

  it("drops rounds whose reference is older than the staleness bound", () => {
    const samples = [
      sample(0, { alpha: 100 }),
      sample(1, { alpha: 100 }, { reference: reference(100, 600_000) }),
    ];
    expect(scorableSamples(samples, settings)).toHaveLength(1);
  });
});

describe("evaluation — provider accuracy", () => {
  it("measures each provider's distance from the reference in bps", () => {
    // Reference 100. alpha is 50 bps high in one round and 100 bps high in the
    // next, so its mean is 75 bps and its worst round is 100 bps.
    const samples = [
      sample(0, { alpha: 100.5, bravo: 100 }),
      sample(1, { alpha: 101, bravo: 100 }),
    ];

    const [alpha, bravo] = providerSeries(samples, settings);

    expect(alpha?.label).toBe("alpha");
    expect(alpha?.meanBps).toBeCloseTo(75, 6);
    expect(alpha?.maxBps).toBeCloseTo(100, 6);
    expect(alpha?.meanAbs).toBeCloseTo(0.75, 6);

    expect(bravo?.meanBps).toBe(0);
    expect(bravo?.maxBps).toBe(0);
  });

  it("scores a provider only on the rounds it answered, counting the rest as failures", () => {
    const failure: ProviderFailure = {
      provider: "bravo",
      kind: "timeout",
      reason: "timed out after 5000ms",
      latencyMs: 5000,
    };

    const samples = [
      sample(0, { alpha: 100, bravo: 100 }),
      sample(1, { alpha: 100 }, { failures: [failure] }),
    ];

    const bravo = providerSeries(samples, settings).find(
      (s) => s.label === "bravo",
    );

    // One answered round, one failure — the outage must not masquerade as
    // accuracy, in either direction.
    expect(bravo?.scored).toBe(1);
    expect(bravo?.failures).toBe(1);
    expect(bravo?.meanBps).toBe(0);
  });

  it("flags a provider that priced against a proxy quote", () => {
    const samples = [
      sample(0, { alpha: 100 }, {
        quotes: [quote("alpha", 100, FRESH, { isQuoteProxy: true })],
      }),
    ];
    expect(providerSeries(samples, settings)[0]?.quoteProxy).toBe(true);
  });
});

describe("evaluation — aggregation comparison", () => {
  it("scores consensus and the naive baselines over the same quote set", () => {
    // Quotes 100, 100, 130 against a reference of 100:
    //   plain median = 100     → 0 bps
    //   plain mean   = 110     → 1000 bps
    // and consensus is recorded as 100, having excluded the outlier.
    const samples = [sample(0, { alpha: 100, bravo: 100, charlie: 130 })];

    const series = aggregationSeries(samples, settings);
    const koinmix = series.find((s) => s.kind === "koinmix");
    const median = series.find((s) => s.label.includes("median"));
    const mean = series.find((s) => s.label.includes("mean"));

    expect(koinmix?.meanBps).toBe(0);
    expect(median?.meanBps).toBe(0);
    expect(mean?.meanBps).toBeCloseTo(1000, 6);
  });
});

describe("evaluation — pipeline attribution", () => {
  it("reports no change when consensus equals the plain median", () => {
    const samples = [sample(0, { alpha: 100, bravo: 100, charlie: 100 })];
    const effect = pipelineEffect(samples);

    expect(effect.roundsChanged).toBe(0);
    expect(effect.roundsCompared).toBe(1);
    expect(effect.meanShiftBps).toBe(0);
  });

  it("measures the shift when exclusions moved the price", () => {
    // Plain median of [100, 100, 130] is 100; consensus landed on 101.
    const samples = [
      sample(0, { alpha: 100, bravo: 100, charlie: 130 }, {
        consensus: {
          price: 101,
          method: "median",
          sourceCount: 2,
          sources: ["alpha", "bravo"],
          spreadBps: 0,
          deviationBps: 0,
          confidence: 0.8,
          isStale: false,
          excluded: [
            {
              provider: "charlie",
              price: 130,
              deviationBps: 3000,
              reason: "outlier",
              detail: "test fixture",
            },
          ],
        },
      }),
    ];

    const effect = pipelineEffect(samples);
    expect(effect.roundsChanged).toBe(1);
    expect(effect.meanShiftBps).toBeCloseTo(100, 6);
    expect(effect.outlierExclusions).toBe(1);
    expect(effect.staleExclusions).toBe(0);
  });
});

describe("evaluation — outlier floor sweep", () => {
  it("shows the floor deciding whether an anomalous quote is dropped", () => {
    const samples = [
      sample(0, { alpha: 100, bravo: 100.2, charlie: 100.1, delta: 130 }),
    ];

    const [low, high] = sweepOutlierFloor(samples, settings, [200, 5000]);

    // At a 200 bps floor the 130 print is ~2980 bps out and is excluded, so the
    // median of the survivors (100.1) sits 10 bps from the reference.
    expect(low?.exclusions).toBe(1);
    expect(low?.meanBps).toBeCloseTo(10, 6);

    // Raise the floor past that deviation and nothing can be excluded: the
    // outlier drags the median to 100.15, i.e. 15 bps out.
    expect(high?.exclusions).toBe(0);
    expect(high?.meanBps).toBeCloseTo(15, 6);
  });

  it("marks the configured floor as current", () => {
    const rows = sweepOutlierFloor(samples3(), settings, [50, 200]);
    expect(rows.find((r) => r.floorBps === 200)?.isCurrent).toBe(true);
    expect(rows.find((r) => r.floorBps === 50)?.isCurrent).toBe(false);
  });
});

describe("evaluation — reliability and market context", () => {
  it("counts failures, refused rounds and single-source rounds", () => {
    const failure: ProviderFailure = {
      provider: "alpha",
      kind: "http",
      reason: "429",
      status: 429,
      latencyMs: 80,
    };

    const samples = [
      sample(0, { alpha: 100, bravo: 100 }),
      sample(1, { bravo: 100 }, { failures: [failure] }),
      sample(2, {}, {
        quotes: [],
        consensus: null,
        consensusFailure: { code: "PROVIDER_UNAVAILABLE", message: "all down" },
      }),
    ];

    const stats = reliability(samples, settings);
    expect(stats.rounds).toBe(3);
    expect(stats.totalFailures).toBe(1);
    expect(stats.roundsFailed).toBe(1);
    expect(stats.singleSourceRounds).toBe(1);
    expect(stats.failuresByProvider).toEqual([["alpha", 1]]);
  });

  it("summarises how far the market moved during the window", () => {
    const samples = [
      sample(0, { alpha: 100 }, { reference: reference(100) }),
      sample(1, { alpha: 100 }, { reference: reference(101) }),
      sample(2, { alpha: 100 }, { reference: reference(100) }),
    ];

    const market = marketContext(samples);
    expect(market?.low).toBe(100);
    expect(market?.high).toBe(101);
    expect(market?.rangeBps).toBeCloseTo(100, 6);
    // Moves of 100 bps up then ~99 bps back down.
    expect(market?.meanMoveBps).toBeGreaterThan(99);
    expect(market?.meanMoveBps).toBeLessThan(101);
  });

  it("returns no context from a single observation", () => {
    expect(marketContext([sample(0, { alpha: 100 })])).toBeNull();
  });
});

function samples3(): readonly SampleRecord[] {
  return [sample(0, { alpha: 100, bravo: 100.1, charlie: 100.2 })];
}
