/**
 * The evaluation reference source.
 *
 * Scoring a price needs something to score against, and the honest problem is
 * that **no ground truth for "the price of ETH" exists**. There is no canonical
 * price, only what individual venues last traded at. So the reference here is
 * chosen for one property that can actually be defended:
 *
 *   It is NOT one of KoinMix's providers.
 *
 * That is what makes the comparison fair. Scoring KoinMix's consensus against
 * the median of its own inputs would be circular — consensus sits at the middle
 * of its inputs by construction and would "win" on arithmetic rather than on
 * merit. A held-out venue scores every column, single providers and consensus
 * alike, from the outside.
 *
 * Kraken is used because it satisfies that plus three practical requirements:
 * real fiat USD spot markets (not a stablecoin proxy), a keyless public API,
 * and — via `/0/public/Trades` rather than `/0/public/Ticker` — a genuine trade
 * timestamp. The last point matters for the same reason it does in `src/`: a
 * reference whose age we cannot see could be arbitrarily stale, and would make
 * every provider look wrong in a way that is really the reference's fault.
 *
 * See `REFERENCE_CAVEAT` for what the resulting numbers may and may not be
 * claimed to show.
 */
import {
  ProviderError,
  parsePositivePrice,
  parseTimestamp,
} from "../../src/providers/errors.js";
import { fetchJson, normaliseBaseUrl } from "../../src/providers/http.js";

export const REFERENCE_SOURCE = "kraken";

/**
 * Printed with every report. The evaluation is worth nothing if its limits are
 * not stated alongside its numbers.
 */
export const REFERENCE_CAVEAT = [
  "Kraken is an independent USD spot venue and is NOT one of KoinMix's four",
  "providers — that is the only reason it can score every column fairly. It is a",
  "reference, not ground truth. No venue publishes 'the' price of an asset, only",
  "the price of its own last trade, so every figure below is a distance from one",
  "real venue's last execution. A source structurally similar to Kraken (a USD",
  "spot exchange reporting last trade) will sit closer to it by construction, not",
  "by being more correct — read the table with that in mind.",
].join("\n  ");

const DEFAULT_BASE_URL = "https://api.kraken.com";

/** Quote currencies for which Kraken lists fiat spot markets for our assets. */
const SUPPORTED_QUOTES: readonly string[] = ["USD", "EUR"];

export interface ReferenceObservation {
  readonly source: string;
  /** Kraken market queried, e.g. `XBTUSD`. */
  readonly instrument: string;
  readonly price: number;
  /** Time of the trade itself, reported by Kraken. Never synthesised. */
  readonly asOf: string;
  readonly receivedAt: string;
  readonly latencyMs: number;
  /** How old the reference trade was when we captured it. */
  readonly ageMs: number;
}

/** Kraken calls Bitcoin XBT; everything else uses the plain ticker. */
export function referenceInstrument(asset: string, quote: string): string {
  const base = asset.toUpperCase() === "BTC" ? "XBT" : asset.toUpperCase();
  return `${base}${quote.toUpperCase()}`;
}

export function referenceSupportsQuote(quote: string): boolean {
  return SUPPORTED_QUOTES.includes(quote.toUpperCase());
}

interface KrakenEnvelope {
  readonly error?: readonly string[];
  readonly result?: Readonly<Record<string, unknown>>;
}

/**
 * Fetch the most recent trade on Kraken for the given market.
 *
 * `/0/public/Trades?count=1` is used over `/0/public/Ticker` because the ticker
 * reports the last trade price with no time attached, and the whole point of a
 * reference is knowing how fresh it is.
 */
export async function fetchReference(
  asset: string,
  quote: string,
  signal: AbortSignal,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<ReferenceObservation> {
  const pair = referenceInstrument(asset, quote);
  const url =
    `${normaliseBaseUrl(baseUrl)}/0/public/Trades` +
    `?pair=${encodeURIComponent(pair)}&count=1`;

  const { data, latencyMs } = await fetchJson<KrakenEnvelope>(
    REFERENCE_SOURCE,
    url,
    { signal },
  );

  // Kraken reports unknown pairs and rate limits inside a 200 body, so the
  // status check in fetchJson is not sufficient on its own.
  if (Array.isArray(data.error) && data.error.length > 0) {
    throw new ProviderError(
      REFERENCE_SOURCE,
      "http",
      `upstream reported: ${data.error.join("; ")}`,
    );
  }

  const trade = latestTrade(data.result, pair);

  const price = parsePositivePrice(REFERENCE_SOURCE, trade[0], "trade.price");
  const asOf = parseTimestamp(
    REFERENCE_SOURCE,
    trade[2],
    "trade.time",
    "seconds",
  );

  const receivedAt = new Date();

  return {
    source: REFERENCE_SOURCE,
    instrument: pair,
    price,
    asOf,
    receivedAt: receivedAt.toISOString(),
    latencyMs,
    ageMs: Math.max(0, receivedAt.getTime() - Date.parse(asOf)),
  };
}

/**
 * Pull the trade series out of Kraken's response.
 *
 * The result is keyed by Kraken's *canonical* pair name, which is not the name
 * you queried with (`XBTUSD` comes back as `XXBTZUSD`), so the series is located
 * by shape rather than by key — alongside a `last` cursor that is a string.
 */
function latestTrade(
  result: Readonly<Record<string, unknown>> | undefined,
  pair: string,
): readonly unknown[] {
  if (!result || typeof result !== "object") {
    throw new ProviderError(
      REFERENCE_SOURCE,
      "malformed",
      `response contained no result object for ${pair}`,
    );
  }

  const series = Object.entries(result).find(
    ([key, value]) => key !== "last" && Array.isArray(value),
  )?.[1] as readonly unknown[] | undefined;

  if (!series || series.length === 0) {
    throw new ProviderError(
      REFERENCE_SOURCE,
      "malformed",
      `response contained no trades for ${pair}`,
    );
  }

  // Kraken returns trades oldest-first; the most recent one is the last entry.
  const trade = series[series.length - 1];

  if (!Array.isArray(trade) || trade.length < 3) {
    throw new ProviderError(
      REFERENCE_SOURCE,
      "malformed",
      `trade entry for ${pair} was not a [price, volume, time, ...] tuple`,
    );
  }

  return trade;
}
