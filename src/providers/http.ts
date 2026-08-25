import { ProviderError } from "./errors.js";

export interface JsonFetchResult<T> {
  readonly data: T;
  /** Wall-clock duration of the upstream call, in milliseconds. */
  readonly latencyMs: number;
}

/**
 * The single HTTP entry point for every provider adapter.
 *
 * Centralising it means timeout handling, status checking, JSON parsing and
 * latency measurement are implemented once and behave identically across
 * providers — so a new adapter cannot accidentally skip one of them.
 */
export async function fetchJson<T>(
  provider: string,
  url: string,
  options: { signal: AbortSignal; headers?: Record<string, string> },
): Promise<JsonFetchResult<T>> {
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: options.signal,
      headers: {
        accept: "application/json",
        // Some exchange APIs reject requests without a User-Agent.
        "user-agent": "koinmix-miner/0.1 (+https://github.com/koinmix)",
        ...options.headers,
      },
    });
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const aborted =
      options.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"));

    throw new ProviderError(
      provider,
      aborted ? "timeout" : "http",
      aborted
        ? `request aborted after ${latencyMs}ms`
        : `network error after ${latencyMs}ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
    );
  }

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    // Include a short snippet of the body — upstreams put the real reason
    // (bad key, rate limit, unknown symbol) there rather than in the status.
    const snippet = (await safeText(response)).slice(0, 200);
    throw new ProviderError(
      provider,
      "http",
      `upstream returned ${response.status} ${response.statusText}${
        snippet ? `: ${snippet}` : ""
      }`,
      response.status,
    );
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    throw new ProviderError(
      provider,
      "malformed",
      "upstream returned a body that was not valid JSON",
    );
  }

  return { data, latencyMs };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/** Strip a trailing slash so base URLs concatenate predictably. */
export function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
