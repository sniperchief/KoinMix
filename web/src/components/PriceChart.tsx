import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CandleSeries } from "../lib/api";
import type { AsyncState } from "../lib/hooks";
import { Badge, Card, Skeleton, Unavailable, cx } from "./ui";

/**
 * Price chart.
 *
 * Draws only bars the venue actually traded. There is no gap-filling, no
 * interpolation and no forward-fill: if a source cannot serve an interval the
 * card renders an unavailable state, because a chart is the one place where
 * invented data is both easiest to produce and hardest to spot.
 */

interface Props {
  series: AsyncState<CandleSeries>;
  interval: string;
  intervals: string[];
  onIntervalChange: (interval: string) => void;
  asset: string;
  quote: string;
}

export function PriceChart({
  series,
  interval,
  intervals,
  onIntervalChange,
  asset,
  quote,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const data = series.data;

  // Create the chart once; data updates go through setData below.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa4b2",
        fontFamily:
          'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.07)" },
        horzLines: { color: "rgba(148,163,184,0.07)" },
      },
      rightPriceScale: {
        borderColor: "rgba(148,163,184,0.18)",
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderColor: "rgba(148,163,184,0.18)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(148,163,184,0.4)", labelBackgroundColor: "#334155" },
        horzLine: { color: "rgba(148,163,184,0.4)", labelBackgroundColor: "#334155" },
      },
      // Zoom and pan, on both axes and by wheel/pinch/drag.
      handleScroll: true,
      handleScale: true,
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#2ec27e",
      downColor: "#e5484d",
      wickUpColor: "#2ec27e",
      wickDownColor: "#e5484d",
      borderVisible: false,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    // Pin volume to the lower quarter so it never competes with price.
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candlesRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  // Push data whenever a new series arrives.
  useEffect(() => {
    const candleSeries = candlesRef.current;
    const volumeSeries = volumeRef.current;
    if (!candleSeries || !volumeSeries) return;

    if (!data || data.candles.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      return;
    }

    candleSeries.setData(
      data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    volumeSeries.setData(
      data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color:
          c.close >= c.open ? "rgba(46,194,126,0.34)" : "rgba(229,72,77,0.34)",
      })),
    );

    chartRef.current?.timeScale().fitContent();
  }, [data]);

  const showChart = data !== null && data.candles.length > 0;

  return (
    <Card
      title={`${asset}/${quote}`}
      subtitle={
        data
          ? `${data.candles.length} bars · ${data.source} · ${data.instrument}`
          : "historical candles"
      }
      actions={
        <div className="flex items-center gap-2">
          {data?.isQuoteProxy && (
            <Badge tone="warn" title={`Priced against ${data.instrument}, a stablecoin proxy for ${quote}`}>
              proxy quote
            </Badge>
          )}
          <div className="flex overflow-hidden rounded border border-line-strong">
            {intervals.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onIntervalChange(option)}
                aria-pressed={option === interval}
                className={cx(
                  "px-2.5 py-1 text-xs font-medium transition-colors",
                  option === interval
                    ? "bg-surface-2 text-ink"
                    : "text-ink-faint hover:text-ink-muted",
                )}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="relative h-[380px] w-full">
        {/* The chart element always exists so the library keeps its instance. */}
        <div
          ref={containerRef}
          className={cx("h-full w-full", !showChart && "invisible")}
        />

        {!showChart && (
          <div className="absolute inset-0">
            {series.loading ? (
              <div className="flex h-full flex-col gap-2 p-2">
                <Skeleton className="h-full w-full" />
              </div>
            ) : (
              <Unavailable
                title="Historical data unavailable"
                detail={
                  series.error ? (
                    <>
                      <span className="block">{series.error.message}</span>
                      {renderFailureDetail(series.error.details)}
                      <span className="mt-2 block text-ink-faint">
                        No candles are drawn rather than approximating this
                        interval from shorter bars.
                      </span>
                    </>
                  ) : (
                    `No source returned candles for ${asset}/${quote} at ${interval}.`
                  )
                }
                onRetry={series.refetch}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Show which venue refused and why — the miner reports it per source. */
function renderFailureDetail(details: Record<string, unknown>) {
  const failures = details.failures;
  if (!Array.isArray(failures) || failures.length === 0) return null;

  return (
    <span className="mt-2 block space-y-0.5 text-left">
      {failures.map((failure, index) => {
        const row = failure as { source?: string; reason?: string };
        return (
          <span key={index} className="block font-mono text-[11px]">
            {row.source}: {row.reason}
          </span>
        );
      })}
    </span>
  );
}
