import {
  handleCryptoPriceDiagnostics,
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

  /**
   * Operator diagnostics. NOT declared in telegraph/koinmix.yaml and therefore
   * not reachable through Telegraph — the node only ever proxies the endpoints
   * the YAML lists.
   *
   * This exists so that inspecting a round costs nothing on the contract side.
   * The alternative, a flag on /v1/price that swells the response, would put
   * internal state one query parameter away from the bytes a validator scores.
   *
   * It runs a full independent round, so it reflects the market at the moment
   * it is called, not the moment some earlier /v1/price call was served. Use the
   * logs to explain a specific served response.
   */
  app.get("/v1/price/debug", async (request, reply) => {
    const { response, diagnostics } = await handleCryptoPriceDiagnostics(
      request.query,
      { ...deps, logger: request.log },
    );
    return reply.code(200).send({ response, diagnostics });
  });
}
