import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type { Logger } from "pino";

/**
 * The concrete Fastify instance type for this application.
 *
 * Supplying `loggerInstance` narrows Fastify's logger generic from
 * `FastifyBaseLogger` to pino's `Logger`, so the default `FastifyInstance` no
 * longer matches. Naming the instantiation once keeps every route signature
 * aligned with what `buildServer()` actually produces.
 */
export type AppServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
