/**
 * Typed error hierarchy.
 *
 * HTTP statuses are chosen to line up with the behaviour Telegraph nodes expect
 * from an upstream subnet. Per the x402 docs, a node surfaces an upstream
 * failure to the caller as 502; returning an accurate status here keeps the
 * miner's failures legible in the node's logs rather than looking like a crash.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNSUPPORTED_INTENT"
  | "NO_PROVIDERS_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "INSUFFICIENT_SOURCES"
  | "CONSENSUS_FAILED"
  | "INTERNAL_ERROR";

export abstract class KoinMixError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /** Safe, structured detail returned to the caller alongside the message. */
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  toResponseBody(): {
    error: string;
    code: ErrorCode;
    details: Record<string, unknown>;
  } {
    return { error: this.message, code: this.code, details: this.details };
  }
}

/** The incoming request failed schema validation. */
export class ValidationError extends KoinMixError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly httpStatus = 400;
}

/** The request named an intent this miner does not declare support for. */
export class UnsupportedIntentError extends KoinMixError {
  readonly code = "UNSUPPORTED_INTENT" as const;
  readonly httpStatus = 400;
}

/**
 * No live price provider is registered. This is the honest Phase 1 state: the
 * miner refuses to answer rather than fabricating a price.
 */
export class NoProvidersConfiguredError extends KoinMixError {
  readonly code = "NO_PROVIDERS_CONFIGURED" as const;
  readonly httpStatus = 503;
}

/** Providers are configured but every one of them failed or timed out. */
export class ProviderUnavailableError extends KoinMixError {
  readonly code = "PROVIDER_UNAVAILABLE" as const;
  readonly httpStatus = 503;
}

/** Some providers answered, but fewer than `CONSENSUS_MIN_SOURCES`. */
export class InsufficientSourcesError extends KoinMixError {
  readonly code = "INSUFFICIENT_SOURCES" as const;
  readonly httpStatus = 503;
}

/** Enough quotes arrived, but they disagreed beyond the tolerated deviation. */
export class ConsensusFailedError extends KoinMixError {
  readonly code = "CONSENSUS_FAILED" as const;
  readonly httpStatus = 502;
}

export function isKoinMixError(e: unknown): e is KoinMixError {
  return e instanceof KoinMixError;
}
