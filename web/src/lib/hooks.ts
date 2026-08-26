import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getCandles,
  getHealth,
  getPriceRound,
  type CandleSeries,
  type Health,
  type PriceRound,
} from "./api";

/**
 * Async state with three distinct outcomes, kept distinct on purpose.
 *
 * `loading` is not "no data", and an error is not an empty result. Collapsing
 * them is how a dashboard ends up rendering a confident-looking zero while the
 * upstream is down.
 */
export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True during a background refresh while previous data is still shown. */
  refreshing: boolean;
  lastUpdated: number | null;
  refetch: () => void;
}

function useAsync<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  // Held in a ref so changing the callback identity does not restart polling.
  const runRef = useRef(run);
  runRef.current = run;

  const hasData = data !== null;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function load(isRefresh: boolean) {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const result = await runRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
        setLastUpdated(Date.now());
      } catch (caught) {
        if (cancelled) return;
        const apiError =
          caught instanceof ApiError
            ? caught
            : new ApiError(0, {
                error: caught instanceof Error ? caught.message : String(caught),
                code: "UNKNOWN",
              });
        // A cancelled request is bookkeeping, not a failure to report.
        if (apiError.code === "MINER_UNREACHABLE" && controller.signal.aborted) {
          return;
        }
        setError(apiError);
        // Deliberately keep prior `data`: stale-but-labelled beats a blank
        // panel on one failed poll. The UI marks it via `error` being set.
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void load(hasData);

    if (!pollMs) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const timer = setInterval(() => {
      // Polling a hidden tab burns provider rate limit for pixels nobody is
      // looking at. CoinGecko's keyless tier is the binding constraint here.
      if (document.visibilityState === "visible") void load(true);
    }, pollMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pollMs, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refreshing, lastUpdated, refetch };
}

export function useHealth(pollMs = 30_000): AsyncState<Health> {
  return useAsync<Health>((signal) => getHealth(signal), [], pollMs);
}

export function usePriceRound(
  asset: string,
  quote: string,
  pollMs: number,
): AsyncState<PriceRound> {
  return useAsync<PriceRound>(
    (signal) => getPriceRound(asset, quote, signal),
    [asset, quote],
    pollMs,
  );
}

export function useCandles(
  asset: string,
  interval: string,
  quote: string,
): AsyncState<CandleSeries> {
  return useAsync<CandleSeries>(
    (signal) => getCandles(asset, interval, quote, 300, signal),
    [asset, interval, quote],
    // Candles refresh far more slowly than the consensus price: even a 1h bar
    // only changes once an hour, and each poll costs an upstream call.
    120_000,
  );
}

/** Ticks once a second, so relative ages stay honest without re-fetching. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
