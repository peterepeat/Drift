// =============================================================================
// DRIFT — WorldRoom: the single authoritative world (one global Durable Object).
//
// Holds every object in memory (backed by DO storage so it survives restart),
// fans out pickup/place/carry/presence over WebSockets, reclaims holds on
// disconnect, and runs a self-rescheduling 60s tick that grows the world even
// with zero connected clients — the world breathes, indifferent.
//
// GROWTH (Phase 2): seed-family objects carry a continuous lifecycle —
// maturity 0->1 (seed -> sprout -> plant -> mature) then aged 0->1 (mature ->
// aged -> dissolve). Growth is slow by default and ACCELERATED BY WARMTH: the
// presence of people nearby heats objects, and heat speeds growth. Mature
// plants shed seeds nearby; fully-aged plants release final seeds and dissolve.
// The visual FORM is always regenerated from seed+maturity+aged (drawPlant) —
// no visual data is stored. Stones do not grow; they only erode by handling.
//
// No identity ever leaves the server: a client's session token is used only
// for hold ownership; broadcasts carry an ephemeral per-connection `pid` and a
// boolean `held` — never the token.
// =============================================================================
import { generateWorld, makeRecord, makeSeedRecord, makeAnomalyRecord, ANOMALY_KINDS, makeCrystalRecord, makeCreatureRecord, makeFishRecord, makeMarkRecord, CREATURE_KINDS, reseedAction, SEED_VERSION, rng, makeNoise } from './seed.js';
import { FLOW_SEED, FLOW_SCALE, FLOW_REACH } from '../public/flow.js'; // shared with the client visual
import { POND_ASPECT, poolContaining as poolContainingIn, bankPoint } from '../public/shared/geometry.js'; // shared pond ellipse geometry (server + client + tests)
import { stoneRadius } from '../public/shared/sizing.js'; // shared form-from-seed footprint (server + client + tests)
import { MSG, scrubForbidden } from '../public/shared/protocol.js'; // shared wire message-types + invariant-#3 field whitelist
import { familyOf } from '../public/shared/families.js'; // shared per-family behaviour flags (drift/fade/tend/trim/deflect)
import { CATALOG as TUNE_CATALOG, coerce as tuneCoerce } from './tuning.js'; // operator panel: full knob catalogue + value coercion
import { HeatField } from './systems/heat.js'; // the coarse thermal field — decay/gradient/stone-formation (PRD §4.1)
import { GiantManager } from './systems/giant.js'; // the gardener giants — movement + the job catalogue (a world-facade + tune-port seam)
import { CreatureManager } from './systems/creatures.js'; // crawler/flier drives + social life + population (shares the giant's facade + tune port)
const TUNE_KIND = Object.fromEntries(TUNE_CATALOG.map((c) => [c.key, c.kind]));

const TICK_MS = 60000;
const HOLD_TIMEOUT_MS = 45000;            // reclaim a hold if its connection vanished
const COG_ALPHA = 0.2;                    // centre-of-gravity EMA weight

// ---- growth tuning (per 60s tick) ------------------------------------------
const SPROUT = 0.14;                      // maturity below this is still a seed
let GROW_BASE = 0.0016;                 // maturity/tick unattended (~10h seed->full)
let GROW_WARM = 0.055;                  // extra maturity/tick at heat=1 (~18min warm)
let AGE_RATE = 0.0045;                  // aged/tick once mature (~hours of maturity)
const HEAT_DECAY = 0.80;                  // heat retained per tick when no warmth
const HEAT_GAIN = 0.36;                   // heat added per nearby presence per tick
const HEAT_RADIUS = 240;                  // world units a presence warms
const PRESENCE_STALE_MS = 12000;          // presence older than this stops warming
const SHED_TICKS = 6;                     // a mature plant sheds ~every 6 ticks
const SHED_MAX_AGED = 0.6;                // stop shedding once this aged
const FINAL_SHED = 2;                     // seeds released when a plant dissolves
// Density-dependent reproduction: a mature plant in a crowded patch sheds less, so the
// world spreads OUTWARD instead of thickening into impenetrable thickets. Counts same-
// family plants within SHED_DENSITY_R (grid-local, cheap); below SOFT it sheds freely,
// at/above MAX the shed is fully suppressed, linear between. Tunable by feel.
const SHED_DENSITY_R = 160;
const SHED_DENSITY_SOFT = 4;
const SHED_DENSITY_MAX = 9;
const DEFAULT_MAX_OBJECTS = 10000;        // population ceiling (PRD §7.3 — the 10k target). Overridable per-deployment via env.MAX_OBJECTS so the cap can be ramped/rolled back with a Cloudflare var, no code change. Needs Workers Paid for rows_written headroom as the world fills (the checkpoint flushes ~all active objects).
const MAT_BCAST_DELTA = 0.025;            // broadcast growth when maturity moves this much

// ---- isolation & the ceiling (PRD §4.3 + §7.3) -----------------------------
// Isolation is DERIVED from a `last_touched` timestamp (set on handle/place, and
// refreshed by nearby warmth) — not a per-tick counter — so an untouched object
// writes nothing each tick and its fade clock survives a DO restart. A forgotten,
// unwarmed stone (which otherwise never decays with time) crumbles to grit; and
// when the world is full, the longest-untouched objects are trimmed so a packed
// world keeps breathing rather than freezing.
const WARM_EPS = 0.02;                     // heat above this counts as "tended" (refreshes last_touched)
const STONE_FADE_MS = 1440 * TICK_MS;      // a stone untouched & unwarmed this long crumbles to grit (~a day)
const CEIL_TRIM = 2;                       // how far under the ceiling to trim to (leaves room to breathe)

// ---- persistence ------------------------------------------------------------
// Broadcast cadence is DECOUPLED from write cadence. Each tick we broadcast every
// lifecycle/drift threshold-crossing for smooth visuals, but those crossings DON'T
// each write to storage — they're recorded in a DIRTY SET (alongside the sub-
// threshold drift no broadcast captured: growth/aging, sub-POS_BCAST_DELTA water
// creep, per-object heat, the warmth-refreshed last_touched clock, crystal decay)
// and flushed together by the periodic checkpoint. The checkpoint writes ONLY the
// dirty objects, never the whole population: an object absent from the set is byte-
// identical on disk already, so skipping it loses nothing. So a warm/active object
// that crosses the broadcast delta many times in a checkpoint window now costs ONE
// write (at the flush) instead of one per crossing — the always-ticking world's
// write rate tracks the CHECKPOINT CADENCE and the amount of CHANGE, not the
// broadcast rate and not the population. That is the lever that has to hold before
// the cap can rise toward the PRD's 10k (the DO rows_written quota was, and remains,
// the binding constraint). STRUCTURAL / OWNERSHIP changes still write immediately:
// spawns and deaths (so a new or gone object survives a pre-checkpoint eviction)
// and a reclaimed hold (ownership must not silently revive). A PERSISTED wall-clock
// mark gates the checkpoint cadence so it fires across DO eviction.
//   TRADE-OFF (deliberate): the dirty set is in-memory only, so if the DO evicts
//   between checkpoints the un-flushed drift reverts to its last on-disk value on
//   reload. This is the SAME bound the dirty-set design already accepted for the
//   sub-threshold drift; deferring the broadcast CROSSINGS too just widens what's
//   subject to it. The revert is bounded by one checkpoint window of SLOW change
//   (~0.05 maturity, ~a screen-pixel-scale drift) and the world's durable-growth
//   cadence is unchanged — the checkpoint already flushes every actively-changing
//   object (each mutates every tick ⇒ is dirty), so this removes the redundant
//   per-crossing writes WITHOUT enlarging the checkpoint. Acceptable for a world
//   this slow; revisit (shorter cadence / Workers Paid) if the cap rises far.
const CHECKPOINT_MS = 30 * 60 * 1000;      // dirty-flush cadence (~30 min)

// ---- seasons (the world's own slow clock; not correlated to real time) ------
// `season` is a monotonic float; the current season is floor(season) % 4 and
// the fractional part is progress toward the next. Each season holds, then
// crossfades to the next over its last ~30%. Seasons modulate growth/aging
// rates and the whole-frame colour grade — never the rules of interaction.
const SEASON_KEYS = ['growing', 'turning', 'resting', 'rising'];
let SEASON_PER_TICK = 4 / 480;          // full 4-season cycle ~8h of ticks (~2h/season)
const GROWTH_MULT = { growing: 1.0, turning: 0.25, resting: 0.0, rising: 0.6 };
const AGE_MULT = { growing: 0.7, turning: 1.4, resting: 0.3, rising: 0.8 };
const lerp = (a, b, t) => a + (b - a) * t;

// ---- communion bloom: the reward for tending a patch TOGETHER ---------------
// When two (or more) people linger in the same patch for a little while, the world
// BLOSSOMS there — a burst of flowering plants, sometimes a luminous anomaly —
// something that can never happen alone. The wordless "come do this with me". Tracked
// in-memory by the midpoint cell of each close presence-pair; sustained ⇒ bloom, then
// a cooldown so a patch can't farm it. (The "what's the point" answer: shared wonder.)
const COMMUNION_R = 300;                  // two presences within this share a patch
const COMMUNION_TICKS = 2;                // sustained ticks of togetherness before it blooms
const COMMUNION_COOLDOWN = 4;             // ticks a bloomed patch rests before it can bloom again
// ---- anomalies (Family 4): rare, luminous, no lifecycle ---------------------
let MAX_ANOMALIES = 4;                  // the world holds at most a few — seeing one is luck
let ANOMALY_SPAWN_CHANCE = 0.03;        // per tick, when conditions allow
const ANOMALY_SEASONS = { growing: true, rising: true }; // "new creation possible"
const ANOMALY_RADIUS = 200;               // world units an anomaly influences
const ANOMALY_GROW_BOOST = 0.02;          // extra maturity/tick for seeds near an anomaly
const ANOMALY_AGE_SLOW = 0.4;             // aging multiplier near an anomaly (slows decay)
// ---- anomaly POWERS (Wave R): drop an anomaly on a plant, or a plant on an anomaly,
// and the anomaly works a power on the plant — NON-uniform by kind. The anomaly is NOT
// consumed (it persists, a reusable wonder). Life-giving kinds RIPEN a seed/leaf into a
// mature tree; geometric kinds BURST a grown tree into a scatter of saplings.
const ANOM_TOUCH_R = 76;                   // a drop within this of the other object triggers the power
const ANOM_BURST_MIN = 3, ANOM_BURST_MAX = 5; // saplings a burst scatters
// kind → PLANT power. point/breath (light/breath = life) ripen; prism/rotor (geometry/spin) burst.
const ANOMALY_POWER = { point: 'ripen', breath: 'ripen', prism: 'burst', rotor: 'burst' };
// Drop an anomaly on a CREATURE (or a creature on an anomaly) and it gets a buff —
// NON-uniform by kind: a 'heart' anomaly TAMES it (follows the nearest person for a
// while); any other glows it (rainbow + 2× speed). Both are timed and wear off.
const GLOW_MS = 180000;                    // a glow buff lasts ~3 min
const TAME_MS = 150000;                    // a tamed creature follows the nearest person ~2.5 min
const ANOMALY_CREATURE_POWER = { heart: 'tame' }; // default (any other kind) → 'glow'

// ---- water, ponds & crystals (Family 3) ------------------------------------
// Water gathers in pools. The CENTRAL pool sits at the world's low centre (where
// objects accumulate); a few smaller PONDS are scattered around it (Wave P).
// Crystalline formations grow at the central pool's edge and slowly dissolve in a
// brief flash. Plants never take root IN water — a seed that lands in a pond is
// nudged to its bank (#shed + a per-tick relocation pass).
const POOLS = [
  { x: 0, y: 0, r: 350 },                  // the central pool — flow + crystals anchor here (POOL)
  { x: -1180, y: 640, r: 250 },
  { x: 1020, y: -760, r: 210 },
  { x: 520, y: 1180, r: 230 },
];
const POOL = POOLS[0];                      // the central/primary pool (world_state.pool; flow & crystal anchor)
const POND_RELOCATE_MAX = 64;               // cap seeds nudged out of water per tick (bounds the broadcast burst)
// Pond ELLIPSE geometry (POND_ASPECT, the containment test, bankPoint) lives in the
// shared public/shared/geometry.js so the DO, the client paint, and the tests can
// never drift apart. POOLS is the world's authoritative layout, injected here once.
const poolContaining = (x, y, margin = 0) => poolContainingIn(POOLS, x, y, margin);
// ---- fish (Family 6): a few swim in each pond (Wave Q) ----------------------
// Existence + a HOME inside a pond only; the live position is a deterministic wander
// the clients compute (public/creatures.js, kind 'fish'), BOUNDED so a fish never
// leaves the water. The tick keeps each pond stocked to a floor and tops up toward a
// cap. Spared isolation-fade, the ceiling trim, and water-drift (they're alive).
const FISH_PER_POND = 3;                   // each pond is kept stocked to at least this many
const FISH_MAX_PER_POND = 6;              // ...and never more than this
const FISH_SPAWN_CHANCE = 0.18;            // per pond per tick, between the floor and the cap
const FISH_HOME_FRAC = 0.5;                // a fish's home sits within this fraction of the pond radius from its centre (home ± reach stays in the water)
const CRYSTAL_CAP = 10;                    // at most this many crystals at once
const CRYSTAL_SPAWN_CHANCE = 0.05;        // per tick, while under the cap
const CRYSTAL_DECAY = 1 / 300;            // decay/tick (~5h to dissolve) — slow, impermanent

