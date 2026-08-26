import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import type { Config } from "../config/env.js";
import { isKoinMixError } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { registerCandleRoutes } from "./routes/candles.js";
import { registerCryptoPriceRoutes } from "./routes/cryptoPrice.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { AppServer } from "./types.js";

export function buildServer(
  config: Config,
  logger: Logger,
  registry: ProviderRegistry,
): AppServer {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
    // Telegraph nodes proxy on behalf of a caller; trust the forwarding headers
    // so logs record the real origin.
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  /**
   * CORS for the demo terminal, which is served from a different origin.
   *
   * Safe to allow broadly here: every route is a public, read-only market-data
   * lookup, there are no cookies or credentials, and `credentials` is never
   * enabled — so a permissive origin grants a browser nothing it could not get
   * by calling the API directly. Narrow it with CORS_ALLOW_ORIGIN if you would
   * rather this deployment only answer your own frontend.
   */
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", config.http.corsAllowOrigin);
    reply.header("vary", "origin");

    if (request.method === "OPTIONS") {
      reply
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "content-type")
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
  });

  registerHealthRoutes(app, config, registry);
  registerCryptoPriceRoutes(app, {
    config,
    registry,
    logger,
  });
  registerCandleRoutes(app, config);

  /**
   * Single error boundary. Known failures map to their declared status and a
   * structured body; anything unexpected is logged in full but reported as a
   * generic 500 so internals never leak to the network.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isKoinMixError(error)) {
      request.log.warn(
        { err: error, code: error.code, details: error.details },
        "request failed",
      );
      return reply.code(error.httpStatus).send({
        ...error.toResponseBody(),
        requestId: request.id,
      });
    }

    // Fastify's own errors (malformed JSON, unsupported media type, ...).
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      request.log.warn({ err: error }, "malformed request");
      return reply.code(error.statusCode).send({
        error: error.message,
        code: "VALIDATION_FAILED",
        details: {},
        requestId: request.id,
      });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({
      error: "internal server error",
      code: "INTERNAL_ERROR",
      details: {},
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: `no route for ${request.method} ${request.url}`,
      code: "VALIDATION_FAILED",
      details: {},
      requestId: request.id,
    }),
  );

  return app;
}
