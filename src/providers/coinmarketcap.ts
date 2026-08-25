import {
  coinmarketcapMarket,
  isSupportedQuote,
  resolveAsset,
  type AssetDefinition,
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
 * CoinMarketCap — https://coinmarketcap.com/api/documentation/v1/
 *
 * Runs in one of two modes depending on whether an API key is present.
 *
 * KEYED (`COINMARKETCAP_API_KEY` set) — `/v2/cryptocurrency/quotes/latest`.
 *   Symbol-based, supports every convert currency, and returns a genuine
 *   per-asset `last_updated` observation time. This is the better mode.
 *
 * KEYLESS — `/public-api/v1/simple/price`.
 *   https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api
 *   No signup, IP rate-pooled. Two hard constraints verified against the live
 *   endpoint, both of which would corrupt output if ignored:
 *
 *   1. It accepts only numeric `ids`; passing `symbol` is a 400.
 *   2. **It silently ignores `convert` and always returns USD.** Requesting
 *      EUR, JPY or GBP returns the USD figure to 14 significant figures with a
 *      success status. This adapter therefore refuses any non-USD quote in
 *      keyless mode rather than mislabelling a USD price.
 *
 *   It also carries no per-asset update time — only `status.timestamp`, which
 *   is when CMC generated the response. That is reported with
 *   `timestampProvenance: "response"` so the weaker guarantee stays visible.
 */
const NAME = "coinmarketcap";
const DEFAULT_BASE_URL = "https://pro-api.coinmarketcap.com";

interface QuoteValue {
  price?: number | string;
  last_updated?: string;
}

interface CoinEntry {
  symbol?: string;
  quote?: Record<string, QuoteValue | undefined>;
}

interface StatusEnvelope {
  // error_code is a number on the keyed API and a string on the keyless one.
  error_code?: number | string;
  error_message?: string | null;
  timestamp?: string;
}

interface QuotesLatestResponse {
  status?: StatusEnvelope;
  // v2 returns an array per symbol; v1 returned a bare object. Both accepted.
  data?: Record<string, CoinEntry | CoinEntry[] | undefined>;
}

interface SimplePriceResponse {
  status?: StatusEnvelope;
  data?: { id?: number; price?: number | string }[];
}

/** CMC reports some failures in a 200 body, so the envelope must be checked. */
function assertEnvelopeOk(status: StatusEnvelope | undefined): void {
  const code = status?.error_code;
  if (code === undefined || code === null) return;
  if (Number(code) === 0) return;

  throw new ProviderError(
    NAME,
    "http",
    `API error ${String(code)}: ${status?.error_message ?? "unknown"}`,
  );
}

export function createCoinMarketCapProvider(deps: ProviderDeps): PriceProvider {
  const apiKey = deps.secret("COINMARKETCAP_API_KEY");
  const baseUrl = normaliseBaseUrl(
    deps.setting("COINMARKETCAP_BASE_URL") ?? DEFAULT_BASE_URL,
  );
  const keyless = !apiKey;

  return {
    name: NAME,

    // Usable either way: the keyless public tier needs no credentials.
    isConfigured: () => true,

    supports: (query) => {
      if (resolveAsset(query.asset) === undefined) return false;
      // Keyless cannot convert, so it can only honestly answer USD.
      if (keyless) return query.quote.toUpperCase() === "USD";
      return isSupportedQuote(query.quote);
    },

    async fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote> {
      const asset = resolveAsset(query.asset);
      if (!asset) {
        throw new ProviderError(
          NAME,
          "unsupported_asset",
          `no CoinMarketCap mapping for ${query.asset}`,
        );
      }

      return keyless
        ? fetchKeyless(baseUrl, asset, query, signal)
        : fetchKeyed(baseUrl, apiKey!, asset, query, signal);
    },
  };
}

/** Keyed Pro API: symbol-based, real observation time, any convert currency. */
async function fetchKeyed(
  baseUrl: string,
  apiKey: string,
  asset: AssetDefinition,
  query: PriceQuery,
  signal: AbortSignal,
): Promise<PriceQuote> {
  const symbol = asset.coinmarketcapSymbol;
  const convert = query.quote.toUpperCase();
  const market = coinmarketcapMarket(asset, query.quote);

  const url =
    `${baseUrl}/v2/cryptocurrency/quotes/latest` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&convert=${encodeURIComponent(convert)}`;

  const { data, latencyMs } = await fetchJson<QuotesLatestResponse>(NAME, url, {
    signal,
    headers: { "X-CMC_PRO_API_KEY": apiKey },
  });

  assertEnvelopeOk(data.status);

  const entry = data.data?.[symbol];
  const coin = Array.isArray(entry) ? entry[0] : entry;
  if (!coin) {
    throw new ProviderError(
      NAME,
      "malformed",
      `response contained no data for symbol "${symbol}"`,
    );
  }

  const quoteValue = coin.quote?.[convert];
  if (!quoteValue) {
    throw new ProviderError(
      NAME,
      "malformed",
      `response contained no "${convert}" conversion for ${symbol}`,
    );
  }

  return {
    provider: NAME,
    asset: query.asset,
    quote: query.quote,
    price: parsePositivePrice(NAME, quoteValue.price, "quote.price"),
    asOf: parseTimestamp(NAME, quoteValue.last_updated, "quote.last_updated", "iso"),
    receivedAt: new Date().toISOString(),
    timestampProvenance: "observed",
    latencyMs,
    instrument: market.instrument,
    isQuoteProxy: market.isQuoteProxy,
  };
}

/** Keyless public API: numeric ids, USD only, response-time timestamp. */
async function fetchKeyless(
  baseUrl: string,
  asset: AssetDefinition,
  query: PriceQuery,
  signal: AbortSignal,
): Promise<PriceQuote> {
  // Guarded in supports(), re-checked here so a direct call cannot bypass it.
  if (query.quote.toUpperCase() !== "USD") {
    throw new ProviderError(
      NAME,
      "unsupported_asset",
      `keyless mode returns USD only (requested ${query.quote}); ` +
        "set COINMARKETCAP_API_KEY for other currencies",
    );
  }

  const id = asset.coinmarketcapId;
  const url = `${baseUrl}/public-api/v1/simple/price?ids=${id}&convert=USD`;

  const { data, latencyMs } = await fetchJson<SimplePriceResponse>(NAME, url, {
    signal,
  });

  assertEnvelopeOk(data.status);

  const entry = data.data?.find((d) => d.id === id);
  if (!entry) {
    throw new ProviderError(
      NAME,
      "malformed",
      `response contained no entry for coin id ${id}`,
    );
  }

  return {
    provider: NAME,
    asset: query.asset,
    quote: "USD",
    price: parsePositivePrice(NAME, entry.price, "price"),
    // Not an observation time — see the note at the top of this file.
    asOf: parseTimestamp(NAME, data.status?.timestamp, "status.timestamp", "iso"),
    receivedAt: new Date().toISOString(),
    timestampProvenance: "response",
    latencyMs,
    instrument: `${asset.coinmarketcapSymbol}/USD`,
    isQuoteProxy: false,
  };
}
