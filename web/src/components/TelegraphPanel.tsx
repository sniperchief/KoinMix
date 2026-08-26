import { useCallback, useEffect, useRef, useState } from "react";
import { parse as parseYaml } from "yaml";
import {
  ApiError,
  MINER_URL,
  getMinerYaml,
  getTelegraphPrice,
  type CryptoPriceResponse,
} from "../lib/api";
import { formatDuration } from "../lib/format";
import { Badge, Card, Unavailable, cx } from "./ui";

/**
 * The Telegraph demonstration.
 *
 * What this does is real: it calls the miner's contract endpoint with exactly
 * the request a Telegraph node builds from on-chain data — `strings[0]` and
 * `strings[1]` mapped onto the `asset` and `quote` query params by
 * `on_chain.request` — then fetches the miner's registered YAML descriptor,
 * parses it, and applies each `on_chain.fields[].source_path` to the live
 * response. The OnChainData arrays shown are therefore computed the same way a
 * node computes them, from the same two artifacts.
 *
 * What this does NOT do is route through a Telegraph node, because KoinMix is
 * not registered yet — that needs a public HTTPS origin and a payout address.
 * The panel says so rather than implying a hop that did not happen. Faking the
 * one link in the chain we cannot yet exercise would undermine the point of
 * showing the chain at all.
 */

interface Props {
  asset: string;
  quote: string;
}

type StageState = "idle" | "active" | "done" | "failed" | "unavailable";

interface Stage {
  key: string;
  label: string;
  detail: string;
  /** False for the hop we cannot exercise until registration. */
  live: boolean;
}

const STAGES: Stage[] = [
  {
    key: "agent",
    label: "Agent",
    detail: "declares an intent, a confidence floor and a deadline",
    live: true,
  },
  {
    key: "telegraph",
    label: "Telegraph node",
    detail: "settles x402 payment, routes by intent, proxies upstream",
    live: false,
  },
  {
    key: "intent",
    label: "CRYPTO_PRICE",
    detail: "strings[0] → asset, strings[1] → quote",
    live: true,
  },
  {
    key: "koinmix",
    label: "KoinMix miner",
    detail: "fans out to four independent market-data providers",
    live: true,
  },
  {
    key: "consensus",
    label: "Consensus",
    detail: "freshness filter → outlier check → weighted median",
    live: true,
  },
  {
    key: "signal",
    label: "Verified price signal",
    detail: "mapped into OnChainData by the miner's YAML",
    live: true,
  },
];

interface OnChainField {
  index: number;
  name: string;
  source_path?: string;
  multiplier?: number;
  transform_rule?: string;
}

interface MappedValue {
  index: number;
  name: string;
  path: string;
  value: string;
  missing: boolean;
}

type OnChainArrays = Record<string, MappedValue[]>;

function resolvePath(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      source,
    );
}

function applyTransform(value: unknown, rule?: string): unknown {
  if (!rule) return value;
  if (rule === "bool_from_int") return Number(value) !== 0;
  if (rule.startsWith("bool_from_eq:")) {
    return String(value) === rule.slice("bool_from_eq:".length);
  }
  return value;
}

/** Apply the YAML's field mapping to a response, exactly as a node would. */
function mapOnChain(
  yamlText: string,
  response: CryptoPriceResponse,
): OnChainArrays {
  const doc = parseYaml(yamlText) as {
    on_chain?: { fields?: Record<string, OnChainField[]> };
  };
  const fields = doc.on_chain?.fields ?? {};
  const out: OnChainArrays = {};

  for (const [group, specs] of Object.entries(fields)) {
    if (!Array.isArray(specs) || specs.length === 0) continue;

    out[group] = [...specs]
      .sort((a, b) => a.index - b.index)
      .map((spec) => {
        if (!spec.source_path) {
          return {
            index: spec.index,
            name: spec.name,
            path: "(node-derived)",
            value: "—",
            missing: false,
          };
        }

        const raw = resolvePath(response, spec.source_path);
        if (raw === undefined) {
          return {
            index: spec.index,
            name: spec.name,
            path: spec.source_path,
            value: "missing",
            missing: true,
          };
        }

        let value = applyTransform(raw, spec.transform_rule);
        if (spec.multiplier !== undefined) {
          value = Math.round(Number(value) * spec.multiplier);
        }

        return {
          index: spec.index,
          name: spec.name,
          path: spec.source_path,
          value: JSON.stringify(value),
          missing: false,
        };
      });
  }

  return out;
}

