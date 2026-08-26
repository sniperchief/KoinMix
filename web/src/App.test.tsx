import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/**
 * Terminal behaviour under each backend outcome.
 *
 * `fetch` is stubbed so every state can be exercised on demand — including the
 * failures a live backend will not produce to order. That is test scaffolding,
 * not runtime data: nothing in `src/` outside these `.test.tsx` files ever
 * constructs a price, and the assertions below check precisely that the UI
 * shows *nothing* where the backend gave it nothing.
 *
 * Lightweight Charts is stubbed because jsdom has no canvas. What is under test
 * here is the terminal's own state handling, not the charting library's
 * rendering.
 */

vi.mock("lightweight-charts", () => {
  const series = { setData: vi.fn(), applyOptions: vi.fn() };
  const chart = {
    addSeries: vi.fn(() => series),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  };
  return {
    createChart: vi.fn(() => chart),
    CandlestickSeries: "Candlestick",
    HistogramSeries: "Histogram",
    ColorType: { Solid: "solid" },
    CrosshairMode: { Normal: 0 },
  };
});

const HEALTH = {
  status: "ok",
  minerSlug: "koinmix-crypto-price",
  subnetId: 9001,
  intent: "crypto_price",
  signalType: "task_completion",
  minPriceUsdc: 0.01,
  providers: {
    enabled: ["coingecko", "coinmarketcap", "binance", "coinbase"],
    active: ["coingecko", "coinmarketcap", "binance", "coinbase"],
    unknown: [],
  },
  assets: ["BTC", "ETH"],
  intervals: ["1h", "4h", "1d"],
  uptimeSeconds: 120,
};

const ROUND = {
  response: {
    intent: "crypto_price",
    asset: "BTC",
    quote: "USD",
    price: "78584.74",
    priceX1e8: 7_858_474_000_000,
    confidence: 0.8395,
    sourceCount: 3,
    sources: ["binance", "coinbase", "coingecko"],
    method: "median",
    deviationBps: 1,
    spreadBps: 3,
    asOf: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    isStale: false,
    minerSlug: "koinmix-crypto-price",
    explanation: "Median price for BTC/USD from 3 live provider quote(s).",
  },
  diagnostics: {
    query: { asset: "BTC", quote: "USD" },
    quotes: [
      {
        provider: "binance",
        price: 78_585.1,
        asOf: new Date().toISOString(),
        ageMs: 900,
        latencyMs: 220,
        instrument: "BTCUSDT",
        isQuoteProxy: true,
        timestampProvenance: "observed",
      },
      {
        provider: "coinbase",
        price: 78_584.2,
        asOf: new Date().toISOString(),
        ageMs: 1800,
        latencyMs: 340,
        instrument: "BTC-USD",
        isQuoteProxy: false,
        timestampProvenance: "observed",
      },
      {
        provider: "coingecko",
        price: 78_570.0,
        asOf: new Date().toISOString(),
        ageMs: 120_000,
        latencyMs: 410,
        instrument: "bitcoin/usd",
        isQuoteProxy: false,
        timestampProvenance: "observed",
      },
    ],
    failures: [
      {
        provider: "coinmarketcap",
        kind: "timeout",
        reason: "timed out after 5000ms",
        latencyMs: 5000,
      },
    ],
    skipped: [],
    excluded: [],
    weights: [
      { provider: "binance", weight: 0.917 },
      { provider: "coinbase", weight: 0.847 },
      { provider: "coingecko", weight: 0.077 },
    ],
    confidenceBreakdown: { score: 0.8395 },
    roundMs: 1370,
  },
};

