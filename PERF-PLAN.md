# Drift render-performance plan — reduce reliance on chunking

Staged execution plan from the session-10 5-lens perf analysis. Full rationale + the ranked
option set + risks live in the `perf-roadmap` memory; this file is the ordered, concrete
**execution checklist**. Ship each numbered step as its own verified commit (build → verify →
commit → push; assets auto-deploy). Re-profile between stages.

## Resume here → user re-profiles zoom-out / STAGE C (Stage A + Stage B phase 1 + 2 zoom-out fixes DONE)
- **`HEAD == origin/main == 512ccc5`.** The user field-tested each increment. Pan ✅ smoother. Zoom-out
  needed TWO fixes (both shipped):
  - **`1ee8939` resolution-match:** cache was PEGGED (`sprites 226 (95.8/96MB)` thrashing) — baked at FIXED
    world-res regardless of display size → resolution-MATCH the bake to zoom (`K=dpr*bakeZoom(camera.z)`,
    √2 buckets [0.25,1.4]); `SPRITE_Z_MAX` 1.8→1.4. Memory fixed, but still 7fps.
  - **`512ccc5` big-tree caching + blob-fallback:** a shipped `?perftrace` per-pass timer + draw-path
    counter pinned it — ~160 BIG TREES (mat≥BIG_TREE_MAT)/frame were drawing LIVE via drawPlant (~90µs
    each), because phase 1 EXCLUDED big trees. Fix: cache big-tree canopies too (roots live+unbent, skipped
    sub-pixel; bbox widened UP_F 4.5/HALF_F 3.0, MAX_SPRITE_PX 1200 — 0 clips mat 0.2-1.0) + a LOD-BLOB
    FALLBACK (un-baked plant → cheap blob, never the ~90µs live drawPlant → no cold-cache fps collapse) +
    BAKES_PER_FRAME 6→10. Measured drawObj 15.4→1.8ms fully warm (8×).
  - **LESSONS:** (1) sprite RESOLUTION must track DISPLAY size, not world size; (2) a cache MISS must never
    cost more than the cached path — fall back CHEAP (blob), never to the expensive live render.
- **▶ NEXT:** user re-profiles the zoomed-out world (should be much smoother now; `?perftrace` gives the
  per-pass + draw-path breakdown if not). Then STAGE C (visible-set iteration + GC) if the remaining
  fixed cost at very-high on-screen counts still bites; Stage B phase 2 (stones) is lower priority (stones
  are cheap single polygons — the perftrace `paint` line will say if they matter).
