import { ConfigError, loadConfig } from "./config/env.js";
import { loadEnvFile } from "./config/loadEnvFile.js";
import { createLogger } from "./logging/logger.js";
import { createProviderRegistry } from "./providers/registry.js";
import { buildServer } from "./http/server.js";

async function main(): Promise<void> {
  // Before loadConfig(), and before anything else reads the environment.
  loadEnvFile();

  const config = loadConfig();
  const logger = createLogger(config);

  const registry = createProviderRegistry(config, logger);
  const app = buildServer(config, logger, registry);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.http.host, port: config.http.port });

  // `minerSlug` and `subnetId` are already on every line via the logger base.
  logger.info(
    {
      minPriceUsdc: config.miner.minPriceUsdc,
      activeProviders: registry.active().map((p) => p.name),
    },
    "KoinMix miner listening",
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // No logger exists yet if config parsing is what failed.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  console.error(error);
  process.exit(1);
});
