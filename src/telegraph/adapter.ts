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
    asOf: consensus.asOf,
    observedAt: now.toISOString(),
    isStale: consensus.isStale,
    minerSlug,
    // The exclusion detail lives here, in the human-readable reason field mapped
    // by signal_mapping.reason_field, rather than as a structured response field
    // the YAML never declared.
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
 * Round-level diagnostics.
 *
 * Explicitly NOT part of the miner contract, and deliberately not a Zod schema:
 * nothing here is promised to any caller, and it must never be merged into the
 * CRYPTO_PRICE response. Telegraph reads the response by dot-path and would
 * happily carry extra keys, which is exactly why the separation has to be
 * enforced here rather than trusted to the node.
 *
 * Served only by the undeclared debug route and written to the logs.
 */
export interface CryptoPriceDiagnostics {
  readonly query: PriceQuery;
  /** Every quote that came back, before any filtering. */
  readonly quotes: ReadonlyArray<{
    readonly provider: string;
    readonly price: number;
    readonly asOf: string;
    readonly ageMs: number;
    readonly latencyMs: number;
    readonly instrument: string;
    readonly isQuoteProxy: boolean;
    readonly timestampProvenance: string;
  }>;
  /** Providers that errored, timed out, or returned something unusable. */
  readonly failures: ReadonlyArray<{
    readonly provider: string;
    readonly kind: string;
    readonly reason: string;
    readonly status?: number;
    readonly latencyMs: number;
  }>;
  /** Providers that declined the pair outright. */
  readonly skipped: readonly string[];
  /** Observations dropped as stale or anomalous, with the reason. */
  readonly excluded: ConsensusResult["excluded"];
  /** Effective weight each surviving quote carried into the weighted median. */
  readonly weights: ConsensusResult["weights"];
  /** How the confidence indicator was composed. */
  readonly confidenceBreakdown: ConsensusResult["confidenceBreakdown"];
  readonly roundMs: number;
}

interface CryptoPriceRound {
  readonly response: CryptoPriceResponse;
  readonly diagnostics: CryptoPriceDiagnostics;
}

/**
 * Full CRYPTO_PRICE round: validate → fan out to providers → reach consensus →
 * format.
 *
 * Throws a `KoinMixError` subclass on every failure path. Notably it will NOT
 * return a price when no provider is configured, and will not substitute a
 * value when providers disagree or fail — inventing a number here is precisely
 * what the hackathon rules and the brief forbid.
 */
export async function handleCryptoPriceRequest(
  raw: unknown,
  deps: AdapterDeps,
): Promise<CryptoPriceResponse> {
  return (await runCryptoPriceRound(raw, deps)).response;
}

/**
 * The same round, with its diagnostics retained. Used only by the debug route.
 */
export async function handleCryptoPriceDiagnostics(
  raw: unknown,
  deps: AdapterDeps,
): Promise<CryptoPriceRound> {
  return runCryptoPriceRound(raw, deps);
}

async function runCryptoPriceRound(
  raw: unknown,
  deps: AdapterDeps,
): Promise<CryptoPriceRound> {
  const { config, registry, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = performance.now();

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
    freshnessHalfLifeMs: config.consensus.freshnessHalfLifeMs,
    unverifiedFreshnessWeight: config.consensus.unverifiedFreshnessWeight,
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
      // Weights vary per round now that freshness feeds them, so without this
      // a past consensus cannot be explained from the logs alone.
      weights: consensus.weights,
    },
    "CRYPTO_PRICE consensus reached",
  );

  const observedAt = now();

  return {
    response: formatCryptoPriceResponse(
      query,
      consensus,
      config.miner.slug,
      observedAt,
    ),
    diagnostics: {
      query,
      quotes: quotes.map((q) => ({
        provider: q.provider,
        price: q.price,
        asOf: q.asOf,
        ageMs: Math.max(0, observedAt.getTime() - Date.parse(q.asOf)),
        latencyMs: q.latencyMs,
        instrument: q.instrument,
        isQuoteProxy: q.isQuoteProxy,
        timestampProvenance: q.timestampProvenance,
      })),
      failures: failures.map((f) => ({
        provider: f.provider,
        kind: f.kind,
        reason: f.reason,
        status: f.status,
        latencyMs: f.latencyMs,
      })),
      skipped: [...skipped],
      excluded: consensus.excluded,
      weights: consensus.weights,
      confidenceBreakdown: consensus.confidenceBreakdown,
      roundMs: Math.round(performance.now() - startedAt),
    },
  };
}
