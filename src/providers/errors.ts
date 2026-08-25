/**
 * Provider-internal failures.
 *
 * These are distinct from the `KoinMixError` hierarchy: those map to HTTP
 * statuses returned to Telegraph, whereas these are collected per-provider by
 * `collectQuotes()` so that one bad upstream never fails a round that other
 * providers can still serve.
 */

export type ProviderFailureKind =
  /** The request exceeded PROVIDER_TIMEOUT_MS or the socket aborted. */
  | "timeout"
  /** Upstream returned a non-2xx status. */
  | "http"
  /** Upstream returned a body we could not parse or that lacked fields. */
  | "malformed"
  /** Upstream returned a price that is absent, non-numeric, or <= 0. */
  | "invalid_price"
  /** The provider has no identifier mapping for the requested asset/quote. */
  | "unsupported_asset"
  /** The provider is missing credentials or configuration. */
  | "not_configured";

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly provider: string;
  readonly kind: ProviderFailureKind;
  /** HTTP status, when the failure was an upstream error response. */
  readonly status?: number;

  constructor(
    provider: string,
    kind: ProviderFailureKind,
    message: string,
    status?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Read a positive, finite number from an upstream field that may arrive as
 * either a JSON number or a decimal string (exchanges differ, and several
 * return strings to preserve precision).
 */
export function parsePositivePrice(
  provider: string,
  raw: unknown,
  field: string,
): number {
  const value = typeof raw === "string" ? Number(raw) : raw;

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProviderError(
      provider,
      "invalid_price",
      `field "${field}" was not a positive finite number (got ${JSON.stringify(raw)})`,
    );
  }

  return value;
}

/**
 * Normalise an upstream timestamp to ISO 8601.
 *
 * Accepts ISO strings, unix seconds, and unix milliseconds — all three appear
 * across the supported providers. Never invents a timestamp: a missing or
 * unparseable value is an error, because a fabricated observation time would
 * defeat the staleness checks downstream.
 */
export function parseTimestamp(
  provider: string,
  raw: unknown,
  field: string,
  unit: "iso" | "seconds" | "milliseconds",
): string {
  let ms: number;

  if (unit === "iso") {
    if (typeof raw !== "string") {
      throw new ProviderError(
        provider,
        "malformed",
        `field "${field}" was not an ISO timestamp string (got ${JSON.stringify(raw)})`,
      );
    }
    ms = Date.parse(raw);
  } else {
    const numeric = typeof raw === "string" ? Number(raw) : raw;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      throw new ProviderError(
        provider,
        "malformed",
        `field "${field}" was not a numeric timestamp (got ${JSON.stringify(raw)})`,
      );
    }
    ms = unit === "seconds" ? numeric * 1000 : numeric;
  }

  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    throw new ProviderError(
      provider,
      "malformed",
      `field "${field}" could not be parsed as a timestamp (got ${JSON.stringify(raw)})`,
    );
  }

  return new Date(ms).toISOString();
}
