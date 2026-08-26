/**
 * Verify the miner descriptor against a live response.
 *
 *   npm run verify:onchain              # BTC/USD
 *   npm run verify:onchain -- ETH USD
 *
 * Two things are checked, and both fail silently in production if wrong:
 *
 * 1. **The YAML conforms to the published standard.** The YAML Standard's
 *    top-level field list is closed, and a node validates against it before
 *    activating a miner. An invented key — or a `signal_mapping.type` outside
 *    the canonical enum — is rejected there, long after `registerMiner()` has
 *    already committed the hash.
 *
 * 2. **Every `source_path` resolves against a real response.** This is the part
 *    no unit test can cover, because it spans two artifacts that are edited
 *    independently: the YAML says `source_path: priceX1e8`, the response has to
 *    actually contain it. If it does not, registration still succeeds and the
 *    miner still returns 200 — the node just writes zeros and empty strings
 *    on-chain, which is worse than an error because it looks like data.
 *
 * The response here comes from the real adapter hitting real providers, so a
 * pass means the exact bytes a Telegraph node would receive map cleanly onto the
 * OnChainData arrays it would then write.
 *
 * Exits non-zero on any problem.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../src/config/env.js";
import { loadEnvFile } from "../src/config/loadEnvFile.js";
import { createLogger } from "../src/logging/logger.js";
import { createProviderRegistry } from "../src/providers/registry.js";
import { handleCryptoPriceRequest } from "../src/telegraph/adapter.js";
import { CANONICAL_SIGNAL_TYPES } from "../src/telegraph/intents.js";

// ── The published standard ──────────────────────────────────────────────────
// https://telegraph-2.gitbook.io/telegraph/miner-registry/yaml-standard.md

const ALLOWED_TOP_LEVEL = new Set([
  "version",
  "kind",
  "id",
  "slug",
  "protocol",
  "name",
  "description",
  "base_url",
  "auth",
  "rate_limit_per_sec",
  "cache_ttl_sec",
  "circuit_threshold",
  "circuit_cooldown_seconds",
  "endpoints",
  "semantics",
  "on_chain",
]);

const REQUIRED_TOP_LEVEL = [
  "version",
  "kind",
  "id",
  "slug",
  "name",
  "base_url",
];

/** The Diamond enforces `length <= 5` for each array on outbound. */
const MAX_ARRAY_LENGTH = 5;

const ARRAY_GROUPS = ["strings", "integers", "bools", "addresses"] as const;

const YAML_PATH = fileURLToPath(
  new URL("../telegraph/koinmix.yaml", import.meta.url),
);

const problems: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

function ok(label: string, detail = ""): void {
  console.log(`  ${"✓"} ${label}${detail ? `  ${detail}` : ""}`);
}

// ── Dot-path resolution, as `transform: direct` performs it ─────────────────

function resolvePath(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      source,
    );
}

function applyTransform(value: unknown, rule: string | undefined): unknown {
  if (!rule) return value;
  if (rule === "bool_from_int") return Number(value) !== 0;
  if (rule.startsWith("bool_from_eq:")) {
    return String(value) === rule.slice("bool_from_eq:".length);
  }
  fail(`unknown transform_rule "${rule}"`);
  return value;
}

interface FieldSpec {
  index: number;
  name: string;
  description?: string;
  source_path?: string;
  multiplier?: number;
  transform_rule?: string;
}

// ── Checks ──────────────────────────────────────────────────────────────────

