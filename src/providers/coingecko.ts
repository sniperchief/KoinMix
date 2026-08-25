import {
  coingeckoMarket,
  isSupportedQuote,
  resolveAsset,
} from "./assets.js";
import { ProviderError, parsePositivePrice, parseTimestamp } from "./errors.js";
import { fetchJson, normaliseBaseUrl } from "./http.js";
import type {
  PriceProvider,
  PriceQuery,
  PriceQuote,
  ProviderDeps,
} from "./types.js";

/**
 * CoinGecko — https://docs.coingecko.com/reference/simple-price
 *
 * `/simple/price` is used because it returns `last_updated_at`, a genuine
 * upstream observation time. Endpoints that omit a timestamp are unusable here:
 * the staleness checks downstream must not run against a time we invented.
 *
 * Works keyless against the public host. A Demo key raises rate limits; a Pro
 * key additionally requires the Pro host and a different header name.
 */
const NAME = "coingecko";
const PUBLIC_BASE_URL = "https://api.coingecko.com/api/v3";
const PRO_BASE_URL = "https://pro-api.coingecko.com/api/v3";

interface SimplePriceResponse {
  [coinId: string]:
    | { [vsCurrency: string]: number | undefined; last_updated_at?: number }
    | undefined;
}

export function createCoinGeckoProvider(deps: ProviderDeps): PriceProvider {
  const apiKey = deps.secret("COINGECKO_API_KEY");
  const plan = (deps.setting("COINGECKO_API_PLAN") ?? "demo").toLowerCase();
  const isPro = plan === "pro";

  const baseUrl = normaliseBaseUrl(
    deps.setting("COINGECKO_BASE_URL") ?? (isPro ? PRO_BASE_URL : PUBLIC_BASE_URL),
  );

  return {
    name: NAME,

    // The public tier needs no credentials, so this provider is always usable.
    // A Pro plan without a key is a misconfiguration, not a keyless setup.
    isConfigured: () => !isPro || Boolean(apiKey),

    supports: (query) =>
      resolveAsset(query.asset) !== undefined && isSupportedQuote(query.quote),

    async fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote> {
      const asset = resolveAsset(query.asset);
      if (!asset) {
        throw new ProviderError(
          NAME,
          "unsupported_asset",
          `no CoinGecko coin id mapped for ${query.asset}`,
        );
      }

      const market = coingeckoMarket(asset, query.quote);
      const vsCurrency = query.quote.toLowerCase();

      const url =
        `${baseUrl}/simple/price` +
        `?ids=${encodeURIComponent(asset.coingeckoId)}` +
        `&vs_currencies=${encodeURIComponent(vsCurrency)}` +
        `&include_last_updated_at=true`;

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers[isPro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = apiKey;
      }

      const { data, latencyMs } = await fetchJson<SimplePriceResponse>(
        NAME,
        url,
        { signal, headers },
      );

      const entry = data[asset.coingeckoId];
      if (!entry || typeof entry !== "object") {
        throw new ProviderError(
          NAME,
          "malformed",
          `response contained no entry for coin id "${asset.coingeckoId}"`,
        );
      }

      const price = parsePositivePrice(NAME, entry[vsCurrency], vsCurrency);
      const asOf = parseTimestamp(
        NAME,
        entry.last_updated_at,
        "last_updated_at",
        "seconds",
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
