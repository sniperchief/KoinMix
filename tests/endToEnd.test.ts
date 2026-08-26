import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/http/server.js";
import { ProviderError } from "../src/providers/errors.js";
import type { PriceQuote } from "../src/providers/types.js";
import {
  CryptoPriceResponseSchema,
  type CryptoPriceResponse,
} from "../src/telegraph/schema.js";
import {
  fixedRegistry,
  quote,
  silentLogger,
  stubProvider,
  testConfig,
} from "./helpers.js";

/**
 * End-to-end route tests: the full Telegraph path through real HTTP handling.
 *
 *   request parsing → asset resolution → provider execution → consensus
 *   → response serialization → error handling
 *
 * `app.inject()` exercises the actual Fastify stack — routing, query parsing,
 * the error boundary, JSON serialization — rather than calling the adapter
 * directly, so serialization bugs and status-code mistakes are caught here and
 * not in production.
 *
 * The providers are stubs, and that is the point of *this* file: a deterministic
 * harness is the only way to test failure paths on demand. Real upstreams are
 * covered by `npm run live:check` and `npm run evaluate`, and the live
 * end-to-end run is documented in README.md. No stub exists anywhere in `src/`.
 */

function build(providers: Parameters<typeof fixedRegistry>[0], env = {}) {
  const config = testConfig(env);
  return buildServer(config, silentLogger, fixedRegistry(providers));
}

/**
 * Quotes are stamped relative to the real clock, not a frozen instant.
 *
 * These tests drive the server through HTTP, and the server reads its own
 * clock — there is no `now` injection past the route boundary. A fixed
 * timestamp would age past the staleness bound and every round would be
 * refused, testing nothing but the staleness filter.
 */
function freshAsOf(secondsAgo = 5): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function priceQuote(
  provider: string,
  price: number,
  overrides: Partial<PriceQuote> = {},
): PriceQuote {
  return quote(provider, price, freshAsOf(), {
    asset: "BTC",
    quote: "USD",
    ...overrides,
  });
}

