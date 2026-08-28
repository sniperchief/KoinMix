/**
 * Telegraph intent + signal-type constants.
 *
 * Sources:
 *  - Hackathon intent catalog (40 intents):
 *    https://hackathon.telegraphprotocol.com/supported-intents
 *  - YAML Standard canonical lists (27 intents, 7 signal types):
 *    https://telegraph-2.gitbook.io/telegraph/miner-registry/yaml-standard.md
 *
 * CASING, RESOLVED (verified 2026-08-25):
 * `CRYPTO_PRICE` appears in the hackathon catalog under "Financial Data"
 * (Tier A, WASM Exact Match) but not in the 27-entry canonical intent list in
 * the YAML Standard, which predates the catalog. That raised the question of
 * which spelling to register.
 *
 * The catalog answers it: it renders EVERY intent in upper snake case,
 * including ones the YAML Standard lists in lower snake case — `WEATHER_CHECK`
 * in the catalog is `weather_check` in the standard, likewise `STORM_ALERT` and
 * `WEATHER_FORECAST`. The casing is therefore presentational, and the wire form
 * is the standard's lower snake case. We declare `crypto_price`.
 *
 * Input remains case-insensitive (see `isSupportedIntent`) so the miner answers
 * whichever spelling a node actually dispatches.
 *
 * ROUTING, RESOLVED (verified 2026-08-27):
 * An earlier revision of this comment recorded routing as the genuinely open
 * question — the Miner Registry docs warned that intents outside the canonical
 * 27 are "accepted but will not be routed by the autonomous engine", and
 * `crypto_price` was not among those 27. That 27-entry list was stale. The live
 * registry at https://integrate.telegraphprotocol.com lists CRYPTO_PRICE among
 * its canonical intents — "Query names a cryptocurrency asset and asks for its
 * current or historical price" — and registration 252 was accepted against it.
 * The intent routes.
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
