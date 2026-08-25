/**
 * Telegraph intent + signal-type constants.
 *
 * Sources:
 *  - Hackathon intent catalog (40 intents):
 *    https://hackathon.telegraphprotocol.com/supported-intents
 *  - YAML Standard canonical lists (27 intents, 7 signal types):
 *    https://telegraph-2.gitbook.io/telegraph/miner-registry/yaml-standard.md
 *
 * NOTE ON A DOCUMENTATION DISCREPANCY (verified 2026-08-24):
 * `CRYPTO_PRICE` appears in the hackathon catalog under "Financial Data"
 * (Tier A, evaluated by WASM Exact Match) but does NOT appear in the 27-entry
 * canonical intent list in the core YAML Standard docs, which predates the
 * hackathon catalog. The YAML Standard writes intents in lower snake_case, and
 * the Miner Registry docs state that intents outside the canonical list are
 * "accepted but will not be routed by the autonomous engine".
 *
 * We therefore declare BOTH spellings and treat them as equivalent on input, so
 * the miner answers whichever casing the node actually dispatches. The exact
 * on-chain string to pass to `registerMiner()` is called out in README.md as an
 * item to confirm with the Telegraph team before registration.
 */

/** The intent this miner serves, in YAML Standard (snake_case) form. */
export const CRYPTO_PRICE_INTENT = "crypto_price" as const;

/** The same intent as spelled in the hackathon catalog. */
export const CRYPTO_PRICE_INTENT_CATALOG = "CRYPTO_PRICE" as const;

/** Every spelling this miner will accept for its intent, normalised lowercase. */
export const SUPPORTED_INTENTS: readonly string[] = Object.freeze([
  CRYPTO_PRICE_INTENT,
]);

/**
 * Canonical `semantics.signal_mapping.type` enum from the YAML Standard.
 * A YAML declaring a value outside this set fails node-side schema validation.
 */
export const CANONICAL_SIGNAL_TYPES = Object.freeze([
  "media_authenticity",
  "weather_risk",
  "text_authenticity",
  "search_relevance",
  "language_response",
  "multimodal_response",
  "task_completion",
] as const);

export type CanonicalSignalType = (typeof CANONICAL_SIGNAL_TYPES)[number];

/**
 * The enum has no financial/market-data member, so `task_completion` is the
 * only value that is not semantically wrong for a deterministic data lookup.
 * This choice is mirrored in telegraph/koinmix.yaml and flagged in README.md.
 */
export const KOINMIX_SIGNAL_TYPE: CanonicalSignalType = "task_completion";

/** True if `value` names the CRYPTO_PRICE intent in any accepted spelling. */
export function isSupportedIntent(value: string): boolean {
  return SUPPORTED_INTENTS.includes(value.trim().toLowerCase());
}