describe("e2e — the Telegraph request path", () => {
  it("serves a GET the way a node maps an on-chain request", async () => {
    // This is the exact shape on_chain.request produces: strings[0] and
    // strings[1] become the asset and quote query params.
    const app = build([
      stubProvider("alpha", priceQuote("alpha", 64_213.55)),
      stubProvider("bravo", priceQuote("bravo", 64_213.55)),
      stubProvider("charlie", priceQuote("charlie", 64_213.55)),
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/price?asset=BTC&quote=USD",
    });

    expect(res.statusCode).toBe(200);

    const body = res.json<CryptoPriceResponse>();
    // Validating against the contract, not just spot-checking fields: a
    // response that no longer parses is a breaking change for the YAML.
    expect(() => CryptoPriceResponseSchema.parse(body)).not.toThrow();

    expect(body.intent).toBe("crypto_price");
    expect(body.asset).toBe("BTC");
    expect(body.quote).toBe("USD");
    expect(body.price).toBe("64213.55");
    expect(body.priceX1e8).toBe(6_421_355_000_000);
    expect(body.sourceCount).toBe(3);
    expect(body.sources).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("accepts a POST body for direct callers", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/price",
      payload: { asset: "BTC", quote: "USD" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<CryptoPriceResponse>().price).toBe("100");
  });

  it("defaults the quote to USD when the node omits strings[1]", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(200);
    expect(res.json<CryptoPriceResponse>().quote).toBe("USD");
  });

  it("normalises a lowercase asset symbol", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/price?asset=btc&quote=usd",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<CryptoPriceResponse>().asset).toBe("BTC");
  });

  it("accepts either spelling of the intent", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);

    for (const intent of ["crypto_price", "CRYPTO_PRICE"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/price?asset=BTC&intent=${intent}`,
      });
      expect(res.statusCode).toBe(200);
      // The echoed intent is always the canonical snake_case wire form.
      expect(res.json<CryptoPriceResponse>().intent).toBe("crypto_price");
    }
  });
});

describe("e2e — the response never carries internal state", () => {
  it("omits diagnostics from the contract response", async () => {
    // A stale quote guarantees the engine produced an exclusion to leak.
    const app = build([
      stubProvider("alpha", priceQuote("alpha", 100)),
      stubProvider("stale", priceQuote("stale", 100, { asOf: freshAsOf(7200) })),
    ]);

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });
    const body = res.json<Record<string, unknown>>();

    for (const internal of [
      "excluded",
      "weights",
      "confidenceBreakdown",
      "diagnostics",
      "quotes",
      "failures",
      "discardedStale",
    ]) {
      expect(body).not.toHaveProperty(internal);
    }
  });

  it("returns exactly the keys the contract declares", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(Object.keys(res.json<object>()).sort()).toEqual(
      [
        "asOf",
        "asset",
        "confidence",
        "deviationBps",
        "explanation",
        "intent",
        "isStale",
        "method",
        "minerSlug",
        "observedAt",
        "price",
        "priceX1e8",
        "quote",
        "sourceCount",
        "sources",
        "spreadBps",
      ].sort(),
    );
  });

  it("exposes diagnostics only on the undeclared debug route", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/price/debug?asset=BTC",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ response: unknown; diagnostics: Record<string, unknown> }>();
    expect(body.response).toBeDefined();
    expect(body.diagnostics).toHaveProperty("weights");
    expect(body.diagnostics).toHaveProperty("excluded");
    expect(body.diagnostics).toHaveProperty("confidenceBreakdown");
  });
});

describe("e2e — error handling", () => {
  it("rejects a missing asset with 400 VALIDATION_FAILED", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({ method: "GET", url: "/v1/price" });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("rejects an asset no provider can resolve", async () => {
    const app = build([
      stubProvider("alpha", new ProviderError("alpha", "unsupported_asset", "no mapping"), false),
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/price?asset=NOTACOIN",
    });

    // Every provider declined the pair, so nothing was quoted.
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("rejects an unsupported intent", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({
      method: "GET",
      url: "/v1/price?asset=BTC&intent=weather_check",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("returns a requestId on every error for correlation", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({ method: "GET", url: "/v1/price" });

    expect(res.json<{ requestId: string }>().requestId).toBeTruthy();
  });

  it("404s an unknown route with a structured body", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({ method: "GET", url: "/v1/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });
});

/**
 * Resilience.
 *
 * The single property that matters: no failure mode may produce a price. A
 * miner that invents a number under load is worse than one that returns an
 * error, both for the hackathon rules and for anything consuming the signal
 * on-chain.
 */
describe("e2e — resilience: failure never yields a price", () => {
  it("refuses when every provider fails", async () => {
    const app = build([
      stubProvider("alpha", new ProviderError("alpha", "http", "500 upstream")),
      stubProvider("bravo", new ProviderError("bravo", "timeout", "timed out")),
    ]);

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(503);
    const body = res.json<Record<string, unknown>>();
    expect(body.code).toBe("PROVIDER_UNAVAILABLE");
    expect(body).not.toHaveProperty("price");
    expect(body).not.toHaveProperty("priceX1e8");
  });

  it("refuses when no provider is configured at all", async () => {
    const app = build([]);
    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(503);
    const body = res.json<Record<string, unknown>>();
    expect(body.code).toBe("NO_PROVIDERS_CONFIGURED");
    expect(body).not.toHaveProperty("price");
  });

  it("still serves a price when only some providers fail", async () => {
    const app = build([
      stubProvider("alpha", priceQuote("alpha", 100)),
      stubProvider("bravo", new ProviderError("bravo", "timeout", "timed out")),
      stubProvider("charlie", priceQuote("charlie", 100)),
    ]);

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(200);
    const body = res.json<CryptoPriceResponse>();
    expect(body.sourceCount).toBe(2);
    // Partial failure must lower the reliability indicator, not the price.
    expect(body.price).toBe("100");
    expect(body.confidence).toBeLessThan(0.7);
  });

  it("refuses when survivors disagree beyond tolerance", async () => {
    const app = build(
      [
        stubProvider("alpha", priceQuote("alpha", 100)),
        stubProvider("bravo", priceQuote("bravo", 200)),
      ],
      { CONSENSUS_MAX_DEVIATION_BPS: "200" },
    );

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(502);
    const body = res.json<Record<string, unknown>>();
    expect(body.code).toBe("CONSENSUS_FAILED");
    expect(body).not.toHaveProperty("price");
  });

  it("refuses when every quote is too stale to use", async () => {
    const app = build(
      [
        stubProvider(
          "alpha",
          priceQuote("alpha", 100, { asOf: "2020-01-01T00:00:00.000Z" }),
        ),
      ],
      { PRICE_MAX_STALENESS_MS: "60000" },
    );

    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });

    expect(res.statusCode).toBe(503);
    const body = res.json<Record<string, unknown>>();
    expect(body.code).toBe("INSUFFICIENT_SOURCES");
    expect(body).not.toHaveProperty("price");
  });

  it("bounds a slow provider by the configured timeout", async () => {
    // A provider that never resolves must not hang the round: collectQuotes
    // hands each provider its own AbortSignal.timeout.
    const hanging = {
      name: "hanging",
      isConfigured: () => true,
      supports: () => true,
      fetchPrice: (_q: unknown, signal: AbortSignal) =>
        new Promise<PriceQuote>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new ProviderError("hanging", "timeout", "aborted")),
          );
        }),
    };

    const app = build([stubProvider("alpha", priceQuote("alpha", 100)), hanging], {
      PROVIDER_TIMEOUT_MS: "150",
    });

    const startedAt = Date.now();
    const res = await app.inject({ method: "GET", url: "/v1/price?asset=BTC" });
    const elapsed = Date.now() - startedAt;

    expect(res.statusCode).toBe(200);
    // Served from the healthy provider, without waiting on the hung one.
    expect(res.json<CryptoPriceResponse>().sourceCount).toBe(1);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("e2e — miner descriptor and health", () => {
  it("serves the YAML verbatim so its on-chain hash matches", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({
      method: "GET",
      url: "/telegraph/koinmix.yaml",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/yaml");

    // registerMiner() commits the SHA-256 of these exact bytes. If the served
    // body differs from the file by even one byte, the node's hash check fails
    // and the miner never activates.
    const onDisk = await readFile(
      fileURLToPath(new URL("../telegraph/koinmix.yaml", import.meta.url)),
      "utf8",
    );
    expect(res.body).toBe(onDisk);
    expect(createHash("sha256").update(res.body).digest("hex")).toBe(
      createHash("sha256").update(onDisk).digest("hex"),
    );
  });

  it("reports ok while a provider is active", async () => {
    const app = build([stubProvider("alpha", priceQuote("alpha", 100))]);
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; intent: string }>();
    expect(body.status).toBe("ok");
    expect(body.intent).toBe("crypto_price");
  });

  it("reports degraded with no active provider", async () => {
    const app = build([]);
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ status: string }>().status).toBe("degraded");
  });
});
