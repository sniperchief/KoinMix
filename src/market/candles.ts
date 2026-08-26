/**
 * Historical OHLC candles.
 *
 * NOT part of the Telegraph contract. CRYPTO_PRICE answers "what is the price
 * now"; candles exist so the demo terminal can draw a chart, and the endpoint
 * that serves them is deliberately absent from telegraph/koinmix.yaml. A node
 * only ever proxies the endpoints the YAML declares.
 *
 * The rule from the price path carries over unchanged: **nothing here
 * synthesises a bar.** Every candle is fetched from a real venue with the
 * venue's own timestamps and volumes. If an interval cannot be served by a real
 * source, the caller gets an error and the UI shows an unavailable state —
 * inventing bars to fill a chart would be exactly the fabrication the hackathon
 * rules forbid, and a chart is the easiest place in a product to get away with
 * it unnoticed.
 */
import {
  binanceMarket,
  coinbaseMarket,
  resolveAsset,
  type AssetDefinition,
} from "../providers/assets.js";
import { ProviderError } from "../providers/errors.js";
import { fetchJson, normaliseBaseUrl } from "../providers/http.js";
import type { ProviderDeps } from "../providers/types.js";

/** Chart intervals the terminal offers. */
export const CANDLE_INTERVALS = ["1h", "4h", "1d", "1w", "1M"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

/** One bar. `time` is unix **seconds**, which is what Lightweight Charts wants. */
export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface CandleSeries {
  readonly asset: string;
  readonly quote: string;
  readonly interval: CandleInterval;
  /** Which venue actually answered. Surfaced so the chart can attribute it. */
  readonly source: string;
  readonly instrument: string;
  /** True when the venue priced against a proxy quote, e.g. USDT for USD. */
  readonly isQuoteProxy: boolean;
  readonly candles: readonly Candle[];
}

interface CandleSource {
  readonly name: string;
  supports(interval: CandleInterval): boolean;
  fetch(
    asset: AssetDefinition,
    quote: string,
    interval: CandleInterval,
    limit: number,
    signal: AbortSignal,
  ): Promise<CandleSeries>;
}

const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 1000;

// ── Binance ─────────────────────────────────────────────────────────────────

/**
 * Binance klines. Chosen as the primary source because it serves every interval
 * the terminal offers natively, so no bar ever has to be aggregated client-side.
 *
 * Row shape: [openTime, open, high, low, close, volume, closeTime, ...].
 */
function createBinanceCandles(deps: ProviderDeps): CandleSource {
  const baseUrl = normaliseBaseUrl(
    deps.setting("BINANCE_BASE_URL") ?? "https://api.binance.com",
  );

  return {
    name: "binance",
    supports: () => true,

    async fetch(asset, quote, interval, limit, signal) {
      const market = binanceMarket(asset, quote);
      const url =
        `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(market.instrument)}` +
        `&interval=${interval}&limit=${limit}`;

      const { data } = await fetchJson<unknown[]>("binance", url, { signal });

      if (!Array.isArray(data)) {
        throw new ProviderError("binance", "malformed", "klines was not an array");
      }

      const candles = data.map((row, index) => {
        if (!Array.isArray(row) || row.length < 6) {
          throw new ProviderError(
            "binance",
            "malformed",
            `kline ${index} was not a [time, o, h, l, c, v, ...] tuple`,
          );
        }
        return buildCandle("binance", {
          // Binance reports the bar's open time in milliseconds.
          timeSeconds: Math.floor(Number(row[0]) / 1000),
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5],
        });
      });

      return {
        asset: asset.symbol,
        quote: quote.toUpperCase(),
        interval,
        source: "binance",
        instrument: market.instrument,
        isQuoteProxy: market.isQuoteProxy,
        candles: sortAscending(candles),
      };
    },
  };
}

// ── Coinbase ────────────────────────────────────────────────────────────────

/**
 * Coinbase Exchange candles, used only as a fallback — Binance is geo-blocked
 * in some regions (HTTP 451) and a chart that dies with it would be fragile.
 *
 * Two traps this adapter has to respect. The column order is
 * [time, LOW, HIGH, OPEN, close, volume] — low and high come before open, which
 * is the reverse of every other venue. And only fixed granularities exist, so
 * 4h/1w/1M are simply unsupported here: producing them would mean stitching
 * shorter bars together, and a stitched bar is not what the venue traded.
 */
const COINBASE_GRANULARITY: Partial<Record<CandleInterval, number>> = {
  "1h": 3600,
  "1d": 86_400,
};

