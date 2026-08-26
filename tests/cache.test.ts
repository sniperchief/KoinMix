import { describe, expect, it } from "vitest";
import { withCache } from "../src/providers/cache.js";
import type {
  PriceProvider,
  PriceQuery,
  PriceQuote,
} from "../src/providers/types.js";
import { quote } from "./helpers.js";

/**
 * The provider cache.
 *
 * Two things are being pinned here, and the second matters more than the first.
 * One: that the cache actually spares the upstream a call, which is the whole
 * reason it exists. Two: that a cache hit is *indistinguishable from the
 * original observation* — same `asOf`, same provenance — so a cached quote goes
 * on ageing and gets discounted by the staleness bound and the freshness
 * half-life exactly as an equally-old fresh quote would. If a hit were ever
 * restamped to look current, the cache would become a way to present stale data
 * as live, which is precisely what the rest of this miner refuses to do.
 */

/** A provider that counts how many times it was actually reached. */
function countingProvider(
  result: PriceQuote | Error = quote("alpha", 100, "2026-08-24T11:59:30.000Z"),
): PriceProvider & { calls: () => number } {
  let calls = 0;
  return {
    name: "alpha",
    calls: () => calls,
    isConfigured: () => true,
    supports: () => true,
    fetchPrice: async (_query: PriceQuery) => {
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const SIGNAL = new AbortController().signal;
const BTC: PriceQuery = { asset: "BTC", quote: "USD" };

/** A controllable clock, so no test depends on real elapsed time. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("provider cache — reuse", () => {
  it("serves a second lookup of the same pair without touching the provider", async () => {
    const provider = countingProvider();
    const time = clock();
    const cached = withCache(provider, 3000, time.now);

    await cached.fetchPrice(BTC, SIGNAL);
    await cached.fetchPrice(BTC, SIGNAL);

    expect(provider.calls()).toBe(1);
  });

  it("asks the provider again once the entry expires", async () => {
    const provider = countingProvider();
    const time = clock();
    const cached = withCache(provider, 3000, time.now);

    await cached.fetchPrice(BTC, SIGNAL);
    time.advance(3001);
    await cached.fetchPrice(BTC, SIGNAL);

    expect(provider.calls()).toBe(2);
  });

  it("expires exactly at the TTL, so an entry never outlives its stated life", async () => {
    const provider = countingProvider();
    const time = clock();
    const cached = withCache(provider, 3000, time.now);

    await cached.fetchPrice(BTC, SIGNAL);

    // One tick short of the TTL the entry is still good...
    time.advance(2999);
    await cached.fetchPrice(BTC, SIGNAL);
    expect(provider.calls()).toBe(1);

    // ...and at the TTL itself it is not. An entry is valid while its age is
    // strictly under the TTL, so "3s cache" never serves anything older than 3s.
    time.advance(1);
    await cached.fetchPrice(BTC, SIGNAL);
    expect(provider.calls()).toBe(2);
  });

  it("keys on the quote currency, so BTC/USD and BTC/EUR never collide", async () => {
    const provider = countingProvider();
    const time = clock();
    const cached = withCache(provider, 3000, time.now);

    await cached.fetchPrice({ asset: "BTC", quote: "USD" }, SIGNAL);
    await cached.fetchPrice({ asset: "BTC", quote: "EUR" }, SIGNAL);
    await cached.fetchPrice({ asset: "ETH", quote: "USD" }, SIGNAL);

    expect(provider.calls()).toBe(3);
  });
});

describe("provider cache — a hit must not look fresher than it is", () => {
  it("returns the observation verbatim, restamping nothing", async () => {
    const original = quote("alpha", 100, "2026-08-24T11:59:30.000Z", {
      timestampProvenance: "observed",
      latencyMs: 412,
      instrument: "BTC-USD",
    });
    const time = clock();
    const cached = withCache(countingProvider(original), 3000, time.now);

    const first = await cached.fetchPrice(BTC, SIGNAL);
    time.advance(2500);
    const hit = await cached.fetchPrice(BTC, SIGNAL);

    // Identical in every field: the age of this observation is 2.5s greater
    // than it was, and the quote says so by not having changed.
    expect(hit).toEqual(first);
    expect(hit.asOf).toBe("2026-08-24T11:59:30.000Z");
    expect(hit.timestampProvenance).toBe("observed");
    expect(hit.latencyMs).toBe(412);
  });
});

describe("provider cache — failures stay live", () => {
  it("does not cache a throw, so a recovered provider is retried at once", async () => {
    const provider = countingProvider(new Error("upstream 429"));
    const time = clock();
    const cached = withCache(provider, 3000, time.now);

    await expect(cached.fetchPrice(BTC, SIGNAL)).rejects.toThrow("upstream 429");
    await expect(cached.fetchPrice(BTC, SIGNAL)).rejects.toThrow("upstream 429");

    // Both attempts reached the provider: an outage is never held open by us.
    expect(provider.calls()).toBe(2);
  });
});

describe("provider cache — transparency of the wrapper", () => {
  it("returns the provider untouched when caching is disabled", () => {
    const provider = countingProvider();
    expect(withCache(provider, 0)).toBe(provider);
  });

  it("passes name, isConfigured and supports straight through", () => {
    const provider: PriceProvider = {
      name: "alpha",
      isConfigured: () => false,
      supports: (q) => q.asset === "BTC",
      fetchPrice: async () => quote("alpha", 100, "2026-08-24T11:59:30.000Z"),
    };
    const cached = withCache(provider, 3000);

    expect(cached.name).toBe("alpha");
    expect(cached.isConfigured()).toBe(false);
    expect(cached.supports({ asset: "BTC", quote: "USD" })).toBe(true);
    expect(cached.supports({ asset: "DOGE", quote: "USD" })).toBe(false);
  });
});
