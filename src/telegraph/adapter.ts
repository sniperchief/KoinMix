import { reachConsensus, type ConsensusResult } from "../consensus/engine.js";
import type { Config } from "../config/env.js";
import {
  NoProvidersConfiguredError,
  ProviderUnavailableError,
  ValidationError,
} from "../errors.js";
import type { AppLogger } from "../logging/logger.js";
import { collectQuotes } from "../providers/collect.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { PriceQuery } from "../providers/types.js";
import { CRYPTO_PRICE_INTENT } from "./intents.js";
import {
  CryptoPriceRequestSchema,
  type CryptoPriceRequest,
  type CryptoPriceResponse,
} from "./schema.js";

/**
 * The Telegraph adapter.
 *
 * This is the seam between Telegraph's transport and KoinMix's domain. It is
 * deliberately transport-agnostic — it takes an already-merged bag of raw input
 * and returns a plain object — so the same code path serves a GET with query
 * params (how the node maps `on_chain.request.query_params` from `strings[]`)
 * and a POST with a JSON body, and so it can be tested without HTTP.
 */

export interface AdapterDeps {
  readonly config: Config;
  readonly registry: ProviderRegistry;
  readonly logger: AppLogger;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Validate raw input against the CRYPTO_PRICE request contract.
 *
 * @throws ValidationError with per-field detail.
 */
export function parseCryptoPriceRequest(raw: unknown): CryptoPriceRequest {
  const parsed = CryptoPriceRequestSchema.safeParse(raw ?? {});

  if (!parsed.success) {
    throw new ValidationError("invalid CRYPTO_PRICE request", {
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join(".") || "(root)",
        message: i.message,
      })),
    });
  }

  return parsed.data;
}

/** Shape a successful consensus into the on-the-wire CRYPTO_PRICE response. */
export function formatCryptoPriceResponse(
  query: PriceQuery,
  consensus: ConsensusResult,
  minerSlug: string,
  now: Date,
): CryptoPriceResponse {
  return {
    intent: CRYPTO_PRICE_INTENT,
    asset: query.asset,
    quote: query.quote,
    price: formatPrice(consensus.priceX1e8),
    priceX1e8: consensus.priceX1e8,
    confidence: consensus.confidence,
    sourceCount: consensus.sourceCount,
    sources: [...consensus.sources],
    method: consensus.method,
    deviationBps: consensus.deviationBps,
    spreadBps: consensus.spreadBps,
    excluded: consensus.excluded.map((e) => ({ ...e })),
    asOf: consensus.asOf,
    observedAt: now.toISOString(),
    isStale: consensus.isStale,
    minerSlug,
    explanation:
      `${consensus.method === "single" ? "Single-source" : "Median"} price for ` +
      `${query.asset}/${query.quote} from ${consensus.sourceCount} live ` +
      `provider quote(s) [${consensus.sources.join(", ")}]; ` +
      `spread ${consensus.spreadBps} bps` +
      (consensus.excluded.length > 0
        ? `; excluded ${consensus.excluded.length} observation(s): ` +
          consensus.excluded
            .map((e) => `${e.provider} (${e.reason})`)
            .join(", ")
        : "") +
      ".",
  };
}

/**
 * Render the scaled integer back to a decimal string.
 *
 * Derived from `priceX1e8` rather than the float so the string and the on-chain
 * integer can never disagree — they are two views of one value. Trailing zeros
 * are trimmed to give exact-match validators a canonical form.
 */
function formatPrice(priceX1e8: number): string {
  const whole = Math.trunc(priceX1e8 / 1e8);
  const frac = String(Math.abs(priceX1e8) % 1e8)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : String(whole);
}

/**
 * Full CRYPTO_PRICE round: validate → fan out to providers → reach consensus →
 * format.
 *
 * Throws a `KoinMixError` subclass on every failure path. Notably it will NOT
 * return a price when no provider is configured — during Phase 1 that is the
 * expected outcome, and inventing a number here is precisely what the hackathon
 * rules and the brief forbid.
 */
export async function handleCryptoPriceRequest(
  raw: unknown,
  deps: AdapterDeps,
): Promise<CryptoPriceResponse> {
  const { config, registry, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const request = parseCryptoPriceRequest(raw);
  const query: PriceQuery = { asset: request.asset, quote: request.quote };

  const providers = registry.active();
  if (providers.length === 0) {
    throw new NoProvidersConfiguredError(
      "no live price provider is configured; this miner does not serve " +
        "synthetic prices",
      { enabled: [...config.providers.enabled] },
    );
  }

  const { quotes, failures, skipped } = await collectQuotes(
    providers,
    query,
    config.providers.timeoutMs,
    logger,
  );

  if (quotes.length === 0) {
    throw new ProviderUnavailableError(
      `no provider returned a usable ${query.asset}/${query.quote} price`,
      { failures, skipped },
    );
  }

  const consensus = reachConsensus(quotes, {
    minSources: config.consensus.minSources,
    maxDeviationBps: config.consensus.maxDeviationBps,
    maxStalenessMs: config.consensus.maxStalenessMs,
    outlierZThreshold: config.consensus.outlierZThreshold,
    outlierMinDeviationBps: config.consensus.outlierMinDeviationBps,
    weights: config.consensus.weights,
    // Failures lower the reliability indicator; they never move the price.
    providerFailureCount: failures.length,
    now: now(),
  });

  logger.info(
    {
      query,
      sourceCount: consensus.sourceCount,
      spreadBps: consensus.spreadBps,
      deviationBps: consensus.deviationBps,
      confidence: consensus.confidence,
      failures: failures.length,
      excluded: consensus.excluded,
    },
    "CRYPTO_PRICE consensus reached",
  );

  return formatCryptoPriceResponse(
    query,
    consensus,
    config.miner.slug,
    now(),
  );
}
