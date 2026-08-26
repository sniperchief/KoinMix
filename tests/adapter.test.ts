import { describe, expect, it } from "vitest";
import {
  NoProvidersConfiguredError,
  ProviderUnavailableError,
} from "../src/errors.js";
import {
  formatCryptoPriceResponse,
  handleCryptoPriceRequest,
} from "../src/telegraph/adapter.js";
import { CryptoPriceResponseSchema } from "../src/telegraph/schema.js";
import {
  fixedRegistry,
  quote,
  silentLogger,
  stubProvider,
  testConfig,
} from "./helpers.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const FRESH = "2026-08-24T11:59:30.000Z";

describe("Telegraph adapter — Phase 1 provider state", () => {
  it("refuses to answer when no provider is configured", async () => {
    const config = testConfig();
    const registry = fixedRegistry([]);

    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC" },
        { config, registry, logger: silentLogger, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(NoProvidersConfiguredError);
  });

  it("returns 503 for the unconfigured state, not a fabricated price", async () => {
    const registry = fixedRegistry([]);
    try {
      await handleCryptoPriceRequest(
        { asset: "BTC" },
        { config: testConfig(), registry, logger: silentLogger, now: () => NOW },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as NoProvidersConfiguredError;
      expect(err.httpStatus).toBe(503);
      expect(err.code).toBe("NO_PROVIDERS_CONFIGURED");
      expect(JSON.stringify(err.toResponseBody())).not.toMatch(/\d+\.\d{2}/);
    }
  });

  it("validates before consulting providers", async () => {
    // An invalid request must fail on shape, not on provider availability.
    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC/USD" },
        {
          config: testConfig(),
          registry: fixedRegistry([]),
          logger: silentLogger,
          now: () => NOW,
        },
      ),
    ).rejects.toThrow(/invalid CRYPTO_PRICE request/);
  });
});

describe("Telegraph adapter — aggregation over provider quotes", () => {
  const config = testConfig({ CONSENSUS_MIN_SOURCES: "1" });

  it("produces a schema-valid response from a single quote", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 64213.55, FRESH)),
    ]);

    const result = await handleCryptoPriceRequest(
      { asset: "BTC", quote: "USD" },
      { config, registry, logger: silentLogger, now: () => NOW },
    );

    expect(() => CryptoPriceResponseSchema.parse(result)).not.toThrow();
    expect(result.intent).toBe("crypto_price");
    expect(result.method).toBe("single");
    expect(result.sourceCount).toBe(1);
    expect(result.price).toBe("64213.55");
    expect(result.priceX1e8).toBe(6_421_355_000_000);
  });

  it("takes the median across three providers", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 100, FRESH)),
      stubProvider("bravo", quote("bravo", 101, FRESH)),
      stubProvider("charlie", quote("charlie", 102, FRESH)),
    ]);

    const result = await handleCryptoPriceRequest(
      { asset: "BTC" },
      { config, registry, logger: silentLogger, now: () => NOW },
    );

    expect(result.price).toBe("101");
    expect(result.method).toBe("median");
    expect(result.sourceCount).toBe(3);
    expect(result.sources).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("survives a partially failing provider set", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 100, FRESH)),
      stubProvider("bravo", new Error("upstream 500")),
    ]);

    const result = await handleCryptoPriceRequest(
      { asset: "BTC" },
      { config, registry, logger: silentLogger, now: () => NOW },
    );

    expect(result.sourceCount).toBe(1);
    expect(result.sources).toEqual(["alpha"]);
  });

  it("fails when every provider fails", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", new Error("timeout")),
      stubProvider("bravo", new Error("429")),
    ]);

    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC" },
        { config, registry, logger: silentLogger, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("discards a provider answering for the wrong asset", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 100, FRESH, { asset: "ETH" })),
    ]);

    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC" },
        { config, registry, logger: silentLogger, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("discards a provider returning a non-positive price", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 0, FRESH)),
    ]);

    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC" },
        { config, registry, logger: silentLogger, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("skips providers that decline the pair", async () => {
    const registry = fixedRegistry([
      stubProvider("alpha", quote("alpha", 100, FRESH), false),
    ]);

    await expect(
      handleCryptoPriceRequest(
        { asset: "BTC" },
        { config, registry, logger: silentLogger, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("response formatting", () => {
  const base = {
    method: "median" as const,
    sourceCount: 2,
    sources: ["alpha", "bravo"],
    deviationBps: 12,
    spreadBps: 24,
    confidence: 0.65,
    confidenceBreakdown: {
      score: 0.65,
      base: 0.7,
      agreementFactor: 1,
      freshnessFactor: 1,
      outlierFactor: 1,
      failureFactor: 1,
      provenanceFactor: 1,
    },
    asOf: FRESH,
    isStale: false,
    discardedStale: [],
    excluded: [],
    weighted: false,
    weights: [
      { provider: "alpha", weight: 1 },
      { provider: "bravo", weight: 1 },
    ],
  };

  it("keeps the decimal string and the scaled integer consistent", () => {
    const result = formatCryptoPriceResponse(
      { asset: "BTC", quote: "USD" },
      { ...base, price: 64213.55, priceX1e8: 6_421_355_000_000 },
      "koinmix-crypto-price",
      NOW,
    );

    expect(result.price).toBe("64213.55");
    expect(Math.round(Number(result.price) * 1e8)).toBe(result.priceX1e8);
  });

  it("trims trailing zeros to a canonical form for exact-match scoring", () => {
    const result = formatCryptoPriceResponse(
      { asset: "BTC", quote: "USD" },
      { ...base, price: 100, priceX1e8: 10_000_000_000 },
      "koinmix-crypto-price",
      NOW,
    );
    expect(result.price).toBe("100");
  });

  it("preserves sub-cent precision", () => {
    const result = formatCryptoPriceResponse(
      { asset: "SHIB", quote: "USD" },
      { ...base, price: 0.00002415, priceX1e8: 2415 },
      "koinmix-crypto-price",
      NOW,
    );
    expect(result.price).toBe("0.00002415");
  });

  it("echoes the canonical snake_case intent", () => {
    const result = formatCryptoPriceResponse(
      { asset: "BTC", quote: "USD" },
      { ...base, price: 100, priceX1e8: 10_000_000_000 },
      "koinmix-crypto-price",
      NOW,
    );
    expect(result.intent).toBe("crypto_price");
    expect(result.observedAt).toBe(NOW.toISOString());
  });

  it("emits every field the YAML maps on-chain via source_path", () => {
    const result = formatCryptoPriceResponse(
      { asset: "BTC", quote: "USD" },
      { ...base, price: 100, priceX1e8: 10_000_000_000 },
      "koinmix-crypto-price",
      NOW,
    );

    // Mirrors on_chain.fields[].source_path in telegraph/koinmix.yaml.
    for (const path of [
      "asset",
      "quote",
      "price",
      "asOf",
      "priceX1e8",
      "confidence",
      "sourceCount",
      "deviationBps",
      "isStale",
    ]) {
      expect(result, `missing on-chain source_path "${path}"`).toHaveProperty(
        path,
      );
    }
  });
});
