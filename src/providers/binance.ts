import { binanceMarket, isSupportedQuote, resolveAsset } from "./assets.js";
import { ProviderError, parsePositivePrice, parseTimestamp } from "./errors.js";
import { fetchJson, normaliseBaseUrl } from "./http.js";
import type {
  PriceProvider,
  PriceQuery,
  PriceQuote,
  ProviderDeps,
} from "./types.js";

/**
 * Binance — https://developers.binance.com/docs/binance-spot-api-docs
 *
 * Uses `/api/v3/ticker/24hr` rather than the lighter `/ticker/price` because
 * only the former carries `closeTime`. A price without an upstream timestamp
 * cannot be staleness-checked honestly.
 *
 * Public market data needs no API key. `BINANCE_BASE_URL` allows pointing at a
 * regional host (e.g. Binance.US) where api.binance.com is geo-restricted —
 * that endpoint returns HTTP 451, which surfaces as an explicit provider
 * failure rather than a silent gap.
 */
const NAME = "binance";
const DEFAULT_BASE_URL = "https://api.binance.com";

interface Ticker24hrResponse {
  symbol?: string;
  lastPrice?: string | number;
  closeTime?: number;
}

export function createBinanceProvider(deps: ProviderDeps): PriceProvider {
  const baseUrl = normaliseBaseUrl(
    deps.setting("BINANCE_BASE_URL") ?? DEFAULT_BASE_URL,
  );

  return {
    name: NAME,

    // Public endpoints require no credentials.
    isConfigured: () => true,

    supports: (query) =>
      resolveAsset(query.asset) !== undefined && isSupportedQuote(query.quote),

    async fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote> {
      const asset = resolveAsset(query.asset);
      if (!asset) {
        throw new ProviderError(
          NAME,
          "unsupported_asset",
          `no Binance base asset mapped for ${query.asset}`,
        );
      }

      const market = binanceMarket(asset, query.quote);
      const url = `${baseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(
        market.instrument,
      )}`;

      const { data, latencyMs } = await fetchJson<Ticker24hrResponse>(
        NAME,
        url,
        { signal },
      );

      if (data.symbol !== market.instrument) {
        throw new ProviderError(
          NAME,
          "malformed",
          `expected symbol "${market.instrument}" but got "${String(data.symbol)}"`,
        );
      }

      const price = parsePositivePrice(NAME, data.lastPrice, "lastPrice");
      const asOf = parseTimestamp(
        NAME,
        data.closeTime,
        "closeTime",
        "milliseconds",
      );

      return {
        provider: NAME,
        asset: query.asset,
        quote: query.quote,
        price,
        asOf,
        receivedAt: new Date().toISOString(),
        timestampProvenance: "observed",
        latencyMs,
        instrument: market.instrument,
        isQuoteProxy: market.isQuoteProxy,
      };
    },
  };
}
