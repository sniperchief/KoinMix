/**
 * A short-lived cache in front of a price provider.
 *
 * Why this exists: every CRYPTO_PRICE round fans out to every provider, so a
 * demo clicking between assets — or a validator sampling the same pair — drives
 * the keyless tiers straight into rate limiting. CoinGecko's free tier was
 * measured returning HTTP 429 on 16 of 50 evaluation rounds at roughly 10
 * requests/minute, which made rate limiting the single largest source of lost
 * quotes in the miner.
 *
 * ## Why this is not a fabrication vector
 *
 * The rule everywhere else in this codebase is that the miner never invents or
 * restamps market data, and a cache is the obvious place to break that rule by
 * accident. So a cache hit returns the stored `PriceQuote` **verbatim** — the
 * upstream `asOf`, its `timestampProvenance`, the `instrument`, the `latencyMs`
 * of the call that actually happened. Nothing is refreshed to look newer than it
 * is.
 *
 * The consequence is the point: a cached quote keeps *ageing* while it sits
 * here. Downstream, `PRICE_MAX_STALENESS_MS` still discards it once it is too
 * old, and the freshness half-life still discounts its weight as it ages. A
 * cached quote is therefore strictly less influential than a fresh one, with no
 * special-casing anywhere in the consensus engine. This layer changes how often
 * we *ask* upstream; it never changes what we claim about a price.
 *
 * Failures are deliberately not cached. A provider that just errored should be
 * retried on the next round rather than having its outage held open by us — and
 * caching an error would let one bad moment suppress a recovered provider.
 */
import type { PriceProvider, PriceQuery, PriceQuote } from "./types.js";

interface CacheEntry {
  readonly quote: PriceQuote;
  /** Wall-clock ms at which this entry stops being served. */
  readonly expiresAt: number;
}

/** Distinct pairs must not collide; the quote currency is part of the identity. */
function cacheKey(query: PriceQuery): string {
  return `${query.asset}/${query.quote}`;
}

/**
 * Wrap a provider so identical pair lookups inside `ttlMs` reuse the last
 * successful quote.
 *
 * `name`, `isConfigured()` and `supports()` pass straight through, so the
 * wrapper is indistinguishable from the provider it decorates everywhere except
 * in how often `fetchPrice` reaches the network.
 *
 * @param ttlMs How long a quote may be reused. `0` disables caching entirely,
 *   returning the provider untouched rather than wrapping it in a no-op.
 * @param now Injected clock, for deterministic tests.
 */
export function withCache(
  provider: PriceProvider,
  ttlMs: number,
  now: () => number = Date.now,
): PriceProvider {
  if (ttlMs <= 0) return provider;

  const entries = new Map<string, CacheEntry>();

  return {
    name: provider.name,
    isConfigured: () => provider.isConfigured(),
    supports: (query) => provider.supports(query),

    async fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote> {
      const key = cacheKey(query);
      const cached = entries.get(key);
      const at = now();

      if (cached && cached.expiresAt > at) {
        // Verbatim: no restamping of asOf, provenance, or latency.
        return cached.quote;
      }

      const quote = await provider.fetchPrice(query, signal);

      // Only successes reach here — a throw propagates uncached, by design.
      entries.set(key, { quote, expiresAt: now() + ttlMs });

      return quote;
    },
  };
}