function checkStructure(doc: Record<string, unknown>): void {
  console.log("\nYAML conformance");

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      fail(
        `top-level key "${key}" is not in the YAML Standard's field list — ` +
          "a strict validator may reject the miner",
      );
    }
  }
  for (const key of REQUIRED_TOP_LEVEL) {
    if (doc[key] === undefined) fail(`required top-level key "${key}" is missing`);
  }
  ok("top-level keys", `${Object.keys(doc).length} present, all recognised`);

  if (doc.version !== "1") fail(`version must be the string "1", got ${JSON.stringify(doc.version)}`);
  if (doc.kind !== "subnet" && doc.kind !== "validator") {
    fail(`kind must be "subnet" or "validator", got ${JSON.stringify(doc.kind)}`);
  }

  const auth = doc.auth as Record<string, unknown> | undefined;
  if (!auth || typeof auth.type !== "string") {
    fail("auth.type is required");
  } else if (!["bearer", "header", "none"].includes(auth.type)) {
    fail(`auth.type must be bearer | header | none, got "${auth.type}"`);
  } else if (auth.type !== "none" && !auth.env_var) {
    fail(`auth.type "${auth.type}" requires env_var`);
  } else {
    ok("auth", `type=${auth.type}`);
  }

  const endpoints = doc.endpoints as FieldSpec[] | undefined;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    fail("at least one endpoint must be declared");
  } else {
    for (const ep of endpoints as unknown as Record<string, unknown>[]) {
      for (const required of ["path", "external_path", "method"]) {
        if (!ep[required]) fail(`endpoint is missing "${required}"`);
      }
    }
    ok("endpoints", (endpoints as unknown as Record<string, unknown>[]).map((e) => `${String(e.method)} ${String(e.path)} → ${String(e.external_path)}`).join(", "));
  }

  const semantics = doc.semantics as Record<string, unknown> | undefined;
  const mapping = semantics?.signal_mapping as Record<string, unknown> | undefined;
  const signalType = mapping?.type;
  if (typeof signalType !== "string" || !(CANONICAL_SIGNAL_TYPES as readonly string[]).includes(signalType)) {
    fail(
      `signal_mapping.type "${String(signalType)}" is outside the canonical enum ` +
        `(${CANONICAL_SIGNAL_TYPES.join(", ")}) and fails node-side validation`,
    );
  } else {
    ok("signal_mapping.type", signalType);
  }

  const intents = semantics?.supported_intents;
  if (!Array.isArray(intents) || intents.length === 0) {
    fail("semantics.supported_intents must list at least one intent");
  } else {
    ok("supported_intents", intents.join(", "));
    for (const intent of intents) {
      if (typeof intent === "string" && intent !== intent.toLowerCase()) {
        fail(`intent "${intent}" is not lower snake_case`);
      }
    }
  }

  const onChain = doc.on_chain as Record<string, unknown> | undefined;
  if (onChain?.transform !== "direct" && onChain?.transform !== "llm") {
    fail(`on_chain.transform must be "direct" or "llm", got ${JSON.stringify(onChain?.transform)}`);
  } else {
    ok("on_chain.transform", String(onChain.transform));
  }
}

function checkMapping(
  doc: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  console.log("\nOn-chain field mapping, resolved against the live response");

  const onChain = doc.on_chain as Record<string, unknown>;
  const fields = (onChain.fields ?? {}) as Record<string, FieldSpec[]>;

  for (const group of ARRAY_GROUPS) {
    const specs = fields[group] ?? [];
    if (specs.length > MAX_ARRAY_LENGTH) {
      fail(`${group}[] declares ${specs.length} entries, exceeding the outbound cap of ${MAX_ARRAY_LENGTH}`);
    }

    const seen = new Set<number>();
    for (const spec of specs) {
      if (seen.has(spec.index)) fail(`${group}[${spec.index}] is declared twice`);
      seen.add(spec.index);
      for (const required of ["index", "name", "description"] as const) {
        if (spec[required] === undefined) {
          fail(`${group}[${spec.index}] is missing required "${required}"`);
        }
      }
    }
    for (let i = 0; i < specs.length; i += 1) {
      if (!seen.has(i)) fail(`${group}[] indices are not contiguous — ${i} is missing`);
    }

    if (specs.length === 0) {
      console.log(`  ${group}: (none)`);
      continue;
    }

    console.log(`  ${group}:`);
    for (const spec of [...specs].sort((a, b) => a.index - b.index)) {
      if (!spec.source_path) {
        console.log(`    [${spec.index}] ${spec.name} — no source_path (node-derived)`);
        continue;
      }

      const raw = resolvePath(response, spec.source_path);

      if (raw === undefined) {
        fail(
          `${group}[${spec.index}] "${spec.name}" → source_path "${spec.source_path}" ` +
            "does not exist in the response; the node would write an empty value on-chain",
        );
        console.log(`    [${spec.index}] ${spec.name} ← ${spec.source_path}  *** MISSING ***`);
        continue;
      }

      let value = applyTransform(raw, spec.transform_rule);
      if (spec.multiplier !== undefined) {
        value = Math.round(Number(value) * spec.multiplier);
      }

      // Type sanity against the array the value lands in.
      if (group === "integers" && !Number.isInteger(Number(value))) {
        fail(`integers[${spec.index}] "${spec.name}" resolved to a non-integer: ${String(value)}`);
      }
      if (group === "bools" && typeof value !== "boolean") {
        fail(`bools[${spec.index}] "${spec.name}" resolved to a non-boolean: ${String(value)}`);
      }
      if (group === "strings" && typeof value !== "string") {
        fail(
          `strings[${spec.index}] "${spec.name}" resolved to ${typeof value}; ` +
            "decimals and identifiers must be strings in strings[]",
        );
      }

      console.log(
        `    [${spec.index}] ${spec.name.padEnd(18)} ← ${spec.source_path.padEnd(14)} = ${JSON.stringify(value)}`,
      );
    }
  }

  // signal_mapping fields must resolve too — they are how a validator scores us.
  const mapping = (doc.semantics as Record<string, unknown>)
    .signal_mapping as Record<string, string>;
  console.log("\nsignal_mapping, resolved against the live response");
  for (const key of ["confidence_field", "label_field", "reason_field"] as const) {
    const path = mapping[key];
    if (!path) continue;
    const value = resolvePath(response, path);
    if (value === undefined) {
      fail(`signal_mapping.${key} → "${path}" does not exist in the response`);
      console.log(`  ${key.padEnd(18)} ← ${path}  *** MISSING ***`);
    } else {
      const rendered = JSON.stringify(value);
      console.log(
        `  ${key.padEnd(18)} ← ${path.padEnd(12)} = ${rendered.length > 60 ? `${rendered.slice(0, 57)}…` : rendered}`,
      );
    }
  }
}

