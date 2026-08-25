import {
  handleCryptoPriceRequest,
  type AdapterDeps,
} from "../../telegraph/adapter.js";
import type { AppServer } from "../types.js";

/**
 * CRYPTO_PRICE endpoint.
 *
 * Registered on the path declared as `endpoints[].external_path` in
 * telegraph/koinmix.yaml. Telegraph nodes call this directly; the node itself
 * terminates x402 payment before proxying, so the miner performs no payment
 * handling of its own (see the x402 Payment doc — the node holds the receiving
 * addresses and talks to the PayAI facilitator).
 *
 * Both verbs share one handler:
 *  - GET  — how an on-chain request arrives, with `on_chain.request.query_params`
 *           mapping `strings[]` onto `asset` / `quote`.
 *  - POST — convenience for direct HTTP callers sending a JSON body.
 */
export function registerCryptoPriceRoutes(
  app: AppServer,
  deps: AdapterDeps,
): void {
  app.get("/v1/price", async (request, reply) => {
    const result = await handleCryptoPriceRequest(request.query, {
      ...deps,
      logger: request.log,
    });
    return reply.code(200).send(result);
  });

  app.post("/v1/price", async (request, reply) => {
    const result = await handleCryptoPriceRequest(request.body, {
      ...deps,
      logger: request.log,
    });
    return reply.code(200).send(result);
  });
}
