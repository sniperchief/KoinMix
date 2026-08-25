import type { Config } from "../config/env.js";
import type { AppLogger } from "../logging/logger.js";
import { createBinanceProvider } from "./binance.js";
import { createCoinbaseProvider } from "./coinbase.js";
import { createCoinGeckoProvider } from "./coingecko.js";
import { createCoinMarketCapProvider } from "./coinmarketcap.js";
import type { PriceProvider, PriceProviderFactory } from "./types.js";

/**
 * Name-keyed registry of available provider implementations.
 *
 * Every entry hits a real upstream market data API. There are no synthetic or
 * fallback providers: if none of these can answer, the miner reports failure
 * rather than emitting a fabricated price.
 *
 * The names here are what `PRICE_PROVIDERS` accepts.
 */
const PROVIDER_FACTORIES: Readonly<Record<string, PriceProviderFactory>> =
  Object.freeze({
    coingecko: createCoinGeckoProvider,
    coinmarketcap: createCoinMarketCapProvider,
    binance: createBinanceProvider,
    coinbase: createCoinbaseProvider,
  });

/** Provider names known to this build, for error messages and docs. */
export function knownProviderNames(): readonly string[] {
  return Object.keys(PROVIDER_FACTORIES);
}

export interface ProviderRegistry {
  /** Providers that are both enabled in config and fully configured. */
  active(): readonly PriceProvider[];
  /** Names requested via PRICE_PROVIDERS that have no implementation. */
  unknown(): readonly string[];
}

export function createProviderRegistry(
  config: Config,
  logger: AppLogger,
): ProviderRegistry {
  const active: PriceProvider[] = [];
  const unknown: string[] = [];

  for (const name of config.providers.enabled) {
    const factory = PROVIDER_FACTORIES[name];

    if (!factory) {
      unknown.push(name);
      logger.error(
        { provider: name, known: knownProviderNames() },
        "PRICE_PROVIDERS names a provider with no implementation; ignoring",
      );
      continue;
    }

    const provider = factory({
      secret: config.secret,
      setting: config.setting,
    });

    if (!provider.isConfigured()) {
      logger.error(
        { provider: name },
        "provider is enabled but missing credentials; ignoring",
      );
      continue;
    }

    active.push(provider);
    logger.info({ provider: name }, "price provider registered");
  }

  if (active.length === 0) {
    logger.warn(
      { enabled: config.providers.enabled },
      "no live price providers active — CRYPTO_PRICE requests will be refused " +
        "with NO_PROVIDERS_CONFIGURED (expected during Phase 1)",
    );
  }

  return {
    active: () => active,
    unknown: () => unknown,
  };
}
