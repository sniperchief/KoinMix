/**
 * Live evaluation harness.
 *
 *   npm run evaluate                              # ETH/USD, 20 samples
 *   npm run evaluate -- ETH --samples 25          # match a specific sample size
 *   npm run evaluate -- BTC ETH --interval 8000   # several assets, slower cadence
 *   npm run evaluate -- SOL --out results.json    # keep the raw samples
 *
 * Every number this prints comes from a real HTTP call made during the run.
 * There is no recorded fixture, no replay mode and no expected-price table: if
 * the network is down the harness reports failures, it does not fill them in.
 * That is not incidental — the hackathon rules forbid simulated data, and an
 * evaluation that could fabricate its own inputs would be worth nothing anyway.
 *
 * This is a measurement tool, not a product feature. Nothing in `src/` imports
 * it, and it deliberately reuses the production consensus engine rather than
 * reimplementing one, so what it measures is what the miner actually does.
 *
 * Exits non-zero if too few rounds were scorable to say anything.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { loadEnvFile } from "../src/config/loadEnvFile.js";
import { reachConsensus } from "../src/consensus/engine.js";
import { isKoinMixError } from "../src/errors.js";
import { createLogger } from "../src/logging/logger.js";
import { collectQuotes } from "../src/providers/collect.js";
import { resolveAsset, supportedAssets } from "../src/providers/assets.js";
import { createProviderRegistry } from "../src/providers/registry.js";
import type { PriceQuery } from "../src/providers/types.js";
import {
  aggregationSeries,
  lagAnalysis,
  marketContext,
  pipelineEffect,
  providerSeries,
  reliability,
  scorableSamples,
  sweepOutlierFloor,
  weightingSweep,
  type ErrorSeries,
  type EvaluationSettings,
  type SampleRecord,
  type WeightingCandidate,
} from "./evaluation/metrics.js";
import {
  fetchReference,
  referenceInstrument,
  referenceSupportsQuote,
  REFERENCE_CAVEAT,
  REFERENCE_SOURCE,
} from "./evaluation/reference.js";

// ── Options ─────────────────────────────────────────────────────────────────

interface Options {
  readonly assets: readonly string[];
  readonly quote: string;
  readonly samples: number;
  readonly intervalMs: number;
  readonly outPath: string | null;
}

/**
 * Defaults are deliberately gentle. CoinGecko's keyless tier rate-limits in the
 * low tens of requests per minute, and a run that triggers 429s measures our
 * request cadence rather than provider accuracy.
 */
const DEFAULT_SAMPLES = 20;
const DEFAULT_INTERVAL_MS = 6000;

/** Candidate values for OUTLIER_MIN_DEVIATION_BPS in the threshold sweep. */
const SWEEP_FLOORS_BPS = [10, 25, 50, 100, 200] as const;

/**
 * Weighting schemes replayed against every round.
 *
 * The first entry reproduces uniform weighting exactly (half-life 0 disables
 * freshness decay), so the table always contains its own control rather than
 * asking the reader to compare against a number from another section.
 */
const WEIGHTING_CANDIDATES: readonly WeightingCandidate[] = [
  // Controls: the pre-Phase-4 scheme, then each half of the change on its own.
  // Without these two it would be impossible to tell whether a combined scheme
  // wins because of freshness, because of provenance, or by accident.
  { label: "uniform (Phase 3)", freshnessHalfLifeMs: 0, unverifiedFreshnessWeight: 1 },
  { label: "freshness only 10s", freshnessHalfLifeMs: 10_000, unverifiedFreshnessWeight: 1 },
  { label: "provenance only ½", freshnessHalfLifeMs: 0, unverifiedFreshnessWeight: 0.5 },
  // The grid.
  { label: "30s + unverified ½", freshnessHalfLifeMs: 30_000, unverifiedFreshnessWeight: 0.5 },
  { label: "20s + unverified ½", freshnessHalfLifeMs: 20_000, unverifiedFreshnessWeight: 0.5 },
  { label: "10s + unverified ½", freshnessHalfLifeMs: 10_000, unverifiedFreshnessWeight: 0.5 },
  { label: "5s + unverified ½", freshnessHalfLifeMs: 5_000, unverifiedFreshnessWeight: 0.5 },
  { label: "10s + unverified ¼", freshnessHalfLifeMs: 10_000, unverifiedFreshnessWeight: 0.25 },
];

