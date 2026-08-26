import type { ReactNode } from "react";

/**
 * Small presentational primitives.
 *
 * Hand-rolled rather than pulled from shadcn/ui: this terminal needs a card, a
 * badge, a stat and two state placeholders, and none of them need the Radix
 * behaviour (focus traps, portals, controlled open state) that makes shadcn
 * worth its install. The dependency would be larger than the code it replaced.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "rounded-lg border border-line bg-surface-1 shadow-sm",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold tracking-tight text-ink">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "up" | "down" | "warn";
}) {
  const toneClass =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warn"
          ? "text-warn"
          : "text-ink";

  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className={cx("tnum mt-1 truncate text-lg", toneClass)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-line-strong text-ink-muted",
    ok: "border-up/40 text-up",
    warn: "border-warn/40 text-warn",
    bad: "border-down/40 text-down",
    info: "border-accent/40 text-accent",
  };

  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Loading placeholder. Never renders a number — an empty box cannot mislead. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx("animate-pulse rounded bg-surface-2", className)}
      aria-hidden="true"
    />
  );
}

/**
 * The explicit "we have no real value for this" state.
 *
 * Used wherever data could not be retrieved, in place of a zero or a dash that
 * might be mistaken for a reading.
 */
export function Unavailable({
  title,
  detail,
  onRetry,
  compact,
}: {
  title: string;
  detail?: ReactNode;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center rounded border border-dashed border-line-strong text-center",
        compact ? "gap-1 p-4" : "gap-2 p-8",
      )}
    >
      <div className="text-sm font-medium text-ink-muted">{title}</div>
      {detail && (
        <div className="max-w-lg text-xs leading-relaxed text-ink-faint">
          {detail}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded border border-line-strong px-2 py-1 text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent"
        >
          Retry
        </button>
      )}
    </div>
  );
}
