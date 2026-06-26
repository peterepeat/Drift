# Drift

A single-URL, real-time, anonymous shared world of slow objects. No accounts, no words, no instruction — you arrive somewhere already in progress, pick things up, put them down, and sometimes feel the warmth of someone else nearby.

**Phase 1 (MVP):** a Canvas 2D world of stones and seeds in the Growing season, with pan/zoom, pick-up/place, real-time sync, presence warmth, and persistence.

**Phase 2 — growth & life:** seeds left undisturbed sprout and grow into branching plants (procgen `drawPlant`), mature plants shed new seeds nearby, and fully-aged plants release final seeds and dissolve. Growth is slow by default but **accelerated by warmth** — lingering near seeds heats them and speeds their growth ("warmth matters to growth"). The whole cycle runs on the 60s tick even with nobody present, and the population is bounded. Disturbing a pre-sprout seed resets it — it has to be left be to take.

**Phase 2 — seasons:** the world cycles **Growing → Turning → Resting → Rising** on its own slow clock (~2h per season), uncorrelated to real time. The server owns the clock; the whole frame crossfades between the four committed grades (colour + saturation) and the season **modulates the lifecycle** — Growing grows fastest, Resting holds its breath (growth paused), Turning ages things quickest. There's no way to see which season it is; you feel it on arrival.

**Phase 2 — anomalies:** rare, luminous, lifecycle-free forms (procgen's four `drawAnomaly` kinds — rotor, point, prism, breath) that mature plants occasionally birth, only in generative seasons, and only a few in the world at once — seeing one is luck. They quietly **accelerate growth and slow decay** nearby (without anyone being told why), and they persist until deliberately dissolved: pick one up and **hold it for 10 seconds** and it fades from your hands. Never explained.

**Phase 2 — water & crystals:** a slow **water pool** lies in the world's low centre (a wet grey-blue sheen beneath the objects), and **crystalline formations** grow at its edge — small, geometric, glinting, and pickable like anything else. They're impermanent: each slowly dissolves in a brief flash and another forms. (The full flow/drift/stone-channelling water system is Phase 3, per the PRD.)

**Phase 2 — stone stacking & erosion-to-grit:** **stones balance** when you drop one within another's footprint, building a cairn that rises and casts soft contact shadows. A stack that grows tall is **unstable** — the world topples it on its own (sooner the taller it is), and tapping a tall stack scatters it on the spot. Lifting a stone off the top leaves the rest standing; pulling one from underneath drops what was above. And stones **erode**: each handling wears one smoother, smaller, and faintly luminous, until a much-handled stone finally crumbles into a brief scatter of grit and is gone.

**Phase 3 — the world is alive.** The systems that were hinted at now run for real:

- **Water flow, drift & channelling.** A slow flow moves across the world — a noise field the server simulates and the client paints from the *same* shared seed, so the faint moving traces and the way things actually move agree. Objects left near the water **drift** along it, very slowly; you come back and something has crept. Placed **stones bend the flow around themselves** — channelling, emergent and never explained. The season gates it: near-frozen in Resting, full in Rising.
- **Thermal & stone formation.** Every area has an invisible **heat** that rises where people linger and fades over time. Sustained-warm, unattended ground slowly **grows a stone** — it finishes after the maker has long gone. Heat also bends the water toward cooler ground.
- **The world stays bounded and fades.** Left utterly untouched and unwarmed, a stone eventually **crumbles to grit** — the world reclaims what's forgotten. The population has a ceiling; a full world lets its most-forgotten things go so it keeps breathing rather than freezing. Anomalies never fade.
- **Generative ambient sound (opt-in).** A quiet, sample-free bed — a low drone on a season-derived tonal centre under a soft noise pad, breathing with the warmth and density around you. **Off by default**; one tap on a tiny corner glyph enables it. No event sounds, no words.

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
          flow.js (shared flow constants) · cull.js (viewport cull) · audio.js (ambient sound)
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

## What this is not

Phases 1–3 are all shipped — the world exists, grows, turns through seasons, pools and flows water, warms and forms stone, stacks and erodes, stays bounded, and (if you ask it to) sounds. **Interest management** is in place: a connecting client sends its viewport and receives only the objects it can see (the rest page in as it pans, via `world_patch`), so the initial payload no longer scales with the whole world. And a **server-side spatial grid** now backs the per-tick neighbour queries — water-flow stone deflection, the interest box scans, and stack-on-place each ask an in-memory spatial hash for just the nearby cells instead of scanning the whole population. Both are purely in-memory and add no Durable Object writes; together they're the scaffolding for a 10k-object world. What remains is tuning by feel and then actually raising the population cap (a deliberate load decision, not a code gap). And by design, forever: no accounts, no chat, no notifications, no sharing, no scores, no onboarding, no words in the world.
