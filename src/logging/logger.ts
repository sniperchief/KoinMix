import { pino, type Logger } from "pino";
import type { Config } from "../config/env.js";

export type { Logger };

/**
 * The minimal logging surface the application depends on.
 *
 * Deliberately structural rather than `pino.Logger`: route handlers pass
 * Fastify's per-request child logger (`request.log`) so that every line carries
 * the request id, and `FastifyBaseLogger` is not the same nominal type as
 * `pino.Logger`. Both satisfy this interface.
 */
export interface AppLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

/**
 * Structured JSON logging. Credential-bearing headers are redacted at the
 * logger level so no call site has to remember to strip them.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.log.level,
    base: {
      service: "koinmix-miner",
      minerSlug: config.miner.slug,
      subnetId: config.miner.subnetId,
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers['payment-signature']",
        "res.headers['payment-required']",
      ],
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.log.pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
          },
        }
      : {}),
  });
}
