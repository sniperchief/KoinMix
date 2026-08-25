#!/usr/bin/env node
/**
 * Compute the SHA-256 commitment for the miner YAML.
 *
 * `MinerRegistryFacet.registerMiner()` takes the SHA-256 of the raw YAML bytes
 * prefixed with 0x — explicitly NOT keccak256. Nodes re-hash the file they
 * fetch from `yamlUrl` and reject the registration on mismatch, so this must be
 * run against the exact bytes that will be served.
 *
 *   node scripts/yaml-hash.mjs [path]
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = process.argv[2]
  ? process.argv[2]
  : fileURLToPath(new URL("../telegraph/koinmix.yaml", import.meta.url));

const bytes = await readFile(target);
const hash = createHash("sha256").update(bytes).digest("hex");

console.log(`file:  ${target}`);
console.log(`bytes: ${bytes.length}`);
console.log(`hash:  0x${hash}`);
