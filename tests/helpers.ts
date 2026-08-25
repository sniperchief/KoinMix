import { loadConfig, type Config } from "../src/config/env.js";
import { pino } from "pino";
import type { AppLogger } from "../src/logging/logger.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import type { PriceProvider, PriceQuote } from "../src/providers/types.js";

/**
 * Test fixtures.
 *
 * The quotes built here are inputs to unit tests of pure aggregation logic —
 * they never reach a production code path. The provider registry ships empty
 * (src/providers/registry.ts) and no fake provider is registered anywhere in
 * `src/`.
 */

export const silentLogger: AppLogger = pino({ level: "silent" });

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...overrides });
}

/** A registry with an explicit provider list, for exercising the adapter. */
export function fixedRegistry(providers: PriceProvider[]): ProviderRegistry {
  return { active: () => providers, unknown: () => [] };
}

export function quote(
  provider: string,
  price: number,
  asOf: string,
  overrides: Partial<PriceQuote> = {},
): PriceQuote {
  return {
    provider,
    asset: "BTC",
    quote: "USD",
    price,
    asOf,
    receivedAt: asOf,
    latencyMs: 100,
    instrument: "BTC-USD",
    isQuoteProxy: false,
    timestampProvenance: "observed",
    ...overrides,
  };
}

/**
 * A provider stub that yields a caller-supplied quote or throws.
 *
 * Used only to exercise orchestration (fan-out, partial failure, aggregation).
 * The real adapters are verified against live APIs by `npm run live:check`.
 */
export function stubProvider(
  name: string,
  result: PriceQuote | Error,
  supports = true,
): PriceProvider {
  return {
    name,
    isConfigured: () => true,
    supports: () => supports,
    fetchPrice: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Env accessors for constructing a provider directly in a test. */
export function providerDeps(
  env: Record<string, string> = {},
): { secret: (n: string) => string | undefined; setting: (n: string) => string | undefined } {
  const isCredential = (n: string) => /_(API_KEY|API_SECRET|TOKEN|PASSWORD)$/.test(n);
  return {
    secret: (n) => (isCredential(n) ? env[n] : undefined),
    setting: (n) => (isCredential(n) ? undefined : env[n]),
  };
}
