import type { CandleSeries, PriceRound } from "../lib/api";
import type { AsyncState } from "../lib/hooks";
import {
  EM_DASH,
  formatAge,
  formatBps,
  formatConfidence,
  formatPercent,
  formatPrice,
} from "../lib/format";
import { Badge, Card, Skeleton, Stat, Unavailable, cx } from "./ui";

/**
 * The headline consensus figures.
 *
 * The 24h change is computed from the candle series alone — last close against
 * the close 24 hours earlier, both from the same venue — rather than by
 * comparing the multi-venue consensus against a single venue's old close. That
 * would mix two different measurements and quietly bake the cross-venue spread
 * into the percentage. When candles are unavailable the figure is omitted, not
 * approximated.
 */

interface Props {
  round: AsyncState<PriceRound>;
  candles: AsyncState<CandleSeries>;
  asset: string;
  quote: string;
  now: number;
}

interface Change24h {
  percent: number;
  absolute: number;
  source: string;
}

export function compute24hChange(series: CandleSeries | null): Change24h | null {
  if (!series || series.candles.length < 2) return null;

  const barsPerDay: Record<string, number> = {
    "1h": 24,
    "4h": 6,
    "1d": 1,
  };
  const span = barsPerDay[series.interval];
  // Weekly and monthly bars cannot express a 24h window at all.
  if (!span) return null;

  const candles = series.candles;
  const latest = candles[candles.length - 1];
  const earlier = candles[candles.length - 1 - span];
  if (!latest || !earlier || earlier.close <= 0) return null;

  return {
    percent: ((latest.close - earlier.close) / earlier.close) * 100,
    absolute: latest.close - earlier.close,
    source: series.source,
  };
}

export function PriceHeader({ round, candles, asset, quote, now }: Props) {
  const response = round.data?.response ?? null;
  const change = compute24hChange(candles.data);

  if (round.loading && !response) {
    return (
      <Card>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-10 w-48" />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-6 w-20" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (!response) {
    return (
      <Card>
        <Unavailable
          title={`No consensus price for ${asset}/${quote}`}
          detail={
            <>
              <span className="block">
                {round.error?.message ?? "The miner did not return a price."}
              </span>
              <span className="mt-1 block font-mono text-[11px]">
                {round.error?.code}
              </span>
              <span className="mt-2 block">
                The miner refuses rather than emitting a fabricated price when
                its providers cannot be reached.
              </span>
            </>
          }
          onRetry={round.refetch}
        />
      </Card>
    );
  }

  const priceValue = Number(response.price);
  const stale = round.error !== null;
  const observedAgeMs = now - Date.parse(response.observedAt);

  return (
    <Card>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Consensus price
            </span>
            {stale && (
              <Badge tone="warn" title={round.error?.message}>
                stale
              </Badge>
            )}
            {response.isStale && <Badge tone="warn">past staleness bound</Badge>}
          </div>

          <div className="tnum mt-1 text-4xl font-semibold tracking-tight text-ink">
            {formatPrice(priceValue)}
            <span className="ml-2 text-base font-normal text-ink-faint">
              {quote}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2 text-sm">
            {change ? (
              <>
                <span
                  className={cx(
                    "tnum font-medium",
                    change.percent >= 0 ? "text-up" : "text-down",
                  )}
                >
                  {formatPercent(change.percent)}
                </span>
                <span className="tnum text-ink-faint">
                  {change.absolute >= 0 ? "+" : ""}
                  {formatPrice(change.absolute)}
                </span>
                <span className="text-xs text-ink-faint">
                  24h · {change.source}
                </span>
              </>
            ) : (
              <span
                className="text-xs text-ink-faint"
                title="24h change needs an hourly, 4-hourly or daily candle series, which is not currently available"
              >
                24h change {EM_DASH} unavailable
              </span>
            )}
          </div>
        </div>

        <Stat
          label="Confidence"
          value={formatConfidence(response.confidence)}
          hint="reliability indicator, not a probability"
          tone={
            response.confidence >= 0.75
              ? "up"
              : response.confidence >= 0.5
                ? "default"
                : "warn"
          }
        />
        <Stat
          label="Sources"
          value={response.sourceCount}
          hint={response.sources.join(", ") || undefined}
          tone={response.sourceCount >= 3 ? "up" : response.sourceCount === 1 ? "warn" : "default"}
        />
        <Stat
          label="Spread"
          value={formatBps(response.spreadBps)}
          hint={`max deviation ${formatBps(response.deviationBps)}`}
        />
        <Stat
          label="Last update"
          value={formatAge(observedAgeMs)}
          hint={
            round.refreshing
              ? "refreshing…"
              : `observed ${new Date(response.asOf).toLocaleTimeString("en-GB", { hour12: false })}`
          }
        />
      </div>
    </Card>
  );
}