/** Tag whichever candidate reproduces the configuration actually in force. */
function weightingCandidates(
  active: EvaluationSettings,
): readonly WeightingCandidate[] {
  return WEIGHTING_CANDIDATES.map((candidate) =>
    candidate.freshnessHalfLifeMs === active.freshnessHalfLifeMs &&
    candidate.unverifiedFreshnessWeight === active.unverifiedFreshnessWeight
      ? { ...candidate, label: `${candidate.label} *` }
      : candidate,
  );
}

/** Below this, differences between sources are indistinguishable from noise. */
const MIN_USEFUL_SAMPLES = 5;

function parseOptions(argv: readonly string[]): Options {
  const assets: string[] = [];
  let quote = "USD";
  let samples = DEFAULT_SAMPLES;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value!;
    };

    switch (arg) {
      case "--samples":
      case "-n":
        samples = positiveInt(next(), arg);
        break;
      case "--interval":
        intervalMs = positiveInt(next(), arg);
        break;
      case "--quote":
        quote = next().toUpperCase();
        break;
      case "--out":
        outPath = next();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option ${arg}`);
        assets.push(arg.toUpperCase());
    }
  }

  return {
    assets: assets.length > 0 ? assets : ["ETH"],
    quote,
    samples,
    intervalMs,
    outPath,
  };
}

function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${flag} expects a positive integer, got "${raw}"`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`evaluate: ${message}`);
  printUsage();
  process.exit(2);
}

function printUsage(): void {
  console.error(
    "\nUsage: npm run evaluate -- [ASSET...] [--samples N] [--interval MS] " +
      "[--quote CODE] [--out FILE]\n" +
      `\n  assets     ${supportedAssets().join(", ")}   (default ETH)` +
      `\n  --samples  rounds per asset (default ${DEFAULT_SAMPLES})` +
      `\n  --interval ms between rounds (default ${DEFAULT_INTERVAL_MS})` +
      "\n  --quote    USD or EUR (default USD)" +
      "\n  --out      write raw samples as JSON for independent checking\n",
  );
}

// ── Sampling ────────────────────────────────────────────────────────────────

loadEnvFile();

const config = loadConfig();
// Provider failures are reported in the tables; pino noise would bury them.
const logger = createLogger({
  ...config,
  log: { ...config.log, level: "silent" },
});
const registry = createProviderRegistry(config, logger);

const settings: EvaluationSettings = {
  minSources: config.consensus.minSources,
  maxDeviationBps: config.consensus.maxDeviationBps,
  maxStalenessMs: config.consensus.maxStalenessMs,
  outlierZThreshold: config.consensus.outlierZThreshold,
  // Mirrors the engine's default: the floor follows the round tolerance unless
  // explicitly overridden.
  outlierMinDeviationBps:
    config.consensus.outlierMinDeviationBps ?? config.consensus.maxDeviationBps,
  weights: config.consensus.weights,
  freshnessHalfLifeMs: config.consensus.freshnessHalfLifeMs,
  unverifiedFreshnessWeight: config.consensus.unverifiedFreshnessWeight,
};

/**
 * Run one round: every provider and the reference queried at the same instant.
 *
 * Simultaneity is the point. The providers and the reference are fetched
 * concurrently so that the comparison is between prices captured at the same
 * wall-clock moment; scoring against a reference fetched seconds later would
 * measure market drift and call it provider error.
 */