function candleSeries() {
  const now = Math.floor(Date.now() / 1000);
  const hour = 3600;
  return {
    asset: "BTC",
    quote: "USD",
    interval: "1h",
    source: "binance",
    instrument: "BTCUSDT",
    isQuoteProxy: true,
    candles: Array.from({ length: 30 }, (_, i) => ({
      time: now - (30 - i) * hour,
      open: 78_000 + i,
      high: 78_100 + i,
      low: 77_900 + i,
      close: 78_050 + i,
      volume: 100 + i,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route stubbed responses by URL, the way the real endpoints are split. */
function stubRoutes(handlers: {
  health?: () => Response;
  round?: () => Response;
  candles?: () => Response;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/healthz")) {
        return handlers.health?.() ?? jsonResponse(HEALTH);
      }
      if (url.includes("/v1/price/debug")) {
        return handlers.round?.() ?? jsonResponse(ROUND);
      }
      if (url.includes("/v1/candles")) {
        return handlers.candles?.() ?? jsonResponse(candleSeries());
      }
      return jsonResponse({ error: "unexpected", code: "UNKNOWN" }, 404);
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("terminal — live data", () => {
  it("renders the consensus price and per-source breakdown", async () => {
    stubRoutes({});
    render(<App />);

    // The headline consensus figure, straight from the miner response. It
    // appears twice by design — the header and the source-panel summary — so
    // assert both rather than requiring a single match.
    const shown = await screen.findAllByText("78,584.74");
    expect(shown.length).toBe(2);

    // Every configured provider appears, including the one that failed.
    for (const provider of ["binance", "coinbase", "coingecko", "coinmarketcap"]) {
      expect(await screen.findByText(provider)).toBeTruthy();
    }

    // The failed provider is labelled, not silently dropped.
    expect(await screen.findByText("failed")).toBeTruthy();
  });

  it("shows the miner as live with its provider count", async () => {
    stubRoutes({});
    render(<App />);

    // "live" also labels each healthy provider row, so scope to the unique
    // provider-count text and assert the badge exists among the matches.
    expect(await screen.findByText("4/4 providers")).toBeTruthy();
    expect((await screen.findAllByText("live")).length).toBeGreaterThan(0);
  });

  it("surfaces the stablecoin proxy rather than hiding it", async () => {
    stubRoutes({});
    render(<App />);

    expect(
      await screen.findByText(/priced against a stablecoin proxy/i),
    ).toBeTruthy();
  });
});

describe("terminal — no fabricated values", () => {
  it("shows an unavailable state, not a zero, when the price round fails", async () => {
    stubRoutes({
      round: () =>
        jsonResponse(
          {
            error: "no provider returned a usable BTC/USD price",
            code: "PROVIDER_UNAVAILABLE",
            details: {},
          },
          503,
        ),
    });
    render(<App />);

    expect(await screen.findByText(/No consensus price/i)).toBeTruthy();
    expect(screen.getByText("PROVIDER_UNAVAILABLE")).toBeTruthy();

    // The critical assertion: nothing numeric stands in for the missing price.
    expect(screen.queryByText("0.00")).toBeNull();
    expect(screen.queryByText(/^78,/)).toBeNull();
  });

  it("shows an unavailable chart, not empty candles, when history is missing", async () => {
    stubRoutes({
      candles: () =>
        jsonResponse(
          {
            error: "no source could serve BTC/USD at 1h",
            code: "PROVIDER_UNAVAILABLE",
            details: {
              failures: [{ source: "binance", reason: "upstream returned 451" }],
            },
          },
          503,
        ),
    });
    render(<App />);

    expect(
      await screen.findByText(/Historical data unavailable/i),
    ).toBeTruthy();
    // The per-source reason is surfaced so the gap is explained, not just blank.
    expect(
      await screen.findByText(/binance: upstream returned 451/i),
    ).toBeTruthy();
  });

  it("omits the 24h change when no intraday series is available", async () => {
    stubRoutes({
      candles: () =>
        jsonResponse({ error: "unavailable", code: "PROVIDER_UNAVAILABLE" }, 503),
    });
    render(<App />);

    expect(await screen.findByText(/24h change .* unavailable/i)).toBeTruthy();
  });

  it("reports the miner as unreachable rather than showing stale figures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<App />);

    expect(await screen.findByText(/Miner unreachable/i)).toBeTruthy();
    expect(
      screen.getByText(/No cached or placeholder prices are shown/i),
    ).toBeTruthy();
  });
});

describe("terminal — loading", () => {
  it("renders a loading state before any data arrives", async () => {
    // A fetch that never settles holds the UI in its initial state.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    });

    // No price, no zero, nothing invented while waiting.
    expect(screen.queryByText(/78,584/)).toBeNull();
  });
});

describe("terminal — Telegraph panel", () => {
  it("discloses that the node hop is not live yet", async () => {
    stubRoutes({});
    render(<App />);

    expect(await screen.findByText(/One hop is simulated/i)).toBeTruthy();
    expect(await screen.findByText("not yet live")).toBeTruthy();
  });

  it("renders the full pipeline", async () => {
    stubRoutes({});
    render(<App />);

    for (const stage of [
      "Agent",
      "Telegraph node",
      "CRYPTO_PRICE",
      "KoinMix miner",
      "Consensus",
      "Verified price signal",
    ]) {
      expect(await screen.findByText(stage)).toBeTruthy();
    }
  });
});
