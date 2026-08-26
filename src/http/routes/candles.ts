import type { Config } from "../../config/env.js";
import { ValidationError } from "../../errors.js";
import {
  CANDLE_INTERVALS,
  CandlesUnavailableError,
  fetchCandles,
  isCandleInterval,
  MAX_LIMIT,
} from "../../market/candles.js";
import { resolveAsset, supportedAssets } from "../../providers/assets.js";
import type { AppServer } from "../types.js";

/**
 * Historical candles for the demo terminal.
 *
 * Deliberately NOT declared in telegraph/koinmix.yaml, and therefore not
 * reachable through Telegraph — the node only proxies endpoints the YAML lists.
 * This exists to draw a chart, and keeping it out of the descriptor is what
 * stops the miner's contract from quietly growing a second purpose.
 *
 * When no real source can serve the requested interval this returns 503 with
 * the per-source reasons attached, so the UI can say *why* a chart is empty
 * instead of rendering a plausible-looking one.
 */
export function registerCandleRoutes(app: AppServer, config: Config): void {
  app.get("/v1/candles", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const asset = (query.asset ?? "").trim().toUpperCase();
    const quote = (query.quote ?? "USD").trim().toUpperCase();
    const interval = (query.interval ?? "1h").trim();

    if (!asset) {
      throw new ValidationError("asset is required", {
        supported: supportedAssets(),
      });
    }

    // Same reasoning as the price path: an asset this miner does not carry is a
    // client error, not a 503 that invites a retry which can never succeed.
    if (!resolveAsset(asset)) {
      throw new ValidationError(`unsupported asset "${asset}"`, {
        supported: supportedAssets(),
      });
    }

    if (!isCandleInterval(interval)) {
      throw new ValidationError(`unsupported interval "${interval}"`, {
        supported: CANDLE_INTERVALS,
      });
    }

    const limit = Number(query.limit ?? 300);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ValidationError(`limit must be an integer in 1..${MAX_LIMIT}`, {
        received: query.limit,
      });
    }

    try {
      const series = await fetchCandles(
        { secret: config.secret, setting: config.setting },
        asset,
        quote,
        interval,
        config.providers.timeoutMs,
        limit,
      );

      request.log.info(
        {
          asset,
          quote,
          interval,
          source: series.source,
          candles: series.candles.length,
        },
        "candles served",
      );

      return reply.code(200).send(series);
    } catch (error) {
      if (error instanceof CandlesUnavailableError) {
        request.log.warn(
          { asset, quote, interval, failures: error.failures },
          "no candle source available",
        );

        // 503 rather than 200-with-empty-array: an empty array reads as "this
        // market has no history", which is a different and untrue statement.
        return reply.code(503).send({
          error: error.message,
          code: "PROVIDER_UNAVAILABLE",
          details: { asset, quote, interval, failures: error.failures },
          requestId: request.id,
        });
      }
      throw error;
    }
  });
}
