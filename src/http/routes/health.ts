import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "../../config/env.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import {
  CRYPTO_PRICE_INTENT,
  KOINMIX_SIGNAL_TYPE,
} from "../../telegraph/intents.js";
import type { AppServer } from "../types.js";

const YAML_PATH = fileURLToPath(
  new URL("../../../telegraph/koinmix.yaml", import.meta.url),
);

export function registerHealthRoutes(
  app: AppServer,
  config: Config,
  registry: ProviderRegistry,
): void {
  /**
   * Liveness/readiness. Reports `degraded` — not `ok` — while no live provider
   * is active, so the Phase 1 state is visible rather than papered over.
   */
  app.get("/healthz", async (_request, reply) => {
    const active = registry.active();
    const ready = active.length > 0;

    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "degraded",
      minerSlug: config.miner.slug,
      subnetId: config.miner.subnetId,
      intent: CRYPTO_PRICE_INTENT,
      signalType: KOINMIX_SIGNAL_TYPE,
      minPriceUsdc: config.miner.minPriceUsdc,
      providers: {
        enabled: config.providers.enabled,
        active: active.map((p) => p.name),
        unknown: registry.unknown(),
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * Serves the miner YAML so it can be registered on-chain directly from this
   * deployment. `registerMiner()` commits the SHA-256 of these exact bytes, so
   * this route must return the file verbatim — no templating.
   */
  app.get("/telegraph/koinmix.yaml", async (_request, reply) => {
    const yaml = await readFile(YAML_PATH, "utf8");
    return reply.code(200).type("application/yaml; charset=utf-8").send(yaml);
  });
}
