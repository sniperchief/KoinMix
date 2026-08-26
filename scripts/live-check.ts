/**
 * Live provider acceptance check.
 *
 * Performs REAL queries against REAL upstream APIs for BTC and ETH and prints
 * what each provider returned. Nothing here is mocked, recorded, or replayed —
 * if the network is down, this fails, which is the entire point.
 *
 *   npm run live:check              # BTC and ETH in USD
 *   npm run live:check -- SOL       # a specific asset
 *   npm run live:check -- BTC EUR   # a specific asset and quote
 *
 * Exits non-zero if no provider returned a usable price.
 */
import { loadConfig } from "../src/config/env.js";
import { loadEnvFile } from "../src/config/loadEnvFile.js";
import { createLogger } from "../src/logging/logger.js";
import { collectQuotes } from "../src/providers/collect.js";
import { createProviderRegistry, knownProviderNames } from "../src/providers/registry.js";
import { supportedAssets } from "../src/providers/assets.js";

loadEnvFile();

const config = loadConfig();
// Keep the transcript readable: provider failures are reported in the table.
const logger = createLogger({ ...config, log: { ...config.log, level: "silent" } });
const registry = createProviderRegistry(config, logger);

const args = process.argv.slice(2).map((a) => a.toUpperCase());
const quote = args.find((a) => ["USD", "EUR", "GBP", "USDT"].includes(a)) ?? "USD";
const assets = args.filter((a) => a !== quote);
const targets = assets.length > 0 ? assets : ["BTC", "ETH"];

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const providers = registry.active();

  console.log("KoinMix — live provider check");
  console.log(`  time            ${new Date().toISOString()}`);
  console.log(`  known providers ${knownProviderNames().join(", ")}`);
  console.log(`  enabled         ${config.providers.enabled.join(", ") || "(none)"}`);
  console.log(`  active          ${providers.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`  timeout         ${config.providers.timeoutMs}ms`);
  console.log(`  supported       ${supportedAssets().join(", ")}`);
  console.log();

  if (providers.length === 0) {
    console.error(
      "No active providers. Set PRICE_PROVIDERS (and any required API key).",
    );
    process.exit(1);
  }

  let successes = 0;
  let attempts = 0;

  for (const asset of targets) {
    const query = { asset, quote };
    const started = Date.now();
    const { quotes, failures, skipped } = await collectQuotes(
      providers,
      query,
      config.providers.timeoutMs,
      logger,
    );

    console.log(`${asset}/${quote}  (round took ${Date.now() - started}ms)`);
    console.log(
      `  ${pad("PROVIDER", 15)}${pad("PRICE", 16)}${pad("LATENCY", 10)}` +
        `${pad("INSTRUMENT", 14)}SOURCE TIMESTAMP`,
    );

    for (const q of [...quotes].sort((a, b) => a.provider.localeCompare(b.provider))) {
      attempts += 1;
      successes += 1;
      const proxy = q.isQuoteProxy ? " *" : "";
      console.log(
        `  ${pad(q.provider, 15)}${pad(q.price.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 8,
        }), 16)}${pad(`${q.latencyMs}ms`, 10)}${pad(q.instrument + proxy, 14)}${q.asOf}`,
      );
    }

    for (const f of failures) {
      attempts += 1;
      console.log(
        `  ${pad(f.provider, 15)}${pad("FAILED", 16)}${pad(`${f.latencyMs}ms`, 10)}` +
          `${pad(f.kind, 14)}${f.reason}`,
      );
    }

    for (const name of skipped) {
      console.log(`  ${pad(name, 15)}${pad("SKIPPED", 16)}unsupported asset/quote`);
    }

    // Spread across providers is the strongest available evidence that these
    // are independent live feeds rather than one source echoed four times.
    if (quotes.length > 1) {
      const prices = quotes.map((q) => q.price);
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      const spreadBps = Math.round(((hi - lo) / lo) * 10_000);
      console.log(
        `  spread: ${lo.toLocaleString("en-US")} – ${hi.toLocaleString("en-US")} ` +
          `(${spreadBps} bps across ${quotes.length} independent providers)`,
      );
    }

    if (quotes.some((q) => q.isQuoteProxy)) {
      console.log("  * quoted against a stablecoin proxy for the requested fiat");
    }

    console.log();
  }

  console.log(`Result: ${successes}/${attempts} provider calls returned a live price.`);

  if (successes === 0) {
    console.error("No provider returned a usable price.");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
