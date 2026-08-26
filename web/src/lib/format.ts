/**
 * Display formatting.
 *
 * Every function here takes a real value and renders it, or renders an explicit
 * placeholder when the value is genuinely absent. None of them substitute a
 * default number — `formatPrice(undefined)` is "—", never "0.00", because a
 * zero in a price column reads as data.
 */

const EM_DASH = "—";

export function formatPrice(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return EM_DASH;
  }
  // Sub-dollar assets need more precision than BTC does.
  const decimals = value >= 1000 ? 2 : value >= 1 ? 2 : 6;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(
  value: number | undefined | null,
  decimals = 2,
): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return EM_DASH;
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatBps(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return EM_DASH;
  }
  return `${value} bps`;
}

export function formatConfidence(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return EM_DASH;
  }
  return value.toFixed(4);
}

/** Compact relative age, e.g. "3s ago", "2m ago". */
export function formatAge(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 1000) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return EM_DASH;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatClock(iso: string | undefined | null): string {
  if (!iso) return EM_DASH;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return EM_DASH;
  return new Date(parsed).toLocaleTimeString("en-GB", { hour12: false });
}

export { EM_DASH };
