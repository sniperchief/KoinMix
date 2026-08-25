import { z } from "zod";
import { CRYPTO_PRICE_INTENT, isSupportedIntent } from "./intents.js";

/**
 * Request/response contracts for the CRYPTO_PRICE intent.
 *
 * Telegraph does not publish a fixed wire schema per intent — the YAML Standard
 * has each miner declare its own `endpoints`, `input_schema` and `output_schema`,
 * and the node maps on-chain arrays onto them via `on_chain.request`. These
 * schemas are the authoritative definition of the KoinMix contract and are
 * mirrored verbatim into telegraph/koinmix.yaml.
 */

/**
 * Ticker symbols and contract-ish identifiers. Deliberately permissive enough
 * for symbols like `BTC`, `USDT.e` or `WETH-USD`, and strict enough to keep
 * arbitrary text out of downstream provider URLs.
 */
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const AssetSymbol = z
  .string()
  .trim()
  .regex(SYMBOL, "must be an alphanumeric ticker symbol (e.g. BTC)")
  .transform((s) => s.toUpperCase());

const QuoteCurrency = z
  .string()
  .trim()
  .regex(SYMBOL, "must be an alphanumeric currency code (e.g. USD)")
  .transform((s) => s.toUpperCase());

/**
 * Incoming CRYPTO_PRICE request.
 *
 * `intent` is optional: when the Telegraph node proxies an on-chain request it
 * maps `strings[]` straight onto query params and does not necessarily restate
 * the intent. When present it must name an intent this miner supports.
 */
export const CryptoPriceRequestSchema = z
  .object({
    intent: z
      .string()
      .trim()
      .refine(isSupportedIntent, {
        message: `unsupported intent (this miner serves "${CRYPTO_PRICE_INTENT}")`,
      })
      .optional(),
    asset: AssetSymbol,
    quote: QuoteCurrency.default("USD"),
  })
  .strip();

export type CryptoPriceRequest = z.infer<typeof CryptoPriceRequestSchema>;

/**
 * Outgoing CRYPTO_PRICE response.
 *
 * Field names are load-bearing: `telegraph/koinmix.yaml` references them by
 * dot-path in `on_chain.fields[].source_path` (a `transform: direct`,
 * deterministic extraction — appropriate for a Tier A / WASM Exact Match
 * intent) and in `semantics.signal_mapping`. Renaming a field here requires
 * re-registering the YAML on-chain.
 */
export const CryptoPriceResponseSchema = z.object({
  /** Echoed intent, always the snake_case canonical form. */
  intent: z.literal(CRYPTO_PRICE_INTENT),
  asset: z.string(),
  quote: z.string(),

  /**
   * Decimal price as a string, to avoid float formatting drift between the
   * miner and validators performing exact-match scoring.
   */
  price: z.string(),
  /** Integer price scaled by 1e8, for `integers[]` on-chain storage. */
  priceX1e8: z.number().int().nonnegative(),

  /**
   * 0..1 reliability indicator. NOT a probability — see
   * src/consensus/confidence.ts for what it does and does not mean.
   */
  confidence: z.number().min(0).max(1),
  /** How many provider quotes survived staleness filtering. */
  sourceCount: z.number().int().nonnegative(),
  /** Names of the contributing providers, sorted for determinism. */
  sources: z.array(z.string()),
  /** Aggregation strategy applied. */
  method: z.enum(["single", "median"]),
  /** Widest deviation of any contributing quote from the consensus, in bps. */
  deviationBps: z.number().int().nonnegative(),
  /** Peak-to-peak disagreement across contributing quotes, in bps. */
  spreadBps: z.number().int().nonnegative(),
  /**
   * Observations excluded from this calculation, with the reason. Exclusion is
   * per-round only — no provider is blacklisted.
   */
  excluded: z.array(
    z.object({
      provider: z.string(),
      price: z.number(),
      deviationBps: z.number().int().nonnegative(),
      reason: z.enum(["stale", "outlier"]),
      detail: z.string(),
    }),
  ),

  /** Provider-reported observation time of the consensus price (ISO 8601). */
  asOf: z.string().datetime(),
  /** When this miner produced the answer (ISO 8601). */
  observedAt: z.string().datetime(),
  /** True if the consensus price is older than the configured staleness bound. */
  isStale: z.boolean(),

  minerSlug: z.string(),
  /** Human-readable rationale; mapped to `signal_mapping.reason_field`. */
  explanation: z.string(),
});

export type CryptoPriceResponse = z.infer<typeof CryptoPriceResponseSchema>;
