# Drift

A single-URL, real-time, anonymous shared world of slow objects. No accounts, no words, no instruction — you arrive somewhere already in progress, pick things up, put them down, and sometimes feel the warmth of someone else nearby.

**Phase 1 (MVP):** a Canvas 2D world of stones and seeds in the Growing season, with pan/zoom, pick-up/place, real-time sync, presence warmth, and persistence.

**Phase 2 — growth & life:** seeds left undisturbed sprout and grow into branching plants (procgen `drawPlant`), mature plants shed new seeds nearby, and fully-aged plants release final seeds and dissolve. Growth is slow by default but **accelerated by warmth** — lingering near seeds heats them and speeds their growth ("warmth matters to growth"). The whole cycle runs on the 60s tick even with nobody present, and the population is bounded. Disturbing a pre-sprout seed resets it — it has to be left be to take.

**Phase 2 — seasons:** the world cycles **Growing → Turning → Resting → Rising** on its own slow clock (~2h per season), uncorrelated to real time. The server owns the clock; the whole frame crossfades between the four committed grades (colour + saturation) and the season **modulates the lifecycle** — Growing grows fastest, Resting holds its breath (growth paused), Turning ages things quickest. There's no way to see which season it is; you feel it on arrival.

**Phase 2 — anomalies:** rare, luminous, lifecycle-free forms (procgen's four `drawAnomaly` kinds — rotor, point, prism, breath) that mature plants occasionally birth, only in generative seasons, and only a few in the world at once — seeing one is luck. They quietly **accelerate growth and slow decay** nearby (without anyone being told why), and they persist until deliberately dissolved: pick one up and **hold it for 10 seconds** and it fades from your hands. Never explained.

## Architecture

One **Cloudflare Durable Object** (`WorldRoom`) is the entire world:

- holds every object in memory, backed by SQLite-backed DO storage (survives restart),
- fans out `pickup` / `place` / `carry` / `presence` over WebSockets to all clients,
- reclaims a held object when its holder disconnects (it drops where it was),
- runs a self-rescheduling **60-second tick** (DO alarm) that grows/ages/sheds the world **even when nobody is connected** — the world breathes, indifferent.

The Worker (`server/index.js`) serves the static client from `public/` and routes `/ws` + `/admin/*` to the single global DO. No separate database is required — DO storage is the persistence layer. Lifecycle state (`maturity`/`aged`/`heat`) is stored, but the visual form of every object is always regenerated from its `seed` — no visual data is ever stored or transmitted.

> **Why not "single Vercel deployment"?** Vercel only gained (beta) WebSocket support days before this was built, and the world needs an always-resident process to tick with zero users. A Durable Object models "one global, ever-running world" natively, with no beta risk. PRD §11 explicitly permits hosting the realtime layer off Vercel.

**No identity is ever in the protocol.** The session token (localStorage) is used server-side only for hold ownership; broadcasts carry an ephemeral per-connection id and a boolean `held` — never the token.

```
public/   index.html · client.js · render.js · drift-procgen.js (lifted verbatim)
server/   index.js (Worker) · world-do.js (Durable Object) · seed.js (world generator)
scripts/  seed-world.js (operator seed/re-seed)
wrangler.toml · package.json
```

## Local development (one command)

```bash
npm install
npm run dev          # wrangler dev → http://localhost:8787
```

Open `http://localhost:8787`. The world **self-seeds** ~200 objects (≈65% seeds, 35% stones) on first load — no seed step needed. Open a second browser window to the same URL to see real-time sync and presence between them.

To test on a phone on the same network, run `npm run dev -- --ip 0.0.0.0` and browse to your machine's LAN IP.

## Environment variables

None are required to run or deploy. The only optional secret:

| Variable | Purpose |
|----------|---------|
| `ADMIN_KEY` | Gates the **forced** re-seed (`/admin/seed?force=1`). Set with `npx wrangler secret put ADMIN_KEY`. The safe, idempotent ensure-seed (`/admin/seed`) needs no key. |

## Seeding the world

The world seeds itself on first touch, so this is rarely needed.

```bash
npm run seed                              # ensure the local dev world is seeded (idempotent)
node scripts/seed-world.js https://your.app   # ensure a deployed world is seeded
ADMIN_KEY=… node scripts/seed-world.js https://your.app --force   # wipe + re-seed
```

The generator (`server/seed.js`) is deterministic from a fixed world seed, so a forced re-seed always reproduces the exact same 200 objects (same ids, positions, and procedural forms).

## Deploy

```bash
npm install -g wrangler      # or use npx
npx wrangler login           # one-time Cloudflare auth
npm run deploy               # wrangler deploy → https://drift.<your-subdomain>.workers.dev
```

That single deploy serves both the client and the WebSocket world at one global URL. (To use a custom domain, add a route in the Cloudflare dashboard or `wrangler.toml`.)

## What this is not (yet)

Still to come: water traces & crystals, stone stacking & erosion-to-grit, sound — those are the remaining Phase 2/3 threads. And by design, forever: no accounts, no chat, no notifications, no sharing, no scores, no onboarding, no words in the world.
