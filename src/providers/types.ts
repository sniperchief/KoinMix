/**
 * The price provider abstraction.
 *
 * Nothing in this file — or anywhere else in the application — knows about
 * CoinGecko, CoinMarketCap or any other specific vendor. Concrete adapters are
 * added in Phase 2 and registered by name; the rest of the miner only ever sees
 * this interface.
 */

export interface PriceQuery {
  /** Uppercase base asset symbol, e.g. "BTC". */
  readonly asset: string;
  /** Uppercase quote currency, e.g. "USD". */
  readonly quote: string;
}

/** A single provider's normalised observation of a price. */
export interface PriceQuote {
  /** Provider name, matching `PriceProvider.name`. */
  readonly provider: string;
  readonly asset: string;
  readonly quote: string;
  /** Price of one `asset` denominated in `quote`. Must be finite and > 0. */
  readonly price: number;
  /** Provider-reported timestamp (ISO 8601). Never synthesised by this miner. */
  readonly asOf: string;
  /**
   * What `asOf` actually means for this provider.
   *
   * `observed` — upstream reported when the price itself was last updated
   *   (Binance `closeTime`, Coinbase `time`, CoinGecko `last_updated_at`).
   * `response` — upstream gave only the time it generated the response, which
   *   says nothing about the age of the price behind it. Weaker, and the
   *   staleness check cannot see through it, so it is labelled rather than
   *   quietly treated as an observation time.
   */
  readonly timestampProvenance: "observed" | "response";
  /** When this miner received the quote (ISO 8601). */
  readonly receivedAt: string;
  /** Upstream call duration in milliseconds. */
  readonly latencyMs: number;
  /**
   * The provider-native market this price came from, e.g. `BTCUSDT`,
   * `BTC-USD`, `bitcoin/usd`. Retained for auditability — it is the only way
   * to tell after the fact which venue and pair produced a number.
   */
  readonly instrument: string;
  /**
   * True when the venue priced against a proxy for the requested quote — e.g.
   * Binance settling a USD request against USDT. Surfaced rather than hidden so
   * the approximation is visible downstream.
   */
  readonly isQuoteProxy: boolean;
}

export interface PriceProvider {
  /** Stable lowercase identifier, e.g. "coingecko". Used in config and logs. */
  readonly name: string;

  /**
   * Whether this provider has everything it needs to run (credentials, etc.).
   * Unconfigured providers are skipped rather than allowed to fail per-request.
   */
  isConfigured(): boolean;

  /** Whether this provider can serve the given asset/quote pair. */
  supports(query: PriceQuery): boolean;

  /**
   * Fetch a live price. Implementations MUST hit a real upstream API and MUST
   * throw rather than return a placeholder when data is unavailable.
   *
   * @param signal Aborts when the per-provider timeout elapses.
   */
  fetchPrice(query: PriceQuery, signal: AbortSignal): Promise<PriceQuote>;
}

/**
 * Everything a provider may read from the environment.
 *
 * Split deliberately: `secret` reaches credentials, `setting` reaches
 * non-sensitive knobs such as base URLs. Neither exposes `process.env`, and the
 * env var names themselves live in the provider modules — so the config layer
 * stays free of provider-specific fields.
 */
export interface ProviderDeps {
  secret: (envVarName: string) => string | undefined;
  setting: (envVarName: string) => string | undefined;
}

/** Factory signature for concrete providers, wired up in the registry. */
export type PriceProviderFactory = (deps: ProviderDeps) => PriceProvider;
