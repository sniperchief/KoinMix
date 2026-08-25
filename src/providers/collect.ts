import type { AppLogger } from "../logging/logger.js";
import { ProviderError, type ProviderFailureKind } from "./errors.js";
import type { PriceProvider, PriceQuery, PriceQuote } from "./types.js";

export interface ProviderFailure {
  readonly provider: string;
  readonly kind: ProviderFailureKind | "unknown";
  readonly reason: string;
  /** Upstream HTTP status, when the failure came from an error response. */
  readonly status?: number;
  /** How long the attempt took before failing. */
  readonly latencyMs: number;
}

export interface CollectResult {
  readonly quotes: readonly PriceQuote[];
  /** Providers that threw, timed out, or returned an unusable quote. */
  readonly failures: readonly ProviderFailure[];
  /** Providers that declined the pair via `supports()`. */
  readonly skipped: readonly string[];
}

/**
 * Query every provider concurrently and gather whatever comes back within the
 * timeout.
 *
 * Isolation is the point: each provider gets its own AbortSignal and its own
 * settled slot, so a hung upstream cannot stall the round and a malformed
 * response cannot poison it. One provider failing while others succeed is a
 * normal, fully-served outcome.
 */
export async function collectQuotes(
  providers: readonly PriceProvider[],
  query: PriceQuery,
  timeoutMs: number,
  logger: AppLogger,
): Promise<CollectResult> {
  const quotes: PriceQuote[] = [];
  const failures: ProviderFailure[] = [];
  const skipped: string[] = [];

  const eligible = providers.filter((p) => {
    if (p.supports(query)) return true;
    skipped.push(p.name);
    return false;
  });

  const settled = await Promise.allSettled(
    eligible.map(async (provider) => {
      const startedAt = performance.now();
      try {
        const quote = await provider.fetchPrice(
          query,
          AbortSignal.timeout(timeoutMs),
        );
        assertUsableQuote(provider.name, query, quote);
        return quote;
      } catch (error) {
        throw describeFailure(
          provider.name,
          error,
          Math.round(performance.now() - startedAt),
        );
      }
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      quotes.push(outcome.value);
      continue;
    }

    const failure = outcome.reason as ProviderFailure;
    failures.push(failure);
    logger.warn(
      {
        provider: failure.provider,
        kind: failure.kind,
        status: failure.status,
        latencyMs: failure.latencyMs,
        query,
        reason: failure.reason,
      },
      "provider quote failed",
    );
  }

  return { quotes, failures, skipped };
}

function describeFailure(
  provider: string,
  error: unknown,
  latencyMs: number,
): ProviderFailure {
  if (error instanceof ProviderError) {
    return {
      provider,
      kind: error.kind,
      reason: error.message,
      status: error.status,
      latencyMs,
    };
  }

  // A timeout raised by AbortSignal.timeout rather than by our fetch wrapper.
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      provider,
      kind: "timeout",
      reason: `timed out after ${latencyMs}ms`,
      latencyMs,
    };
  }

  return {
    provider,
    kind: "unknown",
    reason: error instanceof Error ? error.message : String(error),
    latencyMs,
  };
}

/**
 * Guard the boundary with the outside world.
 *
 * Adapters already validate their own payloads; this re-checks the invariants
 * every consumer downstream relies on, so a future adapter cannot weaken them
 * by omission.
 */
function assertUsableQuote(
  providerName: string,
  query: PriceQuery,
  quote: PriceQuote,
): void {
  if (!Number.isFinite(quote.price) || quote.price <= 0) {
    throw new ProviderError(
      providerName,
      "invalid_price",
      "returned a non-positive or non-finite price",
    );
  }
  if (quote.asset !== query.asset || quote.quote !== query.quote) {
    throw new ProviderError(
      providerName,
      "malformed",
      `returned ${quote.asset}/${quote.quote} but ${query.asset}/${query.quote} was requested`,
    );
  }
  if (Number.isNaN(Date.parse(quote.asOf))) {
    throw new ProviderError(
      providerName,
      "malformed",
      `returned an unparseable asOf timestamp: ${quote.asOf}`,
    );
  }
  if (quote.provider !== providerName) {
    throw new ProviderError(
      providerName,
      "malformed",
      `returned quote.provider="${quote.provider}", expected "${providerName}"`,
    );
  }
}