// ---- creatures (Family 5): a few wandering insects -------------------------
// Stored as existence + a HOME (x/y) only; the live position is a deterministic
// wander the clients compute (public/creatures.js), so no position is ticked or
// broadcast — the always-ticking world spends nothing keeping them moving. They
// ramp to a baseline quickly so an arriving world feels inhabited, then top up to
// a cap. Spared from water-drift, isolation-fade and the ceiling trim (they're alive).
// ---- creatures (crawler/flier) ---------------------------------------------
// The creature LOGIC + the non-tunable CREATURE_* consts (population/social/drive/
// separation/curiosity/follow) now live in server/systems/creatures.js (the
// CreatureManager). These stay HERE: CREATURE_STEP/SEEK_R/PREF_SPREAD are LIVE-
// TUNABLE (the TUNE_REG closures below bind these module `let`s; the manager reads
// them at call-time via the `tune` getter port), and BEFRIEND_MS is used by the
// #onBefriend wire handler (which stays DO-side; creatures just READ o.tameUntil).
let CREATURE_STEP = 46;                 // world units the home migrates toward a goal per tick (live-tunable)
let CREATURE_SEEK_R = 720;              // how far a creature looks for an attractor (live-tunable)
let CREATURE_PREF_SPREAD = 260;         // seeded per-(creature,target) affinity spread — declusters feed/rest targets (live-tunable; 0 ⇒ pure nearest)
let BEFRIEND_MS = 6 * 60 * 1000;        // a bond lasts ~6 min — long enough to be a companion, short enough that its whole arc (form → follow → fade) is watchable
// ---- the giant: a shared, world-tending NPC (the gardener) ------------------
// Its LOGIC + the non-tunable GIANT_* consts now live in server/systems/giant.js
// (the GiantManager). These stay HERE: GIANT_REACH/SIGHT are LIVE-TUNABLE — the
// TUNE_REG closures below bind these module `let`s, so the operator panel keeps
// tuning them at runtime; the manager reads them through a `tune` getter port.
const GIANT_SEED = 0x6a11d7;              // fixed form — one big, gentle creature for everyone (mirrored client-side; unused server-side)
let GIANT_REACH = 64;                   // close enough to tend its goal (live-tunable)
let GIANT_SIGHT = 1300;                 // how far it looks for something to tend (live-tunable; wide, so a big boulder is noticed from afar)

// ---- stones: erosion-to-grit, fuse & break (Family 1) ----------------------
// Stones don't grow; they erode by handling (each place wears them smoother and
// smaller, client-side from `handling`) and eventually dissolve into grit. They also
// FUSE: drop one onto another and they combine into a single larger stone (area-
// adding); and BREAK: a double-click splits one into smaller stones, down to a floor —
// at the floor a break is a NO-OP (the stone persists, never vanishes from breaking). A
// fused/split stone carries a stored radius `r` (absent ⇒ the seed-derived base size);
// the SHAPE is still regenerated from the seed.
let GRIT_HANDLING = 26;                 // handled this many times, a stone is worn to grit and gone
const MAX_STONE_R = 360;                  // floor for the fuse/settle grid-query bound (this.maxStoneR) — kept ≥ STONE_CAP_R so neighbour scans always cover the biggest rock
let MIN_STONE_R = 8;                     // the smallest a stone breaks down to (≈2 √2-steps below the old 16 — a much smaller pebble); below ~MIN×1.35 (≈11) a break does nothing (the stone stays, never breaks to nothing)
// EQUILIBRIUM: the giant merges PEBBLES (r < EQ) it finds paired up, and breaks down only
// BOULDERS LARGER than the (now generous) CAP — so a hand-built monolith up to CAP is left
// standing, while a runaway boulder past it is walked back toward the middle.
let STONE_EQ_R = 40;                     // "a decent stone" — at/above this the giant leaves it be (won't fuse it bigger)
let STONE_CAP_R = 350;                   // the PLAYER hand-fuse ceiling: drop one rock on another and they merge up to here, then bounce. SEPARATE from what the gardener breaks down (GIANT_BREAK_R) — the giant no longer spares a hand-built rock.
let GIANT_BREAK_R = 62;                   // the gardener breaks down any stone LARGER than this, back toward the middle (it spares nothing big). Raise above STONE_CAP_R to make it never touch hand-built rocks.
// Stone footprint in world units — base size from seed; `o.r` overrides once fused/split.
function stoneRadiusOf(o) { return o.r != null ? o.r : stoneRadius(o.seed); } // base from shared sizing; `r` once fused/split
const PLANT_BASE_R = 9;                    // a plant's trunk-base clearance — set down on a rock, it settles beside (Unit ⑥)
// ROCK WINS POSITION WARS: each tick, a free non-stone object overlapping a stone is eased
// clear of it (the stone never moves). Capped per tick so a dense cluster spreads its
// resolution over several ticks rather than one fat broadcast (write-economy: broadcast+dirty).
const STONE_PUSH_MAX = 96;                 // max non-stone objects a stone-collision pass eases clear per tick
const STONE_PUSH_CLEAR = 14;               // body clearance for a non-plant object (creature/anomaly/crystal); plants use PLANT_BASE_R

// ---- water: flow, drift & stone-channelling (Family 3, Phase 3) -------------
// A slow persistent flow moves across the world. Its direction at a point is a
// deterministic noise field (the SAME makeNoise + scale the client paints the
// water sheen from, so what you see and how things drift agree) bent tangentially
// around nearby stones — that deflection IS channelling (PRD §4.2, never told).
// Free objects sitting in the flow drift very slowly along it. Season gates the
// magnitude: Resting is near-frozen, Rising active, Turning disperses.
// FLOW_SEED / FLOW_SCALE / FLOW_REACH are shared with the client via public/flow.js.
const FLOW_SPEED = 1.6;                   // world units/tick at full strength — "very slowly"
const FLOW_STONE_R = 70;                  // a stone deflects flow within this radius
const FLOW_STONE_PUSH = 1.0;              // tangential deflection strength (channelling)
const FLOW_STONE_RADIAL = 0.35;           // small radial-away term so flow never runs into a stone
const FLOW_SEASON = { growing: 0.4, turning: 0.85, resting: 0.05, rising: 1.0 }; // magnitude by season
const POS_BCAST_DELTA = 6;                // broadcast a drifting object only once it has crept this far
const FLOW_HEAT = 0.6;                     // how strongly the heat gradient bends flow toward cooler areas

// ---- interest management (PRD §7.3 — toward a 10k-object world) -------------
// A connecting client sends its viewport half-extents (hw/hh, world units) so the
// initial world_state carries only the objects it can actually see (centred on the
// world's centre-of-gravity, where the camera arrives), not the whole world. As it
// pans, presence_move re-reports the viewport and the server streams in any in-view
// objects the client lacks (`world_patch`). PURELY in-memory: no storage writes, no
// new alarms — this never touches the DO rows_written budget. Falls back to the full
// payload when a client sends no viewport (old clients / tests stay correct).
const INTEREST_MARGIN = 2.4;              // send a ring this many viewport half-extents beyond the screen (a generous preload so panning doesn't reveal objects streaming in)
const PATCH_MAX = 400;                     // cap objects streamed per viewport update (rest follow next tick)

// ---- spatial grid (in-memory; PRD §7.3 — toward a 10k-object world) ---------
// A uniform spatial hash over object positions makes the per-tick / per-message
// neighbour queries (water-flow stone deflection, interest box scans, fuse-on-
// place) O(neighbours) instead of O(all objects), so the population can grow
// toward the PRD's 10k without the tick or a viewport report scanning the whole
// world. It is PURELY in-memory: built from this.objects on load, maintained as
// objects move/spawn/vanish, and NEVER persisted (no record field, no storage
// write) — so it costs nothing against the DO rows_written quota. The cell is
// wider than FLOW_STONE_R so a "stones near a point" query spans few cells.
const GRID_CELL = 256;                     // world units per grid cell (> FLOW_STONE_R = 70)

// ---- thermal field & stone formation (PRD §4.1): the invisible heat grid that
// decays, bends the water flow toward cooler areas, and slowly forms stones in
// sustained-warm spots — now lives in server/systems/heat.js (HeatField). ------
// ---- ground marks (Family 7, Wave S): a shared, ephemeral drawing surface ----
// Double-click bare ground → a small rock-shaped tinted stain, visible to everyone,
// that HEALS over ~10 minutes (the tick removes it once aged out). Capped so the
// surface can't fill up; oldest is evicted first. Spared isolation/ceiling/drift.
const MARK_LIFE_MS = 10 * TICK_MS;         // a mark fully heals (and is removed) after ~10 min
const MARK_MAX = 400;                       // at most this many marks at once (oldest evicted)

// (HEAT_CELL/FIELD_HALF/HEAT_MAX/HEAT_GAIN_FIELD/HEAT_SEASON_DECAY/STONE_HEAT/
//  STONE_FORM_TICKS now live in server/systems/heat.js with the HeatField class.)

function seasonBlend(phase) {
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3;
  f = f * f * (3 - 2 * f); // smoothstep
  return { cur: SEASON_KEYS[i], next: SEASON_KEYS[(i + 1) % 4], fade: f };
}

// ---- runtime tuning registry (operator panel /admin/tuning) ----------------
// The subset of knobs editable LIVE. Each captures its DEFAULT (for reset) plus a get/set
// over the module binding, so the read-sites everywhere else stay untouched. The full
// catalogue + metadata lives in server/tuning.js; this is just the live wiring.
const TUNE_REG = {
  GROW_BASE: { get: () => GROW_BASE, set: (v) => { GROW_BASE = v; }, def: GROW_BASE },
  GROW_WARM: { get: () => GROW_WARM, set: (v) => { GROW_WARM = v; }, def: GROW_WARM },
  AGE_RATE: { get: () => AGE_RATE, set: (v) => { AGE_RATE = v; }, def: AGE_RATE },
  SEASON_PER_TICK: { get: () => SEASON_PER_TICK, set: (v) => { SEASON_PER_TICK = v; }, def: SEASON_PER_TICK },
  MAX_ANOMALIES: { get: () => MAX_ANOMALIES, set: (v) => { MAX_ANOMALIES = v; }, def: MAX_ANOMALIES },
  ANOMALY_SPAWN_CHANCE: { get: () => ANOMALY_SPAWN_CHANCE, set: (v) => { ANOMALY_SPAWN_CHANCE = v; }, def: ANOMALY_SPAWN_CHANCE },
  CREATURE_STEP: { get: () => CREATURE_STEP, set: (v) => { CREATURE_STEP = v; }, def: CREATURE_STEP },
  CREATURE_SEEK_R: { get: () => CREATURE_SEEK_R, set: (v) => { CREATURE_SEEK_R = v; }, def: CREATURE_SEEK_R },
  CREATURE_PREF_SPREAD: { get: () => CREATURE_PREF_SPREAD, set: (v) => { CREATURE_PREF_SPREAD = v; }, def: CREATURE_PREF_SPREAD },
  BEFRIEND_MS: { get: () => BEFRIEND_MS, set: (v) => { BEFRIEND_MS = v; }, def: BEFRIEND_MS },
  GIANT_REACH: { get: () => GIANT_REACH, set: (v) => { GIANT_REACH = v; }, def: GIANT_REACH },
  GIANT_SIGHT: { get: () => GIANT_SIGHT, set: (v) => { GIANT_SIGHT = v; }, def: GIANT_SIGHT },
  GIANT_BREAK_R: { get: () => GIANT_BREAK_R, set: (v) => { GIANT_BREAK_R = v; }, def: GIANT_BREAK_R },
  GRIT_HANDLING: { get: () => GRIT_HANDLING, set: (v) => { GRIT_HANDLING = v; }, def: GRIT_HANDLING },
  MIN_STONE_R: { get: () => MIN_STONE_R, set: (v) => { MIN_STONE_R = v; }, def: MIN_STONE_R },
  STONE_EQ_R: { get: () => STONE_EQ_R, set: (v) => { STONE_EQ_R = v; }, def: STONE_EQ_R },
  STONE_CAP_R: { get: () => STONE_CAP_R, set: (v) => { STONE_CAP_R = v; }, def: STONE_CAP_R },
};

// The per-tick write-economy ledger (invariant #1). Every #tick pass routes its
// outcome through these verbs instead of hand-threading changed/gone/dirty arrays +
// O(n) `.includes` guards — so "which objects take a discrete write vs. ride the
// ~30-min checkpoint" lives in ONE named place a new pass can't silently get wrong.
//   change(o)  — a broadcastable state delta; persisted at the checkpoint (deferred)
//   reclaim(o) — an ownership release; must persist NOW (a missed-close can't revive)
//   defer(o)   — sub-threshold drift: ride the checkpoint, no broadcast
//   spawn(o) / remove(o) — a birth / death (a discrete write at commit)
// Sets give O(1) dedupe; insertion order (= the old array order) drives the commit.
class TickContext {
  constructor(dirty) {
    this._dirty = dirty;        // the DO's persistent dirty set (the checkpoint flushes it)
    this.changed = new Set();
    this.spawned = [];
    this.gone = new Set();
    this.reclaimed = new Set(); // ids in `changed` that persist NOW rather than defer
  }
  change(o) { this.changed.add(o); }
  reclaim(o) { this.changed.add(o); this.reclaimed.add(o.id); }
  defer(o) { this._dirty.add(o.id); }
  spawn(o) { this.spawned.push(o); }
  remove(o) { this.gone.add(o); }
  isGone(o) { return this.gone.has(o); }
}