function createCoinbaseCandles(deps: ProviderDeps): CandleSource {
  const baseUrl = normaliseBaseUrl(
    deps.setting("COINBASE_BASE_URL") ?? "https://api.exchange.coinbase.com",
  );

  return {
    name: "coinbase",
    supports: (interval) => COINBASE_GRANULARITY[interval] !== undefined,

    async fetch(asset, quote, interval, _limit, signal) {
      const granularity = COINBASE_GRANULARITY[interval];
      if (granularity === undefined) {
        throw new ProviderError(
          "coinbase",
          "unsupported_asset",
          `no granularity for interval ${interval}`,
        );
      }

      const market = coinbaseMarket(asset, quote);
      const url =
        `${baseUrl}/products/${encodeURIComponent(market.instrument)}/candles` +
        `?granularity=${granularity}`;

      const { data } = await fetchJson<unknown[]>("coinbase", url, { signal });

      if (!Array.isArray(data)) {
        throw new ProviderError("coinbase", "malformed", "candles was not an array");
      }

      const candles = data.map((row, index) => {
        if (!Array.isArray(row) || row.length < 6) {
          throw new ProviderError(
            "coinbase",
            "malformed",
            `candle ${index} was not a [time, l, h, o, c, v] tuple`,
          );
        }
        return buildCandle("coinbase", {
          // Already in seconds here, unlike Binance.
          timeSeconds: Number(row[0]),
          low: row[1],
          high: row[2],
          open: row[3],
          close: row[4],
          volume: row[5],
        });
      });

      return {
        asset: asset.symbol,
        quote: quote.toUpperCase(),
        interval,
        source: "coinbase",
        instrument: market.instrument,
        isQuoteProxy: market.isQuoteProxy,
        // Coinbase returns newest-first.
        candles: sortAscending(candles),
      };
    },
  };
}

// ── Shared parsing ──────────────────────────────────────────────────────────

interface RawCandle {
  timeSeconds: number;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
}

/**
 * Parse and validate one bar.
 *
 * Every field is checked rather than coerced, for the same reason the price
 * adapters check theirs: a NaN that reaches the chart renders as a gap or a
 * spike that looks like real market structure.
 */
function buildCandle(source: string, raw: RawCandle): Candle {
  const numbers = {
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
  };

  for (const [field, value] of Object.entries(numbers)) {
    // Volume can legitimately be zero on a quiet bar; prices cannot.
    const valid =
      field === "volume"
        ? Number.isFinite(value) && value >= 0
        : Number.isFinite(value) && value > 0;

    if (!valid) {
      throw new ProviderError(
        source,
        "malformed",
        `candle field "${field}" was not usable (got ${JSON.stringify(value)})`,
      );
    }
  }

  if (!Number.isFinite(raw.timeSeconds) || raw.timeSeconds <= 0) {
    throw new ProviderError(
      source,
      "malformed",
      `candle had an unusable timestamp (${JSON.stringify(raw.timeSeconds)})`,
    );
  }

  return { time: raw.timeSeconds, ...numbers };
}

/** Lightweight Charts requires strictly ascending, de-duplicated times. */
function sortAscending(candles: readonly Candle[]): readonly Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of candles) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface CandleFailure {
  readonly source: string;
  readonly reason: string;
}

export class CandlesUnavailableError extends Error {
  override readonly name = "CandlesUnavailableError";
  readonly failures: readonly CandleFailure[];

  constructor(message: string, failures: readonly CandleFailure[]) {
    super(message);
    this.failures = failures;
  }
}

/**
 * Try each source that can serve the interval, in order, and return the first
 * real series. If none can, throw — the caller turns that into an explicit
 * "unavailable" state rather than a chart drawn from nothing.
 */
export async function fetchCandles(
  deps: ProviderDeps,
  assetSymbol: string,
  quote: string,
  interval: CandleInterval,
  timeoutMs: number,
  limit: number = DEFAULT_LIMIT,
): Promise<CandleSeries> {
  const asset = resolveAsset(assetSymbol);
  if (!asset) {
    throw new CandlesUnavailableError(`unsupported asset "${assetSymbol}"`, []);
  }

  const sources = [createBinanceCandles(deps), createCoinbaseCandles(deps)];
  const failures: CandleFailure[] = [];

  for (const source of sources) {
    if (!source.supports(interval)) {
      failures.push({
        source: source.name,
        reason: `does not serve the ${interval} interval natively`,
      });
      continue;
    }

    try {
      const series = await source.fetch(
        asset,
        quote,
        interval,
        Math.min(limit, MAX_LIMIT),
        AbortSignal.timeout(timeoutMs),
      );

      if (series.candles.length === 0) {
        failures.push({ source: source.name, reason: "returned no candles" });
        continue;
      }

      return series;
    } catch (error) {
      failures.push({
        source: source.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new CandlesUnavailableError(
    `no source could serve ${assetSymbol}/${quote} at ${interval}`,
    failures,
  );
}