- **`HEAD == 82e6a4e`.** **✅ STAGE B phase 1 SHIPPED** (`82e6a4e`): the plant-canopy
  sprite cache (`public/spritecache.js`). Bakes `drawPlant` once per (seed | `floor(mat*20)` |
  `floor(aged*8)` | dpr) and blits it; per-frame sway/depth/zoom + a maturity SIZE-CORRECTION (scale
  by true/baked baseLen ratio → size tracks growth continuously) applied at blit time. Scoped to
  mid-maturity plants (SPROUT_C≤mat<BIG_TREE_MAT), `camera.z≤1.8` (live-vector when zoomed in). LRU
  96MB cap + 6-bakes/frame budget + max-sprite-size fallback. `forms.js` UNCHANGED (stays pure). Perf
  HUD gained a `sprites N (MB)` line. Verified: 28 green; pixel-diff 99.5% coverage / 1px bbox;
  800-sample clip sweep 0 clips; size-correction ≤1% at bucket edges; colour Δ<1.5/255 (imperceptible);
  a 5-lens/21-agent adversarial review (1 real finding fixed = size quantization; ΔE + "critical
  ds-offset" refuted by measurement; aged>0.167 branch quantization accepted for phase 1).
- **▶ NEXT (pick per re-profile):** (a) **RE-PROFILE the pan win** on a REAL tab (perf HUD `?perf=1`):
  the sprite cache targets exactly the far-pan jank the user reported. (b) **STAGE B phase 2** (deferred
  from phase 1): cache STONES with a size cap (small stones are cheap to draw but numerous; big fused
  boulders stay live — cheap + huge-sprite) + rooted BIG trees (draw roots live, cache the canopy). (c)
  **STAGE C** (visible-set iteration + GC hitches). Real-tab watch items from phase 1: the z=1.8
  sprite↔live handoff; aged-tree branch count during a far pan.

## Resume here → STAGE B (Stage A is DONE)
- **`HEAD == origin/main == b878cc4`** (was `f8a70c2` at plan creation). **✅ STAGE A SHIPPED**
  as one cohesive commit `b878cc4` (the four sub-steps are interleaved across render.js/client.js/
  view.js, so they shipped + were verified together rather than as 4 split commits). Full suite
  (28) green; 5-lens adversarial equivalence review passed (1 finding fixed: glow-parallax bound
  200→600; 1 false-positive refuted). Forced-frame verified at pinned q0/q2/q4 — the whole
  backdrop now stays present at the bare tier, no console errors.
- **What Stage A delivered:** A2 season-memo (`seasonDerived`), A3a baked ground buffer
  (`paintBackdrop`), A3b pre-rendered glow buffer (`paintGlowsBuffered`, CSS-space/dpr-independent,
  parallax bounded ±600px), A4 always-on glows/sky/grade + removed the dead `noise/glows/sky/grade/
  patches` tier flags, A1 dpr-first 5-tier curve (dpr 2/1.75/1.5/1.25/1, full detail held early;
  `?q` pin now 0–4). The remaining tier levers are `dprCap/flow/sat/shadows/leaves/detailBudget`.
- **▶ NEXT = STAGE B** (the big lever: sprite-cache the static forms). Re-profile first on a REAL
  tab with the perf HUD (`?perf=1`), then start at B1. Real-tab TODOs carried from Stage A to
  eyeball: glow-parallax during a far pan, tier climb/drop feel over time, season crossfade.

## Resume here (state at plan creation)
- `HEAD == origin/main == f8a70c2`. The client is fully modularized (state/view/draw/forms/
  localfx/net/input; client.js ≈ 433 lines = orchestrator). Full suite (28) green; parity 82.
- **Already shipped:** the background texture (ground grain `paintNoise` + colour regions
  `paintGroundPatches`) is now always-on at every tier (`f8a70c2`) — the backdrop no longer
  pops with the quality tier. The `noise`/`patches` flags in `view.js` `QUALITY_TIERS` are now
  vestigial → Stage A repurposes/removes them.
- **The reframe that drives this plan:** per-object *uniqueness is cheap* (deterministic from the
  integer seed). The cost is RE-rendering it every frame — `drawPlant` (drift-procgen.js:210)
  re-runs a recursive branch fractal (~590 stroke ops for a mature tree, min 314 / max 1160)
  60×/s per visible tree, though the form is time-invariant. Plants+stones+seeds are the majority.
  **Keep full uniqueness; cache the render.**

## Verification recipe (every step)
- `node --check` each touched file (leaf modules aren't node-imported); full 28-suite gate green
  (`npm test`; `npm run reap` first — see [[test-harness-cpu]]).
- Browser: `preview_start` (`.claude/launch.json` `drift`) → navigate to `http://localhost:8787/?perf=1`
  (via `preview_eval location.href=…` to wake the tab past the hidden-tab black) → forced-frame
  screenshot + `?q=0..3` pin to eyeball each tier + console clean.
- **Real-tab caveat:** the preview tab is hidden so rAF is PAUSED — frame-ACCUMULATING behaviour
  (tier climb/drop, the perf HUD's live fps, sprite-cache hit-rate over time, sway) is NOT
  observable there. Flag those for the user's real tab. The perf HUD (`?perf=1` / press `p`) is
  the live instrument; a manual tier pin is `?q=0..3`.
- Preserve the calm / wordless / every-object-unique aesthetic at every step — that's the bar.

---

## Stage A — cheap, low-risk wins ✅ DONE (`b878cc4`)
Directly attacks the two things flagged: chunking *feels* jarring, and the backdrop popping.
(Shipped as one commit; sub-steps below are the as-built record. NOTE the two deviations from the
literal plan text: A3a bakes GROUND-only + keeps `paintNoise` per-frame — glows sit between ground
and noise in the stacking order and must stay per-frame for parallax, so ground+noise can't merge
without reordering; and A3b's glow parallax is BOUNDED to ±600px, not literally the raw offset.)

- **A1. Degrade RESOLUTION before DETAIL.** In `view.js` `QUALITY_TIERS`, reorder the curve so
  `dprCap` steps down first (add an intermediate ~1.75/1.5 step) while holding `detailBudget`
  high; only cut object detail at the leanest tiers. A softer raster suits the soft-edged calm
  look far better than chunky LOD blobs. Low risk (machinery exists: dprCap + `resize()` on
  change). Keep a dpr floor ~1.0–1.25 so hairline strokes don't shimmer. Verify each tier via
  `?q=`. *(roadmap ②)*
- **A2. Memoize season-derived work.** Season phase is constant for 60s (server TICK_MS=60000) but
  `seasonGround`/`paintSky` gradient+colour/`paintSeasonGrade` weights+colours/`seasonSat` recompute
  every frame. Cache them on phase-change (guard in `frame()` with `if (phase !== lastPhase)`, or
  compute in `net.js` when `S.seasonPhase` is assigned — invalidate on BOTH world_state + season
  messages). The full-screen grade fillRects stay per-frame; only the colour-math/gradient
  allocation is removed. *(roadmap ③)*
- **A3. Consolidate the backdrop + pre-render glows.** (a) Bake `paintGround`+`paintNoise` into one
  offscreen backdrop canvas rebuilt only on resize / season-ground change; blit it once per frame
  (source-over) instead of a radial-gradient fill + an `overlay` composite every frame — keep the
  current ground→glows→noise stacking order to preserve the look (A/B in browser). (b) Pre-render
  `paintGlows` to a buffer once (seed-fixed) sized viewport+margin; blit at the parallax offset
  instead of rebuilding 2-3 radial gradients + full-screen fills each frame. *(roadmap ③)*
- **A4. (payoff of A2/A3) Keep the WHOLE atmosphere always-on.** Once season + glows are cheap,
  stop gating glows/sky/grade behind the tiers too → the entire backdrop (ground+noise+patches+
  glows+sky+grade) is consistent at every tier; only OBJECTS ever chunk. Completes the `f8a70c2`
  fix. Remove the now-vestigial tier flags. Verify at pinned `?q=3` the atmosphere still reads.

## Stage B — the big lever: sprite-cache the static forms  (phase 1 ✅ DONE `82e6a4e`; phase 2 = stones + big trees)
The change that actually lets full detail hold without chunking. *(roadmap ①)*
Phase 1 shipped the PLANT-canopy cache (the ~590-stroke cost). As-built deviations from the B1–B5
text below: only plants are cached so far (stones are cheap single polygons + big fused boulders would
make huge sprites → deferred to phase 2); big rooted trees (mat≥BIG_TREE_MAT) + pre-sprout seeds stay
live; the cache lives in draw.js (not forms.js — forms.js must stay pure/Node-importable); a maturity
SIZE-CORRECTION at blit time recovers continuous size on top of the bucketed form.

- **B1. A sprite-cache module.** New `public/spritecache.js` (or fold into forms.js): given an
  object, return a cached offscreen canvas of its rendered form, keyed by
  `family + seed + quantized(maturity) + quantized(aged) + erosion/handling(stones)`. Idiom:
  `document.createElement('canvas')` (same as render.js's noise/patches buffers). Store
  `{canvas, ox, oy}` (base-point offset) so the blit lands the base at (cx,cy). Bake at the
  object's canonical world size × dpr.
- **B2. Bucketing (the enabler — get this right or it's a net loss).** Key by
  `Math.round(shownMat*N)`, `Math.round(shownAged*M)` with N≈16–20, M≈8 (fine enough that a bucket
  step is sub-pixel for typical on-screen sizes; coarse enough that a tree re-renders only a few
  times over a multi-second grow, then never — growth is 60s cadence, ~1s settle → steady-state
  hit-rate ~100%). Add hysteresis on the bucket key to avoid re-render thrash across a boundary.
- **B3. Wire the static families through it.** In forms.js, `FORM.stone/seed/mark.draw` (and the
  plant path in `drawPlantForm`) → `blit(getSprite(o), cx, cy)`. Compose the per-frame affine
  transforms at BLIT time, not bake time: `_bend` sway = `translate,rotate(bend),drawImage`
  (turns today's worst case — a cursor-brushed mature grove — into the cheapest); `depthScale` +
  `camera.z` = scale the blit; `_ox/_oy` nudge = translate. Extend the existing stone `_sg` memo
  into a full sprite (gradients bake in). **Leave ANIMATED families live-vector**
  (creature/fish/anomaly/crystal — few + cheap + genuinely time-varying; do NOT cache first).
- **B4. Bound memory.** LRU keyed by the full quantized key; working set = on-screen objects
  (≤ detailBudget), LOD-blobbed objects need no sprite. Cap ~64MB (measure `w*h*4`); pool evicted
  canvases; tie the cap to the quality tier (bare tier = tiny cache). One canonical scale + scaled
  blit (avoid per-zoom caches); only re-render the 1–2 hero objects at extreme zoom if soft.
- **B5. Verify** per-family screenshots vs the pre-B baseline (must be visually identical); watch
  for bucket-boundary popping during growth (coarsen or crossfade if seen — REAL-TAB, since growth
  accumulates); confirm the LOD-blob cut now rarely triggers (the headroom win).

## Stage C — cut the world-size-scaling cost + GC hitches
*(roadmap ④ + ⑤)* — invisible; makes cost track visible count, and stops GC pauses from tripping
the tier down (which is itself a cause of chunking).

- **C1. Iterate the VISIBLE set, not all N.** The client scans all ~6700 objects ~8×/frame. Drive
  growth/position off a small "settling" set (drop an object once its tween reaches rest); marks +
  carry-tethers off tiny live indexes (mark-ids, foreign-`heldBy` ids) updated in the net handlers;
  nudge off a cursor-local spatial bucket. Fall back to a full scan on `world_patch`. *(④)*
- **C2. Kill redundant per-frame recompute + allocations.** Compute `creaturePos` ONCE per creature
  per frame (stash `o._pos`; today wanderAt runs ~6×/creature/frame); cache the fixed-t0 wander
  anchor + `creatureR` (pure fn of seed+kind — stop allocating an rng closure per call); reuse
  module-scratch `{x,y}` in `worldToScreen`/`creaturePos` for the hot loops (thousands of allocs/
  frame → the GC pauses that trip `Q_DOWN_MS`). *(⑤)*
- **C3. Cheaper same-result compute.** LOD budget-th-largest via quickselect/min-heap (not a full
  `sizes.sort()`); numeric id tie-break in the painter sort (hash id→`o._idNum` once; no string
  compare in the hot sort); batch all ground shadows into ONE path (group into 2–3 alpha buckets),
  skip shadows for sub-pixel objects. *(⑤)*

## Stage D — re-profile, then decide on bigger bets (only if still short)
Re-measure with the perf HUD on a real tab. If more is needed, weigh (roadmap "bigger bets"):
two-layer canvas + idle throttle (great for the still-watching state); static world-layer (higher
loop-overhead win but depth-sort-split + pan-reinvalidation complexity — B1–B4 is its lower-risk
sibling); sprite ATLAS / finite-variant bank (bounds memory but APPROXIMATES uniqueness — only if
B4's cache is too heavy, or as a WebGL feeder); WebGL instanced quads (transformative but a large
rewrite + softens the vector look + inherits the atlas uniqueness tension); OffscreenCanvas+Worker
(smooths jank only, no throughput). Client spatial index (modest at N~1300).

## Sequencing & principle
A → B → C → re-profile → D-if-needed. Stage A is safe and immediately improves the chunking/backdrop
FEEL; B is the lever that removes the need to chunk objects; C removes the fixed world-size cost + GC
hitches. **Guiding principle: the world's BACKDROP is always fully painted; graceful degradation is
softer RESOLUTION first, then object LOD only under genuine extreme load — and with the sprite cache,
even that rarely fires.** Keep it calm, wordless, and every-object-unique throughout.