function checkRequestMapping(doc: Record<string, unknown>): void {
  const onChain = doc.on_chain as Record<string, unknown>;
  const requests = onChain.request as
    | Array<Record<string, unknown>>
    | undefined;
  if (!requests) {
    notes.push("on_chain.request is absent — the node cannot build a call from on-chain data");
    return;
  }

  console.log("\nOn-chain request mapping (how strings[] become query params)");
  const endpoints = (doc.endpoints ?? []) as Array<Record<string, unknown>>;

  for (const req of requests) {
    // `endpoint` is a substring match against the declared path.
    const target = String(req.endpoint ?? "");
    const matched = endpoints.find((e) => String(e.path).includes(target));
    if (!matched) {
      fail(`on_chain.request endpoint "${target}" matches no declared endpoint path`);
    }

    const params = (req.query_params ?? {}) as Record<string, { source?: string; optional?: boolean }>;
    for (const [param, spec] of Object.entries(params)) {
      const source = spec.source ?? "";
      if (!/^(strings|numbers|bools)\.\d+$/.test(source)) {
        fail(
          `query_params.${param}.source "${source}" is not a documented source ` +
            "format (strings.N, numbers.N, bools.N)",
        );
      }
      console.log(
        `  ${String(req.method)} ${String(matched?.external_path ?? target)}  ${param} ← ${source}${spec.optional ? " (optional)" : ""}`,
      );
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFile();

  const [asset = "BTC", quoteCode = "USD"] = process.argv
    .slice(2)
    .map((a) => a.toUpperCase());

  const raw = readFileSync(YAML_PATH, "utf8");
  const doc = parse(raw) as Record<string, unknown>;

  console.log("KoinMix — miner descriptor verification");
  console.log(`  yaml    ${YAML_PATH}`);
  console.log(`  query   ${asset}/${quoteCode}`);

  checkStructure(doc);
  checkRequestMapping(doc);

  // A real round against real providers. If this cannot produce a price, the
  // mapping cannot be verified — and saying so is the honest outcome.
  const config = loadConfig();
  const logger = createLogger({
    ...config,
    log: { ...config.log, level: "silent" },
  });
  const registry = createProviderRegistry(config, logger);

  console.log(
    `\nFetching a live ${asset}/${quoteCode} price from ${registry
      .active()
      .map((p) => p.name)
      .join(", ")}…`,
  );

  const response = (await handleCryptoPriceRequest(
    { asset, quote: quoteCode },
    { config, registry, logger },
  )) as unknown as Record<string, unknown>;

  console.log(`  price ${String(response.price)}  from ${String(response.sourceCount)} source(s)`);

  checkMapping(doc, response);

  console.log("");
  for (const note of notes) console.log(`NOTE: ${note}`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) found:`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }

  console.log("All checks passed: the YAML conforms, and every mapped path resolves.");
}

main().catch((error: unknown) => {
  console.error("\nVerification failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
