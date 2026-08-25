import { describe, expect, it } from "vitest";
import { reachConsensus } from "../src/consensus/engine.js";
import {
  ConsensusFailedError,
  InsufficientSourcesError,
} from "../src/errors.js";
import { quote } from "./helpers.js";

/**
 * Consensus engine.
 *
 * Quotes here are constructed fixtures — mocked observations used ONLY inside
 * tests, as the brief requires. No production path constructs a price.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const FRESH = "2026-08-24T11:59:30.000Z"; // 30s old
const STALE = "2026-08-24T11:00:00.000Z"; // 1h old

const options = {
  minSources: 1,
  maxDeviationBps: 200,
  maxStalenessMs: 60_000,
  now: NOW,
};

describe("consensus — basic aggregation", () => {
  it("returns the single quote when only one provider answers", () => {
    const result = reachConsensus([quote("alpha", 100, FRESH)], options);
    expect(result.price).toBe(100);
    expect(result.method).toBe("single");
    expect(result.spreadBps).toBe(0);
    expect(result.deviationBps).toBe(0);
  });

  it("returns the exact price when all providers agree identically", () => {
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 100, FRESH),
        quote("delta", 100, FRESH),
      ],
      options,
    );

    expect(result.price).toBe(100);
    expect(result.spreadBps).toBe(0);
    expect(result.excluded).toHaveLength(0);
    expect(result.sourceCount).toBe(4);
  });

  it("takes the middle value for an odd number of quotes", () => {
    const result = reachConsensus(
      [
        quote("alpha", 102, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 101, FRESH),
      ],
      options,
    );
    expect(result.price).toBe(101);
    expect(result.method).toBe("median");
  });

  it("averages the two middle values for an even number of quotes", () => {
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 102, FRESH)],
      options,
    );
    expect(result.price).toBe(101);
  });

  it("is order-independent", () => {
    const quotes = [
      quote("alpha", 102, FRESH),
      quote("bravo", 100, FRESH),
      quote("charlie", 101, FRESH),
    ];
    expect(reachConsensus(quotes, options)).toEqual(
      reachConsensus([...quotes].reverse(), options),
    );
  });

  it("returns sources sorted for deterministic output", () => {
    const result = reachConsensus(
      [
        quote("zulu", 100, FRESH),
        quote("alpha", 100, FRESH),
        quote("mike", 100, FRESH),
      ],
      options,
    );
    expect(result.sources).toEqual(["alpha", "mike", "zulu"]);
  });

  it("scales the price to a 1e8 integer", () => {
    const result = reachConsensus([quote("alpha", 64213.55, FRESH)], options);
    expect(result.priceX1e8).toBe(6_421_355_000_000);
  });

  it("refuses a price too large to scale without precision loss", () => {
    expect(() => reachConsensus([quote("alpha", 1e12, FRESH)], options)).toThrow(
      ConsensusFailedError,
    );
  });
});

describe("consensus — outlier detection", () => {
  it("excludes the brief's canonical bad tick", () => {
    // CMC/CoinGecko/Binance agree near 4521.7; Coinbase is ~663 bps away.
    const result = reachConsensus(
      [
        quote("coinmarketcap", 4521.81, FRESH),
        quote("coingecko", 4521.69, FRESH),
        quote("binance", 4521.7, FRESH),
        quote("coinbase", 4821.76, FRESH),
      ],
      options,
    );

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.provider).toBe("coinbase");
    expect(result.excluded[0]?.reason).toBe("outlier");
    expect(result.excluded[0]?.price).toBe(4821.76);
    expect(result.excluded[0]?.deviationBps).toBeGreaterThan(600);
    expect(result.excluded[0]?.detail).toMatch(/bps/);

    expect(result.sourceCount).toBe(3);
    expect(result.sources).toEqual(["binance", "coingecko", "coinmarketcap"]);
    expect(result.price).toBeCloseTo(4521.7, 2);
  });

  it("handles the brief's 100/101/100/500 example", () => {
    const result = reachConsensus(
      [
        quote("coinmarketcap", 100, FRESH),
        quote("coingecko", 101, FRESH),
        quote("binance", 100, FRESH),
        quote("coinbase", 500, FRESH),
      ],
      options,
    );

    // 500 identified as the outlier.
    expect(result.excluded.map((e) => e.provider)).toEqual(["coinbase"]);
    // Consensus sits in the 100/101 cluster.
    expect(result.price).toBe(100);
    expect(result.sourceCount).toBe(3);
    // Confidence reduced relative to a clean three-source round.
    const clean = reachConsensus(
      [
        quote("coinmarketcap", 100, FRESH),
        quote("coingecko", 101, FRESH),
        quote("binance", 100, FRESH),
      ],
      options,
    );
    expect(result.confidence).toBeLessThan(clean.confidence);
  });

  it("detects an outlier even when the majority agree exactly (MAD = 0)", () => {
    // MAD collapses to zero here; the bps floor is what carries the decision.
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 100, FRESH),
        quote("delta", 500, FRESH),
      ],
      options,
    );

    expect(result.excluded.map((e) => e.provider)).toEqual(["delta"]);
    expect(result.price).toBe(100);
  });

  it("keeps a within-tolerance third source when the other two agree exactly", () => {
    // Regression: MAD is exactly 0 here, so the modified z-score is infinite
    // for the 101. It is only 100 bps out — inside the 200 bps tolerance — so
    // excluding it would discard real information, narrow the reported spread,
    // and perversely raise confidence.
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 101, FRESH),
        quote("charlie", 100, FRESH),
      ],
      options,
    );

    expect(result.excluded).toHaveLength(0);
    expect(result.sourceCount).toBe(3);
    expect(result.spreadBps).toBe(100);
  });

  it("never excludes an observation inside the round's own tolerance", () => {
    // 150 bps out, tolerance 200 → legitimate disagreement, not an anomaly.
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 100, FRESH),
        quote("delta", 101.5, FRESH),
      ],
      options,
    );

    expect(result.excluded).toHaveLength(0);
    expect(result.sourceCount).toBe(4);
  });

  it("does not flag ordinary microstructure noise as an outlier", () => {
    // Real venues disagree by a few bps; that must never be excluded even
    // though a scale-free z-score alone would flag it.
    const result = reachConsensus(
      [
        quote("alpha", 100.0, FRESH),
        quote("bravo", 100.01, FRESH),
        quote("charlie", 100.02, FRESH),
        quote("delta", 100.4, FRESH),
      ],
      options,
    );

    expect(result.excluded).toHaveLength(0);
    expect(result.sourceCount).toBe(4);
  });

  it("does not exclude with only two quotes, where no majority exists", () => {
    // 100 vs 105 is 476 bps; neither can be shown to be the wrong one.
    expect(() =>
      reachConsensus(
        [quote("alpha", 100, FRESH), quote("bravo", 105, FRESH)],
        options,
      ),
    ).toThrow(ConsensusFailedError);
  });

  it("excludes only the anomalous observation, not the provider", () => {
    const withOutlier = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("coinbase", 500, FRESH),
      ],
      options,
    );
    expect(withOutlier.excluded.map((e) => e.provider)).toEqual(["coinbase"]);

    // The same provider is used normally on the next round.
    const nextRound = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("coinbase", 100.01, FRESH),
      ],
      options,
    );
    expect(nextRound.excluded).toHaveLength(0);
    expect(nextRound.sources).toContain("coinbase");
  });

  it("keeps everything rather than excluding down to a single survivor", () => {
    // Two mutually-distant quotes against one: excluding both would leave a
    // lone unverified source, so the spread guard should refuse instead.
    expect(() =>
      reachConsensus(
        [
          quote("alpha", 100, FRESH),
          quote("bravo", 500, FRESH),
          quote("charlie", 900, FRESH),
        ],
        options,
      ),
    ).toThrow(ConsensusFailedError);
  });

  it("records deviation and reason for every exclusion", () => {
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 100, FRESH),
        quote("delta", 200, FRESH),
        quote("echo", 100, STALE),
      ],
      options,
    );

    const reasons = result.excluded.map((e) => e.reason).sort();
    expect(reasons).toEqual(["outlier", "stale"]);
    for (const exclusion of result.excluded) {
      expect(exclusion.provider).toBeTruthy();
      expect(exclusion.price).toBeGreaterThan(0);
      expect(exclusion.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("consensus — spread", () => {
  it("computes peak-to-peak spread relative to the consensus", () => {
    // min 99, max 101, consensus 100 → (101-99)/100 × 10 000 = 200 bps
    const result = reachConsensus(
      [
        quote("alpha", 99, FRESH),
        quote("bravo", 100, FRESH),
        quote("charlie", 101, FRESH),
      ],
      options,
    );
    expect(result.spreadBps).toBe(200);
    // Worst single deviation is 1/100 → 100 bps.
    expect(result.deviationBps).toBe(100);
  });

  it("reports zero spread for identical quotes", () => {
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 100, FRESH)],
      options,
    );
    expect(result.spreadBps).toBe(0);
  });

  it("handles very small spreads without flagging them", () => {
    const result = reachConsensus(
      [
        quote("alpha", 79_710.0, FRESH),
        quote("bravo", 79_711.35, FRESH),
        quote("charlie", 79_708.74, FRESH),
      ],
      options,
    );
    expect(result.spreadBps).toBeLessThanOrEqual(1);
    expect(result.excluded).toHaveLength(0);
  });

  it("refuses when surviving quotes span more than the tolerance", () => {
    expect(() =>
      reachConsensus(
        [quote("alpha", 100, FRESH), quote("bravo", 120, FRESH)],
        options,
      ),
    ).toThrow(ConsensusFailedError);
  });

  it("accepts disagreement inside the tolerance", () => {
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 101, FRESH)],
      options,
    );
    expect(result.spreadBps).toBeLessThanOrEqual(200);
  });
});

describe("consensus — freshness", () => {
  it("discards stale quotes and records which were dropped", () => {
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 5000, STALE)],
      options,
    );
    expect(result.sourceCount).toBe(1);
    expect(result.discardedStale).toEqual(["bravo"]);
    expect(result.excluded[0]?.reason).toBe("stale");
    expect(result.price).toBe(100);
  });

  it("fails when staleness filtering leaves too few quotes", () => {
    expect(() => reachConsensus([quote("alpha", 100, STALE)], options)).toThrow(
      InsufficientSourcesError,
    );
  });

  it("dates the consensus by its oldest contributing observation", () => {
    const older = "2026-08-24T11:59:20.000Z";
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 100, older)],
      options,
    );
    expect(result.asOf).toBe(older);
  });

  it("lowers confidence as the oldest quote ages", () => {
    const recent = reachConsensus(
      [quote("alpha", 100, "2026-08-24T11:59:59.000Z")],
      options,
    );
    const older = reachConsensus([quote("alpha", 100, FRESH)], options);
    expect(older.confidence).toBeLessThan(recent.confidence);
  });
});

describe("consensus — failure modes", () => {
  const four = [
    quote("coinmarketcap", 100, FRESH),
    quote("coingecko", 100.01, FRESH),
    quote("binance", 100.02, FRESH),
    quote("coinbase", 100.03, FRESH),
  ];

  it("4/4 available produces the strongest result", () => {
    const result = reachConsensus(four, options);
    expect(result.sourceCount).toBe(4);
    // Assert the designed behaviour rather than a magic number: four sources
    // earn the top corroboration base, and nothing degrades the score except
    // the fixture's own age.
    expect(result.confidenceBreakdown.base).toBe(0.95);
    expect(result.confidenceBreakdown.outlierFactor).toBe(1);
    expect(result.confidenceBreakdown.failureFactor).toBe(1);
    expect(result.excluded).toHaveLength(0);
  });

  it("3/4 available still serves, with lower confidence", () => {
    const result = reachConsensus(four.slice(0, 3), {
      ...options,
      providerFailureCount: 1,
    });
    expect(result.sourceCount).toBe(3);
    expect(result.confidence).toBeLessThan(reachConsensus(four, options).confidence);
  });

  it("2/4 available still serves, with lower confidence again", () => {
    const three = reachConsensus(four.slice(0, 3), { ...options, providerFailureCount: 1 });
    const two = reachConsensus(four.slice(0, 2), { ...options, providerFailureCount: 2 });
    expect(two.sourceCount).toBe(2);
    expect(two.confidence).toBeLessThan(three.confidence);
  });

  it("1/4 available serves only when minSources allows it", () => {
    const one = reachConsensus(four.slice(0, 1), { ...options, providerFailureCount: 3 });
    expect(one.sourceCount).toBe(1);
    expect(one.method).toBe("single");
    expect(one.confidence).toBeLessThan(0.5);

    expect(() =>
      reachConsensus(four.slice(0, 1), { ...options, minSources: 2 }),
    ).toThrow(InsufficientSourcesError);
  });

  it("0/4 available never invents a price", () => {
    expect(() => reachConsensus([], options)).toThrow(InsufficientSourcesError);
  });

  it("enforces the configured minimum source count", () => {
    expect(() =>
      reachConsensus([quote("alpha", 100, FRESH)], { ...options, minSources: 3 }),
    ).toThrow(InsufficientSourcesError);
  });
});

describe("consensus — reliability indicator", () => {
  it("rises with corroboration", () => {
    const scores = [1, 2, 3, 4].map(
      (n) =>
        reachConsensus(
          Array.from({ length: n }, (_, i) => quote(`p${i}`, 100, FRESH)),
          options,
        ).confidence,
    );

    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  it("never exceeds 1 or drops below 0", () => {
    const result = reachConsensus(
      Array.from({ length: 6 }, (_, i) => quote(`p${i}`, 100, FRESH)),
      options,
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("never asserts certainty even with many agreeing sources", () => {
    const result = reachConsensus(
      Array.from({ length: 8 }, (_, i) => quote(`p${i}`, 100, "2026-08-24T12:00:00.000Z")),
      options,
    );
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it("falls as disagreement widens", () => {
    const tight = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 100, FRESH)],
      options,
    );
    const loose = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 101.5, FRESH)],
      options,
    );
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });

  it("falls when providers failed, without moving the price", () => {
    const clean = reachConsensus([quote("alpha", 100, FRESH)], options);
    const degraded = reachConsensus([quote("alpha", 100, FRESH)], {
      ...options,
      providerFailureCount: 3,
    });

    expect(degraded.price).toBe(clean.price);
    expect(degraded.confidence).toBeLessThan(clean.confidence);
  });

  it("falls when a source cannot have its freshness verified", () => {
    const verified = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 100, FRESH)],
      options,
    );
    const unverified = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 100, FRESH, { timestampProvenance: "response" }),
      ],
      options,
    );
    expect(unverified.confidence).toBeLessThan(verified.confidence);
  });

  it("exposes a breakdown so the score can be audited", () => {
    const result = reachConsensus(
      [quote("alpha", 100, FRESH), quote("bravo", 101, FRESH)],
      options,
    );
    const b = result.confidenceBreakdown;

    expect(b.base).toBe(0.7);
    for (const factor of [
      b.agreementFactor,
      b.freshnessFactor,
      b.outlierFactor,
      b.failureFactor,
      b.provenanceFactor,
    ]) {
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
    expect(b.score).toBe(result.confidence);
  });
});

describe("consensus — provider weighting", () => {
  it("weighs providers equally by default", () => {
    const result = reachConsensus(
      [
        quote("alpha", 100, FRESH),
        quote("bravo", 101, FRESH),
        quote("charlie", 102, FRESH),
      ],
      options,
    );
    expect(result.price).toBe(101);
    expect(result.weighted).toBe(false);
  });

  it("shifts the consensus toward a more heavily weighted provider", () => {
    const quotes = [
      quote("alpha", 100, FRESH),
      quote("bravo", 101, FRESH),
      quote("charlie", 102, FRESH),
    ];

    // Weighting alpha above the combined others pulls the median to its price.
    const result = reachConsensus(quotes, {
      ...options,
      weights: { alpha: 5 },
    });

    expect(result.price).toBe(100);
    expect(result.weighted).toBe(true);
  });

  it("ignores invalid weights rather than zeroing a source", () => {
    const quotes = [
      quote("alpha", 100, FRESH),
      quote("bravo", 101, FRESH),
      quote("charlie", 102, FRESH),
    ];

    const result = reachConsensus(quotes, {
      ...options,
      weights: { alpha: 0, bravo: Number.NaN, charlie: -1 },
    });

    // All fall back to weight 1, so this matches the unweighted median.
    expect(result.price).toBe(101);
  });

  it("reduces to the plain median when all weights are equal", () => {
    const quotes = [
      quote("alpha", 100, FRESH),
      quote("bravo", 102, FRESH),
    ];

    expect(
      reachConsensus(quotes, { ...options, weights: { alpha: 3, bravo: 3 } }).price,
    ).toBe(reachConsensus(quotes, options).price);
  });
});
