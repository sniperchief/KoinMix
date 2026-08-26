import { z } from "zod";
import {
  DEFAULT_FRESHNESS_HALF_LIFE_MS,
  DEFAULT_UNVERIFIED_FRESHNESS_WEIGHT,
} from "../consensus/weighting.js";

/**
 * The ONLY module in the application permitted to read `process.env`.
 *
 * Everything else receives configuration by injection. This keeps secrets out of
 * arbitrary modules and makes the whole surface testable by passing a plain
 * object into `loadConfig()`.
 */

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // ── HTTP server ──────────────────────────────────────────────────────────
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /**
   * Origin allowed to call this miner from a browser, for the demo terminal.
   *
   * Defaults to `*` because every route is public read-only market data with no
   * cookies or credentials, so this grants a browser nothing it could not get
   * by calling the API directly. Set an explicit origin to restrict it.
   */
  CORS_ALLOW_ORIGIN: z.string().min(1).default("*"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_PRETTY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ── Telegraph miner identity ─────────────────────────────────────────────
  // `slug` and `id` are also declared in telegraph/koinmix.yaml; the YAML is the
  // artifact Telegraph nodes actually read. These mirror it for logs/health.
  MINER_SLUG: z.string().regex(KEBAB_CASE).default("koinmix-crypto-price"),
  MINER_SUBNET_ID: z.coerce.number().int().nonnegative().default(9001),

  /**
   * Floor price per call, in USDC. Telegraph's protocol floor is $0.01 and the
   * on-chain value committed at `registerMiner()` is the source of truth; this
   * is mirrored here (and in the YAML) for documentation and health output.
   */
  MIN_PRICE_USDC: z.coerce.number().min(0.01).default(0.01),

  /** EVM address that receives miner payouts. Required only at registration. */
  MINER_FEE_ADDRESS: z.string().regex(EVM_ADDRESS).optional(),

  // ── Price provider layer ─────────────────────────────────────────────────
  /**
   * Comma-separated list of provider names to enable.
   *
   * All four run without credentials, so a fresh checkout serves live prices
   * immediately. CoinMarketCap falls back to its keyless public endpoint, which
   * is USD-only; setting COINMARKETCAP_API_KEY upgrades it in place.
   */
  PRICE_PROVIDERS: z
    .string()
    .default("coingecko,coinmarketcap,binance,coinbase")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /**
   * How long a successful provider quote may be reused before the provider is
   * asked again. `0` disables caching.
   *
   * Exists because every round fans out to every provider, which drove the
   * keyless tiers into rate limiting — CoinGecko returned HTTP 429 on 16 of 50
   * evaluation rounds. The default is deliberately far below
   * PRICE_MAX_STALENESS_MS: a cached quote keeps its original upstream `asOf`
   * and goes on ageing, so the staleness bound and the freshness half-life
   * discount it exactly as they would any other quote of that age.
   */
  PROVIDER_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(3000),

  // ── Consensus engine ─────────────────────────────────────────────────────
  /** Minimum number of agreeing provider quotes required to emit a signal. */
  CONSENSUS_MIN_SOURCES: z.coerce.number().int().positive().default(1),
  /** Reject the round if surviving quotes span more than this, in bps. */
  CONSENSUS_MAX_DEVIATION_BPS: z.coerce.number().int().positive().default(200),

  /**
   * Modified z-score above which an observation is treated as an outlier.
   * 3.5 is the Iglewicz & Hoaglin (1993) convention for MAD-based scores.
   */
  OUTLIER_Z_THRESHOLD: z.coerce.number().positive().default(3.5),

  /**
   * A quote is never called an outlier below this deviation from the median.
   *
   * Unset by default, in which case it follows CONSENSUS_MAX_DEVIATION_BPS:
   * an observation counts as anomalous only if it exceeds the disagreement the
   * round would already have rejected. Set it explicitly only to make outlier
   * exclusion stricter or looser than the round tolerance.
   */
  OUTLIER_MIN_DEVIATION_BPS: z.coerce.number().positive().optional(),

  /**
   * Optional per-provider weights, e.g. "coinbase:1.5,binance:1".
   *
   * Empty by default — every provider weighs the same. We have no evidence that
   * any venue is systematically more accurate, and weighting on anything less
   * than evidence would bias the signal for no reason.
   */
  PROVIDER_WEIGHTS: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const weights: Record<string, number> = {};
      for (const pair of value.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [name, raw] = pair.split(":").map((s) => s.trim());
        const parsed = Number(raw);
        if (!name || !raw || !Number.isFinite(parsed) || parsed <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid weight "${pair}" (expected "provider:positiveNumber")`,
          });
          continue;
        }
        weights[name.toLowerCase()] = parsed;
      }
      return weights;
    }),
  /**
   * Age at which a quote's weight halves in the weighted median.
   *
   * Freshness weighting exists because the staleness bound alone is a cliff: at
   * 300s a two-minute-old aggregator print counts exactly as much as a
   * one-second-old exchange print, right up until it counts for nothing. Live
   * evaluation showed that cliff costing real accuracy — see the Phase 4
   * results in the README. Set to 0 to weigh every surviving quote equally.
   */
  PRICE_FRESHNESS_HALFLIFE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_FRESHNESS_HALF_LIFE_MS),

  /**
   * Weight multiplier for a quote whose `asOf` is a response time rather than
   * an observation time, i.e. whose real age we cannot verify.
   *
   * 1 disables the penalty. Note that disabling it while leaving freshness
   * weighting on measured *worse* than doing neither, because it moves weight
   * from the source with an honestly old timestamp onto the source with an
   * unverifiable one.
   */
  UNVERIFIED_FRESHNESS_WEIGHT: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_UNVERIFIED_FRESHNESS_WEIGHT),

  /**
   * Quotes older than this are discarded before consensus.
   *
   * Generous by default because upstream observation times vary a lot:
   * exchanges stamp the last trade (near-instant) while aggregators like
   * CoinGecko can report a `last_updated_at` a couple of minutes old on the
   * free tier. Too tight a bound silently discards legitimately fresh data.
   */
  PRICE_MAX_STALENESS_MS: z.coerce.number().int().positive().default(300_000),
});

export type Config = Readonly<{
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  http: Readonly<{ host: string; port: number; corsAllowOrigin: string }>;
  log: Readonly<{ level: string; pretty: boolean }>;
  miner: Readonly<{
    slug: string;
    subnetId: number;
    minPriceUsdc: number;
    feeAddress?: string;
  }>;
  providers: Readonly<{
    enabled: readonly string[];
    timeoutMs: number;
    cacheTtlMs: number;
  }>;
  consensus: Readonly<{
    minSources: number;
    maxDeviationBps: number;
    maxStalenessMs: number;
    outlierZThreshold: number;
    /** Undefined means "follow maxDeviationBps". */
    outlierMinDeviationBps: number | undefined;
    weights: Readonly<Record<string, number>>;
    freshnessHalfLifeMs: number;
    unverifiedFreshnessWeight: number;
  }>;
  /**
   * Provider credentials, captured once from the environment. Keys are the raw
   * env var names (e.g. `COINGECKO_API_KEY`). Providers receive only the secret
   * they ask for, via `Config.secret()`, rather than touching `process.env`.
   */
  secret: (envVarName: string) => string | undefined;

  /**
   * Non-sensitive provider settings — base URLs, plan tiers — read by the same
   * injected-accessor pattern as `secret()`.
   *
   * Keeping both as lookups rather than typed fields is deliberate: it is what
   * lets the config layer stay free of provider-specific knowledge, so adding a
   * provider touches only its own module and the registry. Refuses to return
   * credential-shaped variables, so a secret cannot leak through the channel
   * that gets logged.
   */
  setting: (envVarName: string) => string | undefined;
}>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Parse and validate configuration. Throws `ConfigError` with every problem
 * listed, so a misconfigured deployment fails fast at boot rather than on the
 * first request.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // Snapshot the environment once so no other module needs `process.env`.
  // Credentials and plain settings are kept apart so `setting()` can never be
  // used to read a key.
  const CREDENTIAL_PATTERN = /_(API_KEY|API_SECRET|TOKEN|PASSWORD)$/;
  const secrets = new Map<string, string>();
  const settings = new Map<string, string>();

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CREDENTIAL_PATTERN.test(key)) {
      secrets.set(key, value);
    } else {
      settings.set(key, value);
    }
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    http: Object.freeze({
      host: env.HOST,
      port: env.PORT,
      corsAllowOrigin: env.CORS_ALLOW_ORIGIN,
    }),
    log: Object.freeze({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY }),
    miner: Object.freeze({
      slug: env.MINER_SLUG,
      subnetId: env.MINER_SUBNET_ID,
      minPriceUsdc: env.MIN_PRICE_USDC,
      feeAddress: env.MINER_FEE_ADDRESS,
    }),
    providers: Object.freeze({
      enabled: Object.freeze([...env.PRICE_PROVIDERS]),
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
      cacheTtlMs: env.PROVIDER_CACHE_TTL_MS,
    }),
    consensus: Object.freeze({
      minSources: env.CONSENSUS_MIN_SOURCES,
      maxDeviationBps: env.CONSENSUS_MAX_DEVIATION_BPS,
      maxStalenessMs: env.PRICE_MAX_STALENESS_MS,
      outlierZThreshold: env.OUTLIER_Z_THRESHOLD,
      outlierMinDeviationBps: env.OUTLIER_MIN_DEVIATION_BPS,
      weights: Object.freeze({ ...env.PROVIDER_WEIGHTS }),
      freshnessHalfLifeMs: env.PRICE_FRESHNESS_HALFLIFE_MS,
      unverifiedFreshnessWeight: env.UNVERIFIED_FRESHNESS_WEIGHT,
    }),
    secret: (name: string) => secrets.get(name),
    setting: (name: string) => settings.get(name),
  });
}
