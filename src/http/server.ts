import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import type { Config } from "../config/env.js";
import { isKoinMixError } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import type { ProviderRegistry } from "../providers/registry.js";
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

  registerHealthRoutes(app, config, registry);
  registerCryptoPriceRoutes(app, {
    config,
    registry,
    logger,
  });

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
