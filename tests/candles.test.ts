import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandlesUnavailableError,
  fetchCandles,
  isCandleInterval,
  CANDLE_INTERVALS,
} from "../src/market/candles.js";
import { buildServer } from "../src/http/server.js";
import {
  fixedRegistry,
  providerDeps,
  silentLogger,
  testConfig,
} from "./helpers.js";

/**
 * Candle parsing.
 *
 * `fetch` is stubbed here to feed the parser exact upstream payload shapes —
 * including malformed ones no live API would return on demand. The adapters are
 * exercised against the real venues by the live checks; what these tests pin is
 * the translation, where the bugs are silent: a mis-ordered column or a NaN
 * renders as market structure that never happened.
 */

const deps = providerDeps();

function stubFetch(payload: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: ok ? 200 : 500,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("candles — interval validation", () => {
  it("accepts exactly the advertised intervals", () => {
    for (const interval of CANDLE_INTERVALS) {
      expect(isCandleInterval(interval)).toBe(true);
    }
    for (const bogus of ["5m", "2h", "1y", "", "1H"]) {
      expect(isCandleInterval(bogus)).toBe(false);
    }
  });
});

describe("candles — Binance klines", () => {
  it("maps [openTime, o, h, l, c, v] and converts ms to seconds", async () => {
    stubFetch([
      [1787720400000, "78826.00", "79143.62", "78638.00", "79085.98", "515.23"],
    ]);

    const series = await fetchCandles(deps, "BTC", "USD", "1h", 5000);

    expect(series.source).toBe("binance");
    expect(series.candles).toHaveLength(1);

    const [candle] = series.candles;
    expect(candle?.time).toBe(1_787_720_400); // seconds, not ms
    expect(candle?.open).toBe(78_826);
    expect(candle?.high).toBe(79_143.62);
    expect(candle?.low).toBe(78_638);
    expect(candle?.close).toBe(79_085.98);
    expect(candle?.volume).toBe(515.23);
  });

  it("flags the USDT proxy on a USD request", async () => {
    stubFetch([[1787720400000, "1", "2", "0.5", "1.5", "10"]]);

    const series = await fetchCandles(deps, "BTC", "USD", "1h", 5000);

    // Binance lists no fiat BTC/USD market, so the chart is really BTCUSDT.
    expect(series.instrument).toBe("BTCUSDT");
    expect(series.isQuoteProxy).toBe(true);
  });

  it("returns candles in strictly ascending time order", async () => {
    stubFetch([
      [1787727600000, "3", "3", "3", "3", "1"],
      [1787720400000, "1", "1", "1", "1", "1"],
      [1787724000000, "2", "2", "2", "2", "1"],
    ]);

    const series = await fetchCandles(deps, "BTC", "USD", "1h", 5000);
    const times = series.candles.map((c) => c.time);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe("candles — malformed upstream data is refused, never smoothed over", () => {
  it("rejects a non-numeric price rather than emitting NaN", async () => {
    stubFetch([[1787720400000, "not-a-number", "2", "1", "1.5", "10"]]);

    // Both sources fail (Coinbase gets the same stub), so this surfaces as
    // unavailable — the correct outcome. What must not happen is a NaN bar.
    await expect(fetchCandles(deps, "BTC", "USD", "1h", 5000)).rejects.toThrow(
      CandlesUnavailableError,
    );
  });

  it("rejects a zero or negative price", async () => {
    stubFetch([[1787720400000, "0", "2", "1", "1.5", "10"]]);
    await expect(fetchCandles(deps, "BTC", "USD", "1h", 5000)).rejects.toThrow(
      CandlesUnavailableError,
    );
  });

  it("accepts zero volume, which is legitimate on a quiet bar", async () => {
    stubFetch([[1787720400000, "1", "2", "0.5", "1.5", "0"]]);

    const series = await fetchCandles(deps, "BTC", "USD", "1h", 5000);
    expect(series.candles[0]?.volume).toBe(0);
  });

  it("rejects a truncated row", async () => {
    stubFetch([[1787720400000, "1", "2"]]);
    await expect(fetchCandles(deps, "BTC", "USD", "1h", 5000)).rejects.toThrow(
      CandlesUnavailableError,
    );
  });

  it("reports every source's reason when none can answer", async () => {
    stubFetch({ error: "upstream down" }, false);

    const error = await fetchCandles(deps, "BTC", "USD", "1h", 5000).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CandlesUnavailableError);
    const failures = (error as CandlesUnavailableError).failures;
    expect(failures.map((f) => f.source)).toContain("binance");
    expect(failures.map((f) => f.source)).toContain("coinbase");
  });
});

describe("candles — interval coverage is honest", () => {
  it("records that Coinbase cannot serve 4h natively", async () => {
    // Binance fails, so the only remaining source is Coinbase — which has no
    // 4h granularity. Stitching 1h bars into 4h would be inventing a bar the
    // venue never traded, so the correct answer is that it is unavailable.
    stubFetch({ error: "down" }, false);

    const error = (await fetchCandles(deps, "BTC", "USD", "4h", 5000).catch(
      (e: unknown) => e,
    )) as CandlesUnavailableError;

    const coinbase = error.failures.find((f) => f.source === "coinbase");
    expect(coinbase?.reason).toContain("does not serve the 4h interval");
  });

  it("refuses an unsupported asset without calling any upstream", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(
      fetchCandles(deps, "NOTACOIN", "USD", "1h", 5000),
    ).rejects.toThrow(CandlesUnavailableError);
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * The candles route mirrors the price path's status contract: an asset the
 * miner does not carry is answered 400, not the 503 that a retry loop reads as
 * "come back later". Pinned at the HTTP layer because the status, not the
 * message, is what a client branches on.
 */
describe("candles route — unsupported asset is a client error", () => {
  it("answers 400 with the supported list, not a 503", async () => {
    const app = buildServer(
      testConfig(),
      silentLogger,
      fixedRegistry([]),
    );

    const res = await app.inject({
      method: "GET",
      url: "/v1/candles?asset=NOTACOIN&interval=1h",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; details: { supported: string[] } }>();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.supported).toContain("BTC");

    await app.close();
  });
});
