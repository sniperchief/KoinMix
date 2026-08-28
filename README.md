# KoinMix — Telegraph CRYPTO_PRICE Miner

A [Telegraph Protocol](https://telegraphprotocol.com/) Miner serving the
**CRYPTO_PRICE** intent: multi-provider crypto spot prices, aggregated by median
consensus, with an agreement-derived confidence score.

**Status — serving live prices, and measured.** Four adapters hit real market
data APIs: CoinGecko, CoinMarketCap, Binance and Coinbase. There is no mock,
fallback, or synthetic price anywhere in `src/` — if every provider fails, the
miner returns an error rather than a number. `npm run evaluate` scores the
aggregation against a held-out venue on live data; see
[Evaluation](#evaluation-phase-4) for what it measured and what it changed.

## Live deployment

| | URL |
| --- | --- |
| **Miner** — the Telegraph product | <https://koinmix-production.up.railway.app> |
| **Terminal** — the evidence viewer | <https://koinmix-terminal.vercel.app> |

The miner is the submission: a plain HTTP service a Telegraph node would proxy
to. The terminal exists to make its reasoning visible to a human and is not part
of the miner contract.

Try the contract endpoint directly — this is exactly the call a node makes,
mapping on-chain `strings[0]` and `strings[1]` onto the two query params:

```bash
curl "https://koinmix-production.up.railway.app/v1/price?asset=BTC&quote=USD"
curl  https://koinmix-production.up.railway.app/healthz
curl  https://koinmix-production.up.railway.app/telegraph/koinmix.yaml
```

**Registered on Base Sepolia**, registration ID `252`, on the canonical
`CRYPTO_PRICE` intent — see [On-chain registration](#on-chain-registration).
The terminal still calls the miner directly rather than through a node, and says
so on screen rather than drawing a hop that is not happening.

---

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

## Why KoinMix?

An autonomous agent that acts on a crypto price has a problem a human trader
does not: it cannot glance at a second tab and notice something looks off. It
gets one number, and it acts on it.

Single-source pricing makes that number fragile in ways that are invisible at
the call site. Venues genuinely disagree — a few basis points on a calm day,
far more on a thin book. Aggregators serve prices minutes old while reporting
them as current. Any one API can rate-limit, go down, or return a malformed
tick that parses cleanly as a number. An agent consuming one feed cannot
distinguish "the market moved" from "my source is broken."

KoinMix answers with a number *and the evidence behind it*:

- **Multiple independent venues per round**, so no single upstream determines
  the signal.
- **A confidence indicator and a spread**, so a caller can tell corroborated
  agreement from a lone quote and gate its own behaviour on it.
- **Explicit refusal.** When sources disagree beyond tolerance, or all of them
  fail, KoinMix returns an error. It never falls back to a stale cache, a
  last-known value, or a synthesised price. An agent that receives a number from
  KoinMix knows live sources agreed on it — which is only meaningful because
  there is no path by which a number is returned when they did not.

The terminal exists to make that evidence legible to a human: per-provider
quotes, their ages and latencies, what was excluded and why, and how the
confidence score decomposes.

**What this is not.** KoinMix does not claim to be the most accurate price
source available, and nothing here is a guarantee. The [Evaluation](#evaluation-phase-4)
section reports what was actually measured, over a stated sample size, including
where the results were unimpressive.

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

Each stage is a separate module with a single responsibility, so a new
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
| Evidence weighting | [src/consensus/weighting.ts](src/consensus/weighting.ts) | What an observation is worth, by age and by whether its age can be verified. |
| Evaluation harness | [scripts/evaluate.ts](scripts/evaluate.ts), [scripts/evaluation/](scripts/evaluation/) | Live accuracy measurement against a held-out reference venue. Not imported by `src/`. |
| Descriptor verifier | [scripts/verify-onchain.ts](scripts/verify-onchain.ts) | Checks the YAML against the standard and resolves every mapped path against a live response. |
| Historical candles | [src/market/candles.ts](src/market/candles.ts) | Real OHLCV for the terminal's chart. Undeclared in the YAML — not part of the Telegraph contract. |
| Terminal (frontend) | [web/](web/) | React demo UI. Reads the miner over HTTP; see [web/README.md](web/README.md). |
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
<summary>Response shape</summary>

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

`200 ok` when at least one provider is active, `503 degraded` otherwise —
surfaced rather than hidden.

### `GET /v1/candles?asset=BTC&quote=USD&interval=1h`

Real OHLCV bars for the demo terminal's chart, from Binance (all five intervals
natively) falling back to Coinbase (1h and 1d only). **Not declared in the miner
YAML**, so Telegraph never routes to it — CRYPTO_PRICE answers what the price is
now, and candles exist to draw a chart.

Intervals: `1h`, `4h`, `1d`, `1w`, `1M`. Returns `503` listing each venue's
reason when no real source can serve the interval, rather than an empty array —
an empty array reads as "this market has no history", which is a different and
untrue statement. No bar is ever synthesised or stitched from shorter ones.

### `GET /telegraph/koinmix.yaml`

Serves the miner descriptor verbatim, so it can be registered on-chain straight
from this deployment.

### Errors

Every failure returns `{ error, code, details, requestId }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request failed the Zod contract, **or** named an asset/quote this miner does not carry. The response lists what is supported. |
| `NO_PROVIDERS_CONFIGURED` | 503 | No live provider wired up, e.g. an empty `PRICE_PROVIDERS`. |
| `PROVIDER_UNAVAILABLE` | 503 | Providers configured, but all failed or timed out. |
| `INSUFFICIENT_SOURCES` | 503 | Fewer fresh quotes than `CONSENSUS_MIN_SOURCES`. |
| `CONSENSUS_FAILED` | 502 | Quotes disagreed beyond the deviation tolerance. |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged, never returned. |

**Why 400 and 503 are kept strictly apart.** The status is the only part of a
failure a Telegraph node acts on automatically, and the two classes call for
opposite behaviour: 503 means *the answer exists, try again*, while 400 means
*this request will never succeed*. An unsupported asset therefore answers 400.
It previously fell through to the provider fan-out, where every adapter declined
the pair and the round ended as `PROVIDER_UNAVAILABLE` — inviting a node to
retry, forever, a pair that can never resolve.

The same reasoning splits the two ways a round can come back empty: every
provider *declining* a pair is a standing capability limit (400), while every
provider *failing* is an outage (503). Verified live in both directions — an
unknown asset returns 400 while four dead providers still return 503.

---

## Getting started

Requires Node.js ≥ 20.11.

```bash
npm install
cp .env.example .env
npm run dev          # miner in watch mode on http://localhost:8080
```

The demo terminal is a separate package in [web/](web/):

```bash
cd web && npm install && npm run dev    # terminal on http://localhost:5173
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run typecheck` | Type-check `src/` and `tests/` without emitting. |
| `npm test` | Run the Vitest suite. |
| `npm start` | Run the compiled build. |
| `npm run live:check` | **Real** query against the live provider APIs. Takes optional args: `-- SOL`, `-- BTC EUR`. |
| `npm run evaluate` | **Real** accuracy measurement vs a held-out venue. `-- ETH BTC --samples 25 --out r.json`. |
| `npm run verify:onchain` | Check the miner YAML against the standard and resolve every mapped path against a live response. |
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

## Testing

```bash
npm run typecheck && npm test     # miner:    197 tests, 9 files
cd web && npm test && npm run lint # terminal:  10 tests
```

**197 miner tests** across nine files. What they actually pin:

| File | Covers |
| --- | --- |
| `consensus.test.ts` (50) | Median aggregation, staleness filtering, spread guard, outlier detection including the brief's canonical bad tick, weighting maths. |
| `providers.test.ts` (45) | Each adapter's parsing against exact upstream payload shapes, including malformed ones, plus URL and header construction. |
| `endToEnd.test.ts` (22) | The full HTTP path, including a GET shaped the way a Telegraph node maps an on-chain request. |
| `adapter.test.ts` (19) | Validation, the no-provider and all-providers-failed refusals, and the 400-vs-503 status matrix. |
| `validation.test.ts` (16) | Request contract, including symbols crafted to escape a provider URL. |
| `evaluation-metrics.test.ts` (13) | The evaluation harness's own statistics. |
| `candles.test.ts` (12) | OHLC parsing, notably Coinbase's reversed `[time, low, high, open, …]` column order. |
| `assets.test.ts` (12) | Symbol → per-provider identifier translation. |
| `cache.test.ts` (8) | TTL reuse and expiry, and that a cache hit ages rather than refreshes. |

**Mocks appear only in tests, never in `src/`.** Test doubles feed adapters
exact payload shapes — including malformed ones no live API would produce on
demand — and exercise orchestration under partial failure. The provider registry
contains no synthetic provider, and the real adapters are verified against the
live venues by `npm run live:check` and `npm run evaluate`.

---

## Deployment

The miner is a stateless HTTP service. It needs no database, no queue, and no
persistent volume.

```bash
docker build -t koinmix-miner .
docker run -p 8080:8080 --env-file .env koinmix-miner
```

> **Not yet verified.** The [Dockerfile](Dockerfile) is written against the
> layout verified below, but no Docker daemon was available on the machine where
> this was prepared, so the image itself has not been built. Treat it as
> unproven until you have run the two commands above.

**One non-obvious packaging requirement.**
[src/http/routes/health.ts](src/http/routes/health.ts) resolves the miner
descriptor at `../../../telegraph/koinmix.yaml`, which from `dist/http/routes/`
lands **outside `dist/`**. An image that copies only `dist/` builds fine, boots
fine, and serves prices fine — and then returns 500 on
`GET /telegraph/koinmix.yaml`, the one route a Telegraph node fetches to verify
your on-chain hash. The `telegraph/` directory must ship alongside `dist/`.
Verified by running the compiled build directly: `/healthz`, the YAML route, and
a live BTC round all answer 200.

`.dockerignore` excludes `.env` deliberately, not incidentally: deleting a
secret in a later layer does not remove it from an earlier one, so exclusion is
the only real defence.

### Requirements

| | |
| --- | --- |
| Runtime | Node.js ≥ 20.11 (image uses 22-alpine) |
| Egress | HTTPS to `api.coingecko.com`, `pro-api.coinmarketcap.com`, `api.binance.com`, `api.exchange.coinbase.com` |
| Ingress | **Public HTTPS.** Telegraph nodes must reach `base_url` directly. |
| Credentials | None required — all four providers run keyless. |
| State | None. Scale horizontally; the quote cache is per-instance and needs no coordination. |

`api.binance.com` answers HTTP 451 in some regions. Where that applies, set
`BINANCE_BASE_URL` (e.g. `api.binance.us`) or drop `binance` from
`PRICE_PROVIDERS` — the round degrades to three providers rather than failing.

### Before going live

1. **Set `LOG_PRETTY=false`.** JSON is what aggregators parse, and the
   startup-failure path can only emit a structured `fatal` line when pretty
   printing is off — see [src/index.ts](src/index.ts).
2. **Raise `CONSENSUS_MIN_SOURCES` to ≥ 2.** The default of `1` lets a single
   provider determine the signal.
3. **Set `MINER_FEE_ADDRESS`** to the payout address. Public address only.
4. **Narrow `CORS_ALLOW_ORIGIN`** if you would rather this deployment answered
   only your own terminal.
5. **Keep `base_url` in [telegraph/koinmix.yaml](telegraph/koinmix.yaml)** equal
   to the origin actually serving it — currently
   `https://koinmix-production.up.railway.app`. **Editing the YAML changes its
   SHA-256**, so make any edit *before* registering, then run
   `npm run yaml:hash` and register that hash. See
   [On-chain registration](#on-chain-registration).

### The terminal

[web/](web/) is a static site and deploys separately — it is excluded from the
miner image. Build with `npm run build` and serve `web/dist/` from any static
host, with `VITE_MINER_URL` pointed at the miner's public origin. It holds no
secrets; every figure it displays comes from the miner at runtime.

---

## Configuration

All variables are documented in [.env.example](.env.example) and parsed once in
[src/config/env.ts](src/config/env.ts). Nothing else in the codebase touches
`process.env`; provider credentials are reached only through `Config.secret()`,
so adding a provider needs no change to the config module.

A `.env` file in the working directory is loaded at startup by
[src/config/loadEnvFile.ts](src/config/loadEnvFile.ts), using Node's built-in
loader rather than a dependency. Two behaviours worth knowing: **real
environment variables take precedence over the file**, so a deployment's
injected secrets cannot be clobbered by a stray `.env` and a one-off
`KEY=... npm run ...` override still works; and **a missing `.env` is not an
error**, since production configuration normally arrives from the environment.
Only the three entry points load it — library code and tests never do.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address. |
| `CORS_ALLOW_ORIGIN` | `*` | Browser origin allowed to call the miner, for the terminal. Every route is public read-only data with no credentials. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | Pino level; pretty printing for local dev only. |
| `MINER_SLUG` / `MINER_SUBNET_ID` | `koinmix-crypto-price` / `9001` | Mirror the YAML's `slug` and `id`. |
| `MIN_PRICE_USDC` | `0.01` | Floor price per call. Protocol minimum is $0.01. |
| `MINER_FEE_ADDRESS` | — | Payout address; needed at registration, not runtime. |
| `PRICE_PROVIDERS` | `coingecko,coinmarketcap,binance,coinbase` | Providers to enable. All four run keyless, so a fresh checkout serves live prices immediately. |
| `PROVIDER_TIMEOUT_MS` | `5000` | Per-provider timeout. |
| `PROVIDER_CACHE_TTL_MS` | `3000` | How long a successful quote may be reused before its provider is asked again. `0` disables. See [Caching](#caching). |
| `COINMARKETCAP_API_KEY` | — | Optional. Upgrades CMC from its keyless USD-only endpoint to the full Pro API. |
| `COINGECKO_API_KEY` / `_API_PLAN` | — / `demo` | Optional. Public tier is keyless; `pro` switches host and header. |
| `BINANCE_BASE_URL` | `api.binance.com` | Override where Binance is geo-restricted (HTTP 451). |
| `COINBASE_BASE_URL` | `api.exchange.coinbase.com` | Coinbase Exchange host. |
| `CONSENSUS_MIN_SOURCES` | `1` | Minimum fresh quotes before emitting a price. |
| `CONSENSUS_MAX_DEVIATION_BPS` | `200` | Reject the round past this disagreement. |
| `PRICE_MAX_STALENESS_MS` | `300000` | Discard quotes older than this. |
| `PRICE_FRESHNESS_HALFLIFE_MS` | `10000` | Age at which a quote counts for half as much. `0` disables freshness weighting. |
| `UNVERIFIED_FRESHNESS_WEIGHT` | `0.5` | Weight for a quote whose age cannot be verified. `1` disables the penalty. |
| `OUTLIER_Z_THRESHOLD` | `3.5` | MAD-based modified z-score above which an observation is called anomalous. |
| `OUTLIER_MIN_DEVIATION_BPS` | *follows `CONSENSUS_MAX_DEVIATION_BPS`* | Floor below which a quote is never called an outlier. See [Outlier detection](#outlier-detection). |
| `PROVIDER_WEIGHTS` | *empty* | Optional static per-provider weights, e.g. `coinbase:1.5,binance:1`. Empty means every provider weighs the same. |

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

### Caching

Every round otherwise fans out to every provider, which walks the keyless tiers
straight into rate limiting — CoinGecko returned HTTP 429 on **16 of 50**
evaluation rounds at roughly 10 requests/minute. `PROVIDER_CACHE_TTL_MS`
(default `3000`) lets a successful quote be reused for a few seconds before its
provider is asked again. Implemented as a decorator in
[src/providers/cache.ts](src/providers/cache.ts), so no adapter knows it exists.

**A cache hit returns the stored quote verbatim** — the original upstream
`asOf`, its `timestampProvenance`, the `instrument`, and the latency of the call
that actually happened. Nothing is restamped to look newer than it is.

That is the property that keeps a cache from becoming a way to pass stale data
off as live. Because `asOf` is untouched, a cached quote keeps *ageing*: the
staleness bound still discards it once it is too old, and the freshness
half-life still discounts its weight as it ages, with no special-casing anywhere
in the consensus engine. A cached quote is therefore strictly less influential
than a fresh one. The layer changes how often the miner *asks* upstream; it
never changes what the miner claims about a price.

Measured on the compiled build (BTC/USD, `PROVIDER_CACHE_TTL_MS=3000`):

| | Server-side round | Summed provider latency |
| --- | --- | --- |
| Cache miss | 2396 ms | 4829 ms |
| Cache hit | **1 ms** | — no upstream call |
| After TTL expiry | 921 ms | 2281 ms (upstream re-hit) |

Failures are deliberately **not** cached: a provider that just errored is
retried on the next round rather than having its outage held open locally.

---

## Consensus methodology

The engine ([src/consensus/engine.ts](src/consensus/engine.ts)) is pure and
deterministic — no I/O, clock by injection — because CRYPTO_PRICE is a Tier A
intent scored by WASM Exact Match, so two miners handed the same quotes must
produce byte-identical output.

A round proceeds in fixed order:

1. **Discard stale quotes.** Anything older than `PRICE_MAX_STALENESS_MS`
   (default 300 s) is dropped and recorded as an exclusion with its age.
2. **Detect outliers** among what survives (see below).
3. **Weight each surviving quote** by age and provenance (see below).
4. **Take the weighted median.** Median rather than mean because a single wild
   print moves a mean arbitrarily far while it can only move a median to its
   neighbour.
5. **Guard the spread.** If surviving quotes still disagree by more than
   `CONSENSUS_MAX_DEVIATION_BPS` (default 200 bps = 2 %), the round is
   **refused** with `CONSENSUS_FAILED` rather than answered. Disagreement past
   that point means the miner does not know the price, and saying so is the
   honest output.
6. **Derive the wire format.** The decimal `price` string is computed *from* the
   integer `priceX1e8`, so the string and the on-chain integer are two views of
   one value and cannot drift apart.

### Evidence weighting

Weighting exists because the staleness bound alone is a cliff: at 300 s a
two-minute-old aggregator print counts exactly as much as a one-second-old
exchange print, right up until it counts for nothing.

- **Freshness.** A quote's weight halves every `PRICE_FRESHNESS_HALFLIFE_MS`
  (default 10 s) of age. Set to `0` to weigh every surviving quote equally.
- **Unverifiable timestamps.** A quote whose `asOf` is the provider's *response*
  time rather than a genuine observation time is multiplied by
  `UNVERIFIED_FRESHNESS_WEIGHT` (default `0.5`), because it would otherwise be
  credited with perfect freshness on an unverifiable claim.

This is not free: live evaluation found that disabling the provenance penalty
while leaving freshness weighting on measured **worse** than disabling both,
because it moves weight from the source with an honestly old timestamp onto the
source with an unverifiable one.

A concrete example of why the penalty is needed, measured this session:
CoinMarketCap's keyless timestamp came back **25 ms ahead of our own clock**, so
its apparent age floors at zero every round regardless of how old the price
behind it actually is.

### Outlier detection

Per-observation and per-round only. A provider that produces one anomalous tick
is never blacklisted, because a venue that is wrong once is usually right
immediately afterwards.

Detection uses the **MAD-based modified z-score** with a threshold of `3.5` —
the Iglewicz & Hoaglin (1993) convention, a published figure rather than one
tuned to make tests pass. Two guards constrain it:

- **A bps floor.** The modified z-score is scale-free, so when sources agree
  closely the MAD collapses toward zero and *any* difference produces an
  enormous score. `OUTLIER_MIN_DEVIATION_BPS` sets a floor beneath which nothing
  is called an outlier; it defaults to following `CONSENSUS_MAX_DEVIATION_BPS`,
  which makes exclusion self-consistent — an observation is anomalous only if it
  exceeds the disagreement the round would already have rejected. An earlier
  fixed 50 bps default was wrong for exactly this reason: given `[100, 101, 100]`
  the MAD is zero and 101 sits only 100 bps out, so a legitimate third source was
  excluded and confidence *rose* when it should have fallen.
- **A surviving majority.** Nothing is excluded below three quotes (no majority
  exists to arbitrate), or if exclusion would leave fewer than two survivors.
  Handing a visibly-disagreeing set to the spread guard beats manufacturing
  false agreement by discarding most of the evidence.

**Honest caveat, unchanged:** outlier detection has **never fired on live data**.
Zero exclusions across every evaluation round — the floor sits an order of
magnitude above real cross-venue spread. It is a guard against a broken print,
not an active part of the pipeline, and should not be presented as one.

## Confidence methodology

`confidence` is a **reliability indicator, not a probability.** It does not
estimate the chance the price is correct and is not calibrated against any
outcome distribution. It summarises how much corroboration stood behind an
answer, so a consumer can tell four-source tight agreement from a lone
unverified quote. Treating it as a statistical confidence level would be
unsupported by this methodology.

It is built ([src/consensus/confidence.ts](src/consensus/confidence.ts)) as a
corroboration base multiplied by penalty factors in `[0,1]` — multiplicative so
several mild problems compound rather than cancel:

| Base: surviving sources | 1 → `0.50` · 2 → `0.70` · 3 → `0.85` · 4+ → `0.95` |
| --- | --- |
| Agreement | up to −30 %, by how much of the deviation budget the spread consumed |
| Freshness | up to −20 %, by how far the oldest quote sits through the staleness window |
| Outliers | −10 % per excluded observation |
| Provider failures | −5 % per failure |
| Unverifiable timestamps | −5 % per such surviving quote |

The base is **capped at 0.95 and never reaches 1.0**: four venues agreeing is
strong evidence, but they can still be jointly wrong through a shared upstream
or a market-wide bad print, so the score never asserts certainty.

Ordering is deliberate — disagreement between sources is the strongest signal
that a price may be wrong, so it carries the largest weight, while an upstream
simply being down says comparatively little about the sources that did answer.
The full breakdown is returned on the debug route, so any score can be
decomposed into the factors that produced it.

---

## Evaluation (Phase 4)

```bash
npm run evaluate                                  # ETH/USD, 20 rounds
npm run evaluate -- ETH BTC --samples 25          # both assets
npm run evaluate -- BTC --out results.json        # keep the raw samples
```

Every figure below came from live HTTP calls. The harness has no fixture, no
replay mode and no expected-price table — if the network is down it reports
failures rather than filling them in.

### The methodology problem, and what we did about it

**There is no ground truth for the price of ETH.** No venue publishes *the*
price; each publishes what it last traded at. That makes the obvious evaluation
— score consensus against the median of its own inputs — circular: consensus
sits in the middle of its inputs by construction and would "win" on arithmetic.

So the reference is **held out**: Kraken, a USD fiat spot venue that is *not*
one of our four providers, queried via `/0/public/Trades` so the reference
carries a real trade timestamp rather than an invented one. Every column —
each single provider and each aggregation — is scored by a source that none of
them contain.

That is fair, but it is not ground truth, and the report says so on every run: a
source structurally similar to Kraken (a USD spot exchange quoting last trade)
sits closer to it *by construction*. Rankings between exchanges and aggregators
should be read with that in mind, which is precisely why the change described
below was made on a basis that does not depend on the reference.

### What it measured

Two runs of 25 rounds, 2026-08-25, BTC/USD and ETH/USD, four providers live:

| Source | ETH mean | ETH max | BTC mean | BTC max |
| --- | --- | --- | --- | --- |
| binance | 0.8 bps | 2.7 | 1.6 bps | 2.9 |
| coinbase | 1.4 bps | 3.6 | 1.7 bps | 3.7 |
| coingecko | 2.4 bps | 4.5 | 12.0 bps | 20.2 |
| coinmarketcap | 2.4 bps | 9.7 | 10.2 bps | 23.6 |
| **KoinMix consensus** | **1.1 bps** | **2.7** | **2.3 bps** | **12.3** |
| plain median of the same quotes | 1.1 bps | 3.0 | 4.5 bps | 12.3 |
| plain mean of the same quotes | 1.1 bps | 4.0 | 5.9 bps | 12.3 |

Three findings, in the order they mattered.

**1. The Phase 3 consensus was worse than half its own inputs.** The first
baseline run put KoinMix at 2.9 bps against Binance and Coinbase at 1.8 — the
aggregation was *losing* to the sources it aggregated. With uniform weights and
nothing excluded, `weightedMedian` reduces exactly to `median`, so KoinMix was
returning the plain median of four quotes, two of which were badly lagged. A
median of four averages the middle pair, so it settled halfway between the fresh
exchange prices and the stale aggregator prices — a number nobody was trading at.

**2. The lagged sources were late, not wrong.** The harness records a reference
*time series*, so each quote can be re-scored against the reference observed at
the quote's own timestamp. CoinGecko's BTC error collapsed from 12.0 bps to
3.2 bps under that alignment: it was right about a moment two minutes ago.
CoinMarketCap's did not collapse the same way (10.2 → 7.1, and 7.8 → 9.0 in an
earlier run) — and it reports a *response* timestamp rather than an observation
time, so its claimed sub-second age is unverifiable and demonstrably false.
These are different faults and they need different fixes.

**3. Outlier detection has never fired.** Zero exclusions across every round at
the 200 bps floor. Real cross-venue spread ran 4–12 bps mean and peaked at
26 bps, so the floor is an order of magnitude above anything a functioning
market produces. Sweeping it down to 10 bps produced exclusions but *no*
accuracy gain and a worse tail. **Left unchanged deliberately**: it is a guard
against a genuinely broken print, not a routine part of the pipeline, and
tightening it to make it fire would trade a real safety margin for nothing.

### What changed

Consensus now weights each quote by **how much it says about the price now**,
via [src/consensus/weighting.ts](src/consensus/weighting.ts):

```
weight = providerWeight × freshness(age) × provenancePenalty

freshness(age) = τ / (τ + age)        τ = PRICE_FRESHNESS_HALFLIFE_MS
```

Under a random walk the variance of price drift grows linearly with elapsed
time, and inverse-variance weighting is the standard way to combine estimates of
differing precision; `τ / (τ + age)` is that, normalised, with τ the age at which
an observation counts for half. A quote whose timestamp cannot be age-verified
takes a flat `UNVERIFIED_FRESHNESS_WEIGHT` penalty instead, because scoring it on
its claimed age awards the highest freshness weight to the one source whose
freshness is unproven.

Measured effect, same rounds, only the weights differing:

| Scheme | BTC mean | BTC max |
| --- | --- | --- |
| uniform (Phase 3) | 4.5 bps | 12.3 |
| freshness only | 3.7 bps | 23.4 |
| provenance penalty only | 2.9 bps | 12.3 |
| **both (shipped)** | **2.3 bps** | **12.3** |

**Neither half works alone.** Freshness weighting on its own was *worse than
doing nothing* on the tail — discounting the source with an honestly old
timestamp simply moves weight onto the source whose timestamp cannot be checked.
That is why both defaults are on, and why turning one off is called out in
`.env.example` as a mistake rather than a preference.

Deliberately **not** changed: per-provider weights stay uniform. The data would
support weighting exchanges above aggregators, but that conclusion is
contaminated by the reference being an exchange. Age and verifiability are
properties of the observation itself, true regardless of who reported it — and a
provider that starts publishing fresher data earns its weight back automatically.

τ = 10s was picked from a plateau: every value between 5s and 30s gave the same
result on both assets, so the outcome does not hinge on the constant.

### Caveats on these numbers

- **Two assets, 25 rounds each, one hour, one machine.** Enough to catch a 2 bps
  systematic bias; not enough to characterise tail behaviour. Re-run it.
- **ETH showed no improvement** (1.1 vs 1.1 mean) because that window was calm —
  a 10.4 bps range over 200s. Freshness weighting only helps when the market
  moves enough for lag to cost something, which is the expected null result, not
  a contradiction.
- **KoinMix does not beat the best single source** (Binance, 1.6 bps on BTC), and
  should not be expected to: consensus buys resilience to any one venue failing
  or printing badly, which single-source accuracy does not measure at all.
- **The BTC tail did not improve** — 12.3 bps max, unchanged. Mean error is not
  the whole story and this one is still open.

### Reliability observed

43 provider failures across 50 rounds, dominated by **CoinGecko rate limiting:
16 × HTTP 429** on the keyless tier at roughly 10 requests/minute, plus timeouts
(Binance ×10, CoinGecko ×6, Coinbase ×5, CoinMarketCap ×3 at a 5s bound).

Consequences worth knowing before deploying:

- 3 of 25 BTC rounds were refused outright — the miner returned an error rather
  than a price, which is the intended behaviour but is also lost revenue.
- **2 rounds were decided by a single provider** at `CONSENSUS_MIN_SOURCES=1`.
  Confidence correctly fell to 0.40, but a lone source still set the signal.
  Raising the floor to 2 would have refused those rounds instead; that is an
  availability-vs-reliability call to make deliberately, and the number above is
  what it costs.
- Rate limiting is the single largest reliability problem, and caching plus 429
  backoff would do more for served-request accuracy than any further tuning of
  the aggregation.

## Telegraph conformance (Phase 5)

```bash
npm run verify:onchain              # BTC/USD
npm run verify:onchain -- ETH USD
```

The miner descriptor and the response are two artifacts edited independently,
and nothing fails loudly when they drift: a `source_path` that no longer
resolves still registers, still returns HTTP 200, and simply writes zeros and
empty strings on-chain. `verify:onchain` closes that gap by checking the YAML
against the published standard and then resolving every mapped path against a
**live** response.

### What the standard actually requires

Verified against the [YAML Standard](https://telegraph-2.gitbook.io/telegraph/miner-registry/yaml-standard.md)
on 2026-08-25, and worth stating because two of these are easy to get wrong:

- **The response body is free-form.** The standard says plainly that no
  predefined response schema is enforced on miners — a node reads what it needs
  by dot-path via `on_chain.fields[].source_path` and `semantics.signal_mapping`.
  Custom fields are therefore allowed, which makes restraint our job rather than
  the node's: round diagnostics are deliberately kept out of the response (see
  below).
- **The top-level field list is closed.** `version`, `kind`, `id`, `slug`,
  `protocol`, `name`, `description`, `base_url`, `auth`, the rate/circuit
  settings, `endpoints`, `semantics`, `on_chain` — and nothing else. The YAML
  previously carried `input_schema` and `output_schema` blocks, which are **not**
  part of the standard; they have been removed and the shapes recorded as
  comments instead. `verify:onchain` now rejects any unrecognised top-level key
  so they cannot creep back.
- **The miner performs no payment handling.** Per the
  [x402 doc](https://telegraph-2.gitbook.io/telegraph/miner-registry/x402-payment.md),
  the node terminates payment and PayAI settles it. Miners return 200 on success
  and 502 when the upstream errored; there is no 402 to emit and no payment
  header to read.

### Intent casing, resolved

`crypto_price`, lower snake_case. The hackathon catalog renders it
`CRYPTO_PRICE`, but it renders *every* intent that way — `WEATHER_CHECK` there
is `weather_check` in the standard — so the casing is presentational. Input is
accepted in either spelling.

**Routing is resolved too** (2026-08-27). Earlier revisions of this section
flagged it as the genuinely open question: `crypto_price` was absent from the
27-entry canonical list in the core docs, and those docs warn that non-canonical
intents are "accepted but will not be routed by the autonomous engine".

That list was stale. The live
[Miner YAML Registry](https://integrate.telegraphprotocol.com) carries
`CRYPTO_PRICE` among its searchable canonical intents — *"Query names a
cryptocurrency asset and asks for its current or historical price"* — and
registration 252 was accepted against it. The intent routes.

### Diagnostics are not part of the response

Because the node would happily carry extra keys, the separation is enforced on
our side. `GET /v1/price` returns exactly the sixteen fields the contract
declares — a test asserts the key set exactly, and another asserts that
`excluded`, `weights` and `confidenceBreakdown` never appear.

Round diagnostics go two other places: the structured logs, which explain a
specific served response, and `GET /v1/price/debug`, which is **not declared in
the YAML** and therefore unreachable through Telegraph. The debug route runs its
own round, so it reflects the market when called, not when some earlier request
was served.

### Verified end to end, live

Against the compiled build (`npm start`), real providers, no stubs:

```console
$ curl 'http://127.0.0.1:8080/v1/price?asset=BTC&quote=USD'
{"intent":"crypto_price","asset":"BTC","quote":"USD","price":"78412.25",
 "priceX1e8":7841225000000,"confidence":0.6892,"sourceCount":3,
 "sources":["coinbase","coingecko","coinmarketcap"],"method":"median",
 "deviationBps":16,"spreadBps":16,"asOf":"2026-08-25T21:16:40.000Z",
 "observedAt":"2026-08-25T21:18:39.380Z","isStale":false, ...}
HTTP 200 in 5.98s
```

The four live quotes behind one such round, from the debug route — distinct
venues, distinct instruments, and the Phase 4 weighting visibly at work:

```
coingecko       2430.47   age 149s   378ms   ethereum/usd   ts=observed    weight 0.063
coinmarketcap   2431.83   age   0s  1349ms   ETH/USD        ts=response    weight 0.5
binance         2433.25   age   0s   559ms   ETHUSDT        ts=observed    weight 1.0
coinbase        2433.19   age   2s   354ms   ETH-USD        ts=observed    weight 0.816
```

CoinGecko is 149s stale and drops to 6% of a vote; CoinMarketCap reports a
response timestamp rather than an observation time and takes the flat provenance
penalty. Neither is a hardcoded opinion about the vendor.

The full on-chain mapping resolved against a live response:

```
strings   [0] asset             = "BTC"        [1] quote_currency = "USD"
          [2] price_decimal     = "78584.74"   [3] as_of          = "2026-08-25T21:41:40.000Z"
integers  [0] price_usd_x1e8    = 7858474000000
          [1] confidence_x10000 = 7315         [2] source_count   = 3
          [3] deviation_bps     = 1            [4] spread_bps     = 3
bools     [0] is_stale          = false
```

And the descriptor served over HTTP is byte-identical to the file, so the hash
committed at registration matches what a node fetches:

```
served bytes == file bytes : true
sha256                     : 0x8e485af6f9fdb2d355a5818aff4832f7b2d56e952cdbaa3e5ad0806cf11d4e45
npm run yaml:hash          : 0x8e485af6f9fdb2d355a5818aff4832f7b2d56e952cdbaa3e5ad0806cf11d4e45
```

### Failure never produces a price

Twenty-two route-level tests drive the real Fastify stack through `app.inject()`,
covering request parsing, asset resolution, provider execution, consensus,
serialization, errors and timeouts. The resilience cases assert the property
that matters — that no failure mode emits a number:

| Condition | Status | Code | Price emitted |
| --- | --- | --- | --- |
| Every provider fails | 503 | `PROVIDER_UNAVAILABLE` | none |
| No provider configured | 503 | `NO_PROVIDERS_CONFIGURED` | none |
| All quotes stale | 503 | `INSUFFICIENT_SOURCES` | none |
| Quotes disagree past tolerance | 502 | `CONSENSUS_FAILED` | none |
| Missing / invalid asset | 400 | `VALIDATION_FAILED` | none |
| One provider hangs | 200 | — | served from the rest, inside the timeout |

Provider failure is simulated only in tests. Nothing in `src/` constructs a
quote, and the stubs live in `tests/`.

This was then confirmed unintentionally: during Phase 5 the machine's network
degraded and all four providers timed out at once. The miner returned
`503 PROVIDER_UNAVAILABLE` with no price field, on the live production path,
exactly as the tests specify.

### Local Telegraph node

Telegraph does publish a local harness — `local-telegraph.sh` in the node
project, which runs two Anvil chains, deploys the Diamond, and registers a
signer, so a subnet can be exercised with no mainnet or real payment. It
requires Linux with Go, Java, Cassandra and Foundry; **this project was
developed on Windows, so it has not been run here.** What is verified above is
the miner side of the contract: the exact HTTP call a node makes, and the exact
mapping it applies to the reply. The node-side leg is untested by us and is
called out as such rather than claimed.

## On-chain registration

**Registered on Base Sepolia** (chain `84532`), registration ID **252**, via the
[Miner YAML Registry](https://integrate.telegraphprotocol.com).

| | |
| --- | --- |
| Registration ID | **252** |
| Transaction | `0x2d1447ac439b9d0a…d2fef322` |
| Registry | `0x122396E8602BEed349434AA6E83123E7dD97F5A0` |
| Descriptor | `ipfs://QmZ2xmBXaxAY8vFJWAXvG4TCJ3wnLcPqMos1o7ps8pyyXq` |
| `yamlHash` | `0x4a74c1df8cdfb2d8a52f2e49f9815990a598aa92b7e5e46ef6a9855dd8b94039` |
| `minPriceUsdc` | `10000` ($0.01, the protocol floor) |
| Intent | `CRYPTO_PRICE` |

The registry pins the descriptor to IPFS and registers the hash of the pinned
bytes, so the IPFS copy — not the one this repository serves at
`/telegraph/koinmix.yaml` — is what nodes read. The file here is kept in sync as
documentation and remains the source the descriptor was built from.

### An earlier manual registration

Registration **42** was made first, directly against the registry contract with
a self-hosted descriptor, before the portal was known to be the intake path:

| | |
| --- | --- |
| Transaction | [`0x85a8b73a…f047dc`](https://sepolia.basescan.org/tx/0x85a8b73a4598e3006b947b229efad2cf699f245aa57e450b3a7028577bf047dc) |
| Descriptor | `https://koinmix-production.up.railway.app/telegraph/koinmix.yaml` |
| `yamlHash` | `0x7a3cf8dd8be31ec00249b82128c5213a9df84ec9609c7c0450a6329fe45000b0` |

It is superseded by 252 and retained here as history. Every field was decoded
back out of the `MinerRegistered` event log and checked against the descriptor
being served — the committed hash was byte-identical to the live endpoint's,
which is what the LF pinning in [.gitattributes](.gitattributes) exists for.
Registering the CRLF working copy's hash instead would have failed verification
on every node while the miner looked perfectly healthy.

That registration used [scripts/register-miner.sh](scripts/register-miner.sh),
which re-runs those checks and simulates the call before broadcasting.

```bash
npm run yaml:hash    # → 0x<sha256 of the exact bytes served>

DIAMOND=0x122396E8602BEed349434AA6E83123E7dD97F5A0   # Base Sepolia

cast send "$DIAMOND" \
  "registerMiner(string,bytes32,address,uint256,string[])" \
  "https://koinmix-production.up.railway.app/telegraph/koinmix.yaml" \
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

### Registration prerequisites

All deployment values are now supplied; the one remaining unknown is a question
for the Telegraph team rather than a value the operator can produce.

| Requirement | Status | What it needs |
| --- | --- | --- |
| Public HTTPS origin | **ready** | Deployed at `https://koinmix-production.up.railway.app`, which serves the descriptor at `/telegraph/koinmix.yaml` and is the value of `base_url`. Verified live: health, prices for all four assets, and the YAML route. |
| `MINER_FEE_ADDRESS` | **ready** | Committed on-chain as `0x8348f644389a80e853047c3bced7bfb1b74c582a`. Not set in this repo — it is a registration value, never read by the miner at runtime. |
| `MINER_PRIVATE_KEY` / `RPC` | **done** | Used once, from a Foundry keystore on the operator's machine. Never read by the miner and never stored in this repo. |
| Registration hash | ready | `npm run yaml:hash`, recomputed after any YAML edit. |
| Intent routing | **resolved** | `CRYPTO_PRICE` is canonical in the live registry; registration 252 was accepted against it. |

The miner itself needs no credentials to run: all four providers work keyless,
and `auth.type: none` in the YAML means the node injects nothing.

### One open question for the Telegraph team

**Signal type.** The canonical `signal_mapping.type` enum has no
financial/market-data member, and a value outside it fails node-side validation.
We use `task_completion` as the only member that is not semantically wrong for a
deterministic data lookup. A market-data member would describe this miner
better; whether one now exists is worth confirming.

Intent routing, previously listed here, is resolved — see
[Intent casing, resolved](#intent-casing-resolved).

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

## Performance

Measured against the compiled build on 2026-08-26, BTC/USD, 10 rounds spaced
beyond the cache TTL so every round genuinely fanned out. Home broadband from
Western Europe — treat these as indicative, not as a benchmark.

| | Median | p90 | Max |
| --- | --- | --- | --- |
| Total request (client wall clock) | 631 ms | 2416 ms | 2416 ms |
| Server-side round | 602 ms | 1969 ms | 1969 ms |
| Consensus + formatting only | **16 ms** | 28 ms | 28 ms |

Per-provider upstream latency over the same rounds:

| Provider | Median | p90 |
| --- | --- | --- |
| coingecko | 216 ms | 639 ms |
| coinbase | 244 ms | 777 ms |
| coinmarketcap | 287 ms | 1952 ms |
| binance | 556 ms | 1065 ms |

**Latency is upstream latency.** Consensus accounts for roughly 16 ms of a
~600 ms round — under 3 % — so the cost is dominated entirely by waiting on
provider APIs, which run concurrently and are bounded by
`PROVIDER_TIMEOUT_MS`. There is no bottleneck in the aggregation worth
optimising, and none was optimised. The one change made was the quote cache,
which addresses request *volume* against rate-limited tiers rather than
per-round latency — see [Caching](#caching).

---

## Known limitations

- **Asset coverage is a curated table.** BTC, ETH, SOL and XRP are mapped in
  [assets.ts](src/providers/assets.ts); anything else is refused rather than
  guessed. A wrong CoinGecko slug would silently price the wrong token, so the
  table is deliberate — but it does not scale to thousands of assets.
- **Rate-limit handling is a cache, not a strategy.** `PROVIDER_CACHE_TTL_MS`
  cuts repeat traffic (a hit costs 1 ms and no upstream call), which was enough
  to address the measured problem: CoinGecko's keyless tier returned HTTP 429 on
  16 of 50 evaluation rounds at ~10 req/min. But there is still **no 429 backoff
  and no request coalescing** — two rounds for the same pair arriving
  simultaneously both miss the cache and both hit upstream. Under genuinely
  concurrent load the 429s will return.
- **The cache is per-instance.** Horizontal scaling multiplies upstream request
  volume by the instance count.
- **`CONSENSUS_MIN_SOURCES` defaults to 1**, so a single provider can currently
  determine the signal. Measured at 2 rounds in 25 during evaluation. Raise it
  to ≥ 2 before serving real traffic, accepting the extra refusals.
- **Outlier detection has never fired on live data.** Zero exclusions across
  every evaluation round: the 200 bps floor sits an order of magnitude above
  real cross-venue spread. It is a guard against a broken print, not an active
  part of the pipeline, and should not be mistaken for one.
- **The worst-case error is unimproved.** Freshness weighting cut BTC mean error
  by half but left the 12.3 bps tail exactly where it was.
- **Accuracy is measured against one held-out venue**, over two assets and 25
  rounds each. That is enough to expose a systematic bias and not enough to
  characterise tails; it also cannot rank exchanges against aggregators without
  the reference's own venue type biasing the answer.
- **Non-USD quotes are only partly covered.** EUR/GBP work on CoinGecko, CMC and
  Coinbase, but Binance has no such pair for these assets and will fail.
- **CoinMarketCap's keyed mode is unverified against the live API.** Keyless
  mode is confirmed working end to end; the `/v2` path is written to the
  documented shape and unit-tested, but has never made a real call. Add a key
  and run `npm run live:check` to confirm it.
- **Keyless CoinMarketCap is USD-only**, so non-USD rounds run one provider
  short.

## Next

- Add 429 backoff and single-flight request coalescing. The quote cache landed
  in Phase 7 and handles repeat traffic; coalescing was deliberately left out
  because sharing one in-flight promise across callers lets one round's timeout
  abort another's, which is not a change worth making during a hardening pass.
- Re-run `npm run evaluate` during a volatile window and over more assets; the
  current numbers come from two calm-to-moderate hours.
- Investigate the unimproved tail: which rounds produce the worst error, and
  whether they share a cause.
- Deploy to a public HTTPS origin, set `base_url` and `MINER_FEE_ADDRESS`, then
  register on Base Sepolia — the last blockers are deployment values, not code.
- Confirm intent routing with the Telegraph team (see above).
- Run the miner against a local Telegraph node to exercise the node-side leg,
  which needs a Linux host.