export function TelegraphPanel({ asset, quote }: Props) {
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<CryptoPriceResponse | null>(null);
  const [onChain, setOnChain] = useState<OnChainArrays | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // A pending request for BTC is meaningless once the user switches to ETH.
  useEffect(() => {
    abortRef.current?.abort();
    setResponse(null);
    setOnChain(null);
    setError(null);
    setElapsedMs(null);
    setStage(null);
    setRunning(false);
  }, [asset, quote]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setResponse(null);
    setOnChain(null);
    setStage("koinmix");

    const startedAt = performance.now();

    try {
      // The contract endpoint, called the way a node calls it.
      const price = await getTelegraphPrice(asset, quote, controller.signal);
      if (controller.signal.aborted) return;

      setResponse(price);
      setStage("signal");

      // The real descriptor, parsed and applied — not a hardcoded mapping.
      try {
        const yamlText = await getMinerYaml(controller.signal);
        if (!controller.signal.aborted) setOnChain(mapOnChain(yamlText, price));
      } catch {
        // The price is still real even if the descriptor could not be read;
        // the mapping section simply stays empty rather than being invented.
        if (!controller.signal.aborted) setOnChain(null);
      }

      if (!controller.signal.aborted) {
        setElapsedMs(performance.now() - startedAt);
        setStage(null);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setStage("failed");
      setElapsedMs(performance.now() - startedAt);
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [asset, quote]);

  const stageState = (key: string): StageState => {
    const stageObject = STAGES.find((s) => s.key === key);
    if (stageObject && !stageObject.live) return "unavailable";
    if (error) return key === stage ? "failed" : "idle";
    if (running) return key === stage ? "active" : "idle";
    if (response) return "done";
    return "idle";
  };

  return (
    <Card
      title="Query via Telegraph"
      subtitle="the exact request a Telegraph node issues, against the live miner"
      actions={
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className={cx(
            "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
            running
              ? "cursor-not-allowed border-line text-ink-faint"
              : "border-accent/50 text-accent hover:bg-accent/10",
          )}
        >
          {running ? "Querying…" : `Query ${asset}/${quote}`}
        </button>
      }
    >
      <ol className="flex flex-col gap-0">
        {STAGES.map((item, index) => {
          const state = stageState(item.key);
          return (
            <li key={item.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={cx(
                    "mt-1 size-2.5 shrink-0 rounded-full border",
                    state === "done" && "border-up bg-up",
                    state === "active" && "live-dot border-accent bg-accent",
                    state === "failed" && "border-down bg-down",
                    state === "unavailable" && "border-warn bg-transparent",
                    state === "idle" && "border-line-strong bg-transparent",
                  )}
                />
                {index < STAGES.length - 1 && (
                  <span className="my-1 w-px flex-1 bg-line" />
                )}
              </div>

              <div className="pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {item.label}
                  </span>
                  {!item.live && (
                    <Badge
                      tone="warn"
                      title="KoinMix is not registered on-chain yet, so no node is in the path"
                    >
                      not yet live
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-faint">{item.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="rounded border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed text-ink-muted">
        <span className="font-medium text-warn">One hop is simulated.</span>{" "}
        KoinMix is not registered on-chain yet, so no Telegraph node sits in this
        path. Everything else is real: the button issues the request a node
        would issue, to{" "}
        <code className="font-mono text-[11px] text-ink-muted">{MINER_URL}</code>
        , and the arrays below are produced by parsing the miner&apos;s own
        registered YAML and applying its <code className="font-mono">source_path</code>{" "}
        mappings to the live response.
      </p>

      {error && (
        <div className="mt-4">
          <Unavailable
            title="Query failed"
            detail={
              <>
                <span className="block">{error.message}</span>
                {error instanceof ApiError && (
                  <span className="mt-1 block font-mono text-[11px]">
                    {error.code}
                    {error.requestId ? ` · ${error.requestId}` : ""}
                  </span>
                )}
                <span className="mt-2 block">
                  The miner returned an error rather than a price. No value is
                  shown because none was produced.
                </span>
              </>
            }
            onRetry={() => void run()}
            compact
          />
        </div>
      )}

      {response && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Badge tone="ok">200 OK</Badge>
            <Badge tone="info">{response.intent}</Badge>
            <span className="text-xs text-ink-faint">
              round trip {formatDuration(elapsedMs)} · {response.sourceCount}{" "}
              sources · confidence {response.confidence.toFixed(4)}
            </span>
          </div>

          {onChain ? (
            <div>
              <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                OnChainData, as the node would build it
              </h3>
              <div className="mt-2 space-y-3">
                {Object.entries(onChain).map(([group, values]) => (
                  <div key={group}>
                    <div className="font-mono text-[11px] text-ink-muted">
                      {group}[]
                    </div>
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full min-w-[420px] text-xs">
                        <tbody>
                          {values.map((value) => (
                            <tr key={`${group}-${value.index}`}>
                              <td className="w-10 py-1 font-mono text-ink-faint">
                                [{value.index}]
                              </td>
                              <td className="py-1 pr-3 text-ink-muted">
                                {value.name}
                              </td>
                              <td className="py-1 pr-3 font-mono text-[11px] text-ink-faint">
                                ← {value.path}
                              </td>
                              <td
                                className={cx(
                                  "tnum py-1 text-right",
                                  value.missing ? "text-down" : "text-ink",
                                )}
                              >
                                {value.value}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-faint">
              Miner descriptor unavailable, so the on-chain mapping is not shown.
              The price above is still live.
            </p>
          )}

          <details className="group">
            <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">
              Raw response
            </summary>
            <pre className="mt-2 overflow-x-auto rounded border border-line bg-surface-0 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
              {JSON.stringify(response, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Card>
  );
}
