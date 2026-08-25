import { describe, expect, it } from "vitest";
import {
  binanceMarket,
  coinbaseMarket,
  coingeckoMarket,
  coinmarketcapMarket,
  isSupportedQuote,
  resolveAsset,
  supportedAssets,
} from "../src/providers/assets.js";

describe("asset resolution", () => {
  it("resolves the required Phase 2 assets", () => {
    expect(resolveAsset("BTC")?.coingeckoId).toBe("bitcoin");
    expect(resolveAsset("ETH")?.coingeckoId).toBe("ethereum");
  });

  it("is case-insensitive on the incoming symbol", () => {
    expect(resolveAsset("btc")?.symbol).toBe("BTC");
    expect(resolveAsset("Eth")?.symbol).toBe("ETH");
  });

  it("returns undefined for an unmapped asset rather than guessing", () => {
    expect(resolveAsset("NOTACOIN")).toBeUndefined();
    expect(resolveAsset("")).toBeUndefined();
  });

  it("exposes the supported asset list", () => {
    expect(supportedAssets()).toContain("BTC");
    expect(supportedAssets()).toContain("ETH");
  });

  it("accepts known quote currencies only", () => {
    expect(isSupportedQuote("USD")).toBe(true);
    expect(isSupportedQuote("usd")).toBe(true);
    expect(isSupportedQuote("XYZ")).toBe(false);
  });
});

describe("per-provider market identifiers", () => {
  const btc = resolveAsset("BTC")!;
  const eth = resolveAsset("ETH")!;

  it("builds CoinGecko coin ids", () => {
    expect(coingeckoMarket(btc, "USD").instrument).toBe("bitcoin/usd");
    expect(coingeckoMarket(eth, "EUR").instrument).toBe("ethereum/eur");
  });

  it("builds CoinMarketCap symbol pairs", () => {
    expect(coinmarketcapMarket(btc, "USD").instrument).toBe("BTC/USD");
  });

  it("builds Coinbase dashed product ids", () => {
    expect(coinbaseMarket(btc, "USD").instrument).toBe("BTC-USD");
    expect(coinbaseMarket(eth, "USD").instrument).toBe("ETH-USD");
  });

  it("builds Binance concatenated pairs", () => {
    expect(binanceMarket(btc, "USDT").instrument).toBe("BTCUSDT");
  });

  it("substitutes USDT for USD on Binance and flags the proxy", () => {
    // Binance's global venue has no fiat BTC/USD spot market.
    const market = binanceMarket(btc, "USD");
    expect(market.instrument).toBe("BTCUSDT");
    expect(market.effectiveQuote).toBe("USDT");
    expect(market.isQuoteProxy).toBe(true);
  });

  it("does not flag a proxy when the venue quotes the requested currency", () => {
    expect(binanceMarket(btc, "USDT").isQuoteProxy).toBe(false);
    expect(coinbaseMarket(btc, "USD").isQuoteProxy).toBe(false);
    expect(coingeckoMarket(btc, "USD").isQuoteProxy).toBe(false);
  });

  it("gives BTC and ETH distinct identifiers on every provider", () => {
    for (const build of [
      coingeckoMarket,
      coinmarketcapMarket,
      binanceMarket,
      coinbaseMarket,
    ]) {
      expect(build(btc, "USD").instrument).not.toBe(build(eth, "USD").instrument);
    }
  });
});