async function takeSample(index: number, query: PriceQuery): Promise<SampleRecord> {
  const capturedAt = new Date();
  const startedAt = performance.now();

  const [collected, reference] = await Promise.all([
    collectQuotes(
      registry.active(),
      query,
      config.providers.timeoutMs,
      logger,
    ),
    fetchReference(
      query.asset,
      query.quote,
      AbortSignal.timeout(config.providers.timeoutMs),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);

  const roundMs = Math.round(performance.now() - startedAt);
  const evaluatedAt = new Date();

  let consensus: SampleRecord["consensus"] = null;
  let consensusFailure: SampleRecord["consensusFailure"] = null;

  if (collected.quotes.length === 0) {
    consensusFailure = {
      code: "PROVIDER_UNAVAILABLE",
      message: "no provider returned a usable price",
    };
  } else {
    try {
      // The production engine, with the production configuration. Anything else
      // would evaluate an algorithm we do not actually ship.
      const result = reachConsensus(collected.quotes, {
        minSources: settings.minSources,
        maxDeviationBps: settings.maxDeviationBps,
        maxStalenessMs: settings.maxStalenessMs,
        outlierZThreshold: settings.outlierZThreshold,
        outlierMinDeviationBps: config.consensus.outlierMinDeviationBps,
        weights: settings.weights,
        freshnessHalfLifeMs: settings.freshnessHalfLifeMs,
        unverifiedFreshnessWeight: settings.unverifiedFreshnessWeight,
        providerFailureCount: collected.failures.length,
        now: evaluatedAt,
      });

      consensus = {
        price: result.price,
        method: result.method,
        sourceCount: result.sourceCount,
        sources: result.sources,
        spreadBps: result.spreadBps,
        deviationBps: result.deviationBps,
        confidence: result.confidence,
        isStale: result.isStale,
        excluded: result.excluded,
      };
    } catch (error) {
      consensusFailure = {
        code: isKoinMixError(error) ? error.code : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    index,
    capturedAt: capturedAt.toISOString(),
    evaluatedAt: evaluatedAt.toISOString(),
    roundMs,
    quotes: collected.quotes,
    failures: collected.failures,
    skipped: collected.skipped,
    reference: reference.ok ? reference.value : null,
    referenceFailure: reference.ok ? null : reference.reason,
    consensus,
    consensusFailure,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function money(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function bps(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "—";
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value / 100).toFixed(4)}%` : "—";
}

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// ── Report ──────────────────────────────────────────────────────────────────

const COLUMNS = "  SOURCE               N     MEAN      MED      MAX      MEAN%       ABS      AGE      LAT  FAIL";

function renderSeriesRow(series: ErrorSeries): string {
  const label = series.quoteProxy ? `${series.label} *` : series.label;
  return (
    "  " +
    padRight(label, 20) +
    padLeft(String(series.scored), 3) +
    padLeft(bps(series.meanBps), 9) +
    padLeft(bps(series.medianBps), 9) +
    padLeft(bps(series.maxBps), 9) +
    padLeft(pct(series.meanBps), 11) +
    padLeft(
      Number.isFinite(series.meanAbs) ? money(series.meanAbs) : "—",
      10,
    ) +
    padLeft(seconds(series.meanAgeMs), 9) +
    padLeft(seconds(series.meanLatencyMs), 9) +
    padLeft(series.failures > 0 ? String(series.failures) : "·", 6)
  );
}

function renderReport(
  query: PriceQuery,
  samples: readonly SampleRecord[],
): void {
  const providers = providerSeries(samples, settings);
  const aggregates = aggregationSeries(samples, settings);
  const stats = reliability(samples, settings);
  const market = marketContext(samples);
  const effect = pipelineEffect(samples);
  const sweep = sweepOutlierFloor(samples, settings, [...SWEEP_FLOORS_BPS]);
  const scorable = scorableSamples(samples, settings);

  const first = samples[0];
  const last = samples[samples.length - 1];

  console.log("");
  console.log("═".repeat(96));
  console.log(`KoinMix Evaluation — CRYPTO_PRICE`);
  console.log("═".repeat(96));
  console.log("");
  console.log(`  Asset            ${query.asset}/${query.quote}`);
  console.log(
    `  Samples          ${samples.length} taken, ${scorable.length} scorable` +
      (samples.length !== scorable.length
        ? ` (${samples.length - scorable.length} had no usable reference)`
        : ""),
  );
  if (first && last) {
    console.log(
      `  Window           ${first.capturedAt} → ${last.capturedAt}` +
        ` (${Math.round(
          (Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / 1000,
        )}s)`,
    );
  }
  console.log(
    `  Reference        ${REFERENCE_SOURCE} last trade on ` +
      `${referenceInstrument(query.asset, query.quote)}` +
      `, mean age ${seconds(stats.meanReferenceAgeMs)}`,
  );
  console.log(
    `  Providers        ${registry.active().map((p) => p.name).join(", ")}`,
  );
  console.log(
    `  Engine config    minSources=${settings.minSources} ` +
      `maxDeviation=${settings.maxDeviationBps}bps ` +
      `staleness=${settings.maxStalenessMs}ms ` +
      `z=${settings.outlierZThreshold} ` +
      `outlierFloor=${settings.outlierMinDeviationBps}bps`,
  );
  console.log(
    `                   halfLife=${settings.freshnessHalfLifeMs}ms ` +
      `unverifiedWeight=${settings.unverifiedFreshnessWeight} ` +
      `providerWeights=${
        Object.keys(settings.weights).length > 0
          ? JSON.stringify(settings.weights)
          : "uniform"
      }`,
  );
  console.log("");

  // ── Market context ──
  if (market) {
    console.log("MARKET CONTEXT  (from the reference series — how much there was to get wrong)");
    console.log(
      `  Reference range  ${money(market.low)} – ${money(market.high)}` +
        `  (${bps(market.rangeBps)} bps over ${Math.round(market.windowMs / 1000)}s)`,
    );
    console.log(
      `  Mean move/round  ${bps(market.meanMoveBps)} bps` +
        `   ← roughly the error a one-round-lagged quote inherits for free`,
    );
    console.log("");
  }

  // ── Accuracy ──
  console.log(`ACCURACY vs ${REFERENCE_SOURCE.toUpperCase()}  (error in basis points; 1 bp = 0.01%)`);
  console.log(COLUMNS);
  for (const series of providers) {
    console.log(renderSeriesRow(series));
  }
  console.log("  " + "─".repeat(88));
  for (const series of aggregates) {
    console.log(renderSeriesRow(series));
  }
  if (providers.some((p) => p.quoteProxy)) {
    console.log("  * priced against a stablecoin proxy for the requested fiat");
  }
  console.log(
    "  N counts only rounds this source answered, so flakiness shows in N/FAIL, not in the error.",
  );
  console.log("");

  // ── Reliability ──
  console.log("RELIABILITY");
  console.log(
    `  Provider failures      ${stats.totalFailures}` +
      (stats.failuresByProvider.length > 0
        ? `   (${stats.failuresByProvider.map(([n, c]) => `${n} ×${c}`).join(", ")})`
        : ""),
  );
  console.log(
    `  Rounds refused         ${stats.roundsFailed} / ${stats.rounds}`,
  );
  console.log(
    `  Sources per round      ` +
      (stats.sourceCountHistogram.length > 0
        ? stats.sourceCountHistogram
            .map(([count, n]) => `${count} src ×${n}`)
            .join(", ")
        : "—"),
  );
  console.log(
    `  Single-source rounds   ${stats.singleSourceRounds}` +
      (stats.singleSourceRounds > 0
        ? "   ← one provider alone decided the signal"
        : ""),
  );
  console.log(
    `  Spread across sources  mean ${bps(stats.meanSpreadBps)} bps, ` +
      `p90 ${bps(stats.p90SpreadBps)} bps, max ${bps(stats.maxSpreadBps)} bps ` +
      `(tolerance ${settings.maxDeviationBps} bps)`,
  );
  console.log(
    `  Confidence             mean ${stats.meanConfidence.toFixed(4)}, ` +
      `min ${stats.minConfidence.toFixed(4)}`,
  );
  console.log(`  Round latency          mean ${seconds(stats.meanRoundMs)}`);
  console.log("");

  // ── What the pipeline did ──
  console.log("PIPELINE EFFECT  (what our algorithm changed vs a plain median of the same quotes)");
  console.log(
    `  Rounds altered         ${effect.roundsChanged} / ${effect.roundsCompared}` +
      (effect.roundsChanged > 0
        ? `   (mean shift ${bps(effect.meanShiftBps)} bps)`
        : "   ← KoinMix returned exactly the plain median every round"),
  );
  console.log(`  Stale quotes dropped   ${effect.staleExclusions}`);
  console.log(`  Outliers excluded      ${effect.outlierExclusions}`);
  console.log("");

  // ── Lag check ──
  const lag = lagAnalysis(samples, settings);
  if (lag.some((row) => Number.isFinite(row.errorAlignedBps))) {
    console.log("LAG CHECK  (wrong, or merely late? each quote re-scored against the reference at its OWN timestamp)");
    console.log("  PROVIDER                AGE    ERR vs NOW   ERR vs THEN     N");
    for (const row of lag) {
      console.log(
        "  " +
          padRight(row.provider, 18) +
          padLeft(seconds(row.meanAgeMs), 9) +
          padLeft(bps(row.errorNowBps), 14) +
          padLeft(bps(row.errorAlignedBps), 14) +
          padLeft(String(row.aligned), 6),
      );
    }
    console.log(
      "  A large drop from NOW to THEN means the source was right about an earlier moment —",
    );
    console.log(
      "  a staleness problem to be discounted by age, not an accuracy problem to be distrusted.",
    );
    console.log("");
  }

  // ── Weighting candidates ──
  console.log("WEIGHTING CANDIDATES  (identical quotes, identical exclusions — only the weights differ)");
  console.log(COLUMNS);
  for (const series of weightingSweep(
    samples,
    settings,
    weightingCandidates(settings),
  )) {
    console.log(renderSeriesRow(series));
  }
  console.log("  * configuration actually in force this run");
  console.log("");

  // ── Threshold sweep ──
  console.log("OUTLIER FLOOR SWEEP  (replaying every round at other OUTLIER_MIN_DEVIATION_BPS values)");
  console.log("  FLOOR    EXCLUSIONS   ROUNDS HIT    MEAN ERR     MAX ERR");
  for (const row of sweep) {
    console.log(
      "  " +
        padRight(`${row.floorBps} bps${row.isCurrent ? " *" : ""}`, 9) +
        padLeft(String(row.exclusions), 10) +
        padLeft(String(row.roundsAffected), 13) +
        padLeft(bps(row.meanBps), 12) +
        padLeft(bps(row.maxBps), 12),
    );
  }
  console.log("  * current setting");
  console.log("");

  // ── Findings ──
  console.log("FINDINGS");
  for (const line of findings(providers, aggregates, stats, effect, sweep)) {
    console.log(`  ${line}`);
  }
  console.log("");
  console.log(`REFERENCE CAVEAT`);
  console.log(`  ${REFERENCE_CAVEAT}`);
  console.log("");
}

/**
 * Statements assembled from the measured values only.
 *
 * Every sentence here is a template filled with numbers computed above — no
 * interpretation is baked in, so a run that contradicts our design assumptions
 * says so in its own output rather than being quietly explained away.
 */
function findings(
  providers: readonly ErrorSeries[],
  aggregates: readonly ErrorSeries[],
  stats: ReturnType<typeof reliability>,
  effect: ReturnType<typeof pipelineEffect>,
  sweep: ReturnType<typeof sweepOutlierFloor>,
): readonly string[] {
  const lines: string[] = [];

  const scored = providers.filter((p) => p.scored > 0);
  const koinmix = aggregates.find((a) => a.kind === "koinmix");
  const plainMedian = aggregates.find((a) => a.label.includes("median"));

  if (!koinmix || koinmix.scored === 0 || scored.length === 0) {
    return ["Not enough scorable rounds to draw a conclusion."];
  }

  // 1. Does consensus improve accuracy?
  const byMean = [...scored].sort((a, b) => a.meanBps - b.meanBps);
  const best = byMean[0]!;
  const worst = byMean[byMean.length - 1]!;
  const beaten = scored.filter((p) => p.meanBps > koinmix.meanBps).length;

  lines.push(
    `1. Mean error: KoinMix ${bps(koinmix.meanBps)} bps, beating ${beaten} of ` +
      `${scored.length} single sources. Best single was ${best.label} at ` +
      `${bps(best.meanBps)} bps; worst was ${worst.label} at ${bps(worst.meanBps)} bps.`,
  );

  const byMax = [...scored].sort((a, b) => a.maxBps - b.maxBps);
  const bestMax = byMax[0]!;
  const beatenMax = scored.filter((p) => p.maxBps > koinmix.maxBps).length;
  lines.push(
    `   Worst round: KoinMix ${bps(koinmix.maxBps)} bps, better than ` +
      `${beatenMax} of ${scored.length} single sources ` +
      `(best single tail was ${bestMax.label} at ${bps(bestMax.maxBps)} bps). ` +
      `Tail behaviour is what aggregation is bought for.`,
  );

  // 2. Which sources are reliable?
  const flaky = scored.filter((p) => p.failures > 0);
  lines.push(
    `2. Availability: ` +
      (flaky.length === 0
        ? `no provider failed in ${stats.rounds} rounds.`
        : flaky
            .map((p) => `${p.label} failed ${p.failures}×`)
            .join(", ") + `, out of ${stats.rounds} rounds.`),
  );

  const laggiest = [...scored]
    .filter((p) => p.meanAgeMs !== null)
    .sort((a, b) => (b.meanAgeMs ?? 0) - (a.meanAgeMs ?? 0))[0];
  if (laggiest?.meanAgeMs != null) {
    lines.push(
      `   Staleness: ${laggiest.label} quotes were the oldest at ` +
        `${seconds(laggiest.meanAgeMs)} mean age — part of its error is lag, not inaccuracy.`,
    );
  }

  // 3. Thresholds.
  lines.push(
    `3. Thresholds: observed spread peaked at ${bps(stats.maxSpreadBps)} bps ` +
      `against a ${settings.maxDeviationBps} bps tolerance ` +
      `(${((stats.maxSpreadBps / settings.maxDeviationBps) * 100).toFixed(0)}% of budget used at worst).` +
      (stats.singleSourceRounds > 0
        ? ` ${stats.singleSourceRounds} round(s) rested on a single source at minSources=${settings.minSources}.`
        : ""),
  );

  // 4. Does outlier detection help?
  const current = sweep.find((r) => r.isCurrent);
  const bestSweep = [...sweep]
    .filter((r) => Number.isFinite(r.meanBps))
    .sort((a, b) => a.meanBps - b.meanBps)[0];
  lines.push(
    `4. Outliers: ${effect.outlierExclusions} excluded at the current ` +
      `${settings.outlierMinDeviationBps} bps floor` +
      (current && bestSweep
        ? `; sweeping the floor, best mean error was ${bps(bestSweep.meanBps)} bps at ` +
          `${bestSweep.floorBps} bps vs ${bps(current.meanBps)} bps at the current setting.`
        : "."),
  );

  if (plainMedian && effect.roundsChanged === 0) {
    lines.push(
      `   With uniform weights and nothing excluded, KoinMix reduces exactly to ` +
        `the plain median — the guards cost nothing but bought nothing here either.`,
    );
  }

  // 5. Provider failure behaviour.
  lines.push(
    `5. Under failure: ${stats.roundsFailed} of ${stats.rounds} rounds were ` +
      `refused outright; the rest degraded to fewer sources ` +
      `(${stats.sourceCountHistogram.map(([c, n]) => `${c}×${n}`).join(", ")}) ` +
      `with confidence falling to ${stats.minConfidence.toFixed(4)} at worst.`,
  );

  return lines;
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const providers = registry.active();

  if (providers.length === 0) {
    console.error(
      "No active providers. Set PRICE_PROVIDERS (and any required API key).",
    );
    process.exit(1);
  }

  if (!referenceSupportsQuote(options.quote)) {
    console.error(
      `The evaluation reference (${REFERENCE_SOURCE}) has no verified fiat ` +
        `market for ${options.quote}. Use USD or EUR.`,
    );
    process.exit(2);
  }

  for (const asset of options.assets) {
    if (!resolveAsset(asset)) {
      console.error(
        `Unsupported asset "${asset}". Known: ${supportedAssets().join(", ")}`,
      );
      process.exit(2);
    }
  }

  const everything: Record<string, readonly SampleRecord[]> = {};

  for (const asset of options.assets) {
    const query: PriceQuery = { asset, quote: options.quote };
    const samples: SampleRecord[] = [];

    console.log(
      `\nSampling ${asset}/${options.quote} — ${options.samples} rounds every ` +
        `${options.intervalMs}ms (~${Math.round(
          (options.samples * options.intervalMs) / 1000,
        )}s), live upstreams only.\n`,
    );

    for (let i = 0; i < options.samples; i += 1) {
      const sample = await takeSample(i, query);
      samples.push(sample);
      console.log(progressLine(sample, options.samples));

      if (i < options.samples - 1) {
        await sleep(options.intervalMs);
      }
    }

    everything[`${asset}/${options.quote}`] = samples;
    renderReport(query, samples);
  }

  if (options.outPath) {
    writeFileSync(
      options.outPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), settings, samples: everything },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`Raw samples written to ${options.outPath}\n`);
  }

  const scorableTotal = Object.values(everything).reduce(
    (n, samples) => n + scorableSamples(samples, settings).length,
    0,
  );

  if (scorableTotal < MIN_USEFUL_SAMPLES) {
    console.error(
      `Only ${scorableTotal} scorable round(s) — too few to conclude anything. ` +
        "Check network access to the providers and the reference.",
    );
    process.exit(1);
  }
}

/** One line per round, so a long run is visibly live rather than hung. */
function progressLine(sample: SampleRecord, total: number): string {
  const n = padLeft(`${sample.index + 1}/${total}`, 7);
  const ref = sample.reference ? money(sample.reference.price) : "ref FAILED";
  const price = sample.consensus
    ? money(sample.consensus.price)
    : `refused (${sample.consensusFailure?.code ?? "?"})`;

  const error =
    sample.consensus && sample.reference
      ? `${padLeft(
          (
            (Math.abs(sample.consensus.price - sample.reference.price) /
              sample.reference.price) *
            10_000
          ).toFixed(1),
          6,
        )} bps`
      : padLeft("—", 10);

  return (
    `  [${n}]  ref ${padLeft(ref, 12)}   koinmix ${padLeft(price, 12)}   ` +
    `err ${error}   spread ${padLeft(
      sample.consensus ? `${sample.consensus.spreadBps}` : "—",
      4,
    )} bps   ` +
    `src ${sample.quotes.length}` +
    (sample.failures.length > 0
      ? `   fail ${sample.failures.map((f) => `${f.provider}:${f.kind}`).join(",")}`
      : "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
