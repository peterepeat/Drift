# Drift — refactor backlog (architecture assessment seed)

A prioritised, substantive backlog for making the engine more **elegant, generalised,
maintainable, and efficient** — the jumping-off point for a focused architecture pass in a
fresh thread. Produced from a multi-agent tech-debt scan of the codebase (June 2026), then
kept current as later work touched these areas.

## The shape of the problem

Two **god-files** hold almost everything, mirror-imaged across the network boundary:

- `server/world-do.js` (~2.3k lines) — one `WorldRoom` Durable Object mixing ~16 concerns:
  the 60s tick, WS fan-out, persistence/checkpoint, interest paging, the spatial grid, and
  every domain system (stones, creatures, social, giants, water/flow, thermal, seasons,
  anomalies, crystals, fish, communion, marks) plus the `/admin/*` HTTP router. ~120 loose
  module constants up top; ~67 `o.family === '…'` branches scattered through.
- `public/client.js` (~1.8k lines) — the symmetric client god-file: ~75 constants, the
  per-frame `update*`/`draw*` functions, input, websocket, and the ~200-line `frame()` loop.
  ~58 `o.family === '…'` branches.

**Hard invariants any refactor must preserve** (these are *why* the DO survives — don't
regress them):
1. **Write-economy** — the always-on tick must NOT write per-object-per-tick. Discrete writes
   are spawns/deaths/reclaims only; everything else broadcasts + rides the ~30-min checkpoint
   via `this.dirty`. `objWrites` is the canary (the `decouple`/`checkpoint` suites assert it).
2. **Zero per-frame sync** — creature/giant motion is a deterministic function of a shared
   clock + seed; clients recompute positions locally. No per-frame positions on the wire.
3. **Form-from-seed** — an object's visual form is always regenerated from its integer `seed`
   (+ maturity/aged/kind); never stored or transmitted.
4. **Reseed is the only destructive op** — a full wipe; version-gated; owner-approved.

## Prioritised candidates

Effort: **S** ≤ half a day · **M** ~1–2 days · **L** a focused multi-day effort. Lead with the
S wins (high safety, immediate readability), then the structural M/L work.

### Quick wins (S)

1. **`#removeObject(o)` helper for the 11× delete-dance.** The exact 7-line sequence
   (`objects.delete` · `bcastMark.delete` · `driftMark.delete` · `dirty.delete` ·
   `storage.delete` · `objWrites++` · `#gridRemove`) is duplicated verbatim ~11× in
   `world-do.js`. One helper removes ~60 lines, centralises the write accounting, and kills
   a real desync/leak risk (any future copy that forgets a map). _world-do.js (search
   `this.objects.delete(`)._
2. **Centralise `POND_ASPECT` + pond-ellipse math.** `POND_ASPECT = 0.7` is declared twice —
   `world-do.js` and `render.js` — each with a "MUST match the other" comment: the exact
   latent-divergence trap `flow.js` already exists to prevent. Move it (and the
   `poolContaining`/`bankPoint` ellipse helpers) into a shared module. _world-do.js:~151,
   render.js:~166._
3. **One `#gridNearest(x,y,r,filter,maxR)` helper.** The "scan `#gridNear`, keep the closest
   passing the distance test" idiom is hand-rolled ~8× (fuse, anomaly-target, nearest-presence,
   creature goal, giant partner/drink…) — easy for one copy to get the `< bestD` tie-break
   subtly wrong. _world-do.js (search `#gridNear`)._

### Structural (M)

4. **Share seed-derived sizing across server + client.** `stoneRadius` (server) and
   `stoneSize` (client) are byte-identical `12 + rng(seed)()*34` with a "MUST match" comment;
   the same hidden contract governs anomaly/crystal/creature footprints. A shared `form.js`
   consumed by both kills the duplication and the silent-divergence risk for every family at
   once. _client.js:~304, world-do.js:~272._
