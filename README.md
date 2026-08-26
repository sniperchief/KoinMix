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

### `GET /telegraph/koinmix.yaml`

Serves the miner descriptor verbatim, so it can be registered on-chain straight
from this deployment.

### Errors

Every failure returns `{ error, code, details, requestId }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request failed the Zod contract. |
| `NO_PROVIDERS_CONFIGURED` | 503 | No live provider wired up, e.g. an empty `PRICE_PROVIDERS`. |
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
| `PRICE_FRESHNESS_HALFLIFE_MS` | `10000` | Age at which a quote counts for half as much. `0` disables freshness weighting. |
| `UNVERIFIED_FRESHNESS_WEIGHT` | `0.5` | Weight for a quote whose age cannot be verified. `1` disables the penalty. |

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

What remains genuinely open is **routing, not casing**: `crypto_price` is not
among the canonical 27 intents in the core docs, and the registry docs warn that
non-canonical intents are "accepted but will not be routed by the autonomous
engine". The hackathon catalog lists CRYPTO_PRICE as a first-class Tier A intent,
so the two sources disagree. Confirm with the Telegraph team before relying on
autonomous routing.

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

Not performed yet — recorded here so the YAML is registerable as it stands.

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

### What is still required before registering

None of the following is invented here, because none of it can be: each needs a
value only the operator or the Telegraph team can supply.

| Requirement | Status | What it needs |
| --- | --- | --- |
| Public HTTPS origin | **outstanding** | `base_url` in the YAML is `https://miner.koinmix.io`, a placeholder. It must point at a real deployment reachable by nodes, and the YAML must be served from it. Editing it changes the hash. |
| `MINER_FEE_ADDRESS` | **outstanding** | The EVM address that receives payouts. Unset — the config accepts it but no value is committed anywhere in this repo. |
| `MINER_PRIVATE_KEY` / `RPC` | **outstanding** | Used only by the `cast send` above, at the operator's machine. Never read by the miner. |
| Registration hash | ready | `npm run yaml:hash`, recomputed after any YAML edit. |
| Intent routing | **needs confirmation** | See below. |

The miner itself needs no credentials to run: all four providers work keyless,
and `auth.type: none` in the YAML means the node injects nothing.

### Two open questions for the Telegraph team

1. **Intent routing.** Resolved: the *casing* is `crypto_price`, since the
   hackathon catalog uppercases every intent including ones the standard lists
   in lower snake_case. Still open: `crypto_price` is not among the canonical 27
   intents, and the registry docs warn non-canonical intents are "accepted but
   will not be routed by the autonomous engine", while the hackathon catalog
   lists CRYPTO_PRICE as a first-class Tier A intent. The two sources disagree,
   and only Telegraph can say which governs routing.
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
  provider. CoinGecko's keyless tier returns HTTP 429 under sustained load —
  measured at 16 rejections across 50 evaluation rounds (~10 req/min), making
  this the largest single reliability problem in the miner.
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

- Add per-provider caching and 429 backoff — the evaluation says this now buys
  more served-request accuracy than any further tuning of the aggregation.
- Re-run `npm run evaluate` during a volatile window and over more assets; the
  current numbers come from two calm-to-moderate hours.
- Investigate the unimproved tail: which rounds produce the worst error, and
  whether they share a cause.
- Deploy to a public HTTPS origin, set `base_url` and `MINER_FEE_ADDRESS`, then
  register on Base Sepolia — the last blockers are deployment values, not code.
- Confirm intent routing with the Telegraph team (see above).
- Run the miner against a local Telegraph node to exercise the node-side leg,
  which needs a Linux host.
