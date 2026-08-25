import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { parseCryptoPriceRequest } from "../src/telegraph/adapter.js";
import { isSupportedIntent } from "../src/telegraph/intents.js";

describe("CRYPTO_PRICE request validation", () => {
  it("accepts a minimal request and defaults the quote to USD", () => {
    expect(parseCryptoPriceRequest({ asset: "BTC" })).toEqual({
      asset: "BTC",
      quote: "USD",
    });
  });

  it("normalises asset and quote to uppercase", () => {
    const parsed = parseCryptoPriceRequest({ asset: "eth", quote: "eur" });
    expect(parsed.asset).toBe("ETH");
    expect(parsed.quote).toBe("EUR");
  });

  it("trims surrounding whitespace", () => {
    expect(parseCryptoPriceRequest({ asset: "  SOL  " }).asset).toBe("SOL");
  });

  it("accepts symbols containing dots and dashes", () => {
    expect(parseCryptoPriceRequest({ asset: "USDT.e" }).asset).toBe("USDT.E");
    expect(parseCryptoPriceRequest({ asset: "WETH-USD" }).asset).toBe(
      "WETH-USD",
    );
  });

  it("accepts an explicit supported intent", () => {
    const parsed = parseCryptoPriceRequest({
      intent: "crypto_price",
      asset: "BTC",
    });
    expect(parsed.intent).toBe("crypto_price");
  });

  it("accepts the hackathon catalog's uppercase intent spelling", () => {
    expect(() =>
      parseCryptoPriceRequest({ intent: "CRYPTO_PRICE", asset: "BTC" }),
    ).not.toThrow();
  });

  it("rejects an intent this miner does not serve", () => {
    expect(() =>
      parseCryptoPriceRequest({ intent: "weather_check", asset: "BTC" }),
    ).toThrow(ValidationError);
  });

  it("rejects a missing asset", () => {
    expect(() => parseCryptoPriceRequest({})).toThrow(ValidationError);
    expect(() => parseCryptoPriceRequest(undefined)).toThrow(ValidationError);
  });

  it("rejects an asset with characters that could escape a provider URL", () => {
    for (const asset of ["BTC/USD", "../etc", "BTC USD", "<script>", ""]) {
      expect(
        () => parseCryptoPriceRequest({ asset }),
        `expected "${asset}" to be rejected`,
      ).toThrow(ValidationError);
    }
  });

  it("rejects an over-long asset symbol", () => {
    expect(() => parseCryptoPriceRequest({ asset: "A".repeat(64) })).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-string asset", () => {
    expect(() => parseCryptoPriceRequest({ asset: 123 })).toThrow(
      ValidationError,
    );
    expect(() => parseCryptoPriceRequest({ asset: null })).toThrow(
      ValidationError,
    );
  });

  it("ignores unknown fields rather than failing", () => {
    const parsed = parseCryptoPriceRequest({ asset: "BTC", nonsense: true });
    expect(parsed).toEqual({ asset: "BTC", quote: "USD" });
  });

  it("reports the offending field in the error details", () => {
    try {
      parseCryptoPriceRequest({ asset: "BTC/USD" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as {
        issues: { field: string }[];
      };
      expect(details.issues[0]?.field).toBe("asset");
    }
  });

  it("maps a ValidationError to HTTP 400", () => {
    const error = new ValidationError("bad");
    expect(error.httpStatus).toBe(400);
    expect(error.code).toBe("VALIDATION_FAILED");
  });
});

describe("intent recognition", () => {
  it("accepts both documented spellings", () => {
    expect(isSupportedIntent("crypto_price")).toBe(true);
    expect(isSupportedIntent("CRYPTO_PRICE")).toBe(true);
    expect(isSupportedIntent("  Crypto_Price ")).toBe(true);
  });

  it("rejects other canonical Telegraph intents", () => {
    expect(isSupportedIntent("chat_completion")).toBe(false);
    expect(isSupportedIntent("stock_price")).toBe(false);
  });
});