export class WorldRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Population ceiling: env-overridable so the cap can be ramped/rolled back via a
    // Cloudflare var without a code change (a deliberate DO-load decision — PRD §7.3).
    // Clamped to a sane range so a typo can't set a runaway cap.
    const envMax = parseInt(env.MAX_OBJECTS, 10);
    this.maxObjects = Number.isFinite(envMax) ? Math.max(200, Math.min(50000, envMax)) : DEFAULT_MAX_OBJECTS;
    // Seed population is env-overridable (env.SEED_N) — small for fast local tests;
    // prod leaves it unset and gets the full grove world. undefined ⇒ generator default.
    const envSeedN = parseInt(env.SEED_N, 10);
    this.seedCount = Number.isFinite(envSeedN) ? Math.max(20, Math.min(50000, envSeedN)) : undefined;
    this.objects = new Map();      // id -> record
    this.cog = { x: 0, y: 0, n: 0 }; // world centre-of-gravity (EMA of presence; DO-owned, shared by many readers incl. the giant)
    this.lastSeen = new Map();     // pid -> ts (presence liveness)
    this.presencePos = new Map();  // pid -> { x, y, ts } (drives warmth)
    this.bcastMark = new Map();    // id -> { maturity, aged } last broadcast (chatter control)
    this.driftMark = new Map();    // id -> { x, y } last-broadcast position (water-drift chatter control)
    this.viewports = new Map();    // pid -> { cx, cy, hw, hh } last-reported interest box (in-memory only)
    this.known = new Map();        // pid -> Set(id) objects already sent to this connection (interest streaming)
    this.grid = new Map();         // "cx,cy" -> Set(record): in-memory spatial hash (never persisted)
    this.cellOf = new Map();       // id -> "cx,cy": each object's current grid cell (for move/remove)
    this.maxStoneR = MAX_STONE_R;  // largest stone footprint present — fuse/settle query bound (recomputed in #gridRebuild; bumped on fuse)
    this.dirty = new Set();        // ids whose in-memory state diverged from disk since last #persist (checkpoint flushes these)
    this.objWrites = 0;            // discrete per-object row writes+deletes (NOT the batched checkpoint) — the rows_written lever, exposed for ops/tests
    this.flowNoise = null;         // lazily-built makeNoise(FLOW_SEED); shared with the client visual
    this.heat = new HeatField();   // coarse thermal field — decay/gradient/stone-formation (PRD §4.1; server/systems/heat.js)
    this.lastCheckpoint = 0;       // wall-clock ms of the last full snapshot (persisted; survives eviction)
    this.season = 0;               // monotonic season phase (floor % 4 = current season)
    this.bounds = null;            // {x,y} half-extents of the object field — the client clamps its camera to this (no wandering into the void)
    this.communion = new Map();    // midpoint-cell -> sustained-togetherness ticks (negative = cooldown); in-memory, never persisted
    // Inbound wire dispatch: one handler per MSG type (replaces the if/else ladder).
    // Built once here (private methods exist on the instance before the constructor
    // body runs); webSocketMessage looks up m.t and calls the handler with (ws,m,pid,now).
    // NULL-PROTOTYPE map so a hostile m.t ('constructor'/'toString'/'__proto__'/…) can't
    // reach an inherited Object.prototype member — only the 9 registered types dispatch.
    this.msgHandlers = Object.assign(Object.create(null), {
      [MSG.PICKUP]: this.#onPickup, [MSG.CARRY]: this.#onCarry, [MSG.PLACE]: this.#onPlace,
      [MSG.BREAK]: this.#onBreak, [MSG.DISSOLVE]: this.#onDissolve, [MSG.MARK]: this.#onMark,
      [MSG.GIANT_SKIP]: this.#onGiantSkip, [MSG.BEFRIEND]: this.#onBefriend, [MSG.PRESENCE_MOVE]: this.#onPresenceMove,
    });
    // The DO's subsystems (giant + creatures) reach the world through a shared WORLD
    // FACADE: read-through getters for the shared/DO-owned state (objects/cog/bounds/
    // season/maxObjects/SPROUT) + arrow forwarders to the DO's own private methods (so
    // #-privacy, objWrites accounting + broadcast order stay byte-identical). The giant
    // writes IN PLACE through the write forwarders (its act() runs outside the ledger —
    // why the write-economy tests run it off); creatures run inside #tick and write via
    // the ctx ledger passed to their passes, so they only need the grid forwarders +
    // nearestPresence. The TUNE port exposes the live-tunable knobs as getters over the
    // module `let`s (read at call time, so a TUNE_REG.set is seen on the next tick).
    const self = this;
    const world = {
      get objects() { return self.objects; }, get cog() { return self.cog; },
      get bounds() { return self.bounds; }, get season() { return self.season; },
      get maxObjects() { return self.maxObjects; }, get SPROUT() { return SPROUT; },
      gridNear: (x, y, r, f) => self.#gridNear(x, y, r, f),
      gridNearest: (x, y, r, f, score) => self.#gridNearest(x, y, r, f, score),
      gridUpdate: (o) => self.#gridUpdate(o),
      nearestPresence: (x, y, maxR) => self.#nearestPresence(x, y, maxR),
      addObject: (o) => self.#addObject(o),
      removeObject: (o, extras) => self.#removeObject(o, extras),
      persist: (o) => self.#persist(o),
      bcast: (msg, except) => self.#bcast(msg, except),
      stateMsg: (o, now) => self.#stateMsg(o, now),
      tryFuse: (o, now) => self.#tryFuse(o, now),
      breakStone: (o, now) => self.#breakStone(o, now),
      // a wordless "a gardener just tended here" cue — a bespoke one-shot bcast (never persisted),
      // turned into a soft shimmer bloom on the client. Rate is bounded by GIANT_TENDS_PER_TICK.
      tendCue: (x, y) => self.#bcast({ t: MSG.TEND, x, y }, null),
    };
    const tune = {
      get REACH() { return GIANT_REACH; }, get SIGHT() { return GIANT_SIGHT; }, get BREAK_R() { return GIANT_BREAK_R; },
      get SEASON_PER_TICK() { return SEASON_PER_TICK; }, get STONE_EQ_R() { return STONE_EQ_R; }, get STONE_CAP_R() { return STONE_CAP_R; },
      get STEP() { return CREATURE_STEP; }, get SEEK_R() { return CREATURE_SEEK_R; }, get PREF_SPREAD() { return CREATURE_PREF_SPREAD; },
    };
    this.giant = new GiantManager(world, tune, POOLS);
    this.creatures = new CreatureManager(world, tune, POOLS);
    this.state.blockConcurrencyWhile(async () => { await this.#load(); });
  }

  async #load() {
    const list = await this.state.storage.list({ prefix: 'obj:' });
    // A record the migration actually rewrote (e.g. a legacy stone getting its
    // last_touched clock stamped) is now divergent from disk in memory only —
    // mark it dirty so the first checkpoint freezes it, exactly as the old
    // full-population checkpoint did. Otherwise such a stone would re-stamp
    // last_touched=now on every cold load and never accumulate its fade clock.
    for (const [, rec] of list) { if (this.#migrate(rec)) this.dirty.add(rec.id); this.objects.set(rec.id, rec); }
    this.cog = (await this.state.storage.get('cog')) || { x: 0, y: 0, n: 0 };
    this.giant.load(this.cog); // the gardeners begin near the world's heart, a little apart
    this.season = (await this.state.storage.get('meta:season')) || 0;
    this.heat.load(await this.state.storage.get('field:heat')); // rebuilt lazily if absent
    this.lastCheckpoint = (await this.state.storage.get('meta:checkpoint')) || 0;
    this.tuneOverrides = (await this.state.storage.get('meta:tuning')) || {}; // operator-panel overrides, re-applied over the defaults each load
    for (const [k, v] of Object.entries(this.tuneOverrides)) if (TUNE_REG[k]) TUNE_REG[k].set(v);
    // Seed a fresh world, OR reseed once if this world was left by an older generator
    // (version-gated; stamps the new version so it never loops). This is how a
    // deployed generator change reaches the live world — no admin key, no wipe route.
    const action = reseedAction(this.objects.size, await this.state.storage.get('meta:seedVersion'));
    if (action === 'seed-fresh') await this.#seed(false);
    else if (action === 'reseed') await this.#seed(true);
    this.#gridRebuild();           // index every loaded/seeded object (in-memory; the grid is empty after a DO restart)
    // Self-heal the tick alarm: arm it if there's none OR if the stored alarm is
    // already past-due. A deploy/restart can leave a past alarm that never re-fires,
    // which silently freezes the world's clock (no growth, no creatures); re-arming
    // a past-due alarm guarantees the world keeps breathing across deploys.
    const alarmAt = await this.state.storage.getAlarm();
    if (alarmAt == null || alarmAt <= Date.now()) {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // Backfill lifecycle fields on records written by an earlier version. Returns
  // true if it actually rewrote the record (so #load can mark it dirty for the
  // next checkpoint — under the dirty-flush, an unmarked migration would never
  // reach disk).
  #migrate(o) {
    let changed = false;
    if (typeof o.maturity !== 'number') { o.maturity = 0; changed = true; }
    if (typeof o.aged !== 'number') { o.aged = 0; changed = true; }
    if (typeof o.heat !== 'number') { o.heat = 0; changed = true; }
    if (typeof o.shedAccum !== 'number') { o.shedAccum = 0; changed = true; }
    if (typeof o.decay !== 'number') { o.decay = 0; changed = true; }
    // Records from before the last_touched clock start their fade timer NOW, not
    // at created_at — otherwise a long-lived world's stones would all crumble to
    // grit on the first tick after this deploy.
    if (typeof o.last_touched !== 'number') { o.last_touched = Date.now(); changed = true; }
    if ('isolation' in o) { delete o.isolation; changed = true; } // replaced by the derived last_touched clock
    // Creatures from before the anchored wander start their anchor at created_at, so
    // they begin on their home rather than snapping out by a stale wander offset.
    if (o.family === 'creature' && typeof o.wanderT0 !== 'number') { o.wanderT0 = o.created_at || Date.now(); changed = true; }
    return changed;
  }

  async #seed(force) {
    if (force) {
      const old = await this.state.storage.list({ prefix: 'obj:' });
      if (old.size) await this.state.storage.delete([...old.keys()]);
      this.objects.clear();
    }
    const recs = generateWorld(Date.now(), this.seedCount);
    const puts = {};
    for (const r of recs) { this.objects.set(r.id, r); puts['obj:' + r.id] = r; }
    await this.#putAll(puts);
    this.#gridRebuild();           // re-index from scratch (a force-reseed wiped the old grid too)
    this.cog = { x: 0, y: 0, n: 0 };
    await this.state.storage.put('cog', this.cog);
    await this.state.storage.put('meta:seeded', { at: Date.now(), n: recs.length });
    await this.state.storage.put('meta:seedVersion', SEED_VERSION); // stamp so the one-time reseed never loops
    return recs.length;
  }

  // storage.put accepts at most 128 entries per call.
  async #putAll(map) {
    const entries = Object.entries(map);
    for (let i = 0; i < entries.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
  }

  // ---- HTTP (routed here by the Worker) -------------------------------------
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const pid = crypto.randomUUID();          // ephemeral; not tied to the token
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ pid });
      // Interest-managed initial payload: if the client tells us its viewport size,
      // send only what it can see. A returning client may also hint its remembered
      // home centre (cx/cy — the return thread, PRD §6.3) so its first payload lands
      // on its own area; default to the cog, where a fresh arrival lands (§5.4).
      // cx/cy are PURELY a viewport hint — no identity, nothing stored per token.
      const hw = parseFloat(url.searchParams.get('hw'));
      const hh = parseFloat(url.searchParams.get('hh'));
      const cxp = parseFloat(url.searchParams.get('cx')), cyp = parseFloat(url.searchParams.get('cy'));
      const cx = Number.isFinite(cxp) ? cxp : this.cog.x;
      const cy = Number.isFinite(cyp) ? cyp : this.cog.y;
      const box = (hw > 0 && hh > 0) ? this.#boxFrom(cx, cy, hw, hh) : null;
      const state = this.#worldState(pid, box);
      this.#send(server, state);
      if (box) {
        this.viewports.set(pid, { cx, cy, hw, hh });
        this.known.set(pid, new Set(state.objects.map((o) => o.id)));
      } else {
        this.known.set(pid, new Set(this.objects.keys())); // got the whole world
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/admin/seed') {
      const force = url.searchParams.get('force') === '1';
      if (force && !this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const before = this.objects.size;
      let n = before;
      if (force) n = await this.#seed(true);
      else if (before === 0) n = await this.#seed(false);
      if (force) for (const ws of this.state.getWebSockets()) {
        const wpid = ws.deserializeAttachment()?.pid;
        const v = this.viewports.get(wpid);
        const state = this.#worldState(wpid, v ? this.#boxFrom(v.cx, v.cy, v.hw, v.hh) : null);
        this.known.set(wpid, new Set(state.objects.map((o) => o.id))); // reset known to the fresh world
        this.#send(ws, state);
      }
      return Response.json({ ok: true, seeded: n, was: before, forced: force });
    }

    // Operator tuning panel. GET = read the whole catalogue (no key, values only). POST
    // ?key=&value= sets one LIVE knob; it's coerced, applied to the running world, and the
    // override persisted (re-applied on every load). Gated for any mutation.
    if (url.pathname === '/admin/tuning') {
      if (request.method === 'GET') return Response.json(this.#tuningState());
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const key = url.searchParams.get('key'), reg = TUNE_REG[key];
      if (!reg) return Response.json({ ok: false, error: 'unknown or non-live knob' }, { status: 400 });
      const v = tuneCoerce(TUNE_KIND[key], url.searchParams.get('value'));
      if (typeof v !== 'number' || !Number.isFinite(v)) return Response.json({ ok: false, error: 'bad value' }, { status: 400 });
      reg.set(v); this.tuneOverrides[key] = v; await this.state.storage.put('meta:tuning', this.tuneOverrides);
      return Response.json({ ok: true, key, value: String(reg.get()) });
    }
    if (url.pathname === '/admin/tuning/reset') {   // POST ?key= resets one knob; no key resets ALL to defaults
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const key = url.searchParams.get('key');
      if (key) { const reg = TUNE_REG[key]; if (!reg) return Response.json({ ok: false, error: 'unknown knob' }, { status: 400 }); reg.set(reg.def); delete this.tuneOverrides[key]; }
      else { for (const k of Object.keys(TUNE_REG)) TUNE_REG[k].set(TUNE_REG[k].def); this.tuneOverrides = {}; }
      await this.state.storage.put('meta:tuning', this.tuneOverrides);
      return Response.json({ ok: true, key: key || 'all', value: (key && TUNE_REG[key]) ? String(TUNE_REG[key].get()) : undefined });
    }

    // Ops/testing only: advance the world by N ticks immediately. Gated by ADMIN_KEY.
    if (url.pathname === '/admin/tick') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const n = Math.max(1, Math.min(500, parseInt(url.searchParams.get('n') || '1', 10)));
      const setSeason = url.searchParams.get('season');
      if (setSeason != null) this.season = parseFloat(setSeason) || 0; // jump the season clock (testing)
      const before = this.objects.size, writesBefore = this.objWrites;
      let spawned = 0, gone = 0, checkpoints = 0, checkpointWrote = 0;
      for (let i = 0; i < n; i++) { const r = await this.#tick(Date.now()); spawned += r.spawned; gone += r.gone; if (r.checkpointed) { checkpoints++; checkpointWrote += r.checkpointWrote; } }
      // objWrites = discrete per-object row writes/deletes during these ticks (spawns + deaths + any
      // hold-reclaim), NOT the batched checkpoint — growth/drift broadcasts are decoupled and cost zero here.
      return Response.json({ ok: true, ticks: n, before, after: this.objects.size, spawned, gone, objWrites: this.objWrites - writesBefore, checkpoints, checkpointWrote, season: this.season, max: this.maxObjects });
    }

    // Ops/testing only: spawn one anomaly (optionally at ?x=&y=). Gated.
    if (url.pathname === '/admin/anomaly') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const px = url.searchParams.get('x'), py = url.searchParams.get('y');
      const at = (px != null && py != null) ? { x: parseFloat(px), y: parseFloat(py) } : null;
      const matures = [...this.objects.values()].filter((o) => o.family === 'seed' && o.maturity >= 1);
      const parent = matures.length ? matures[Math.floor(Math.random() * matures.length)] : { x: 0, y: 0 };
      const an = this.#spawnAnomaly(parent, Date.now(), at, url.searchParams.get('kind'));
      await this.#addObject(an);
      return Response.json({ ok: true, anomaly: { id: an.id, kind: an.kind, x: an.x, y: an.y } });
    }

    // Ops/testing only: spawn one crystal (optionally at ?x=&y=). Gated.
    if (url.pathname === '/admin/crystal') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const px = url.searchParams.get('x'), py = url.searchParams.get('y');
      const at = (px != null && py != null) ? { x: parseFloat(px), y: parseFloat(py) } : null;
      const cr = this.#spawnCrystal(Date.now(), at);
      await this.#addObject(cr);
      return Response.json({ ok: true, crystal: { id: cr.id, x: cr.x, y: cr.y } });
    }

    // Ops/testing only: spawn one creature (optionally at ?x=&y=&kind=). Gated.
    if (url.pathname === '/admin/creature') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const px = url.searchParams.get('x'), py = url.searchParams.get('y');
      const at = (px != null && py != null) ? { x: parseFloat(px), y: parseFloat(py) } : null;
      const cr = this.creatures.spawnCreature(Date.now(), at, url.searchParams.get('kind'));
      await this.#addObject(cr);
      return Response.json({ ok: true, creature: { id: cr.id, kind: cr.kind, x: cr.x, y: cr.y } });
    }

    // Ops/testing only: read the giant, or set its position (?x=&y=) + clear its goal. Gated.
    if (url.pathname === '/admin/giant') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const payload = this.giant.admin({ i: url.searchParams.get('i'), x: url.searchParams.get('x'), y: url.searchParams.get('y'), off: url.searchParams.get('off') });
      return Response.json({ ok: true, ...payload });
    }

    // Ops/testing only: spawn one fish in a pond (?pond= index, default central). Gated.
    if (url.pathname === '/admin/fish') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const pi = Math.max(0, Math.min(POOLS.length - 1, parseInt(url.searchParams.get('pond') || '0', 10) || 0));
      const f = this.#spawnFish(Date.now(), POOLS[pi]);
      await this.#addObject(f);
      return Response.json({ ok: true, fish: { id: f.id, x: f.x, y: f.y, pond: pi } });
    }

    // Ops/testing only: read the water flow vector at (?x=&y=). Gated.
    if (url.pathname === '/admin/flow') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const x = parseFloat(url.searchParams.get('x') || '0'), y = parseFloat(url.searchParams.get('y') || '0');
      const f = this.#flowAt(x, y, seasonBlend(this.season));
      return Response.json({ ok: true, x, y, vx: f.vx, vy: f.vy, season: this.season });
    }

    // Ops/testing only: force an object's position (bypasses hold). Gated.
    if (url.pathname === '/admin/place') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const o = this.objects.get(url.searchParams.get('id') || '');
      if (!o) return Response.json({ ok: false, error: 'no such object' }, { status: 404 });
      const x = parseFloat(url.searchParams.get('x')), y = parseFloat(url.searchParams.get('y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Response.json({ ok: false, error: 'bad coords' }, { status: 400 });
      const now = Date.now();
      o.x = x; o.y = y; o.last_touched = now;
      const rr = parseFloat(url.searchParams.get('r')); // optional: set a stone's stored radius (e.g. build a boulder for the equilibrium test, now that hand-fusing caps)
      if (Number.isFinite(rr) && o.family === 'stone') { o.r = rr; this.maxStoneR = Math.max(this.maxStoneR, rr); }
      this.#gridUpdate(o);
      this.driftMark.delete(o.id);
      await this.#persist(o);
      this.#bcast(this.#stateMsg(o, now), null);
      return Response.json({ ok: true, id: o.id, x: o.x, y: o.y, r: o.r });
    }

    // Ops/testing only: read the heat field at (?x=&y=), or ?set= a cell's heat. Gated.
    if (url.pathname === '/admin/heat') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const x = parseFloat(url.searchParams.get('x') || '0'), y = parseFloat(url.searchParams.get('y') || '0');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Response.json({ ok: false, error: 'bad coords' }, { status: 400 });
      const setv = url.searchParams.get('set');
      if (setv != null && Number.isFinite(parseFloat(setv))) {
        this.heat.setCell(x, y, parseFloat(setv));
        await this.state.storage.put('field:heat', this.heat.field);
      }
      const g = this.heat.grad(x, y);
      return Response.json({ ok: true, x, y, heat: this.heat.at(x, y), gx: g.gx, gy: g.gy });
    }

    // Ops/testing only: bulk-spawn N cheap dormant seeds to push toward the ceiling. Gated.
    if (url.pathname === '/admin/fill') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const n = Math.max(1, Math.min(20000, parseInt(url.searchParams.get('n') || '1', 10)));
      const now = Date.now(), puts = {};
      for (let i = 0; i < n; i++) {
        const r = makeSeedRecord(crypto.randomUUID(), (Math.random() * 4294967296) >>> 0,
          (Math.random() * 2 - 1) * 1500, (Math.random() * 2 - 1) * 1500, now);
        this.objects.set(r.id, r); puts['obj:' + r.id] = r;
      }
      await this.#putAll(puts);
      this.#gridRebuild();           // cheaper than n incremental adds for a bulk fill
      return Response.json({ ok: true, added: n, total: this.objects.size });
    }

    // Ops/testing only: set an object's lifecycle (maturity/aged) directly, so a
    // test can make a plant dissolution-ready without ticking it there naturally
    // (natural timing is marginal and balloons the world). Gated; inert in prod.
    if (url.pathname === '/admin/lifecycle') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const o = this.objects.get(url.searchParams.get('id') || '');
      if (!o) return Response.json({ ok: false, error: 'no such object' }, { status: 404 });
      const mat = parseFloat(url.searchParams.get('maturity')), ag = parseFloat(url.searchParams.get('aged'));
      if (Number.isFinite(mat)) o.maturity = Math.max(0, Math.min(1, mat));
      if (Number.isFinite(ag)) o.aged = Math.max(0, Math.min(1, ag));
      await this.#persist(o);
      this.#bcast(this.#stateMsg(o, Date.now()), null);
      return Response.json({ ok: true, id: o.id, maturity: o.maturity, aged: o.aged });
    }

    // Ops/testing only: age an object's last_touched clock by N ticks (drive
    // fade/ceiling tests). Gated.
    if (url.pathname === '/admin/isolate') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const o = this.objects.get(url.searchParams.get('id') || '');
      if (!o) return Response.json({ ok: false, error: 'no such object' }, { status: 404 });
      const ticks = Math.max(0, parseInt(url.searchParams.get('n') || '0', 10) || 0);
      o.last_touched = Date.now() - ticks * TICK_MS;
      o.created_at = Date.now() - ticks * TICK_MS; // also age the birth clock (drives mark-heal / lifespan tests)
      await this.#persist(o);
      return Response.json({ ok: true, id: o.id, agedTicks: ticks });
    }

    // Ops/testing only: assert the in-memory spatial grid is consistent with the
    // object map (every object indexed in exactly its computed cell, and nothing
    // stale lingers). Gated; inert in prod. Used by test/grid.test.mjs.
    if (url.pathname === '/admin/grid') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      let indexed = 0, consistent = true;
      for (const [k, cell] of this.grid) {
        for (const o of cell) {
          indexed++;
          if (this.objects.get(o.id) !== o) consistent = false;   // grid holds a stale/foreign record
          if (this.#cellKey(o.x, o.y) !== k) consistent = false;  // record sits in the wrong cell
          if (this.cellOf.get(o.id) !== k) consistent = false;    // reverse index disagrees
        }
      }
      for (const o of this.objects.values()) {                    // every live object is indexed
        const k = this.cellOf.get(o.id);
        if (k === undefined || !this.grid.get(k)?.has(o)) consistent = false;
      }
      if (indexed !== this.objects.size) consistent = false;
      return Response.json({ ok: true, cells: this.grid.size, indexed, objects: this.objects.size, consistent });
    }

    // Ops/testing only: force a checkpoint NOW (ignoring the wall-clock gate) and
    // report how many objects it wrote — i.e. the size of the dirty set. Gated;
    // inert in prod. Used by test/checkpoint.test.mjs to prove the dirty flush.
    if (url.pathname === '/admin/checkpoint') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const total = this.objects.size, dirtyBefore = this.dirty.size;
      const wrote = await this.#checkpoint(Date.now());
      return Response.json({ ok: true, wrote, dirtyBefore, total });
    }

    // Public, READ-ONLY health probe (no secret; no mutation) — surfaces whether
    // the world is actually ticking (season/alarm) and how it's populated.
    if (url.pathname === '/status') {
      let creatures = 0; for (const o of this.objects.values()) if (o.family === 'creature') creatures++;
      return Response.json({
        objects: this.objects.size, creatures, season: this.season,
        seedVersion: await this.state.storage.get('meta:seedVersion'),
        alarmAt: await this.state.storage.getAlarm(), now: Date.now(),
      });
    }

    return new Response('not found', { status: 404 });
  }

  #adminOk(request) {
    return this.env.ADMIN_KEY && request.headers.get('x-admin-key') === this.env.ADMIN_KEY;
  }

  // The operator-panel tuning view: every catalogued knob with its current value (live knobs
  // report the running value; the rest report their code default) and whether it's overridden.
  #tuningState() {
    return { knobs: TUNE_CATALOG.map((c) => ({
      key: c.key, where: c.where, group: c.group, label: c.label, default: c.default,
      curated: c.curated, kind: c.kind, min: c.min, max: c.max, note: c.note, live: c.live,
      value: (c.live && TUNE_REG[c.key]) ? String(TUNE_REG[c.key].get()) : c.default,
      overridden: !!(this.tuneOverrides && this.tuneOverrides[c.key] !== undefined),
    })) };
  }

  // Public projection of an object (FORM derived from seed; no visual data).
  #pub(o) {
    const p = {
      id: o.id, family: o.family, x: o.x, y: o.y, seed: o.seed,
      handling: o.handling, held: o.held !== '',
      maturity: o.maturity, aged: o.aged, created_at: o.created_at,
    };
    if (o.kind) p.kind = o.kind; // anomalies + creatures carry their form/kind
    if (o.kinds && o.kinds.length > 1) p.kinds = o.kinds; // a fused anomaly's hybrid kinds (form blend + combined powers + breakability)
    if (o.wanderT0 != null) p.wanderT0 = o.wanderT0; // the shared wander anchor (creatures + fish)
    if (o.glowUntil) { p.glowUntil = o.glowUntil; p.glowHue = o.glowHue; } // anomaly glow buff (rainbow + 2× speed)
    if (o.tameUntil) p.tameUntil = o.tameUntil; // tamed (follows the nearest person)
    if (o.family === 'creature') p.act = (o.tameUntil && o.tameUntil > Date.now()) ? 'follow' : this.creatures.driveLabel(o); // its current focus, for the (debug) focus label — computed live, never stored
    if (o.family === 'stone' && o.r != null) p.r = o.r; // a fused/split stone's stored radius (shape still from seed)
    if (o.held !== '') p.heldBy = o.heldConn; // the holder's EPHEMERAL pid (same id presence carries) — links a carried thing to its carrier; never the token
    return scrubForbidden(p); // invariant #3: defensively strip any raw record field (a no-op while we build by listing)
  }
  #stateMsg(o, now) {
    const m = {
      t: MSG.OBJECT_STATE, id: o.id, x: o.x, y: o.y, handling: o.handling,
      held: o.held !== '', maturity: o.maturity, aged: o.aged, ts: now,
      heldBy: o.held !== '' ? o.heldConn : '', // who's carrying it ('' = nobody) — for the felt-presence tether
    };
    if (o.wanderT0 != null) m.wanderT0 = o.wanderT0; // re-anchor on the wire so a placed creature/fish continues smoothly for everyone
    if (o.glowUntil) { m.glowUntil = o.glowUntil; m.glowHue = o.glowHue; } // anomaly glow buff
    if (o.tameUntil) m.tameUntil = o.tameUntil; // tamed (follows the nearest person)
    if (o.family === 'creature') m.act = (o.tameUntil && o.tameUntil > now) ? 'follow' : this.creatures.driveLabel(o); // current focus, for the (debug) focus label — computed live, never stored
    if (o.family === 'stone' && o.r != null) m.r = o.r;   // a fused stone broadcasts its grown radius
    if (o.kinds && o.kinds.length > 1) m.kinds = o.kinds;  // a fused anomaly broadcasts its hybrid kinds (live form change)
    return scrubForbidden(m); // invariant #3: defensively strip any raw record field
  }
  #worldState(pid, box) {
    const objects = [];
    // Box path uses the spatial grid (cell-aligned superset, re-tightened by
    // #inBox); the box-less full world stays a plain scan (old / test clients).
    const src = box ? this.#gridQueryBox(box) : this.objects.values();
    for (const o of src) { if (box && !this.#inBox(o, box)) continue; objects.push(this.#pub(o)); }
    return { t: MSG.WORLD_STATE, now: Date.now(), pid, season: this.season, pool: POOL, pools: POOLS, cog: { x: this.cog.x, y: this.cog.y }, bounds: this.bounds || this.#computeBounds(), giants: this.giant.pub(), objects };
  }
  // Half-extents of the whole object field (every object, not just the box) — the
  // client clamps its camera here so it can never wander far into empty space. A
  // floor keeps a sparse world from over-constraining the camera. Recomputed each
  // tick (cheap) and on connect; broadcast so the bound tracks the growing world.
  #computeBounds() {
    let bx = 0, by = 0;
    for (const o of this.objects.values()) { const ax = Math.abs(o.x), ay = Math.abs(o.y); if (ax > bx) bx = ax; if (ay > by) by = ay; }
    for (const p of POOLS) { const ax = Math.abs(p.x) + p.r, ay = Math.abs(p.y) + p.r; if (ax > bx) bx = ax; if (ay > by) by = ay; } // every pond stays reachable
    return { x: Math.max(900, bx), y: Math.max(900, by) };
  }
  // Interest box from a viewport centre + half-extents, widened by INTEREST_MARGIN.
  #boxFrom(cx, cy, hw, hh) {
    const mw = hw * INTEREST_MARGIN, mh = hh * INTEREST_MARGIN;
    return { minX: cx - mw, maxX: cx + mw, minY: cy - mh, maxY: cy + mh };
  }
  #inBox(o, b) { return o.x >= b.minX && o.x <= b.maxX && o.y >= b.minY && o.y <= b.maxY; }

  // ---- spatial grid (in-memory; never persisted) ----------------------------
  #cellKey(x, y) { return Math.floor(x / GRID_CELL) + ',' + Math.floor(y / GRID_CELL); }
  #gridAdd(o) {
    const k = this.#cellKey(o.x, o.y);
    let cell = this.grid.get(k);
    if (!cell) { cell = new Set(); this.grid.set(k, cell); }
    cell.add(o);
    this.cellOf.set(o.id, k);
  }
  #gridRemove(o) {
    const k = this.cellOf.get(o.id);
    if (k === undefined) return;
    const cell = this.grid.get(k);
    if (cell) { cell.delete(o); if (!cell.size) this.grid.delete(k); }
    this.cellOf.delete(o.id);
  }
  // Re-index after an object's x/y changed. No-op when it stayed in the same cell
  // (the sub-pixel-drift common case = one Map.get + string compare). Self-heals
  // an object that was never added (treats it as an add) rather than throwing.
  #gridUpdate(o) {
    const newK = this.#cellKey(o.x, o.y);
    const oldK = this.cellOf.get(o.id);
    if (oldK === newK) return;
    if (oldK === undefined) { this.#gridAdd(o); return; }
    const cell = this.grid.get(oldK);
    if (cell) { cell.delete(o); if (!cell.size) this.grid.delete(oldK); }
    let next = this.grid.get(newK);
    if (!next) { next = new Set(); this.grid.set(newK, next); }
    next.add(o);
    this.cellOf.set(o.id, newK);
  }
  #gridRebuild() {
    this.grid.clear(); this.cellOf.clear();
    this.maxStoneR = MAX_STONE_R; // largest stone footprint in the world — the upper bound for fuse/settle grid queries (tracks legacy boulders the giant hasn't broken down yet)
    for (const o of this.objects.values()) {
      this.#gridAdd(o);
      if (o.family === 'stone') this.maxStoneR = Math.max(this.maxStoneR, stoneRadiusOf(o));
    }
  }
  // Records within radius r of (x,y), as a cell-aligned SUPERSET — the caller
  // applies the exact distance test. `filter` trims per record while scanning.
  #gridNear(x, y, r, filter) {
    const cx0 = Math.floor((x - r) / GRID_CELL), cx1 = Math.floor((x + r) / GRID_CELL);
    const cy0 = Math.floor((y - r) / GRID_CELL), cy1 = Math.floor((y + r) / GRID_CELL);
    const out = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const cell = this.grid.get(cx + ',' + cy);
      if (!cell) continue;
      for (const o of cell) if (!filter || filter(o)) out.push(o);
    }
    return out;
  }
  // The single record within radius r of (x,y) passing `filter` that MINIMISES
  // `score` (default: Euclidean distance) — the "scan #gridNear, keep the closest
  // passing the exact test" idiom in ONE place, so the < tie-break can't drift
  // between copies. The disc test (d > r) re-tightens the cell-aligned superset; a
  // caller needing a per-candidate acceptance (e.g. "within the target's own
  // footprint") puts it in `filter`. Returns the best record, or null.
  #gridNearest(x, y, r, filter, score = null) {
    let best = null, bestScore = Infinity;
    for (const o of this.#gridNear(x, y, r, filter)) {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d > r) continue;
      const sc = score ? score(o, d) : d;
      if (sc < bestScore) { bestScore = sc; best = o; }
    }
    return best;
  }
  // Records whose cell overlaps box, as a cell-aligned SUPERSET — the caller
  // applies the exact #inBox test to tighten to the rectangle.
  #gridQueryBox(b) {
    const cx0 = Math.floor(b.minX / GRID_CELL), cx1 = Math.floor(b.maxX / GRID_CELL);
    const cy0 = Math.floor(b.minY / GRID_CELL), cy1 = Math.floor(b.maxY / GRID_CELL);
    const out = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const cell = this.grid.get(cx + ',' + cy);
      if (!cell) continue;
      for (const o of cell) out.push(o);
    }
    return out;
  }

  // Stream any in-view objects this connection hasn't been sent yet (interest paging).
  // Reads in-memory state only; never writes storage.
  #streamInterest(ws, pid, box) {
    let known = this.known.get(pid);
    if (!known) { known = new Set(); this.known.set(pid, known); }
    const objects = [];
    for (const o of this.#gridQueryBox(box)) {
      if (known.has(o.id) || !this.#inBox(o, box)) continue;
      objects.push(this.#pub(o));
      known.add(o.id);
      if (objects.length >= PATCH_MAX) break; // rest follow on the next viewport report
    }
    if (objects.length) this.#send(ws, { t: MSG.WORLD_PATCH, objects });
  }

  #send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  #bcast(obj, exceptWs) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(s); } catch {}
    }
  }
  async #persist(o) { await this.state.storage.put('obj:' + o.id, o); this.dirty.delete(o.id); this.objWrites++; } // now byte-current on disk

  // ---- object add / remove (the single home of the spawn/death accounting) ----
  // Two symmetric helpers that own the coupling between this.objects, the spatial
  // grid, the broadcast/drift chatter memos, the dirty set, and storage. Funnelling
  // every spawn/death through them keeps `objWrites` exact (invariant #1: the tick's
  // only discrete writes are spawns/deaths/reclaims) and makes a forgotten map — a
  // ghost grid hit, a stale broadcast-throttle, a storage leak — structurally
  // impossible. Replaces the spawn-triple (~11×) and the delete-dance (~12×, one
  // copy of which had already drifted: the mark-eviction omitted the chatter purges).
  async #addObject(o) {
    this.objects.set(o.id, o);
    this.#gridAdd(o);
    await this.#persist(o);                       // the discrete spawn write
    this.#bcast({ t: MSG.OBJECT_NEW, o: this.#pub(o) }, null);
  }
  async #removeObject(o, extras = null) {
    this.#gridRemove(o);
    this.objects.delete(o.id);
    this.bcastMark.delete(o.id);
    this.driftMark.delete(o.id);
    this.dirty.delete(o.id);
    await this.state.storage.delete('obj:' + o.id); // the discrete death write
    this.objWrites++;
    this.#bcast({ t: MSG.OBJECT_GONE, id: o.id, ...(extras || {}) }, null);
  }

  // ---- WebSocket message handling -------------------------------------------
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const handler = this.msgHandlers[m?.t];
    if (typeof handler !== 'function') return;  // an unknown / malformed wire type is ignored (typeof guards belt-and-suspenders with the null-proto map)
    await handler.call(this, ws, m, ws.deserializeAttachment()?.pid, Date.now());
  }

  // pickup: claim a free object. Single-threaded DO → this read-then-write IS the CAS.
  async #onPickup(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o) return;
    if (o.held === '') {
      o.held = m.token; o.heldConn = pid; o.held_at = now; o.last_touched = now;
      await this.#persist(o);
      this.#send(ws, { t: MSG.PICKUP_ACK, id: o.id, ok: true });
      this.#bcast(this.#stateMsg(o, now), ws);
      this.#updateCog(o.x, o.y);
    } else {
      this.#send(ws, { t: MSG.PICKUP_ACK, id: o.id, ok: false });
      this.#send(ws, this.#stateMsg(o, now));
    }
  }

  // carry: stream a held object's position (in-memory only; persisted on place / reclaim).
  async #onCarry(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o || o.held !== m.token) return;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return; // never store a corrupt position (a NaN serialises to null → 0,0)
    o.x = m.x; o.y = m.y;                    // in-memory only; persisted on place / reclaim
    this.#gridUpdate(o);                      // keep a carried object findable at its current spot
    this.dirty.add(o.id);                     // carried position is unpersisted — let a checkpoint catch a long carry
    this.#bcast(this.#stateMsg(o, now), ws);
  }

  // place: release a held object at the drop point + run the on-drop interactions
  // (fish-food, anomaly powers, stone fuse/grit/roll). The family blocks each either
  // consume/relocate o (early return) or fall through to a shared persist+broadcast
  // tail. (The per-family split lands with the FAMILIES registry — candidate #8.)
  async #onPlace(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o) return;
    if (o.held !== m.token) { this.#send(ws, this.#stateMsg(o, now)); return; } // not the holder
    if (Number.isFinite(m.x) && Number.isFinite(m.y)) { o.x = m.x; o.y = m.y; } // corrupt coords → release in place, don't teleport to 0,0
    o.held = ''; o.heldConn = ''; o.held_at = 0;
    o.handling += 1; o.last_touched = now; // a placed object has just been tended
    if (o.family === 'creature') {
      o.wanderT0 = now; // re-anchor: it wanders on a NEW route from where it was set down
      // A ground bug dropped into a pond becomes FISH FOOD (Wave Q): it sinks (a
      // splash) and a fish rises if the pond has room — drop a bug, feed the water.
      const pond = o.kind === 'crawler' ? poolContaining(o.x, o.y) : null;
      if (pond) {
        await this.#removeObject(o, { splash: true, x: o.x, y: o.y });
        const counts = this.#fishCountByPond(), idx = POOLS.indexOf(pond);
        if (idx >= 0 && counts[idx] < FISH_MAX_PER_POND) {
          const f = this.#spawnFish(now, pond);
          await this.#addObject(f);
        }
        return;
      }
      // Dropped onto an anomaly → its creature power(s): a heart TAMES, any other GLOWS
      // (a hybrid can do both). o falls through to the generic persist/broadcast below,
      // which carries the buff fields to everyone.
      const an = this.#anomalyNear(o.x, o.y);
      if (an) this.#anomalyWorkCreature(this.#anomalyKindsOf(an), o, now);
    }
    // Disturbing a pre-sprout seed resets its growth — it must be left be to take.
    if (o.family === 'seed' && o.maturity < SPROUT) { o.maturity = 0; o.heat = 0; }
    // Anomaly powers (Wave R): drop an anomaly ONTO a plant, or a plant ONTO an
    // anomaly, and the anomaly's power works on the plant (by kind). The anomaly
    // itself is never consumed — it persists, a reusable wonder.
    if (o.family === 'anomaly') {
      // Dropped onto another anomaly → FUSE into one hybrid: kinds unioned, form
      // blended, powers combined. Mirrors stone fusing; the dropped one is consumed.
      const fused = this.#tryFuseAnomaly(o, now);
      if (fused) {
        await this.#removeObject(o, { fused: fused.id });
        await this.#persist(fused);
        this.#bcast(this.#stateMsg(fused, now), null);
        return;
      }
      const kinds = this.#anomalyKindsOf(o);
      const target = this.#anomalyTargetNear(o.x, o.y, o);
      if (target && target.family === 'seed') {
        await this.#anomalyWorkSeed(kinds, target, now, false); // ripen and/or burst by the anomaly's combined powers
      } else if (target && target.family === 'creature') { // a creature beneath it → tame and/or glow
        this.#anomalyWorkCreature(kinds, target, now);
        await this.#persist(target); this.#bcast(this.#stateMsg(target, now), null);
      }
      // the anomaly settles at its spot — falls through to the persist/broadcast below
    } else if (o.family === 'seed') {
      const an = this.#anomalyNear(o.x, o.y);
      if (an && await this.#anomalyWorkSeed(this.#anomalyKindsOf(an), o, now, true)) return; // o was burst (consumed); else it ripened in place and falls through
    }
    // A plant set down ON a rock settles beside it — never a flat card on top (Unit ⑥).
    // If THAT nudge pushed it into a pond, ease it back to the bank (don't strand a
    // plant in water). Only when the settle actually moved it — a plant dropped
    // straight into open water keeps its existing behaviour (the tick relocates it).
    if (o.family === 'seed') {
      const px = o.x, py = o.y;
      this.#settleClearOfStones(o, PLANT_BASE_R);
      if (o.x !== px || o.y !== py) { const pond = poolContaining(o.x, o.y); if (pond) { const b = bankPoint(pond, o.x, o.y, o.seed); o.x = b.x; o.y = b.y; } }
    }
    let bounced = false; // a stone dropped on an ALREADY-CAPPED rock bounces off instead of vanishing into it
    if (o.family === 'stone') {
      // Worn to grit by too much handling — a brief scatter, then gone (§4.3).
      if (o.handling >= GRIT_HANDLING) {
        await this.#removeObject(o, { grit: true });
        return;
      }
      // A GENTLY-PLACED stone set down on another → FUSE (target grows, this one is consumed) —
      // the physical "stack it on top". A THROWN stone (m.fling) keeps its momentum: it does NOT
      // merge, it carries past and just rests clear of whatever it landed against ("knock past").
      // On a gentle place, a target already AT the cap BOUNCES the dropper off (kept + eased clear).
      if (m.fling) {
        this.#settleStoneClear(o); // a thrown rock never merges — ease it clear of any overlap, it came to rest beside/past
      } else {
        const fused = this.#tryFuse(o, now);
        if (fused && fused.bounce) { bounced = true; }
        else if (fused) {
          await this.#removeObject(o, { fused: fused.id });
          await this.#persist(fused);
          this.#bcast(this.#stateMsg(fused, now), null);
          this.#updateCog(fused.x, fused.y);
          return;
        }
      }
    }
    // No rocks in water: a stone left in a pool rolls to the nearest bank. We set its
    // authoritative resting spot now and flag the broadcast so the client eases it
    // there as a roll (rather than snapping). Land objects are unaffected.
    const rollFrom = o.family === 'stone' ? this.#rollStoneFromWater(o) : null;
    this.#gridUpdate(o); // index the final position (after any settle-clear / roll)
    await this.#persist(o);
    const sm = this.#stateMsg(o, now); if (rollFrom) sm.roll = 1; if (bounced) sm.bounce = 1;
    this.#bcast(sm, null);
    this.#updateCog(o.x, o.y);
  }

  // break: double-click a stone → split into smaller stones (or grit if already tiny);
  // double-click a FUSED anomaly → split back into its constituent kinds. No ownership
  // needed (anyone can break a free one), but not while it's held.
  async #onBreak(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o || o.held !== '') return;
    let pieces = null, puff = null;
    if (o.family === 'stone') { pieces = this.#breakStone(o, now); puff = { grit: true }; } // a dust puff
    else if (o.family === 'anomaly' && this.#anomalyKindsOf(o).length > 1) { pieces = this.#breakAnomaly(o, now); puff = { burst: true, x: o.x, y: o.y }; } // a soft ripple
    if (!pieces || !pieces.length) return; // nothing breakable here (a too-small stone just stays — never breaks to nothing)
    await this.#removeObject(o, puff);
    for (const c of pieces) await this.#addObject(c);
  }

  // dissolve: only the current holder can dissolve an anomaly (the deliberate 10s hold).
  async #onDissolve(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o || o.family !== 'anomaly' || o.held !== m.token) return;
    await this.#removeObject(o);
  }

  // mark: double-click bare ground → leave a rock-shaped tinted stain (Wave S). Visible
  // to all, heals over ~10 min. Land only (not water); oldest evicted at the cap.
  async #onMark(ws, m, pid, now) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    if (poolContaining(m.x, m.y)) return; // marks settle on land, not on the water
    let count = 0, oldest = null;
    for (const o of this.objects.values()) if (o.family === 'mark') { count++; if (!oldest || o.created_at < oldest.created_at) oldest = o; }
    if (count >= MARK_MAX && oldest) { // make room: evict the oldest mark
      await this.#removeObject(oldest);
    }
    const mk = makeMarkRecord(crypto.randomUUID(), (Math.random() * 4294967296) >>> 0, m.x, m.y, now);
    await this.#addObject(mk);
  }

  // giant_skip: a friendly tap on a giant — it lets go of what it was about to do and ambles on.
  async #onGiantSkip(ws, m, pid, now) {
    this.giant.reset(); // a friendly tap lets the gardeners amble on
  }

  // befriend: sustained attention has bonded a creature to someone — it becomes tamed
  // (follows the nearest person for a good long while) so they have a companion to return to.
  async #onBefriend(ws, m, pid, now) {
    const o = this.objects.get(m.id);
    if (!o || o.family !== 'creature' || o.held !== '') return;
    o.tameUntil = now + BEFRIEND_MS;
    await this.#persist(o);
    this.#bcast(this.#stateMsg(o, now), null);
  }

  // presence_move: a warmth heartbeat (broadcast to others, never the sender) that also
  // carries the viewport, so we page in any objects now in view (interest streaming).
  async #onPresenceMove(ws, m, pid, now) {
    this.lastSeen.set(pid, now);
    this.presencePos.set(pid, { x: m.x, y: m.y, ts: now });
    this.#bcast({ t: MSG.PRESENCE, pid, x: m.x, y: m.y, ts: now }, ws);
    if (m.hw > 0 && m.hh > 0) {
      this.viewports.set(pid, { cx: m.x, cy: m.y, hw: m.hw, hh: m.hh });
      this.#streamInterest(ws, pid, this.#boxFrom(m.x, m.y, m.hw, m.hh));
    }
  }

  async webSocketClose(ws) { await this.#dropConn(ws); }
  async webSocketError(ws) { await this.#dropConn(ws); }

  async #dropConn(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    this.lastSeen.delete(pid);
    this.presencePos.delete(pid);
    this.viewports.delete(pid);
    this.known.delete(pid);
    const now = Date.now();
    for (const o of this.objects.values()) {
      if (o.heldConn === pid) {
        o.held = ''; o.heldConn = ''; o.held_at = 0;
        await this.#persist(o);
        this.#bcast(this.#stateMsg(o, now), null);
      }
    }
    this.#bcast({ t: MSG.PRESENCE_GONE, pid }, null);
  }

  #updateCog(x, y) {
    this.cog.x = this.cog.x * (1 - COG_ALPHA) + x * COG_ALPHA;
    this.cog.y = this.cog.y * (1 - COG_ALPHA) + y * COG_ALPHA;
    this.cog.n += 1;
    this.state.storage.put('cog', this.cog); // fire-and-forget
  }

  #warmth(o, now) {
    let warm = 0;
    for (const p of this.presencePos.values()) {
      if (now - p.ts > PRESENCE_STALE_MS) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < HEAT_RADIUS) warm += HEAT_GAIN * (1 - d / HEAT_RADIUS);
    }
    return warm;
  }

  // ---- the breath: one growth/decay tick ------------------------------------
  // One world tick. Broadcasts every lifecycle move / spawn / death for smooth
  // visuals, but only SPAWNS, DEATHS and ownership reclaims write to storage as they
  // happen; the broadcast growth/drift moves (and all the sub-threshold drift) are
  // recorded in the dirty set and flushed by the periodic checkpoint — broadcast
  // cadence is decoupled from write cadence (see the persistence note and #checkpoint).
  async #tick(now) {
    const ctx = new TickContext(this.dirty); // the per-tick write-economy ledger (invariant #1)
    // Season modulates how fast life grows and ages this tick.
    const sb = seasonBlend(this.season);
    const gMult = lerp(GROWTH_MULT[sb.cur], GROWTH_MULT[sb.next], sb.fade);
    const aMult = lerp(AGE_MULT[sb.cur], AGE_MULT[sb.next], sb.fade);
    // Thermal field first: it bends the flow (read during drift below) and slowly
    // grows stones in sustained-warm areas. Pass the live presences (the warmth
    // sources) + a room check; update() returns the formed stones and the ledger
    // spawns them (so write-economy accounting stays single-source, invariant #1).
    const livePresence = [];
    for (const p of this.presencePos.values()) if (now - p.ts <= PRESENCE_STALE_MS) livePresence.push(p);
    for (const s of this.heat.update(now, sb, livePresence, (n) => this.objects.size + n < this.maxObjects)) ctx.spawn(s);
    const anomalies = [];
    for (const o of this.objects.values()) if (o.family === 'anomaly') anomalies.push(o);
    // The tick is an ordered sequence of passes over the TickContext ledger. Order is
    // BEHAVIOUR: it fixes the global RNG sequence, the accounting (pending spawns, the
    // ceiling's breathing room) and the "shove then re-bank" precedence. Each pass writes
    // ONLY through ctx (change/reclaim/defer/spawn/remove) so write-economy stays single-
    // source (invariant #1). heat/communion/creatures/giant are their own modules; the rest
    // are named #tick* passes (defined below #tick, in this same order).
    this.#tickLifecycle(ctx, now, gMult, aMult, anomalies); // growth / age / shed / dissolve + crystal decay + mark heal
    this.#tickWaterDrift(ctx, sb);                          // free objects near the pool creep along the flow
    this.#tickIsolation(ctx, now);                          // a forgotten free stone crumbles to grit; warmth refreshes the clock
    this.#tickCeiling(ctx);                                 // a full world trims its longest-untouched back under the cap
    this.#prunePresence(now);                               // drop presences whose connection never closed cleanly
    this.#communion(now, ctx);                              // where people tend a patch TOGETHER, the world blossoms
    this.#tickAnomalySpawn(ctx, now, sb, anomalies);        // rarely, a mature plant births an anomaly (generative seasons)
    this.#tickCrystalSpawn(ctx, now);                       // crystalline formations grow at the pool's edge, up to a few
    const creRoom = this.maxObjects - CEIL_TRIM;            // ceiling's breathing room — shared by the creature + fish refills
    this.creatures.maintainPopulation(now, ctx, creRoom);   // per-species floor → baseline ramp → chance-gated top-up
    this.#tickFish(ctx, now, creRoom);                      // keep every pond stocked (floor-fill + chance top-up)
    this.creatures.moveHomes(ctx);                          // step each free creature's HOME toward its goal + anti-crowd separation
    this.creatures.social(now, ctx);                        // mate (→ spawned) / clash (→ gone, or a routed flee → changed)
    this.#tickStonePush(ctx);                               // a stone never yields ground — shove overlappers just-clear
    this.#tickPondRelocate(ctx, now);                       // no trees in water — nudge any seed/stone in a pond to its bank

    await this.#commit(ctx, now);                           // flush ctx.changed (persist reclaimed, else defer + broadcast), then spawns + deaths

    this.season += SEASON_PER_TICK; // advance the world's own season clock (in memory every tick)
    await this.state.storage.put('meta:season', this.season); // one tiny key; cheap
    // Persist the thermal field only when it's live (or just settled to zero) —
    // an idle, all-zero world shouldn't write the field every tick forever.
    if (this.heat.needsPersist) await this.state.storage.put('field:heat', this.heat.field);
    this.heat.endTick();

    // Checkpoint: only every CHECKPOINT_MS (wall-clock, persisted so it fires
    // across eviction). Flushes the dirty set — the in-memory drift no discrete
    // write captured — and nothing else; clean objects are already byte-current
    // on disk. This is what keeps the always-ticking world off the rows_written
    // quota AND lets its write rate scale with change, not population.
    let checkpointed = false, checkpointWrote = 0;
    if (now - this.lastCheckpoint >= CHECKPOINT_MS) {
      checkpointWrote = await this.#checkpoint(now);
      checkpointed = true;
    }
    await this.giant.step(now); // each gardener strolls a step + tends what it reaches
    this.bounds = this.#computeBounds(); // refresh the camera bound (the world grows/shrinks)
    this.#bcast({ t: MSG.SEASON, phase: this.season, bounds: this.bounds, giants: this.giant.pub() }, null); // feel the clock turn + the gardeners' new spots (clients glide to them)

    return { spawned: ctx.spawned.length, gone: ctx.gone.size, checkpointed, checkpointWrote };
  }

  // ---- #tick passes (each writes only through the ctx ledger; order is behaviour) ----
  // Growth & lifecycle: per free object — hold-timeout reclaim, crystal decay, mark heal,
  // plant growth/age/shed/dissolve, and the broadcast-on-threshold + sub-threshold-defer
  // bookkeeping. `anomalies` is pre-gathered so growth can sense a nearby wonder.
  #tickLifecycle(ctx, now, gMult, aMult, anomalies) {
    for (const o of this.objects.values()) {
      if (o.held !== '' && now - o.held_at > HOLD_TIMEOUT_MS) { // missed-close safety net
        o.held = ''; o.heldConn = ''; o.held_at = 0; ctx.reclaim(o); // ownership ⇒ persist now
      }
      if (o.held !== '') continue;          // growth paused while held
      const fam = familyOf(o.family);
      if (fam.decays) {                     // crystals slowly dissolve (a brief flash, then gone)
        o.decay = Math.min(1, (o.decay || 0) + CRYSTAL_DECAY);
        if (o.decay >= 1) ctx.remove(o);
        else ctx.defer(o);                  // decay advances with no discrete write — the checkpoint must catch it
        continue;
      }
      if (fam.heals) {                      // ground marks heal and vanish after ~10 min (Wave S)
        if (now - (o.created_at || now) >= MARK_LIFE_MS) ctx.remove(o);
        continue;
      }
      if (!fam.grows) continue;             // stones / anomalies / fish have no time-based change here

      const beforeHeat = o.heat, beforeShed = o.shedAccum;
      o.heat = Math.min(1, o.heat * HEAT_DECAY + this.#warmth(o, now));
      const beforeMat = o.maturity, beforeAged = o.aged;
      // An anomaly nearby quietly accelerates growth and slows aging.
      let nearAnomaly = false;
      for (const an of anomalies) { if (Math.hypot(o.x - an.x, o.y - an.y) < ANOMALY_RADIUS) { nearAnomaly = true; break; } }

      if (o.maturity < 1) {
        o.maturity = Math.min(1, o.maturity + (GROW_BASE + GROW_WARM * o.heat + (nearAnomaly ? ANOMALY_GROW_BOOST : 0)) * gMult);
      } else {
        o.aged = Math.min(1, o.aged + AGE_RATE * aMult * (nearAnomaly ? ANOMALY_AGE_SLOW : 1));
        if (o.aged < SHED_MAX_AGED) {
          o.shedAccum += 1;
          if (o.shedAccum >= SHED_TICKS && this.objects.size + ctx.spawned.length < this.maxObjects) {
            o.shedAccum = 0; // reset whether or not it sheds — a crowded plant simply waits another cycle (no burst when the patch later clears)
            if (Math.random() >= this.#shedSuppression(o)) ctx.spawn(this.#shed(o, now));
          }
        }
        if (o.aged >= 1) {                  // dissolve: release final seeds, then gone
          for (let k = 0; k < FINAL_SHED && this.objects.size + ctx.spawned.length < this.maxObjects; k++) {
            ctx.spawn(this.#shed(o, now));
          }
          ctx.remove(o);
        }
      }

      // broadcast only on a meaningful lifecycle move (keeps a quiet world quiet)
      const mark = this.bcastMark.get(o.id) || { maturity: beforeMat, aged: beforeAged };
      const crossedSprout = (beforeMat < SPROUT) !== (o.maturity < SPROUT);
      if (Math.abs(o.maturity - mark.maturity) >= MAT_BCAST_DELTA ||
          Math.abs(o.aged - mark.aged) >= MAT_BCAST_DELTA ||
          crossedSprout) {
        this.bcastMark.set(o.id, { maturity: o.maturity, aged: o.aged });
        // guard against a double-handle when a hold also timed out this tick
        if (!ctx.isGone(o)) ctx.change(o);
      }
      // Sub-threshold lifecycle change (incl. checkpoint-only heat) that no
      // discrete write captured: mark it so the next checkpoint can't lose it.
      if ((o.maturity !== beforeMat || o.aged !== beforeAged || o.heat !== beforeHeat || o.shedAccum !== beforeShed) &&
          !ctx.changed.has(o) && !ctx.isGone(o)) ctx.defer(o);
    }
  }

  // Water drift: eligible free objects near the pool creep along the flow. Movement is
  // sub-pixel/tick; mark it dirty (a checkpoint persists the creep) but BROADCAST only
  // once an object has crept POS_BCAST_DELTA — else a pool full of drifters spams state.
  #tickWaterDrift(ctx, sb) {
    for (const o of this.objects.values()) {
      if (ctx.isGone(o) || !this.#driftEligible(o) ||
          Math.hypot(o.x - POOL.x, o.y - POOL.y) > POOL.r * FLOW_REACH) {
        // If it drifted some un-broadcast distance before becoming ineligible,
        // flush a final state so clients don't stay stuck up to POS_BCAST_DELTA behind.
        const m0 = this.driftMark.get(o.id);
        if (m0 && (o.x !== m0.x || o.y !== m0.y) && !ctx.isGone(o)) ctx.change(o);
        this.driftMark.delete(o.id);
        continue;
      }
      const f = this.#flowAt(o.x, o.y, sb);
      o.x += f.vx * FLOW_SPEED; o.y += f.vy * FLOW_SPEED;
      this.#gridUpdate(o);                      // re-index the drifted object (no-op until it crosses a cell)
      ctx.defer(o);                             // the creep is unpersisted until a checkpoint flushes it
      const mark = this.driftMark.get(o.id);
      if (!mark) { this.driftMark.set(o.id, { x: o.x, y: o.y }); continue; }
      if (Math.hypot(o.x - mark.x, o.y - mark.y) >= POS_BCAST_DELTA) {
        this.driftMark.set(o.id, { x: o.x, y: o.y });
        ctx.change(o);
      }
    }
  }

  // Isolation (PRD §4.3): derived from last_touched — no per-tick write. Warmth refreshes
  // the clock (in memory; persisted at the next checkpoint); a forgotten free stone crumbles
  // to grit. Anomalies, creatures, and held objects are tended/alive — never faded, never dirtied.
  #tickIsolation(ctx, now) {
    for (const o of this.objects.values()) {
      const fam = familyOf(o.family);
      if (fam.tended || o.held !== '') continue; // anomaly/creature/fish/mark are alive — never faded, never dirtied
      if (this.heat.at(o.x, o.y) > WARM_EPS) { o.last_touched = now; ctx.defer(o); continue; } // refresh is checkpoint-only
      if (fam.fades && (now - o.last_touched) >= STONE_FADE_MS) ctx.remove(o); // only a forgotten stone crumbles to grit
    }
  }

  // Ceiling (PRD §7.3): when the world is full, the longest-untouched (smallest last_touched)
  // objects are trimmed back to just under the cap so a packed world keeps breathing. Anomalies
  // and held objects are spared. A forced eviction is NOT a natural death — it releases no seeds.
  #tickCeiling(ctx) {
    const effective = this.objects.size - ctx.gone.size;
    if (effective >= this.maxObjects) {
      const cands = [];
      for (const o of this.objects.values()) {
        if (!familyOf(o.family).trimmable || o.held !== '' || ctx.isGone(o)) continue; // the alive families are ceiling-protected
        cands.push(o);
      }
      cands.sort((a, b) => a.last_touched - b.last_touched); // longest-untouched first
      const trim = Math.min(cands.length, effective - (this.maxObjects - CEIL_TRIM));
      for (let k = 0; k < trim; k++) ctx.remove(cands[k]);
    }
  }

  // Prune stale presence so the warmth map can't grow unbounded from connections that never closed cleanly.
  #prunePresence(now) {
    for (const [pid, p] of this.presencePos) {
      if (now - p.ts > PRESENCE_STALE_MS + 5000) this.presencePos.delete(pid);
    }
  }

  // Rarely, a mature plant births an anomaly — only in generative seasons, and only while the
  // world holds fewer than a few. Seeing one is luck. (anomalies = the count at tick start.)
  #tickAnomalySpawn(ctx, now, sb, anomalies) {
    if (anomalies.length < MAX_ANOMALIES && ANOMALY_SEASONS[sb.cur] &&
        this.objects.size + ctx.spawned.length < this.maxObjects && Math.random() < ANOMALY_SPAWN_CHANCE) {
      const matures = [];
      for (const o of this.objects.values()) if (o.family === 'seed' && o.maturity >= 1 && o.aged < 0.5) matures.push(o);
      if (matures.length) ctx.spawn(this.#spawnAnomaly(matures[Math.floor(Math.random() * matures.length)], now));
    }
  }

  // Crystalline formations grow at the pool's edge, up to a few.
  #tickCrystalSpawn(ctx, now) {
    let crystalCount = 0;
    for (const o of this.objects.values()) if (o.family === 'crystal') crystalCount++;
    if (crystalCount < CRYSTAL_CAP && this.objects.size + ctx.spawned.length < this.maxObjects && Math.random() < CRYSTAL_SPAWN_CHANCE) {
      ctx.spawn(this.#spawnCrystal(now));
    }
  }

  // Fish (Wave Q): keep every pond stocked. Floor-fill to FISH_PER_POND, then a chance-gated
  // top-up toward the cap. (Pending fish count toward the per-pond cap so one tick can't overfill.)
  #tickFish(ctx, now, creRoom) {
    const fishCounts = this.#fishCountByPond();
    for (const s of ctx.spawned) if (s.family === 'fish') { for (let i = 0; i < POOLS.length; i++) { const p = POOLS[i]; const dx = s.x - p.x, dy = s.y - p.y; if (dx * dx + dy * dy <= p.r * p.r) { fishCounts[i]++; break; } } }
    for (let i = 0; i < POOLS.length; i++) {
      while (fishCounts[i] < FISH_PER_POND && this.objects.size + ctx.spawned.length < creRoom) { ctx.spawn(this.#spawnFish(now, POOLS[i])); fishCounts[i]++; }
      if (fishCounts[i] < FISH_MAX_PER_POND && this.objects.size + ctx.spawned.length < creRoom && Math.random() < FISH_SPAWN_CHANCE) { ctx.spawn(this.#spawnFish(now, POOLS[i])); fishCounts[i]++; }
    }
  }

  // ROCK WINS POSITION WARS: a stone never yields ground. Any free non-stone object whose body
  // overlaps a stone's footprint is eased OUT to just-clear — the stone itself never moves.
  // Capped per tick; broadcast + dirtied via `changed` (the pond pass then re-banks any shoved into water).
  #tickStonePush(ctx) {
    let shoved = 0;
    for (const o of this.objects.values()) {
      if (shoved >= STONE_PUSH_MAX) break;
      if (o.held !== '' || (o.family !== 'seed' && o.family !== 'creature' && o.family !== 'anomaly' && o.family !== 'crystal')) continue;
      const px = o.x, py = o.y;
      this.#settleClearOfStones(o, o.family === 'seed' ? PLANT_BASE_R : STONE_PUSH_CLEAR);
      if (o.x !== px || o.y !== py) { this.#gridUpdate(o); ctx.change(o); shoved++; }
    }
  }

  // No trees in water (Wave P): any free seed/plant sitting in a pond is nudged to its bank; a
  // rock that drifted (or was caught) in a pool rolls out with the roll flag. Capped per tick.
  #tickPondRelocate(ctx, now) {
    let relocated = 0;
    for (const o of this.objects.values()) {
      if (relocated >= POND_RELOCATE_MAX) break;
      if (o.held !== '' || (o.family !== 'seed' && o.family !== 'stone')) continue;
      const p = poolContaining(o.x, o.y);
      if (!p) continue;
      this.driftMark.delete(o.id);
      if (o.family === 'stone') {
        // A rock that drifted (or was caught) in a pool rolls to the bank too — broadcast
        // with the roll flag so the client eases it out, and dirty it for the checkpoint.
        this.#rollStoneFromWater(o);
        this.#gridUpdate(o); this.dirty.add(o.id);
        const sm = this.#stateMsg(o, now); sm.roll = 1; this.#bcast(sm, null);
      } else {
        const b = bankPoint(p, o.x, o.y, o.seed);
        o.x = b.x; o.y = b.y;
        this.#gridUpdate(o);
        ctx.change(o);
      }
      relocated++;
    }
  }

  // Commit: broadcast every threshold-crossing for smooth visuals, but DON'T write per crossing —
  // mark it dirty and let the periodic checkpoint persist it (the broadcast/persist decouple). A
  // reclaimed hold is the exception: ownership writes NOW so a missed-close release can't revive.
  async #commit(ctx, now) {
    for (const o of ctx.changed) {
      if (ctx.reclaimed.has(o.id)) await this.#persist(o); else ctx.defer(o);
      this.#bcast(this.#stateMsg(o, now), null);
    }
    for (const o of ctx.spawned) await this.#addObject(o);
    for (const o of ctx.gone) await this.#removeObject(o);
  }

  // Flush the dirty set to storage and stamp the checkpoint mark. Writes only the
  // objects whose in-memory state diverged from disk since their last #persist; an
  // object NOT in the set is byte-identical on disk already, so skipping it loses
  // nothing. Returns how many objects were written (0 when nothing has drifted).
  async #checkpoint(now) {
    const ids = [...this.dirty];     // snapshot, then clear only what we flush (defensive vs any interleave)
    const puts = {};
    for (const id of ids) { const o = this.objects.get(id); if (o) puts['obj:' + id] = o; }
    const wrote = Object.keys(puts).length;
    if (wrote) await this.#putAll(puts);
    for (const id of ids) this.dirty.delete(id);
    this.#gridRebuild();             // in-memory self-heal against any missed grid hook / desync (zero storage cost)
    this.lastCheckpoint = now;
    await this.state.storage.put('meta:checkpoint', now);
    return wrote;
  }

  // ---- stone fusing ----------------------------------------------------------
  // Place-time: if the stone landed within another free stone's footprint, the two
  // FUSE into a single larger stone (radii area-added, capped). Returns the grown
  // target (the caller consumes the dropped stone), or null if it didn't land on one
  // (in which case it's settled clear so it doesn't overlap a neighbour).
  #tryFuse(o, now) {
    const ro = stoneRadiusOf(o);
    // the nearest free stone the drop landed substantially ON TOP of → fuse into it. Forgiving of
    // not-dead-centre: the dropped stone merges if its centre is within the target's footprint plus
    // half its own radius (i.e. it's more than half over the target) — a clear "on top", not a graze.
    const target = this.#gridNearest(o.x, o.y, ro + this.maxStoneR, (s) => s.family === 'stone' && s.id !== o.id && s.held === '' && Math.hypot(s.x - o.x, s.y - o.y) < stoneRadiusOf(s) + ro * 0.5);
    if (!target) { this.#settleStoneClear(o); return null; }
    // A target already AT the cap can't grow — fusing would just delete the dropped stone for
    // nothing. They BOUNCE instead: ease the dropper clear and signal a recoil (kept whole).
    if (stoneRadiusOf(target) >= STONE_CAP_R - 0.5) { this.#settleStoneClear(o); return { bounce: true }; }
    // area-combine, but CAPPED at the equilibrium ceiling — you can build a chunky rock,
    // not an ever-growing monolith. Never shrinks an already-large (legacy) boulder; the
    // giant is what walks those back down toward the middle.
    const grown = Math.hypot(ro, stoneRadiusOf(target));
    target.r = Math.max(stoneRadiusOf(target), Math.min(STONE_CAP_R, grown));
    this.maxStoneR = Math.max(this.maxStoneR, target.r); // keep the fuse/settle query bound covering the biggest rock
    target.last_touched = now;
    this.#gridUpdate(target);
    return target;
  }
  // Break a stone into smaller pieces (double-click). Splits its radius area-
  // conservingly into 2-3 children with fresh seeds, scattered; a stone already near
  // the floor crumbles to grit instead. Returns the spawned children (for broadcast).
  #breakStone(o, now) {
    const r = stoneRadiusOf(o);
    if (r <= MIN_STONE_R * 1.35) return []; // already at the floor — caller no-ops, the stone stays (never breaks to nothing)
    const pieces = r > 52 ? 3 : 2;
    const childR = Math.max(MIN_STONE_R, r / Math.sqrt(pieces)); // area-conserving
    const out = [];
    for (let k = 0; k < pieces; k++) {
      const ang = (k / pieces) * Math.PI * 2 + Math.random() * 0.8, dist = childR * (0.8 + Math.random() * 0.4);
      const seed = (Math.random() * 4294967296) >>> 0;
      const child = makeRecord(crypto.randomUUID(), 'stone', seed, o.x + Math.cos(ang) * dist, o.y + Math.sin(ang) * dist, now);
      child.r = childR;
      out.push(child);
    }
    return out;
  }

  // ---- anomaly fusing & powers (Wave R + hybrids) ----------------------------
  // The kinds an anomaly embodies: a fused hybrid carries an explicit list; a plain one
  // is just its single `kind`. Always ≥1 entry (back-compat with pre-hybrid records).
  #anomalyKindsOf(o) { return (o.kinds && o.kinds.length) ? o.kinds : (o.kind ? [o.kind] : []); }

  // Place-time: an anomaly dropped within ANOM_TOUCH_R of another free anomaly that
  // brings at least one NEW kind FUSES into it — the target gains the dropped one's
  // kinds (form blends, powers combine) and the dropped anomaly is consumed. Returns
  // the grown target, or null (merging the same kinds would destroy a wonder for
  // nothing, so we leave both standing).
  #tryFuseAnomaly(o, now) {
    // nearest OTHER free anomaly within touch range → fuse the dropped one into it
    const target = this.#gridNearest(o.x, o.y, ANOM_TOUCH_R, (a) => a.family === 'anomaly' && a.held === '' && a.id !== o.id);
    if (!target) return null;
    const uniq = [];
    for (const k of [...this.#anomalyKindsOf(target), ...this.#anomalyKindsOf(o)]) if (!uniq.includes(k)) uniq.push(k);
    if (uniq.length <= this.#anomalyKindsOf(target).length) return null; // no new kind — leave both be
    target.kinds = uniq.slice(0, ANOMALY_KINDS.length);
    target.kind = target.kinds[0]; // primary kind = the draw fallback for pre-hybrid clients
    target.last_touched = now;
    this.#gridUpdate(target);
    return target;
  }

  // Break a fused anomaly back into one single-kind anomaly per constituent kind,
  // scattered with fresh seeds. Returns the children (for broadcast).
  #breakAnomaly(o, now) {
    const kinds = this.#anomalyKindsOf(o), n = kinds.length, out = [];
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2 + Math.random() * 0.7, dist = 26 + Math.random() * 28;
      const seed = (Math.random() * 4294967296) >>> 0;
      out.push(makeAnomalyRecord(crypto.randomUUID(), seed, kinds[k], o.x + Math.cos(ang) * dist, o.y + Math.sin(ang) * dist, now));
    }
    return out;
  }
  // The nearest free PLANT or CREATURE within ANOM_TOUCH_R of (x,y) — what an anomaly
  // dropped here would work its power on (ripen/burst a plant; glow/tame a creature).
  #anomalyTargetNear(x, y, self) {
    return this.#gridNearest(x, y, ANOM_TOUCH_R, (o) => (o.family === 'seed' || o.family === 'creature') && o.held === '' && o !== self);
  }
  // The plant powers (ripen/burst) a kinds-list confers — a heart contributes none.
  #plantPowers(kinds) { const s = new Set(); for (const k of kinds) { const p = ANOMALY_POWER[k]; if (p) s.add(p); } return s; }

  // Apply an anomaly's combined plant powers to a seed: RIPEN (young→fresh mature) then,
  // if it also bursts and the seed is now mature, BURST it into saplings (consuming it).
  // When the seed is the placed object (seedIsPlaced), the caller's fall-through persist
  // captures a ripen; otherwise we persist+broadcast it here. Returns true if consumed.
  async #anomalyWorkSeed(kinds, seed, now, seedIsPlaced) {
    const powers = this.#plantPowers(kinds);
    let ripened = false;
    if (powers.has('ripen') && ((seed.maturity || 0) < 1 || (seed.aged || 0) > 0)) {
      seed.maturity = 1; seed.aged = 0; seed.heat = 0; seed.last_touched = now; ripened = true;
    }
    if (powers.has('burst') && (seed.maturity || 0) >= SPROUT) { await this.#burstPlant(seed, now); return true; }
    if (ripened && !seedIsPlaced) { await this.#persist(seed); this.#bcast(this.#stateMsg(seed, now), null); }
    return false;
  }

  // Apply an anomaly's combined creature powers: a 'heart' TAMES (follow the nearest
  // person), any other kind GLOWS (rainbow + 2× speed) — a hybrid can do both. Sets
  // fields only; the caller persists/broadcasts.
  #anomalyWorkCreature(kinds, c, now) {
    let tamed = false, glowed = false;
    for (const k of kinds) { if ((ANOMALY_CREATURE_POWER[k] || 'glow') === 'tame') tamed = true; else glowed = true; }
    if (tamed) c.tameUntil = now + TAME_MS;
    if (glowed) { c.glowUntil = now + GLOW_MS; c.glowHue = Math.floor(Math.random() * 360); }
  }
  // The nearest free ANOMALY within ANOM_TOUCH_R of (x,y).
  #anomalyNear(x, y) {
    return this.#gridNearest(x, y, ANOM_TOUCH_R, (a) => a.family === 'anomaly' && a.held === '');
  }
  // BURST: a grown tree shatters into a scatter of fresh saplings (kept out of water).
  async #burstPlant(target, now) {
    await this.#removeObject(target, { burst: true, x: target.x, y: target.y });
    const n = ANOM_BURST_MIN + Math.floor(Math.random() * (ANOM_BURST_MAX - ANOM_BURST_MIN + 1));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.7, d = 28 + Math.random() * 48;
      let x = target.x + Math.cos(a) * d, y = target.y + Math.sin(a) * d;
      const pond = poolContaining(x, y); if (pond) { const b = bankPoint(pond, x, y); x = b.x; y = b.y; } // saplings never land in water
      const s = makeSeedRecord(crypto.randomUUID(), (Math.random() * 4294967296) >>> 0, x, y, now);
      s.maturity = 0.06 + Math.random() * 0.06; // a hair past a seed — clearly young sprouts, not dormant seeds
      await this.#addObject(s);
    }
  }

  // A stone dropped OVERLAPPING others — but not centred enough to fuse — must not
  // pass THROUGH them. Ease it out to just-touching, biased toward the FRONT (down/+y)
  // so it settles against the near side rather than hiding behind. Each pass resolves
  // the deepest overlap; a few passes clear a small cluster. Fully deterministic (no
  // randomness) so every client agrees on where it came to rest.
  #settleStoneClear(o) { this.#settleClearOfStones(o, stoneRadiusOf(o)); }
  // Generalised: ease object `o` (a body of radius `ro`) out of any stone footprint it
  // overlaps, biased toward the FRONT (+y). Used both by stone-on-stone settling and to
  // settle a PLANT set down on a rock beside it — never a flat card on top (Unit ⑥).
  #settleClearOfStones(o, ro) {
    for (let iter = 0; iter < 10; iter++) {
      let worst = null, worstOver = 1e-3;     // ignore sub-unit grazes
      for (const s of this.#gridNear(o.x, o.y, ro + this.maxStoneR, (s) => s.family === 'stone' && s.id !== o.id && s.held === '')) {
        const min = ro + stoneRadiusOf(s);
        const dx = o.x - s.x, dy = o.y - s.y, d = Math.hypot(dx, dy);
        const over = min - d;
        if (over > worstOver) { worstOver = over; worst = { dx, dy, d, min }; }
      }
      if (!worst) break;                       // nothing left overlapping
      let { dx, dy, d, min } = worst;
      if (d < 0.001) { dx = 0; dy = 1; d = 0.001; } // exactly coincident → straight to the front
      let ux = dx / d, uy = dy / d + 0.45;     // bias the escape toward +y (the front)
      const ul = Math.hypot(ux, uy) || 1;
      o.x += (ux / ul) * (min - d); o.y += (uy / ul) * (min - d);
    }
  }
  // If stone `o` is sitting in a pool, move it to rest fully on the nearest bank (pushed
  // out past the rim by its OWN radius, so no part is over water) and return where it was
  // (so the caller can flag the roll); else return null. Mutates o.x/o.y only.
  #rollStoneFromWater(o) {
    const pond = poolContaining(o.x, o.y);
    if (!pond) return null;
    const from = { x: o.x, y: o.y };
    const b = bankPoint(pond, o.x, o.y, o.seed, stoneRadiusOf(o)); // past the elliptical rim by the stone's own radius
    o.x = b.x; o.y = b.y;
    return from;
  }

  // ---- water flow ------------------------------------------------------------
  // Flow vector at world (x,y) for the current season blend `sb`. Base direction
  // is the shared noise field (same makeNoise + FLOW_SCALE the client paints from).
  // Nearby stones bend the flow TANGENTIALLY around themselves — it curves past
  // them rather than running in, and that deflection IS channelling. The push is
  // mostly tangential (so a head-on flow is steered aside, never reversed) with a
  // small radial-away term to keep flow out of the stone. Only stones within
  // FLOW_STONE_R can deflect, so we ask the spatial grid for that neighbourhood
  // instead of scanning every stone per drifter.
  #flowAt(x, y, sb) {
    if (!this.flowNoise) this.flowNoise = makeNoise(FLOW_SEED);
    const a = this.flowNoise(x * FLOW_SCALE, y * FLOW_SCALE) * Math.PI;
    let vx = Math.cos(a), vy = Math.sin(a);
    for (const s of this.#gridNear(x, y, FLOW_STONE_R, (s) => familyOf(s.family).deflectsFlow)) {
      const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
      if (d > 0.001 && d < FLOW_STONE_R) {
        const f = 1 - d / FLOW_STONE_R, rx = dx / d, ry = dy / d;
        // tangent perpendicular to the radial, oriented to agree with the base flow
        let tx = -ry, ty = rx;
        if (tx * vx + ty * vy < 0) { tx = -tx; ty = -ty; }
        vx += (tx * FLOW_STONE_PUSH + rx * FLOW_STONE_RADIAL) * f;
        vy += (ty * FLOW_STONE_PUSH + ry * FLOW_STONE_RADIAL) * f;
      }
    }
    if (this.heat.field) { // water flows toward cooler areas (PRD §4.2) — bend along -∇heat
      const g = this.heat.grad(x, y);
      vx -= g.gx * FLOW_HEAT; vy -= g.gy * FLOW_HEAT;
    }
    const m = Math.hypot(vx, vy) || 1;
    const mag = lerp(FLOW_SEASON[sb.cur], FLOW_SEASON[sb.next], sb.fade);
    return { vx: (vx / m) * mag, vy: (vy / m) * mag };
  }

  // (thermal field — #ensureHeat/#cellIndex/#heatAt/#heatGrad/#updateHeat/#formStone
  //  — extracted to server/systems/heat.js; the DO holds one HeatField as this.heat.)

  // What drifts on the water: free, unheld things that aren't stones (the channel
  // walls) or anomalies, and aren't pre-sprout seeds (those must be left
  // undisturbed to take root). So mature plants and crystals creep along.
  #driftEligible(o) {
    if (o.held !== '') return false;
    const fam = familyOf(o.family);
    if (!fam.drifts) return false; // stone is a wall; creatures + fish move themselves; marks don't drift
    if (fam.driftsAfterSprout && o.maturity < SPROUT) return false; // a seed must root before it creeps
    return true;
  }

  #shed(parent, now) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 55 + Math.random() * 105; // shed further out so growth doesn't re-clump the world
    let x = parent.x + Math.cos(ang) * dist;
    let y = parent.y + Math.sin(ang) * dist;
    const inPond = poolContaining(x, y); // seeds never take root in water — settle on the bank
    if (inPond) { const b = bankPoint(inPond, x, y); x = b.x; y = b.y; }
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeSeedRecord(crypto.randomUUID(), seed, x, y, now);
  }
  // How crowded a mature plant's patch is → probability its shed is suppressed (0..1).
  // Counts same-family neighbours within SHED_DENSITY_R via the in-memory grid (O(local),
  // zero storage). Below SOFT it sheds freely (0); at/above MAX it's fully suppressed (1);
  // linear between. This is density-dependent reproduction — the world spreads outward
  // instead of thickening into thickets, with no retroactive thinning of what's there.
  #shedSuppression(o) {
    let n = 0;
    const r2 = SHED_DENSITY_R * SHED_DENSITY_R;
    for (const s of this.#gridNear(o.x, o.y, SHED_DENSITY_R, (s) => s.family === 'seed')) {
      if (s.id === o.id) continue;
      const dx = s.x - o.x, dy = s.y - o.y;
      if (dx * dx + dy * dy <= r2 && ++n >= SHED_DENSITY_MAX) return 1; // saturated — early out
    }
    if (n <= SHED_DENSITY_SOFT) return 0;
    return (n - SHED_DENSITY_SOFT) / (SHED_DENSITY_MAX - SHED_DENSITY_SOFT);
  }

  // Communion: where two+ people LINGER together, the world blossoms. Each tick, every
  // close presence-pair's midpoint cell accrues a counter; once sustained it blooms a
  // burst of flowering plants (+ sometimes an anomaly) there, then rests on a cooldown.
  // In-memory + presence-driven (no storage); the blooms themselves are ordinary
  // spawned objects (ride the normal spawn write). Returns nothing; pushes to `spawned`.
  #communion(now, ctx) {
    const live = [];
    for (const p of this.presencePos.values()) if (now - p.ts <= PRESENCE_STALE_MS) live.push(p);
    const active = new Set();
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) > COMMUNION_R) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const key = Math.round(mx / COMMUNION_R) + ',' + Math.round(my / COMMUNION_R);
      if (active.has(key)) continue;     // one bloom-progress per patch per tick
      active.add(key);
      const c = (this.communion.get(key) || 0) + 1;
      if (c >= COMMUNION_TICKS && this.objects.size + ctx.spawned.length < this.maxObjects - CEIL_TRIM) {
        this.communion.set(key, -COMMUNION_COOLDOWN);         // bloom, then rest
        for (const o of this.#communionBloom(mx, my, now)) ctx.spawn(o);
      } else this.communion.set(key, c);
    }
    // patches no longer shared cool off (negative = cooldown counts back up to 0)
    for (const [key, c] of this.communion) {
      if (active.has(key)) continue;
      const nc = c < 0 ? c + 1 : c - 1;
      if (nc === 0) this.communion.delete(key); else this.communion.set(key, nc);
    }
  }
  #communionBloom(x, y, now) {
    const out = [];
    const k = 2 + Math.floor(Math.random() * 2);             // 2-3 flowering plants, born mature
    for (let i = 0; i < k; i++) {
      const ang = Math.random() * Math.PI * 2, d = 24 + Math.random() * 66;
      const seed = (Math.random() * 4294967296) >>> 0;
      out.push(makeSeedRecord(crypto.randomUUID(), seed, x + Math.cos(ang) * d, y + Math.sin(ang) * d, now, 0.82 + Math.random() * 0.18, 0));
    }
    if (Math.random() < 0.3) {                                // sometimes the rarest gift: a luminous anomaly
      const seed = (Math.random() * 4294967296) >>> 0;
      out.push(makeAnomalyRecord(crypto.randomUUID(), seed, ANOMALY_KINDS[Math.floor(Math.random() * ANOMALY_KINDS.length)], x, y, now));
    }
    return out;
  }

  #spawnAnomaly(parent, now, at, kind) {
    const ang = Math.random() * Math.PI * 2, dist = 30 + Math.random() * 60;
    const x = at ? at.x : parent.x + Math.cos(ang) * dist;
    const y = at ? at.y : parent.y + Math.sin(ang) * dist;
    const seed = (Math.random() * 4294967296) >>> 0;
    const k = (kind && ANOMALY_KINDS.includes(kind)) ? kind : ANOMALY_KINDS[Math.floor(Math.random() * ANOMALY_KINDS.length)];
    return makeAnomalyRecord(crypto.randomUUID(), seed, k, x, y, now);
  }

  #spawnCrystal(now, at) {
    const ang = Math.random() * Math.PI * 2;
    const rr = 0.82 + Math.random() * 0.3;            // at / just past the (elliptical) pool edge
    const x = at ? at.x : POOL.x + Math.cos(ang) * POOL.r * rr;
    const y = at ? at.y : POOL.y + Math.sin(ang) * POOL.r * POND_ASPECT * rr; // squashed to the ellipse
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeCrystalRecord(crypto.randomUUID(), seed, x, y, now);
  }

  // A fish's home sits well INSIDE a pond (≤ FISH_HOME_FRAC of the radius from its
  // centre), so home + its bounded wander never crosses the rim — it stays in the water.
  #spawnFish(now, pond) {
    const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * pond.r * FISH_HOME_FRAC;
    const x = pond.x + Math.cos(ang) * rr, y = pond.y + Math.sin(ang) * rr * POND_ASPECT; // inside the ELLIPSE (squashed y)
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeFishRecord(crypto.randomUUID(), seed, x, y, now);
  }
  // Count current fish by the pond their home sits in (index into POOLS; -1 = none).
  #fishCountByPond() {
    const counts = new Array(POOLS.length).fill(0);
    for (const o of this.objects.values()) {
      if (o.family !== 'fish') continue;
      for (let i = 0; i < POOLS.length; i++) { const p = POOLS[i]; const dx = o.x - p.x, dy = o.y - p.y; if (dx * dx + dy * dy <= p.r * p.r) { counts[i]++; break; } }
    }
    return counts;
  }

  // The nearest LIVE presence within maxR (or null) — drives creature curiosity.
  #nearestPresence(x, y, maxR) {
    let best = null, bd = maxR, now = Date.now();
    for (const p of this.presencePos.values()) {
      if (now - p.ts > PRESENCE_STALE_MS) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  // (the giant — #pondAcross/#giantStep/#buildGiantJobs/#giant* — extracted to
  //  server/systems/giant.js; the DO holds one GiantManager as this.giant.)

  // (creatures — driveLabel/#creatureGoal/#creatureSeparation/#strength/#breed/social/
  //  maintainPopulation/moveHomes/spawnCreature — extracted to server/systems/creatures.js;
  //  the DO holds one CreatureManager as this.creatures. #nearestPresence stays here —
  //  it reads presence state — and is forwarded to the manager via the world facade.)

  async alarm() {
    // A bad tick must NOT freeze the world forever: catch, log, and ALWAYS
    // reschedule so the world keeps breathing (and the error surfaces in logs).
    try { await this.#tick(Date.now()); }
    catch (e) { console.error('tick failed:', (e && e.stack) || String(e)); }
    await this.state.storage.setAlarm(Date.now() + TICK_MS);
  }
}
