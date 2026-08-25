import { afterEach, describe, expect, it, vi } from "vitest";
import { createBinanceProvider } from "../src/providers/binance.js";
import { createCoinbaseProvider } from "../src/providers/coinbase.js";
import { createCoinGeckoProvider } from "../src/providers/coingecko.js";
import { createCoinMarketCapProvider } from "../src/providers/coinmarketcap.js";
import { ProviderError } from "../src/providers/errors.js";
import { providerDeps } from "./helpers.js";

/**
 * Adapter normalisation and failure handling.
 *
 * These exercise the parsing/error layer by stubbing `fetch` with payloads
 * shaped like each upstream's documented response. The NUMBERS ARE DELIBERATELY
 * FICTITIOUS (12345.67) so nothing here can be mistaken for market data — the
 * point is field mapping and error classification, not prices.
 *
 * Actual live correctness is verified separately by `npm run live:check`, which
 * hits the real APIs. No production code path ever uses a canned response.
 */

const QUERY = { asset: "BTC", quote: "USD" };
const signal = () => AbortSignal.timeout(5_000);

function stubFetch(body: unknown, init: ResponseInit = { status: 200 }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        ...init,
      }),
    ),
  );
}

function lastUrl(): string {
  const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return String(mock.mock.calls[0]?.[0]);
}

