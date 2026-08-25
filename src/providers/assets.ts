/**
 * Asset resolution.
 *
 * The Telegraph CRYPTO_PRICE input contract carries a plain ticker symbol
 * (`asset: "BTC"`) and a quote code (`quote: "USD"`) — see
 * src/telegraph/schema.ts. Providers do not agree on how to name that asset:
 * CoinGecko wants a slug (`bitcoin`), CoinMarketCap wants the symbol (`BTC`),
 * Binance wants a concatenated market pair (`BTCUSDT`), and Coinbase wants a
 * dashed product id (`BTC-USD`).
 *
 * This module is the single place that translation happens, so adding an asset
 * is a one-line table edit rather than a change to four adapters.
 */

export interface AssetDefinition {
  /** Canonical uppercase ticker, as it arrives from Telegraph. */
  readonly symbol: string;
  readonly name: string;
  /** CoinGecko coin id (their `/coins/list` slug). */
  readonly coingeckoId: string;
  /** CoinMarketCap ticker symbol, used by the keyed Pro endpoint. */
  readonly coinmarketcapSymbol: string;
  /**
   * CoinMarketCap numeric coin id. The keyless public endpoint accepts only
   * `ids` — passing `symbol` there is a 400.
   */
  readonly coinmarketcapId: number;
  /** Binance base asset, combined with a quote asset to form a market pair. */
  readonly binanceBase: string;
  /** Coinbase base currency, combined with a quote to form a product id. */
  readonly coinbaseBase: string;
}

/**
 * Supported assets. Phase 2 requires BTC and ETH; the remaining majors are
 * included because they cost one line each and are unambiguous across all four
 * providers. Anything not listed is explicitly unsupported rather than guessed.
 */
const ASSETS: Readonly<Record<string, AssetDefinition>> = Object.freeze({
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    coingeckoId: "bitcoin",
    coinmarketcapSymbol: "BTC",
    coinmarketcapId: 1,
    binanceBase: "BTC",
    coinbaseBase: "BTC",
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    coingeckoId: "ethereum",
    coinmarketcapSymbol: "ETH",
    coinmarketcapId: 1027,
    binanceBase: "ETH",
    coinbaseBase: "ETH",
  },
  SOL: {
    symbol: "SOL",
    name: "Solana",
    coingeckoId: "solana",
    coinmarketcapSymbol: "SOL",
    coinmarketcapId: 5426,
    binanceBase: "SOL",
    coinbaseBase: "SOL",
  },
  XRP: {
    symbol: "XRP",
    name: "XRP",
    coingeckoId: "ripple",
    coinmarketcapSymbol: "XRP",
    coinmarketcapId: 52,
    binanceBase: "XRP",
    coinbaseBase: "XRP",
  },
});

/** Fiat/stablecoin quote codes this miner will attempt. */
const SUPPORTED_QUOTES: readonly string[] = Object.freeze([
  "USD",
  "EUR",
  "GBP",
  "USDT",
]);

/**
 * Binance's global venue lists no fiat-USD spot market for these assets — the
 * deep book is against USDT. We therefore price BTC/USD via BTCUSDT and record
 * the substitution on the quote (see `ResolvedMarket.isQuoteProxy`).
 *
 * This is a real, disclosed approximation: USDT tracks USD closely but is not
 * identical, so the substitution is surfaced rather than hidden. The Phase 1
 * consensus engine's deviation guard is what catches a genuine depeg.
 */
const BINANCE_QUOTE_PROXIES: Readonly<Record<string, string>> = Object.freeze({
  USD: "USDT",
});

export interface ResolvedMarket {
  /** Provider-native identifier for the market or coin. */
  readonly instrument: string;
  /** Quote asset actually traded, which may be a proxy for the request. */
  readonly effectiveQuote: string;
  /** True when `effectiveQuote` differs from the requested quote currency. */
  readonly isQuoteProxy: boolean;
}

export function resolveAsset(symbol: string): AssetDefinition | undefined {
  return ASSETS[symbol.toUpperCase()];
}

export function isSupportedQuote(quote: string): boolean {
  return SUPPORTED_QUOTES.includes(quote.toUpperCase());
}

/** Every asset symbol this miner can price. Used by health output and docs. */
export function supportedAssets(): readonly string[] {
  return Object.keys(ASSETS);
}

// ── Per-provider market construction ────────────────────────────────────────

/** CoinGecko: `/simple/price?ids=bitcoin&vs_currencies=usd`. */
export function coingeckoMarket(
  asset: AssetDefinition,
  quote: string,
): ResolvedMarket {
  return {
    instrument: `${asset.coingeckoId}/${quote.toLowerCase()}`,
    effectiveQuote: quote.toUpperCase(),
    isQuoteProxy: false,
  };
}

/** CoinMarketCap: `?symbol=BTC&convert=USD`. */
export function coinmarketcapMarket(
  asset: AssetDefinition,
  quote: string,
): ResolvedMarket {
  return {
    instrument: `${asset.coinmarketcapSymbol}/${quote.toUpperCase()}`,
    effectiveQuote: quote.toUpperCase(),
    isQuoteProxy: false,
  };
}

/** Binance: concatenated pair, e.g. `BTCUSDT`. */
export function binanceMarket(
  asset: AssetDefinition,
  quote: string,
): ResolvedMarket {
  const requested = quote.toUpperCase();
  const effective = BINANCE_QUOTE_PROXIES[requested] ?? requested;

  return {
    instrument: `${asset.binanceBase}${effective}`,
    effectiveQuote: effective,
    isQuoteProxy: effective !== requested,
  };
}

/** Coinbase Exchange: dashed product id, e.g. `BTC-USD`. */
export function coinbaseMarket(
  asset: AssetDefinition,
  quote: string,
): ResolvedMarket {
  return {
    instrument: `${asset.coinbaseBase}-${quote.toUpperCase()}`,
    effectiveQuote: quote.toUpperCase(),
    isQuoteProxy: false,
  };
}
