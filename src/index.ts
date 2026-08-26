import { ConfigError, loadConfig } from "./config/env.js";
import { loadEnvFile } from "./config/loadEnvFile.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createProviderRegistry } from "./providers/registry.js";
import { buildServer } from "./http/server.js";

/**
 * Hoisted so the top-level catch can report a startup failure through the same
 * structured stream as everything else. A crash at boot — a port already bound,
 * a filesystem permission — is exactly the event an operator most needs to find
 * in their log aggregator, and it is the one event that would otherwise arrive
 * as an unparseable stack in the middle of a JSON log.
 */
let logger: Logger | undefined;

/**
 * Whether `logger` writes through the `pino-pretty` worker thread.
 *
 * The fatal path below has to know, because a worker-backed logger cannot be
 * written to and exited from in the same tick — see the comment there.
 */
let loggerUsesWorkerTransport = false;

async function main(): Promise<void> {
  // Before loadConfig(), and before anything else reads the environment.
  loadEnvFile();

  const config = loadConfig();

  // Local binding for use inside main, module binding for the top-level catch.
  // Without the local one, every use below would have to re-narrow a
  // module-scoped `Logger | undefined` that nothing else can actually reset.
  const log = createLogger(config);
  logger = log;
  loggerUsesWorkerTransport = config.log.pretty;

  const registry = createProviderRegistry(config, log);
  const app = buildServer(config, log, registry);

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.http.host, port: config.http.port });

  // `minerSlug` and `subnetId` are already on every line via the logger base.
  log.info(
    {
      minPriceUsdc: config.miner.minPriceUsdc,
      activeProviders: registry.active().map((p) => p.name),
    },
    "KoinMix miner listening",
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Genuinely no logger yet: config parsing is what builds it.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }

  /**
   * Report the failure through the structured logger — but only when that
   * logger writes synchronously.
   *
   * A worker-backed logger (`LOG_PRETTY=true`, via `pino-pretty`) cannot be
   * written to and exited from in the same breath, and both ways out are worse
   * than this one. Calling `process.exit()` runs pino's `process.on("exit")`
   * flush while the loop is already tearing down, so `thread-stream` spins and
   * throws `_flushSync took too long (10s)` — the crash reporter becomes the
   * crash. Setting `process.exitCode` and returning instead leaves the worker
   * thread itself holding the loop open, and the process simply hangs. Both
   * were observed directly before settling on this.
   *
   * So: production (`LOG_PRETTY=false`, the configuration whose logs are
   * actually aggregated) gets the structured fatal line, written synchronously
   * to a file descriptor and therefore safe to exit on immediately. Local dev
   * gets the raw stack on stderr, which is what a human watching a terminal
   * wants regardless.
   */
  if (logger && !loggerUsesWorkerTransport) {
    logger.fatal({ err: error }, "miner failed to start");
  } else {
    console.error(error);
  }

  process.exit(1);
});
