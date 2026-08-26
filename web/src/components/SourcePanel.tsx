import type { Health, PriceRound } from "../lib/api";
import type { AsyncState } from "../lib/hooks";
import {
  EM_DASH,
  formatAge,
  formatBps,
  formatConfidence,
  formatDuration,
  formatPrice,
} from "../lib/format";
import { Badge, Card, Skeleton, Unavailable, cx } from "./ui";

/**
 * Per-source transparency.
 *
 * Every provider the miner attempted appears here, including the ones that
 * failed — a source panel that silently omits failures overstates how much
 * agreement stood behind the price. Providers are listed from the miner's own
 * configured set, so a provider that returned nothing shows as failed rather
 * than simply vanishing from the table.
 */

interface Props {
  round: AsyncState<PriceRound>;
  health: AsyncState<Health>;
  quote: string;
}

type RowStatus = "live" | "excluded" | "failed" | "skipped" | "unknown";

interface Row {
  provider: string;
  price: number | null;
  ageMs: number | null;
  latencyMs: number | null;
  instrument: string | null;
  status: RowStatus;
  detail: string | null;
  weight: number | null;
  isQuoteProxy: boolean;
  unverifiedTimestamp: boolean;
}

function buildRows(round: PriceRound | null, configured: string[]): Row[] {
  if (!round) return [];

  const { diagnostics } = round;
  const names = new Set<string>([
    ...configured,
    ...diagnostics.quotes.map((q) => q.provider),
    ...diagnostics.failures.map((f) => f.provider),
    ...diagnostics.skipped,
  ]);

  return [...names].sort().map((provider) => {
    const quote = diagnostics.quotes.find((q) => q.provider === provider);
    const failure = diagnostics.failures.find((f) => f.provider === provider);
    const exclusion = diagnostics.excluded.find((e) => e.provider === provider);
    const weight = diagnostics.weights.find((w) => w.provider === provider);
    const skipped = diagnostics.skipped.includes(provider);

    let status: RowStatus = "unknown";
    let detail: string | null = null;

    if (exclusion) {
      status = "excluded";
      detail = exclusion.detail;
    } else if (quote) {
      status = "live";
    } else if (failure) {
      status = "failed";
      detail = `${failure.kind}: ${failure.reason}`;
    } else if (skipped) {
      status = "skipped";
      detail = "provider does not serve this pair";
    }

    return {
      provider,
      price: quote?.price ?? exclusion?.price ?? null,
      ageMs: quote?.ageMs ?? null,
      latencyMs: quote?.latencyMs ?? failure?.latencyMs ?? null,
      instrument: quote?.instrument ?? null,
      status,
      detail,
      weight: weight?.weight ?? null,
      isQuoteProxy: quote?.isQuoteProxy ?? false,
      unverifiedTimestamp: quote?.timestampProvenance === "response",
    };
  });
}

const STATUS_BADGE: Record<RowStatus, { tone: "ok" | "warn" | "bad" | "neutral"; label: string }> = {
  live: { tone: "ok", label: "live" },
  excluded: { tone: "warn", label: "outlier" },
  failed: { tone: "bad", label: "failed" },
  skipped: { tone: "neutral", label: "skipped" },
  unknown: { tone: "neutral", label: "—" },
};

export function SourcePanel({ round, health, quote }: Props) {
  const configured = health.data?.providers.enabled ?? [];
  const rows = buildRows(round.data, configured);
  const response = round.data?.response ?? null;
  const diagnostics = round.data?.diagnostics ?? null;

  return (
    <Card
      title="Source consensus"
      subtitle="every provider the miner attempted this round"
      actions={
        diagnostics && (
          <span className="text-xs text-ink-faint">
            round {formatDuration(diagnostics.roundMs)}
          </span>
        )
      }
    >
      {round.loading && rows.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Unavailable
          title="No provider data"
          detail={round.error?.message ?? "The miner returned no round detail."}
          onRetry={round.refetch}
          compact
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 text-right font-medium">Price</th>
                <th className="pb-2 text-right font-medium">Weight</th>
                <th className="pb-2 text-right font-medium">Observed</th>
                <th className="pb-2 text-right font-medium">Latency</th>
                <th className="pb-2 pl-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const badge = STATUS_BADGE[row.status];
                return (
                  <tr
                    key={row.provider}
                    className="border-b border-line/60 last:border-0"
                    title={row.detail ?? undefined}
                  >
                    <td className="py-2.5">
                      <div className="font-medium text-ink">{row.provider}</div>
                      {row.instrument && (
                        <div className="font-mono text-[11px] text-ink-faint">
                          {row.instrument}
                          {row.isQuoteProxy && " *"}
                        </div>
                      )}
                    </td>
                    <td
                      className={cx(
                        "tnum py-2.5 text-right",
                        row.status === "live" ? "text-ink" : "text-ink-faint",
                      )}
                    >
                      {row.price === null ? EM_DASH : formatPrice(row.price)}
                    </td>
                    <td className="tnum py-2.5 text-right text-ink-muted">
                      {row.weight === null ? EM_DASH : row.weight.toFixed(3)}
                    </td>
                    <td className="tnum py-2.5 text-right text-ink-muted">
                      {row.ageMs === null ? EM_DASH : formatAge(row.ageMs)}
                      {row.unverifiedTimestamp && (
                        <span
                          className="ml-1 text-warn"
                          title="Provider reports a response time, not an observation time — its true age cannot be verified"
                        >
                          ?
                        </span>
                      )}
                    </td>
                    <td className="tnum py-2.5 text-right text-ink-faint">
                      {row.latencyMs === null
                        ? EM_DASH
                        : formatDuration(row.latencyMs)}
                    </td>
                    <td className="py-2.5 pl-3">
                      <Badge tone={badge.tone} title={row.detail ?? undefined}>
                        {badge.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {rows.some((r) => r.isQuoteProxy) && (
            <p className="mt-3 text-[11px] text-ink-faint">
              * priced against a stablecoin proxy for {quote}
            </p>
          )}
          {rows.some((r) => r.unverifiedTimestamp) && (
            <p className="mt-1 text-[11px] text-ink-faint">
              ? timestamp is a response time, so the quote&apos;s true age cannot
              be verified — it carries reduced weight
            </p>
          )}
        </div>
      )}

      {response && (
        <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-4">
          <SummaryCell
            label="KoinMix consensus"
            value={formatPrice(Number(response.price))}
            emphasis
          />
          <SummaryCell label="Spread" value={formatBps(response.spreadBps)} />
          <SummaryCell
            label="Confidence"
            value={formatConfidence(response.confidence)}
          />
          <SummaryCell
            label="Sources available"
            value={`${response.sourceCount} of ${rows.length || EM_DASH}`}
          />
        </div>
      )}
    </Card>
  );
}

function SummaryCell({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div
        className={cx(
          "tnum mt-0.5",
          emphasis ? "text-lg font-semibold text-ink" : "text-sm text-ink-muted",
        )}
      >
        {value}
      </div>
    </div>
  );
}