5. **Central, overridable tuning table** (✅ *partially done this session*). The ~120 server +
   ~75 client constants are now **catalogued** in `server/tuning.js` (197 knobs w/ group,
   label, default, range), surfaced in the `/admin-peter` panel, and **16 high-impact server
   knobs are live-overridable** via a `TUNE_REG` of get/set-over-`let` closures (no read-site
   rewrite). _Remaining:_ migrate the rest of the constants into the table (the clean
   object-`T.X` form, or extend the `let`+registry pattern), and wire the curated **client**
   knobs (LOD budget, befriend dwell, feel timings) to hydrate from the server so they're
   live too. This is the natural place to finish the generalisation. _world-do.js:~24,
   server/tuning.js._
6. **Split `webSocketMessage` into a handler map keyed by `m.t`.** A ~200-line if/else ladder
   over 9 protocols; the `place` arm alone is ~100 lines of stone/anomaly/creature/seed/pond
   special-cases. A `{ pickup, carry, place, … }` dispatch (with `place` further decomposed by
   family) yields named, individually-testable handlers and mirrors the client's already
   switch-based `onMessage`. _world-do.js:~866._
7. **Unify the giant `goal.kind` dispatch into one job table.** The six job kinds
   (ripen/thin/fillhole/tendstone/breakstone/sow) are spelled out three separate times —
   validity, the score ladder, and the `act()` switch. A per-kind descriptor
   `{ validate, find, need, act }` collapses three parallel ladders into one list (and makes a
   new gardener behaviour a single entry). _world-do.js:~2090._

### Larger / highest-leverage (L)

8. **A family/behaviour registry to replace the per-family if-ladders.** `o.family === 'x'`
   appears ~125× across both files, encoding an implicit per-type table (drifts? ages? fades?
   trimmable? casts shadow? lodColor? collisionGive? wanders? radius?) as ad-hoc branches in
   `#tick`, `#driftEligible`, `paintObject`, `objRadius`, shadow/lod/lightness helpers. A
   single `FAMILIES` registry of `{ drifts, ages, fades, trimmable, draw, radius, lodColor }`
   makes adding/altering a family **one entry** instead of edits across ~10 ladders — and makes
   the rules auditable. The single biggest elegance win. _world-do.js + client.js._
9. **Extract the giant gardener into its own module/class.** ~240 self-contained lines
   (`#giantStep`, `#pondAcross`, `#giantPickGoal`, `#giantNearest`, ~10 `#giantFindX`,
   `#giantAct`) + its own 16-constant block. It only touches the world via objects/grid/spawn/
   remove — a clean `GiantManager` seam that shrinks the god-object ~11% and isolates the most
   special-cased AI from the simulation core. _world-do.js:~1896._
10. **Collapse `#tick`'s ~10 sequential object loops.** `#tick` walks `this.objects` up to ~10
    times per tick — growth, drift, isolation, ceiling, goal-drift, the new stone-push, pond-
    relocate — each re-implementing its own `for (o of …) if (o.family === …)` filter. Extract
    `#growthPass`/`#driftPass`/… and **fuse** the ones that can share a single iteration: both a
    readability win (285-line method → named phases) and an efficiency win as the world nears the
    10k cap. (Pairs naturally with #8's registry.) _world-do.js:~1112._

## Recommendation for the assessment

- **Use multi-agent orchestration (Ultracode) for the *assessment + design*, not the *execution*.**
  Fan out independent reviewers per subsystem, then an **adversarial pass** that checks each
  proposed refactor against the four invariants above before it enters the plan. That's the
  "understand → design → review" shape; this backlog is a down-payment on it.
- **Execute the backlog as sequential, test-gated increments** (the existing harness + ship
  workflow already support this). A god-object has a high merge-conflict surface, so parallel
  edits fight; the independent extractions (#1, #2, #3, #9) can run in worktrees, but the big
  ones (#8 registry, #10 tick-collapse) should be serial.
- **Suggested order:** the S wins first (immediate, safe), then #5 (finish the tuning table —
  it's already half-built and unblocks tuning-by-config), then #8 (registry) as the keystone,
  with #9/#10 falling out of it, and #6/#7 alongside.

_See `git log` for the per-change history and `README.md`/`ROADMAP.md` for the product context._