function lastHeaders(): Record<string, string> {
  const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return (mock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
}

afterEach(() => vi.unstubAllGlobals());

describe("CoinGecko adapter", () => {
  it("normalises a documented response", async () => {
    stubFetch({ bitcoin: { usd: 12345.67, last_updated_at: 1787621620 } });

    const quote = await createCoinGeckoProvider(providerDeps()).fetchPrice(
      QUERY,
      signal(),
    );

    expect(quote.provider).toBe("coingecko");
    expect(quote.price).toBe(12345.67);
    expect(quote.asset).toBe("BTC");
    expect(quote.instrument).toBe("bitcoin/usd");
    expect(quote.isQuoteProxy).toBe(false);
    // unix seconds → ISO
    expect(quote.asOf).toBe(new Date(1787621620 * 1000).toISOString());
    expect(quote.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("requests the coin id and asks for a timestamp", async () => {
    stubFetch({ bitcoin: { usd: 12345.67, last_updated_at: 1787621620 } });
    await createCoinGeckoProvider(providerDeps()).fetchPrice(QUERY, signal());

    expect(lastUrl()).toContain("ids=bitcoin");
    expect(lastUrl()).toContain("vs_currencies=usd");
    expect(lastUrl()).toContain("include_last_updated_at=true");
  });

  it("works without credentials on the public tier", () => {
    expect(createCoinGeckoProvider(providerDeps()).isConfigured()).toBe(true);
  });

  it("sends a demo key when one is set", async () => {
    stubFetch({ bitcoin: { usd: 12345.67, last_updated_at: 1787621620 } });
    await createCoinGeckoProvider(
      providerDeps({ COINGECKO_API_KEY: "demo-key" }),
    ).fetchPrice(QUERY, signal());

    expect(lastHeaders()["x-cg-demo-api-key"]).toBe("demo-key");
  });

  it("uses the pro host and header on the pro plan", async () => {
    stubFetch({ bitcoin: { usd: 12345.67, last_updated_at: 1787621620 } });
    await createCoinGeckoProvider(
      providerDeps({ COINGECKO_API_KEY: "pro-key", COINGECKO_API_PLAN: "pro" }),
    ).fetchPrice(QUERY, signal());

    expect(lastUrl()).toContain("pro-api.coingecko.com");
    expect(lastHeaders()["x-cg-pro-api-key"]).toBe("pro-key");
  });

  it("reports the pro plan as unconfigured without a key", () => {
    const provider = createCoinGeckoProvider(
      providerDeps({ COINGECKO_API_PLAN: "pro" }),
    );
    expect(provider.isConfigured()).toBe(false);
  });

  it("rejects a response missing the coin entry", async () => {
    stubFetch({});
    await expect(
      createCoinGeckoProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a missing timestamp rather than inventing one", async () => {
    stubFetch({ bitcoin: { usd: 12345.67 } });
    await expect(
      createCoinGeckoProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("CoinMarketCap adapter — keyed mode", () => {
  const deps = providerDeps({ COINMARKETCAP_API_KEY: "cmc-key" });

  const v2Body = {
    status: { error_code: 0, error_message: null },
    data: {
      BTC: [
        {
          symbol: "BTC",
          quote: { USD: { price: 12345.67, last_updated: "2026-08-25T01:00:00.000Z" } },
        },
      ],
    },
  };

  it("normalises the v2 array-per-symbol shape", async () => {
    stubFetch(v2Body);
    const quote = await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());

    expect(quote.provider).toBe("coinmarketcap");
    expect(quote.price).toBe(12345.67);
    expect(quote.asOf).toBe("2026-08-25T01:00:00.000Z");
    expect(quote.instrument).toBe("BTC/USD");
  });

  it("also accepts the v1 object-per-symbol shape", async () => {
    stubFetch({
      status: { error_code: 0 },
      data: {
        BTC: {
          symbol: "BTC",
          quote: { USD: { price: 12345.67, last_updated: "2026-08-25T01:00:00.000Z" } },
        },
      },
    });

    const quote = await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());
    expect(quote.price).toBe(12345.67);
  });

  it("sends the API key header", async () => {
    stubFetch(v2Body);
    await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());
    expect(lastHeaders()["X-CMC_PRO_API_KEY"]).toBe("cmc-key");
  });

  it("uses the keyed /v2 endpoint, not the public one", async () => {
    stubFetch(v2Body);
    await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());
    expect(lastUrl()).toContain("/v2/cryptocurrency/quotes/latest");
    expect(lastUrl()).not.toContain("/public-api");
  });

  it("supports non-USD conversions when keyed", () => {
    expect(createCoinMarketCapProvider(deps).supports({ asset: "BTC", quote: "EUR" }))
      .toBe(true);
  });

  it("detects an error code returned inside a 200 envelope", async () => {
    stubFetch({ status: { error_code: 1002, error_message: "API key missing." } });
    await expect(
      createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "http" });
  });

  it("rejects a missing conversion currency", async () => {
    stubFetch({
      status: { error_code: 0 },
      data: { BTC: [{ symbol: "BTC", quote: {} }] },
    });
    await expect(
      createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("CoinMarketCap adapter — keyless mode", () => {
  const deps = providerDeps();

  const keylessBody = {
    data: [{ id: 1, price: 12345.67 }],
    status: {
      timestamp: "2026-08-25T02:21:28.204Z",
      error_code: "0",
      error_message: "",
    },
  };

  it("is usable without any credentials", () => {
    expect(createCoinMarketCapProvider(deps).isConfigured()).toBe(true);
  });

  it("calls the public endpoint with a numeric id, not a symbol", async () => {
    stubFetch(keylessBody);
    await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());

    expect(lastUrl()).toContain("/public-api/v1/simple/price");
    expect(lastUrl()).toContain("ids=1"); // BTC
    expect(lastUrl()).not.toContain("symbol=");
  });

  it("sends no API key header", async () => {
    stubFetch(keylessBody);
    await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());
    expect(lastHeaders()["X-CMC_PRO_API_KEY"]).toBeUndefined();
  });

  it("normalises the id/price array shape", async () => {
    stubFetch(keylessBody);
    const quote = await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());

    expect(quote.price).toBe(12345.67);
    expect(quote.quote).toBe("USD");
    expect(quote.instrument).toBe("BTC/USD");
  });

  it("marks the timestamp as response-time, not an observation", async () => {
    stubFetch(keylessBody);
    const quote = await createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal());

    // The keyless endpoint gives only status.timestamp, which says nothing
    // about how old the underlying price is.
    expect(quote.timestampProvenance).toBe("response");
    expect(quote.asOf).toBe("2026-08-25T02:21:28.204Z");
  });

  it("refuses non-USD, because the endpoint silently ignores convert", () => {
    // Verified live: ?convert=EUR|JPY|GBP all return the USD figure with a
    // success status. Answering them would mislabel a USD price.
    const provider = createCoinMarketCapProvider(deps);
    expect(provider.supports({ asset: "BTC", quote: "EUR" })).toBe(false);
    expect(provider.supports({ asset: "BTC", quote: "JPY" })).toBe(false);
    expect(provider.supports({ asset: "BTC", quote: "USD" })).toBe(true);
  });

  it("throws rather than mislabelling if a non-USD call bypasses supports()", async () => {
    stubFetch(keylessBody);
    await expect(
      createCoinMarketCapProvider(deps).fetchPrice(
        { asset: "BTC", quote: "EUR" },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "unsupported_asset" });
  });

  it("handles the string error_code the public API returns", async () => {
    stubFetch({ status: { error_code: "400", error_message: "'ids' is required" } });
    await expect(
      createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "http" });
  });

  it("rejects a response missing the requested id", async () => {
    stubFetch({ data: [{ id: 1027, price: 1 }], status: { error_code: "0" } });
    await expect(
      createCoinMarketCapProvider(deps).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("Binance adapter", () => {
  const body = {
    symbol: "BTCUSDT",
    lastPrice: "12345.67000000",
    closeTime: 1787621786964,
  };

  it("normalises a string price and millisecond timestamp", async () => {
    stubFetch(body);
    const quote = await createBinanceProvider(providerDeps()).fetchPrice(
      QUERY,
      signal(),
    );

    expect(quote.price).toBe(12345.67);
    expect(quote.asOf).toBe(new Date(1787621786964).toISOString());
    expect(quote.instrument).toBe("BTCUSDT");
  });

  it("flags the USDT proxy while still answering the USD request", async () => {
    stubFetch(body);
    const quote = await createBinanceProvider(providerDeps()).fetchPrice(
      QUERY,
      signal(),
    );

    // The caller asked for USD and gets USD back, with the substitution visible.
    expect(quote.quote).toBe("USD");
    expect(quote.isQuoteProxy).toBe(true);
  });

  it("honours a base URL override for geo-restricted regions", async () => {
    stubFetch(body);
    await createBinanceProvider(
      providerDeps({ BINANCE_BASE_URL: "https://api.binance.us" }),
    ).fetchPrice(QUERY, signal());

    expect(lastUrl()).toContain("api.binance.us");
  });

  it("rejects a response for a different symbol", async () => {
    stubFetch({ ...body, symbol: "ETHUSDT" });
    await expect(
      createBinanceProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("surfaces a geo-block as an explicit http failure", async () => {
    stubFetch({ msg: "Service unavailable from a restricted location." }, { status: 451 });
    await expect(
      createBinanceProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "http", status: 451 });
  });
});

describe("Coinbase adapter", () => {
  const body = { price: "12345.67", time: "2026-08-25T01:35:52.515397327Z" };

  it("normalises a nanosecond timestamp to milliseconds", async () => {
    stubFetch(body);
    const quote = await createCoinbaseProvider(providerDeps()).fetchPrice(
      QUERY,
      signal(),
    );

    expect(quote.price).toBe(12345.67);
    expect(quote.asOf).toBe("2026-08-25T01:35:52.515Z");
    expect(quote.instrument).toBe("BTC-USD");
    expect(quote.isQuoteProxy).toBe(false);
  });

  it("requests the product ticker endpoint", async () => {
    stubFetch(body);
    await createCoinbaseProvider(providerDeps()).fetchPrice(QUERY, signal());
    expect(lastUrl()).toContain("/products/BTC-USD/ticker");
  });

  it("rejects a zero or negative price", async () => {
    stubFetch({ ...body, price: "0" });
    await expect(
      createCoinbaseProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "invalid_price" });
  });

  it("rejects a non-numeric price", async () => {
    stubFetch({ ...body, price: "unavailable" });
    await expect(
      createCoinbaseProvider(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "invalid_price" });
  });
});

describe("shared failure handling", () => {
  const providers = [
    ["coingecko", createCoinGeckoProvider],
    ["binance", createBinanceProvider],
    ["coinbase", createCoinbaseProvider],
  ] as const;

  it.each(providers)("%s surfaces a non-2xx as an http failure", async (name, make) => {
    stubFetch({ error: "boom" }, { status: 503 });
    await expect(
      make(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ provider: name, kind: "http", status: 503 });
  });

  it.each(providers)("%s surfaces non-JSON as malformed", async (_name, make) => {
    stubFetch("<html>gateway timeout</html>");
    await expect(
      make(providerDeps()).fetchPrice(QUERY, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it.each(providers)("%s declines an unmapped asset", (_name, make) => {
    expect(make(providerDeps()).supports({ asset: "NOTACOIN", quote: "USD" })).toBe(
      false,
    );
    expect(make(providerDeps()).supports({ asset: "BTC", quote: "USD" })).toBe(true);
  });

  it.each(providers)("%s reports a network error as a ProviderError", async (_n, make) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const error = await make(providerDeps())
      .fetchPrice(QUERY, signal())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("http");
  });
});
