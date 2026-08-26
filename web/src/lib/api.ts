/**
 * Typed client for the KoinMix miner.
 *
 * Every value rendered by this terminal originates here, from a live miner
 * response. There is no fixture module, no seeded store and no default price
 * anywhere in `src/` — when a request fails the hooks expose the error and the
 * UI renders an unavailable state instead. A dashboard is the easiest place to
 * quietly paper over missing data, so the absence of fallbacks is deliberate.
 */

export const MINER_URL: string = (
  import.meta.env.VITE_MINER_URL ?? "http://localhost:8080"
).replace(/\/+$/, "");

/** Shape of the miner's structured error body. */
export interface ApiErrorBody {
  error: string;
  code: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
    this.requestId = body.requestId;
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${MINER_URL}${path}`, {
      signal,
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    // A network-level failure is not a miner error; say so precisely, because
    // "miner unreachable" and "miner refused" call for different fixes.
    throw new ApiError(0, {
      error:
        cause instanceof Error && cause.name === "AbortError"
          ? "request cancelled"
          : `cannot reach the miner at ${MINER_URL}`,
      code: "MINER_UNREACHABLE",
    });
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(response.status, {
      error: "miner returned a body that was not valid JSON",
      code: "MALFORMED_RESPONSE",
    });
  }

  if (!response.ok) {
    const body = parsed as Partial<ApiErrorBody> | null;
    throw new ApiError(response.status, {
      error: body?.error ?? `miner returned ${response.status}`,
      code: body?.code ?? "UNKNOWN",
      details: body?.details,
      requestId: body?.requestId,
    });
  }

  return parsed as T;
}

// ── Contract types, mirroring src/telegraph/schema.ts ────────────────────────

export interface CryptoPriceResponse {
  intent: string;
  asset: string;
  quote: string;
  price: string;
  priceX1e8: number;
  confidence: number;
  sourceCount: number;
  sources: string[];
  method: "single" | "median";
  deviationBps: number;
  spreadBps: number;
  asOf: string;
  observedAt: string;
  isStale: boolean;
  minerSlug: string;
  explanation: string;
}

export interface DiagnosticQuote {
  provider: string;
  price: number;
  asOf: string;
  ageMs: number;
  latencyMs: number;
  instrument: string;
  isQuoteProxy: boolean;
  timestampProvenance: "observed" | "response";
}

export interface DiagnosticFailure {
  provider: string;
  kind: string;
  reason: string;
  status?: number;
  latencyMs: number;
}

export interface Exclusion {
  provider: string;
  price: number;
  deviationBps: number;
  reason: "stale" | "outlier";
  detail: string;
}

export interface Diagnostics {
  query: { asset: string; quote: string };
  quotes: DiagnosticQuote[];
  failures: DiagnosticFailure[];
  skipped: string[];
  excluded: Exclusion[];
  weights: { provider: string; weight: number }[];
  confidenceBreakdown: Record<string, number>;
  roundMs: number;
}

export interface PriceRound {
  response: CryptoPriceResponse;
  diagnostics: Diagnostics;
}

export interface Health {
  status: "ok" | "degraded";
  minerSlug: string;
  subnetId: number;
  intent: string;
  signalType: string;
  minPriceUsdc: number;
  providers: { enabled: string[]; active: string[]; unknown: string[] };
  assets: string[];
  intervals: string[];
  uptimeSeconds: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  asset: string;
  quote: string;
  interval: string;
  source: string;
  instrument: string;
  isQuoteProxy: boolean;
  candles: Candle[];
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request<Health>("/healthz", signal);
}

/**
 * The dashboard reads the debug route because it is the only endpoint carrying
 * the per-provider breakdown the source panel needs. That route is operator
 * surface — undeclared in the miner YAML and unreachable through Telegraph —
 * which is exactly why the consensus panel can show it without any of it
 * leaking into the bytes a validator scores.
 */
export function getPriceRound(
  asset: string,
  quote = "USD",
  signal?: AbortSignal,
): Promise<PriceRound> {
  return request<PriceRound>(
    `/v1/price/debug?asset=${encodeURIComponent(asset)}&quote=${encodeURIComponent(quote)}`,
    signal,
  );
}

/**
 * The contract endpoint, called exactly as a Telegraph node calls it: the node
 * maps on-chain `strings[0]` and `strings[1]` onto these two query params.
 * Used by the Telegraph panel so the demo exercises the real path.
 */
export function getTelegraphPrice(
  asset: string,
  quote = "USD",
  signal?: AbortSignal,
): Promise<CryptoPriceResponse> {
  return request<CryptoPriceResponse>(
    `/v1/price?asset=${encodeURIComponent(asset)}&quote=${encodeURIComponent(quote)}`,
    signal,
  );
}

export function getCandles(
  asset: string,
  interval: string,
  quote = "USD",
  limit = 300,
  signal?: AbortSignal,
): Promise<CandleSeries> {
  return request<CandleSeries>(
    `/v1/candles?asset=${encodeURIComponent(asset)}&quote=${encodeURIComponent(quote)}` +
      `&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    signal,
  );
}

/** The miner descriptor, served verbatim so its on-chain hash matches. */
export async function getMinerYaml(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${MINER_URL}/telegraph/koinmix.yaml`, { signal });
  if (!response.ok) throw new Error(`miner YAML unavailable (${response.status})`);
  return response.text();
}
