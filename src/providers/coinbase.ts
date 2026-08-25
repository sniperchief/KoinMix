import { coinbaseMarket, isSupportedQuote, resolveAsset } from "./assets.js";
import { ProviderError, parsePositivePrice, parseTimestamp } from "./errors.js";
import { fetchJson, normaliseBaseUrl } from "./http.js";
import type {
  PriceProvider,
  PriceQuery,
  PriceQuote,
  ProviderDeps,
} from "./types.js";

/**
 * Coinbase Exchange —
 * https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductticker
 *
 * Uses the Exchange product ticker rather than the simpler `/v2/prices/spot`
 * endpoint, because only the former returns a `time` field. Coinbase reports
 * that timestamp with nanosecond precision; `Date.parse` truncates to
 * milliseconds, which is the resolution everything downstream uses anyway.
 *
 * Public market data needs no API key. Coinbase quotes real fiat pairs, so
 * unlike Binance there is no stablecoin substitution.
 */
const NAME = "coinbase";
const DEFAULT_BASE_URL = "https://api.exchange.coinbase.com";

interface ProductTickerResponse {
  price?: string | number;
  time?: string;
  message?: string;
}

export function createCoinbaseProvider(deps: ProviderDeps): PriceProvider {
  const baseUrl = normaliseBaseUrl(
    deps.setting("COINBASE_BASE_URL") ?? DEFAULT_BASE_URL,
  );

  return {
    name: NAME,

    isConfigured: () => true,

    supports: (query) =>
      resolveAsset(query.asset) !== undefined && isSupportedQuote(query.quote),

    async fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote> {
      const asset = resolveAsset(query.asset);
      if (!asset) {
        throw new ProviderError(
          NAME,
          "unsupported_asset",
          `no Coinbase base currency mapped for ${query.asset}`,
        );
      }

      const market = coinbaseMarket(asset, query.quote);
      const url = `${baseUrl}/products/${encodeURIComponent(
        market.instrument,
      )}/ticker`;

      const { data, latencyMs } = await fetchJson<ProductTickerResponse>(
        NAME,
        url,
        { signal },
      );

      // Coinbase answers an unknown product with 404 + {"message": "NotFound"},
      // but a defensive check costs nothing if that ever changes.
      if (data.message) {
        throw new ProviderError(
          NAME,
          "malformed",
          `upstream reported: ${data.message}`,
        );
      }

      const price = parsePositivePrice(NAME, data.price, "price");
      const asOf = parseTimestamp(NAME, data.time, "time", "iso");

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
