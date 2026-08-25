# KoinMix — Telegraph CRYPTO_PRICE Miner

A [Telegraph Protocol](https://telegraphprotocol.com/) Miner serving the
**CRYPTO_PRICE** intent: multi-provider crypto spot prices, aggregated by median
consensus, with an agreement-derived confidence score.

**Status — serving live prices.** Four adapters hit real market data APIs:
CoinGecko, CoinMarketCap, Binance and Coinbase. There is no mock, fallback, or
synthetic price anywhere in `src/` — if every provider fails, the miner returns
an error rather than a number.

Verify it against the live APIs yourself:

```console
$ npm run live:check

BTC/USD  (round took 2785ms)
  PROVIDER       PRICE           LATENCY   INSTRUMENT    SOURCE TIMESTAMP
  binance        79,711.35       1683ms    BTCUSDT *     2026-08-25T01:49:43.005Z
  coinbase       79,708.74       1438ms    BTC-USD       2026-08-25T01:49:41.616Z
  coingecko      79,670.00       2388ms    bitcoin/usd   2026-08-25T01:47:30.000Z
  spread: 79,670 – 79,711.35 (5 bps across 3 independent providers)
  * quoted against a stablecoin proxy for the requested fiat
```

---

## How a Telegraph Miner actually works

Worth stating plainly, because it drives the whole design: **a Telegraph Miner is
an ordinary upstream HTTP API.** You do not implement a Telegraph SDK or open a
socket to the network. Instead:

1. You publish a **YAML config** ([`telegraph/koinmix.yaml`](telegraph/koinmix.yaml))
   declaring your `base_url`, endpoints, response semantics, and how your JSON
   maps onto on-chain arrays.
2. You register the YAML's **SHA-256 hash** on-chain by calling
   `MinerRegistryFacet.registerMiner()` on the Telegraph Diamond.
3. Telegraph nodes detect the event, fetch your YAML, verify the hash, and
   activate you at the next **epoch boundary** — no node restarts, no PRs.
4. At request time the node terminates **x402 payment** itself, then proxies to
   your `base_url` and maps your response into a signal.

So this repository is a plain, well-structured HTTP service plus a YAML
descriptor. The miner performs **no payment handling** — the node holds the
receiving addresses and talks to the PayAI facilitator.

```
Agent / dApp
    │  declares intent: CRYPTO_PRICE
    ▼
Telegraph node ── x402 402/pay/retry ──┐
    │  routes by supported_intents      │  (node-side, not ours)
    ▼                                   ┘
KoinMix Miner  ──►  validation ──► providers ──► consensus ──► response
    │
    ▼  node maps response via on_chain.fields
Signal on Base
```

---

## Architecture

Each stage is a separate module with a single responsibility, so a Phase 2
provider can be added without touching validation, consensus, or transport.

| Layer | Location | Responsibility |
| --- | --- | --- |
| Configuration | [src/config/env.ts](src/config/env.ts) | The **only** module that reads `process.env`. Zod-validated, fails fast at boot. |
| Telegraph adapter | [src/telegraph/adapter.ts](src/telegraph/adapter.ts) | Transport-agnostic seam: validate → fan out → consensus → format. |
| Intent constants | [src/telegraph/intents.ts](src/telegraph/intents.ts) | Canonical intent and signal-type values, with the doc discrepancies recorded. |
| Request validation | [src/telegraph/schema.ts](src/telegraph/schema.ts) | Zod request/response contracts, mirrored into the YAML. |
| Provider layer | [src/providers/](src/providers/) | `PriceProvider` interface, four live adapters, registry, concurrent collection. |
| Asset resolution | [src/providers/assets.ts](src/providers/assets.ts) | Single place translating `BTC` into each provider's identifier. |
| Provider HTTP | [src/providers/http.ts](src/providers/http.ts) | One fetch path: timeout, status checks, JSON parsing, latency. |
| Consensus engine | [src/consensus/engine.ts](src/consensus/engine.ts) | Pure, deterministic median aggregation with staleness and deviation guards. |
| HTTP transport | [src/http/](src/http/) | Fastify routes, single error boundary, structured request logging. |
| Errors | [src/errors.ts](src/errors.ts) | Typed hierarchy carrying HTTP status + machine-readable code. |
| Miner descriptor | [telegraph/koinmix.yaml](telegraph/koinmix.yaml) | The artifact Telegraph nodes read and hash. |

**Why the consensus engine is pure.** CRYPTO_PRICE is a **Tier A** intent scored
by *WASM Exact Match*. Two miners handed the same quotes must produce
byte-identical output, so the engine does no I/O, takes its clock by injection,
and derives the decimal `price` string from the integer `priceX1e8` — the string
and the on-chain integer are two views of one value and cannot drift apart.

---

## API

### `GET /v1/price?asset=BTC&quote=USD`
### `POST /v1/price` — `{"asset": "BTC", "quote": "USD"}`

`GET` is the shape an on-chain request arrives in: the node maps `strings[0]` and
`strings[1]` onto `asset` and `quote` per `on_chain.request.query_params`. `POST`
is a convenience for direct HTTP callers. `quote` defaults to `USD`.

<details>
<summary>Response shape (Phase 2, once providers are live)</summary>

```json
{
  "intent": "crypto_price",
  "asset": "BTC",
  "quote": "USD",
  "price": "64213.55",
  "priceX1e8": 6421355000000,
  "confidence": 0.8,
  "sourceCount": 3,
  "sources": ["alpha", "bravo", "charlie"],
  "method": "median",
  "deviationBps": 12,
  "asOf": "2026-08-24T11:59:30.000Z",
  "observedAt": "2026-08-24T12:00:00.000Z",
  "isStale": false,
  "minerSlug": "koinmix-crypto-price",
  "explanation": "Median price for BTC/USD from 3 live provider quote(s) ..."
}
```

Field names are load-bearing — `telegraph/koinmix.yaml` references them by
dot-path in `on_chain.fields[].source_path`. Renaming one requires deregistering
and re-registering the YAML on-chain.
</details>

### `GET /healthz`

`200 ok` when at least one provider is active, `503 degraded` otherwise (the
Phase 1 state — surfaced rather than hidden).

### `GET /telegraph/koinmix.yaml`

Serves the miner descriptor verbatim, so it can be registered on-chain straight
from this deployment.

### Errors

Every failure returns `{ error, code, details, requestId }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request failed the Zod contract. |
| `NO_PROVIDERS_CONFIGURED` | 503 | No live provider wired up (**current Phase 1 state**). |
| `PROVIDER_UNAVAILABLE` | 503 | Providers configured, but all failed or timed out. |
| `INSUFFICIENT_SOURCES` | 503 | Fewer fresh quotes than `CONSENSUS_MIN_SOURCES`. |
| `CONSENSUS_FAILED` | 502 | Quotes disagreed beyond the deviation tolerance. |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged, never returned. |

---

## Getting started

Requires Node.js ≥ 20.11.

```bash
npm install
cp .env.example .env
npm run dev          # watch mode on http://localhost:8080
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run typecheck` | Type-check `src/` and `tests/` without emitting. |
| `npm test` | Run the Vitest suite. |
| `npm start` | Run the compiled build. |
| `npm run live:check` | **Real** query against the live provider APIs. Takes optional args: `-- SOL`, `-- BTC EUR`. |
| `npm run yaml:hash` | SHA-256 of the miner YAML, for on-chain registration. |

### Windows: `ComSpec` must be set

If `npm install` fails with `ERR_INVALID_ARG_TYPE: The "file" argument must be
of type string`, or `npm test` hangs with no output, the shell has an empty
`ComSpec`. npm needs it to spawn lifecycle scripts (esbuild's `postinstall`),
and Vitest's default `forks` pool needs it to spawn workers.

```powershell
$env:ComSpec = "C:\Windows\System32\cmd.exe"    # PowerShell
export COMSPEC="C:\\Windows\\System32\\cmd.exe" # bash
```

This is an environment quirk, not a project defect. The Vitest half is already
worked around in [vitest.config.ts](vitest.config.ts) via `pool: "threads"`.

---

## Configuration

All variables are documented in [.env.example](.env.example) and parsed once in
[src/config/env.ts](src/config/env.ts). Nothing else in the codebase touches
`process.env`; provider credentials are reached only through `Config.secret()`,
so adding a provider needs no change to the config module.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | Pino level; pretty printing for local dev only. |
| `MINER_SLUG` / `MINER_SUBNET_ID` | `koinmix-crypto-price` / `9001` | Mirror the YAML's `slug` and `id`. |
| `MIN_PRICE_USDC` | `0.01` | Floor price per call. Protocol minimum is $0.01. |
| `MINER_FEE_ADDRESS` | — | Payout address; needed at registration, not runtime. |
| `PRICE_PROVIDERS` | `coingecko,binance,coinbase` | Providers to enable. Add `coinmarketcap` once you have a key. |
| `PROVIDER_TIMEOUT_MS` | `5000` | Per-provider timeout. |
| `COINMARKETCAP_API_KEY` | — | Optional. Upgrades CMC from its keyless USD-only endpoint to the full Pro API. |
| `COINGECKO_API_KEY` / `_API_PLAN` | — / `demo` | Optional. Public tier is keyless; `pro` switches host and header. |
| `BINANCE_BASE_URL` | `api.binance.com` | Override where Binance is geo-restricted (HTTP 451). |
| `COINBASE_BASE_URL` | `api.exchange.coinbase.com` | Coinbase Exchange host. |
| `CONSENSUS_MIN_SOURCES` | `1` | Minimum fresh quotes before emitting a price. |
| `CONSENSUS_MAX_DEVIATION_BPS` | `200` | Reject the round past this disagreement. |
| `PRICE_MAX_STALENESS_MS` | `300000` | Discard quotes older than this. |

### Providers

| Provider | Endpoint | Key | Notes |
| --- | --- | --- | --- |
| CoinGecko | `/simple/price` | Optional | Chosen over lighter endpoints because it returns `last_updated_at`. Free tier lags 1–2 min. |
| CoinMarketCap | `/v2/…/quotes/latest` (keyed) or `/public-api/v1/simple/price` (keyless) | Optional | Two modes — see below. Signals some errors in a 200 envelope, so the body is checked too. |
| Binance | `/api/v3/ticker/24hr` | No | Used over `/ticker/price` because only this carries `closeTime`. |
| Coinbase | `/products/{id}/ticker` | No | Exchange API over `/v2/prices/spot`, which has no timestamp. Real fiat pairs. |

Two decisions worth knowing:

- **No provider may invent a timestamp.** Every adapter uses an endpoint that
  reports a genuine upstream observation time, and a missing one is a hard
  error. A synthesised `asOf` would silently defeat staleness checking.
- **Binance USD is served from USDT.** Binance's global venue lists no fiat
  BTC/USD or ETH/USD spot market. A USD request is filled from `BTCUSDT` and
  flagged `isQuoteProxy: true` rather than silently substituted. USDT tracks USD
  closely but is not identical; a real depeg shows up as a consensus deviation.

#### CoinMarketCap's two modes

Without a key the adapter uses CMC's
[keyless public API](https://coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api).
It works with no signup, but has two constraints — both verified against the
live endpoint, and both of which would corrupt output if ignored:

1. **It silently ignores `convert` and always returns USD.** Requesting EUR, JPY
   or GBP returns the USD figure to 14 significant figures with a success
   status. The adapter therefore refuses non-USD in keyless mode rather than
   mislabelling a USD price — which on an exact-match-scored intent would be
   worse than returning nothing.
2. **No per-asset update time**, only CMC's response timestamp. Reported as
   `timestampProvenance: "response"` instead of `"observed"`.

Setting `COINMARKETCAP_API_KEY` upgrades to `/v2/cryptocurrency/quotes/latest`
in place, which fixes both. That is the recommended production setup.

---

## On-chain registration

Not performed in Phase 1 — recorded here so the YAML is registerable as soon as
providers are live.

```bash
npm run yaml:hash    # → 0x<sha256 of the exact bytes served>

DIAMOND=0x122396E8602BEed349434AA6E83123E7dD97F5A0   # Base Sepolia

cast send "$DIAMOND" \
  "registerMiner(string,bytes32,address,uint256,string[])" \
  "https://miner.koinmix.io/telegraph/koinmix.yaml" \
  "$YAML_HASH" \
  "$MINER_FEE_ADDRESS" \
  10000 \
  '["crypto_price"]' \
  --rpc-url "$RPC" --private-key "$MINER_PRIVATE_KEY"
```

Notes drawn from the docs, each easy to get wrong:

- The hash is **SHA-256**, explicitly *not* keccak256.
- `minPriceUsdc` is in 6-decimal USDC: `10000` = $0.01, the protocol minimum.
- There is **no update function** — deregister, edit, then re-register for a new
  `registrationId`.
- Registrations activate at the next **epoch boundary** (`EPOCH_BLOCK_INTERVAL`,
  default 300 blocks), not immediately.

### Two open questions for the Telegraph team

Both are recorded in code rather than guessed at, and neither blocks Phase 1:

1. **Intent string casing.** `CRYPTO_PRICE` appears in the
   [hackathon intent catalog](https://hackathon.telegraphprotocol.com/supported-intents)
   (Financial Data, Tier A) but *not* in the 27-entry canonical list in the core
   docs, which predates it. The YAML Standard writes intents in `snake_case`, and
   the registry docs warn that non-canonical intents are "accepted but will not be
   routed". We declare `crypto_price` and accept both spellings on input —
   the exact on-chain string should be confirmed before registering.
2. **Signal type.** The canonical `signal_mapping.type` enum has no
   financial/market-data member, and a value outside it fails node-side
   validation. We use `task_completion` as the only member that is not
   semantically wrong for a deterministic data lookup.

---

## Telegraph documentation used

| Document | What it settled |
| --- | --- |
| [YAML Standard](https://telegraph-2.gitbook.io/telegraph/miner-registry/yaml-standard.md) | Full v1 schema, `semantics`, `on_chain` transforms, `on_chain.request` mapping, canonical intent/signal enums. |
| [Miner Registry Contract & Listener](https://telegraph-2.gitbook.io/telegraph/miner-registry/miner-registry-facet.md) | `registerMiner()` signature, Diamond address, SHA-256 rule, epoch activation, no-update flow. |
| [Miner Registry Overview](https://telegraph-2.gitbook.io/telegraph/miner-registry/miner-registry.md) | Registration lifecycle and discovery model. |
| [x402 Payment](https://telegraph-2.gitbook.io/telegraph/miner-registry/x402-payment.md) | Confirmed payment is node-side; error-status conventions (502 upstream). |
| [Subnet Integration for Devs](https://telegraph-2.gitbook.io/telegraph/inference-sources/subnet-integration-for-devs.md) | `OnChainData` typed arrays, max length 5, encoding rules for decimals. |
| [Hackathon intent catalog](https://hackathon.telegraphprotocol.com/supported-intents) | `CRYPTO_PRICE` as Tier A / Financial Data / WASM Exact Match. |
| [Hackathon rules](https://hackathon.telegraphprotocol.com/rules) | Judging criteria; the prohibition on simulated data. |
| [Docs index (llms.txt)](https://telegraph-2.gitbook.io/telegraph/llms.txt) | Canonical page listing. |

---

## Known limitations

- **Asset coverage is a curated table.** BTC, ETH, SOL and XRP are mapped in
  [assets.ts](src/providers/assets.ts); anything else is refused rather than
  guessed. A wrong CoinGecko slug would silently price the wrong token, so the
  table is deliberate — but it does not scale to thousands of assets.
- **No caching or rate-limit handling.** Every request fans out to every
  provider. CoinGecko's keyless tier will return HTTP 429 under sustained load.
- **`CONSENSUS_MIN_SOURCES` defaults to 1**, so a single provider can currently
  determine the signal. Raise it to ≥ 2 before serving real traffic.
- **Non-USD quotes are only partly covered.** EUR/GBP work on CoinGecko, CMC and
  Coinbase, but Binance has no such pair for these assets and will fail.
- **CoinMarketCap's keyed mode is unverified against the live API.** Keyless
  mode is confirmed working end to end; the `/v2` path is written to the
  documented shape and unit-tested, but has never made a real call. Add a key
  and run `npm run live:check` to confirm it.
- **Keyless CoinMarketCap is USD-only**, so non-USD rounds run one provider
  short.

## Next

- Confirm the two open registration questions above, then register on Base Sepolia.
- Deploy to a public HTTPS origin and set `base_url` in the YAML to match.
- Add per-provider caching and 429 backoff.
- Route-level tests through `app.inject()`.
