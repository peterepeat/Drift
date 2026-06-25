# Drift integration tests

Node-driven WebSocket/HTTP tests that exercise the live behaviour of the
Durable Object: the realtime protocol, growth, seasons, anomalies, and water &
crystals. They drive the world through the `ADMIN_KEY`-gated `/admin/*`
endpoints (`tick`, `seed`, `anomaly`, `crystal`) so growth/decay/seasons can be
fast-forwarded deterministically instead of waiting for the 60s tick.

## Run

```bash
cp .dev.vars.example .dev.vars      # provides ADMIN_KEY for the /admin/* routes
npm test                            # boots a fresh worker per suite, runs all 5
```

Or a single suite against an already-running `wrangler dev`:

```bash
PORT=8799 node test/protocol.test.mjs
```

## Suites

| File | Covers |
|------|--------|
| `protocol.test.mjs` | pickup/carry/place, conflict, disconnect-reclaim, presence, no-identity (17 checks) |
| `growth.test.mjs` | seed→plant lifecycle, warmth acceleration, shedding, dissolution, disturbance reset |
| `seasons.test.mjs` | season clock, growth/aging modulation, wrap |
| `anomalies.test.mjs` | spawn cap, no-decay, proximity boost, holder-only dissolution |
| `water-crystals.test.mjs` | pool, edge-formation, cap, held-pause, dissolution |

## Notes (gotchas baked into `run-all.sh`)

- **Run each suite on its own fresh world.** Several suites pick "a dormant
  seed"; after heavy ticking the world saturates at the population cap and none
  remain. `run-all.sh` wipes `.wrangler/state` before each suite.
- **Use an isolated port** (default 8799), not 8787. A browser tab left open on
  8787 reconnects and sends presence every 500ms, which fails the protocol
  suite's "sender doesn't receive its own presence" check.
- Each test file honours a `PORT` env var (defaults to 8787).
