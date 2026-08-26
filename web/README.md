# KoinMix Terminal

The demonstration frontend for the [KoinMix miner](../README.md): a market
intelligence terminal showing the CRYPTO_PRICE consensus, the sources behind it,
and the Telegraph request path.

React · Vite · TypeScript · Tailwind CSS v4 · TradingView Lightweight Charts.

## Running it

The terminal reads everything from the miner, so start that first:

```bash
# in the project root
npm run build && npm start        # miner on :8080

# in web/
npm install
npm run dev                       # terminal on :5173
```

Point it at a different miner with `VITE_MINER_URL` (see [.env.example](.env.example)).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with HMR. |
| `npm run build` | Type-check and build to `dist/`. |
| `npm run preview` | Serve the production build. |
| `npm test` | Render tests for every backend outcome. |

## No fabricated data

The hackathon rules forbid simulated data, and a dashboard is the easiest place
to break that rule without anyone noticing — a chart with plausible bars and a
price that always renders looks *more* finished than an honest one.

So there is no fixture module, no seeded store and no default value anywhere in
`src/`. Every figure traces to a live miner response. Where something cannot be
retrieved, the UI says so:

| Situation | What is shown |
| --- | --- |
| Miner unreachable | Full-page unavailable state naming the URL it tried |
| All providers failed | "No consensus price", with the miner's error code |
| A provider failed | That row marked `failed`; it still counts against the source total |
| No candles for an interval | "Historical data unavailable", listing each venue's reason |
| 24h change not derivable | Omitted, labelled unavailable |
| Still loading | Skeletons — never a zero or a placeholder number |

`npm test` asserts these, including that no numeric value appears where the
backend gave none.

The one thing stubbed anywhere is `fetch` inside `src/App.test.tsx`, so the
failure paths can be exercised on demand. That is test scaffolding and never
ships.

## Where each number comes from

| Panel | Endpoint | Notes |
| --- | --- | --- |
| Asset selector, interval tabs | `GET /healthz` | The miner advertises what it serves, so the UI cannot offer an asset the backend would refuse |
| Consensus price, confidence, spread, sources | `GET /v1/price/debug` | The only endpoint carrying the per-source breakdown |
| Chart | `GET /v1/candles` | Real OHLCV from Binance, falling back to Coinbase |
| Telegraph panel | `GET /v1/price` + `GET /telegraph/koinmix.yaml` | The contract endpoint, called as a node calls it |

The dashboard reads the **debug** route because the source panel needs per-source
detail. That route is operator surface — undeclared in the miner YAML and
unreachable through Telegraph — which is exactly why showing it here cannot leak
internal state into the bytes a validator scores.

### The 24h change

Computed from the candle series alone: last close against the close 24 hours
earlier, both from the same venue, and attributed to that venue in the UI.

Comparing the multi-venue consensus against one venue's old close would have
been easier, but it mixes two different measurements and quietly folds the
cross-venue spread into the percentage. On a weekly or monthly chart the
terminal fetches an hourly series purely for this figure, because weekly bars
cannot express a 24-hour window.

### The Telegraph panel

"Query via Telegraph" issues a real request to the miner's contract endpoint,
with the query params a node builds from `strings[0]` and `strings[1]`. It then
fetches the miner's **registered YAML**, parses it, and applies each
`on_chain.fields[].source_path` to the live response — so the OnChainData arrays
shown are computed the way a node computes them, from the same two artifacts,
not from a hardcoded mapping.

**One hop is simulated, and the UI says so.** KoinMix is not registered on-chain
yet, so no Telegraph node sits in the path. That stage is badged "not yet live"
rather than animated as though it happened.

## Notes

- **shadcn/ui was not used.** The terminal needs a card, a badge, a stat and two
  placeholders; none need the Radix behaviour that makes shadcn worth its
  install. The primitives in `src/components/ui.tsx` are smaller than the
  dependency would have been.
- **Vitest is pinned to 2.x.** Vitest 4 workers time out before starting when the
  project path contains a space, which this one does.
- Polling pauses when the tab is hidden — CoinGecko's rate limit is the binding
  constraint, and refreshing pixels nobody is looking at spends it for nothing.
