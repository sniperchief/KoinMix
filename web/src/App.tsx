import { useEffect, useState } from "react";
import { PriceChart } from "./components/PriceChart";
import { PriceHeader } from "./components/PriceHeader";
import { SourcePanel } from "./components/SourcePanel";
import { TelegraphPanel } from "./components/TelegraphPanel";
import { Badge, Unavailable, cx } from "./components/ui";
import { MINER_URL } from "./lib/api";
import { useCandles, useHealth, useNow, usePriceRound } from "./lib/hooks";

/**
 * KoinMix — market intelligence terminal.
 *
 * A demonstration surface for the miner, not a trading product. Every figure it
 * renders comes from a live miner response; there is no fixture data anywhere in
 * this app, and each panel degrades to an explicit unavailable state instead of
 * filling gaps.
 */

const QUOTE = "USD";
const PRICE_POLL_MS = 15_000;

/** Fallbacks used only until /healthz answers, never in place of real data. */
const DEFAULT_ASSETS = ["BTC", "ETH"];
const DEFAULT_INTERVALS = ["1h", "4h", "1d", "1w", "1M"];

export default function App() {
  const health = useHealth();
  const [asset, setAsset] = useState("BTC");
  // Named chartInterval, not interval: a state setter called `setInterval`
  // shadows the global timer function inside this component.
  const [chartInterval, setChartInterval] = useState("1h");

  // The miner advertises what it can serve, so the selector never offers an
  // asset the backend would refuse.
  const assets = health.data?.assets?.length ? health.data.assets : DEFAULT_ASSETS;
  const intervals = health.data?.intervals?.length
    ? health.data.intervals
    : DEFAULT_INTERVALS;

  useEffect(() => {
    if (assets.length > 0 && !assets.includes(asset)) setAsset(assets[0]!);
  }, [assets, asset]);

  const round = usePriceRound(asset, QUOTE, PRICE_POLL_MS);
  const candles = useCandles(asset, chartInterval, QUOTE);
  const now = useNow();

  // The 24h change needs an intraday series; when the chart is on a weekly or
  // monthly interval, fetch an hourly series alongside it purely for that
  // figure rather than deriving it from bars that cannot express 24 hours.
  const intradayForChange = useCandles(
    asset,
    chartInterval === "1w" || chartInterval === "1M" ? "1h" : chartInterval,
    QUOTE,
  );

  const unreachable =
    health.error?.code === "MINER_UNREACHABLE" &&
    round.error?.code === "MINER_UNREACHABLE";

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-surface-0/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight text-ink">
              KoinMix
            </h1>
            <span className="text-xs text-ink-faint">
              CRYPTO_PRICE consensus
            </span>
          </div>

          <nav className="flex overflow-hidden rounded border border-line-strong">
            {assets.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setAsset(option)}
                aria-pressed={option === asset}
                className={cx(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  option === asset
                    ? "bg-surface-2 text-ink"
                    : "text-ink-faint hover:text-ink-muted",
                )}
              >
                {option}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <MinerStatus health={health} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5">
        {unreachable ? (
          <Unavailable
            title="Miner unreachable"
            detail={
              <>
                <span className="block">
                  Nothing is reachable at{" "}
                  <code className="font-mono text-[11px]">{MINER_URL}</code>.
                </span>
                <span className="mt-2 block">
                  Start it with{" "}
                  <code className="font-mono text-[11px]">npm start</code> in the
                  project root, or point this terminal elsewhere with{" "}
                  <code className="font-mono text-[11px]">VITE_MINER_URL</code>.
                </span>
                <span className="mt-2 block">
                  No cached or placeholder prices are shown while it is down.
                </span>
              </>
            }
            onRetry={() => {
              health.refetch();
              round.refetch();
            }}
          />
        ) : (
          <div className="space-y-5">
            <PriceHeader
              round={round}
              candles={intradayForChange}
              asset={asset}
              quote={QUOTE}
              now={now}
            />

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <PriceChart
                  series={candles}
                  interval={chartInterval}
                  intervals={intervals}
                  onIntervalChange={setChartInterval}
                  asset={asset}
                  quote={QUOTE}
                />
              </div>
              <div className="lg:col-span-1">
                <TelegraphPanel asset={asset} quote={QUOTE} />
              </div>
            </div>

            <SourcePanel round={round} health={health} quote={QUOTE} />
          </div>
        )}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-2">
        <p className="text-[11px] leading-relaxed text-ink-faint">
          All figures are fetched live from the KoinMix miner and its upstream
          market-data providers. Nothing on this page is simulated: where a value
          cannot be retrieved it is shown as unavailable rather than estimated.
          Confidence is a bounded reliability indicator, not a probability.
        </p>
      </footer>
    </div>
  );
}

function MinerStatus({
  health,
}: {
  health: ReturnType<typeof useHealth>;
}) {
  if (health.loading && !health.data) {
    return <span className="text-xs text-ink-faint">connecting…</span>;
  }

  if (!health.data) {
    return <Badge tone="bad">miner offline</Badge>;
  }

  const { status, providers, minerSlug } = health.data;
  const active = providers.active.length;
  const enabled = providers.enabled.length;

  return (
    <div className="flex items-center gap-2">
      <Badge tone={status === "ok" ? "ok" : "warn"} title={minerSlug}>
        <span
          className={cx(
            "live-dot size-1.5 rounded-full",
            status === "ok" ? "bg-up" : "bg-warn",
          )}
        />
        {status === "ok" ? "live" : "degraded"}
      </Badge>
      <span
        className="text-xs text-ink-faint"
        title={`active: ${providers.active.join(", ") || "none"}`}
      >
        {active}/{enabled} providers
      </span>
    </div>
  );
}
