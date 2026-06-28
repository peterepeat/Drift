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
import { generateWorld, makeRecord, makeSeedRecord, makeAnomalyRecord, ANOMALY_KINDS, makeCrystalRecord, makeCreatureRecord, CREATURE_KINDS, reseedAction, SEED_VERSION, rng, makeNoise } from './seed.js';
import { FLOW_SEED, FLOW_SCALE, FLOW_REACH } from '../public/flow.js'; // shared with the client visual

const TICK_MS = 60000;
const HOLD_TIMEOUT_MS = 45000;            // reclaim a hold if its connection vanished
const COG_ALPHA = 0.2;                    // centre-of-gravity EMA weight

// ---- growth tuning (per 60s tick) ------------------------------------------
const SPROUT = 0.14;                      // maturity below this is still a seed
const GROW_BASE = 0.0016;                 // maturity/tick unattended (~10h seed->full)
const GROW_WARM = 0.055;                  // extra maturity/tick at heat=1 (~18min warm)
const AGE_RATE = 0.0045;                  // aged/tick once mature (~hours of maturity)
const HEAT_DECAY = 0.80;                  // heat retained per tick when no warmth
const HEAT_GAIN = 0.36;                   // heat added per nearby presence per tick
const HEAT_RADIUS = 240;                  // world units a presence warms
const PRESENCE_STALE_MS = 12000;          // presence older than this stops warming
const SHED_TICKS = 6;                     // a mature plant sheds ~every 6 ticks
const SHED_MAX_AGED = 0.6;                // stop shedding once this aged
const FINAL_SHED = 2;                     // seeds released when a plant dissolves
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
const SEASON_PER_TICK = 4 / 480;          // full 4-season cycle ~8h of ticks (~2h/season)
const GROWTH_MULT = { growing: 1.0, turning: 0.25, resting: 0.0, rising: 0.6 };
const AGE_MULT = { growing: 0.7, turning: 1.4, resting: 0.3, rising: 0.8 };
const lerp = (a, b, t) => a + (b - a) * t;

// ---- anomalies (Family 4): rare, luminous, no lifecycle ---------------------
const MAX_ANOMALIES = 4;                  // the world holds at most a few — seeing one is luck
const ANOMALY_SPAWN_CHANCE = 0.03;        // per tick, when conditions allow
const ANOMALY_SEASONS = { growing: true, rising: true }; // "new creation possible"
const ANOMALY_RADIUS = 200;               // world units an anomaly influences
const ANOMALY_GROW_BOOST = 0.02;          // extra maturity/tick for seeds near an anomaly
const ANOMALY_AGE_SLOW = 0.4;             // aging multiplier near an anomaly (slows decay)

// ---- water & crystals (Family 3) -------------------------------------------
// Water pools in the world's low centre (where objects accumulate). Crystalline
// formations grow at the pool's edge and slowly dissolve in a brief flash.
const POOL = { x: 0, y: 0, r: 350 };      // the world's water pool (world units)
const CRYSTAL_CAP = 10;                    // at most this many crystals at once
const CRYSTAL_SPAWN_CHANCE = 0.05;        // per tick, while under the cap
const CRYSTAL_DECAY = 1 / 300;            // decay/tick (~5h to dissolve) — slow, impermanent

// ---- creatures (Family 5): a few wandering insects -------------------------
// Stored as existence + a HOME (x/y) only; the live position is a deterministic
// wander the clients compute (public/creatures.js), so no position is ticked or
// broadcast — the always-ticking world spends nothing keeping them moving. They
// ramp to a baseline quickly so an arriving world feels inhabited, then top up to
// a cap. Spared from water-drift, isolation-fade and the ceiling trim (they're alive).
const MIN_CREATURES = 50;                 // a livelier world — you should spot several wherever you look
const MAX_CREATURES = 120;
const CREATURE_SPAWN_CHANCE = 0.12;       // per tick, between MIN and MAX (ramps up a touch quicker)
// ---- creatures: social life & population homeostasis (Wave G2) -------------
// Creatures that share a patch interact: same species may MATE (an offspring with a
// blended seed), different species may CLASH (the smaller routs — fleeing far, rarely
// dying). The population stays self-balancing: births are capped at MAX_CREATURES and
// a death never drops a kind below MIN_PER_SPECIES, while the per-species floor in the
// spawn ramp refills any kind that thins — so nothing explodes or goes extinct.
const SOCIAL_R = 80;                      // grid radius for "near enough to interact" (>= MATE/FIGHT dist)
const MATE_DIST = 64;                     // same-species homes this close may breed
const MATE_CHANCE = 0.05;                 // per eligible pair, per tick (gentle — a dense cluster has many pairs)
const FIGHT_DIST = 58;                    // different-species homes this close may clash
const FIGHT_CHANCE = 0.2;                 // per eligible pair, per tick
const DEATH_CHANCE = 0.28;                // a clash that kills the loser (else it just routs)
const FLEE_DIST = 130;                    // how far a routed creature bolts
const MIN_PER_SPECIES = 12;               // a kind never falls below this (no extinction)
const MAX_PER_SPECIES = 60;               // ...nor past this (== MAX_CREATURES/2, so the ceiling ITSELF enforces parity — no kind hogs the cap)
// ---- creatures: goal-seeking drift (Wave G1) -------------------------------
// Each tick a creature steps its HOME toward what it needs — a plant to feed at, the
// pool to drink, a stone to rest by — cycling slowly through those drives (seed-
// desynced so they don't all do the same thing). The step is broadcast and the client
// EASES the home (like water drift), so under the lively wander it reads as a slow,
// purposeful drift rather than a teleport. Authority stays server-side; motion stays
// deterministic + zero per-frame sync. Held creatures are left alone.
const CREATURE_DRIVES = ['feed', 'drink', 'rest', 'roam'];
const CREATURE_STEP = 46;                 // world units the home migrates toward a goal per tick
const CREATURE_SEEK_R = 720;              // how far a creature looks for an attractor
const CREATURE_ARRIVE = 42;               // stop this near the goal (graze/rest beside it, don't pile on)
const CREATURE_DRIVE_TICKS = 5;           // a creature holds one drive ~this many ticks before it shifts

// ---- stones: erosion-to-grit & stacking (Family 1) -------------------------
// Stones don't grow; they erode by handling (each place wears them smoother and
// smaller, client-side from `handling`) and eventually dissolve into grit. They also
// FUSE: drop one onto another and they combine into a single larger stone (area-
// adding); and BREAK: a double-click splits one into smaller stones, until the pieces
// are too small and crumble to grit. A fused/split stone carries a stored radius `r`
// (absent ⇒ the seed-derived base size); the SHAPE is still regenerated from the seed.
const GRIT_HANDLING = 26;                 // handled this many times, a stone is worn to grit and gone
const STACK_STEP = 12;                    // (legacy, unused) world units a stone once rose per stack level
const STACK_TALL = 4;                     // (legacy, unused)
const STACK_MAX = 6;                      // (legacy, unused)
const TOPPLE_CHANCE = 0.12;               // (legacy, unused)
const MAX_STONE_R = 88;                   // a fused stone caps here (world units)
const MIN_STONE_R = 9;                    // break a stone below this and it crumbles to grit instead
// Stone footprint in world units — base size from seed; `o.r` overrides once fused/split.
function stoneRadius(seed) { return 12 + rng(seed >>> 0)() * 34; }      // MUST match the client's seed-derived base
function stoneRadiusOf(o) { return o.r != null ? o.r : stoneRadius(o.seed); }
const MAX_STONE_RADIUS = MAX_STONE_R;     // grid-query radius (a fused stone can be this big)

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
const INTEREST_MARGIN = 1.6;              // send a ring this many viewport half-extents beyond the screen
const PATCH_MAX = 400;                     // cap objects streamed per viewport update (rest follow next tick)

// ---- spatial grid (in-memory; PRD §7.3 — toward a 10k-object world) ---------
// A uniform spatial hash over object positions makes the per-tick / per-message
// neighbour queries (water-flow stone deflection, interest box scans, stack-on-
// place) O(neighbours) instead of O(all objects), so the population can grow
// toward the PRD's 10k without the tick or a viewport report scanning the whole
// world. It is PURELY in-memory: built from this.objects on load, maintained as
// objects move/spawn/vanish, and NEVER persisted (no record field, no storage
// write) — so it costs nothing against the DO rows_written quota. The cell is
// wider than FLOW_STONE_R so a "stones near a point" query spans few cells.
const GRID_CELL = 256;                     // world units per grid cell (> FLOW_STONE_R = 70)

// ---- thermal field & stone formation (PRD §4.1) ----------------------------
// Every area carries a slow, invisible heat value (0..1) that rises where people
// linger and decays over time (season-modulated: Growing lets heat linger,
// Resting bleeds it away). Sustained-warm cells slowly grow STONES (PRD §3/§4.1:
// "form slowly in warm areas" — the maker is long gone before it finishes), and
// the heat GRADIENT bends the water flow toward cooler areas. This field is
// SEPARATE from the per-object `heat` that drives growth (unchanged), and is
// never transmitted — heat is invisible (PRD §4.1).
const HEAT_CELL = 200;                     // world units per heat cell
const FIELD_HALF = 2000;                   // field covers ±this around the origin (20×20 = 400 cells)
const HEAT_MAX = 1.0;                      // per-cell heat ceiling
const HEAT_GAIN_FIELD = 0.5;               // heat a present person adds to their cell per tick
const HEAT_SEASON_DECAY = { growing: 0.99, turning: 0.98, resting: 0.95, rising: 0.985 }; // heat retained/tick
const STONE_HEAT = 0.35;                   // a cell this warm makes progress toward forming a stone
const STONE_FORM_TICKS = 90;               // sustained warm ticks to form one stone (~forms while you're gone)

function seasonBlend(phase) {
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3;
  f = f * f * (3 - 2 * f); // smoothstep
  return { cur: SEASON_KEYS[i], next: SEASON_KEYS[(i + 1) % 4], fade: f };
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
    this.cog = { x: 0, y: 0, n: 0 };
    this.lastSeen = new Map();     // pid -> ts (presence liveness)
    this.presencePos = new Map();  // pid -> { x, y, ts } (drives warmth)
    this.bcastMark = new Map();    // id -> { maturity, aged } last broadcast (chatter control)
    this.driftMark = new Map();    // id -> { x, y } last-broadcast position (water-drift chatter control)
    this.viewports = new Map();    // pid -> { cx, cy, hw, hh } last-reported interest box (in-memory only)
    this.known = new Map();        // pid -> Set(id) objects already sent to this connection (interest streaming)
    this.grid = new Map();         // "cx,cy" -> Set(record): in-memory spatial hash (never persisted)
    this.cellOf = new Map();       // id -> "cx,cy": each object's current grid cell (for move/remove)
    this.dirty = new Set();        // ids whose in-memory state diverged from disk since last #persist (checkpoint flushes these)
    this.objWrites = 0;            // discrete per-object row writes+deletes (NOT the batched checkpoint) — the rows_written lever, exposed for ops/tests
    this.flowNoise = null;         // lazily-built makeNoise(FLOW_SEED); shared with the client visual
    this.heat = null;              // coarse thermal field { w, data[], form[] } (lazy; PRD §4.1)
    this.heatActive = false;       // any heat/formation this tick (skip persisting an inert field)
    this.heatWasActive = false;    // was active last tick (so the field's final settle-to-zero persists once)
    this.lastCheckpoint = 0;       // wall-clock ms of the last full snapshot (persisted; survives eviction)
    this.season = 0;               // monotonic season phase (floor % 4 = current season)
    this.bounds = null;            // {x,y} half-extents of the object field — the client clamps its camera to this (no wandering into the void)
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
    this.season = (await this.state.storage.get('meta:season')) || 0;
    this.heat = (await this.state.storage.get('field:heat')) || null; // rebuilt lazily if absent
    this.lastCheckpoint = (await this.state.storage.get('meta:checkpoint')) || 0;
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
    if (typeof o.stack !== 'number') { o.stack = 0; changed = true; }
    if (typeof o.stackBase !== 'string') { o.stackBase = ''; changed = true; }
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
      this.objects.set(an.id, an); this.#gridAdd(an); await this.#persist(an);
      this.#bcast({ t: 'object_new', o: this.#pub(an) }, null);
      return Response.json({ ok: true, anomaly: { id: an.id, kind: an.kind, x: an.x, y: an.y } });
    }

    // Ops/testing only: spawn one crystal (optionally at ?x=&y=). Gated.
    if (url.pathname === '/admin/crystal') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const px = url.searchParams.get('x'), py = url.searchParams.get('y');
      const at = (px != null && py != null) ? { x: parseFloat(px), y: parseFloat(py) } : null;
      const cr = this.#spawnCrystal(Date.now(), at);
      this.objects.set(cr.id, cr); this.#gridAdd(cr); await this.#persist(cr);
      this.#bcast({ t: 'object_new', o: this.#pub(cr) }, null);
      return Response.json({ ok: true, crystal: { id: cr.id, x: cr.x, y: cr.y } });
    }

    // Ops/testing only: spawn one creature (optionally at ?x=&y=&kind=). Gated.
    if (url.pathname === '/admin/creature') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const px = url.searchParams.get('x'), py = url.searchParams.get('y');
      const at = (px != null && py != null) ? { x: parseFloat(px), y: parseFloat(py) } : null;
      const cr = this.#spawnCreature(Date.now(), at, url.searchParams.get('kind'));
      this.objects.set(cr.id, cr); this.#gridAdd(cr); await this.#persist(cr);
      this.#bcast({ t: 'object_new', o: this.#pub(cr) }, null);
      return Response.json({ ok: true, creature: { id: cr.id, kind: cr.kind, x: cr.x, y: cr.y } });
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
      if (o.family === 'stone') await this.#detachFromStack(o, now); // relocating a stacked stone leaves the stack
      o.x = x; o.y = y; o.stack = 0; o.stackBase = ''; o.last_touched = now;
      this.#gridUpdate(o);
      this.driftMark.delete(o.id);
      await this.#persist(o);
      this.#bcast(this.#stateMsg(o, now), null);
      return Response.json({ ok: true, id: o.id, x: o.x, y: o.y });
    }

    // Ops/testing only: read the heat field at (?x=&y=), or ?set= a cell's heat. Gated.
    if (url.pathname === '/admin/heat') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const x = parseFloat(url.searchParams.get('x') || '0'), y = parseFloat(url.searchParams.get('y') || '0');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Response.json({ ok: false, error: 'bad coords' }, { status: 400 });
      const setv = url.searchParams.get('set');
      if (setv != null && Number.isFinite(parseFloat(setv))) {
        this.#ensureHeat().data[this.#cellIndex(x, y)] = Math.max(0, Math.min(HEAT_MAX, parseFloat(setv)));
        await this.state.storage.put('field:heat', this.heat);
      }
      const g = this.#heatGrad(x, y);
      return Response.json({ ok: true, x, y, heat: this.#heatAt(x, y), gx: g.gx, gy: g.gy });
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

  // Public projection of an object (FORM derived from seed; no visual data).
  #pub(o) {
    const p = {
      id: o.id, family: o.family, x: o.x, y: o.y, seed: o.seed,
      handling: o.handling, held: o.held !== '',
      maturity: o.maturity, aged: o.aged, created_at: o.created_at,
      stack: o.stack || 0, stackBase: o.stackBase || '',
    };
    if (o.kind) p.kind = o.kind; // anomalies + creatures carry their form/kind
    if (o.family === 'creature') p.wanderT0 = o.wanderT0; // the shared wander anchor
    if (o.family === 'stone' && o.r != null) p.r = o.r; // a fused/split stone's stored radius (shape still from seed)
    if (o.held !== '') p.heldBy = o.heldConn; // the holder's EPHEMERAL pid (same id presence carries) — links a carried thing to its carrier; never the token
    return p;
  }
  #stateMsg(o, now) {
    const m = {
      t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling,
      held: o.held !== '', maturity: o.maturity, aged: o.aged,
      stack: o.stack || 0, stackBase: o.stackBase || '', ts: now,
      heldBy: o.held !== '' ? o.heldConn : '', // who's carrying it ('' = nobody) — for the felt-presence tether
    };
    if (o.family === 'creature') m.wanderT0 = o.wanderT0; // re-anchor on the wire so a placed creature continues smoothly for everyone
    if (o.family === 'stone' && o.r != null) m.r = o.r;   // a fused stone broadcasts its grown radius
    return m;
  }
  #worldState(pid, box) {
    const objects = [];
    // Box path uses the spatial grid (cell-aligned superset, re-tightened by
    // #inBox); the box-less full world stays a plain scan (old / test clients).
    const src = box ? this.#gridQueryBox(box) : this.objects.values();
    for (const o of src) { if (box && !this.#inBox(o, box)) continue; objects.push(this.#pub(o)); }
    return { t: 'world_state', now: Date.now(), pid, season: this.season, pool: POOL, cog: { x: this.cog.x, y: this.cog.y }, bounds: this.bounds || this.#computeBounds(), objects };
  }
  // Half-extents of the whole object field (every object, not just the box) — the
  // client clamps its camera here so it can never wander far into empty space. A
  // floor keeps a sparse world from over-constraining the camera. Recomputed each
  // tick (cheap) and on connect; broadcast so the bound tracks the growing world.
  #computeBounds() {
    let bx = 0, by = 0;
    for (const o of this.objects.values()) { const ax = Math.abs(o.x), ay = Math.abs(o.y); if (ax > bx) bx = ax; if (ay > by) by = ay; }
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
    for (const o of this.objects.values()) this.#gridAdd(o);
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
    if (objects.length) this.#send(ws, { t: 'world_patch', objects });
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

  // ---- WebSocket message handling -------------------------------------------
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const pid = ws.deserializeAttachment()?.pid;
    const now = Date.now();

    if (m.t === 'pickup') {
      const o = this.objects.get(m.id);
      if (!o) return;
      if (o.held === '') {
        // Single-threaded DO -> this read-then-write IS the atomic compare-and-set.
        o.held = m.token; o.heldConn = pid; o.held_at = now; o.last_touched = now;
        // Lifting a stone out of a stack: anything resting above it loses its
        // support and scatters; the lifted stone leaves the stack.
        if (o.family === 'stone') await this.#detachFromStack(o, now);
        await this.#persist(o);
        this.#send(ws, { t: 'pickup_ack', id: o.id, ok: true });
        this.#bcast(this.#stateMsg(o, now), ws);
        this.#updateCog(o.x, o.y);
      } else {
        this.#send(ws, { t: 'pickup_ack', id: o.id, ok: false });
        this.#send(ws, this.#stateMsg(o, now));
      }

    } else if (m.t === 'carry') {
      const o = this.objects.get(m.id);
      if (!o || o.held !== m.token) return;
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return; // never store a corrupt position (a NaN serialises to null → 0,0)
      o.x = m.x; o.y = m.y;                    // in-memory only; persisted on place / reclaim
      this.#gridUpdate(o);                      // keep a carried object findable at its current spot
      this.dirty.add(o.id);                     // carried position is unpersisted — let a checkpoint catch a long carry
      this.#bcast(this.#stateMsg(o, now), ws);

    } else if (m.t === 'place') {
      const o = this.objects.get(m.id);
      if (!o) return;
      if (o.held !== m.token) { this.#send(ws, this.#stateMsg(o, now)); return; } // not the holder
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) { o.x = m.x; o.y = m.y; } // corrupt coords → release in place, don't teleport to 0,0
      o.held = ''; o.heldConn = ''; o.held_at = 0;
      o.handling += 1; o.last_touched = now; // a placed object has just been tended
      if (o.family === 'creature') o.wanderT0 = now; // re-anchor: it wanders on a NEW route from where it was set down
      // Disturbing a pre-sprout seed resets its growth — it must be left be to take.
      if (o.family === 'seed' && o.maturity < SPROUT) { o.maturity = 0; o.heat = 0; }
      if (o.family === 'stone') {
        // Worn to grit by too much handling — a brief scatter, then gone (§4.3).
        if (o.handling >= GRIT_HANDLING) {
          this.#gridRemove(o);
          this.objects.delete(o.id); this.bcastMark.delete(o.id); this.driftMark.delete(o.id); this.dirty.delete(o.id);
          await this.state.storage.delete('obj:' + o.id); this.objWrites++;
          this.#bcast({ t: 'object_gone', id: o.id, grit: true }, null);
          return;
        }
        // Dropped onto another stone → FUSE: the target grows, this stone is consumed.
        const fused = this.#tryFuse(o, now);
        if (fused) {
          this.#gridRemove(o);
          this.objects.delete(o.id); this.bcastMark.delete(o.id); this.driftMark.delete(o.id); this.dirty.delete(o.id);
          await this.state.storage.delete('obj:' + o.id); this.objWrites++;
          this.#bcast({ t: 'object_gone', id: o.id, fused: fused.id }, null);
          await this.#persist(fused);
          this.#bcast(this.#stateMsg(fused, now), null);
          this.#updateCog(fused.x, fused.y);
          return;
        }
      }
      this.#gridUpdate(o); // index the final position (after any settle-clear)
      await this.#persist(o);
      this.#bcast(this.#stateMsg(o, now), null);
      this.#updateCog(o.x, o.y);

    } else if (m.t === 'break') {
      // Double-click a stone → split it into smaller stones (or grit if already tiny).
      // No ownership needed (anyone can break a free stone), but not while it's held.
      const o = this.objects.get(m.id);
      if (!o || o.family !== 'stone' || o.held !== '') return;
      const pieces = this.#breakStone(o, now);
      this.#gridRemove(o);
      this.objects.delete(o.id); this.bcastMark.delete(o.id); this.driftMark.delete(o.id); this.dirty.delete(o.id);
      await this.state.storage.delete('obj:' + o.id); this.objWrites++;
      this.#bcast({ t: 'object_gone', id: o.id, grit: true }, null); // a dust puff as it breaks
      for (const c of pieces) {
        this.objects.set(c.id, c); this.#gridAdd(c); await this.#persist(c);
        this.#bcast({ t: 'object_new', o: this.#pub(c) }, null);
      }

    } else if (m.t === 'dissolve') {
      // Only the current holder can dissolve an anomaly (the deliberate 10s hold).
      const o = this.objects.get(m.id);
      if (!o || o.family !== 'anomaly' || o.held !== m.token) return;
      this.#gridRemove(o);
      this.objects.delete(o.id); this.bcastMark.delete(o.id); this.driftMark.delete(o.id); this.dirty.delete(o.id);
      await this.state.storage.delete('obj:' + o.id); this.objWrites++;
      this.#bcast({ t: 'object_gone', id: o.id }, null);

    } else if (m.t === 'scatter') {
      // Tapping a tall stack topples it (no ownership — anyone can knock it down).
      const o = this.objects.get(m.id);
      if (!o || o.family !== 'stone') return;
      await this.#toppleStack(o.stackBase || o.id, now);

    } else if (m.t === 'presence_move') {
      this.lastSeen.set(pid, now);
      this.presencePos.set(pid, { x: m.x, y: m.y, ts: now });
      this.#bcast({ t: 'presence', pid, x: m.x, y: m.y, ts: now }, ws);
      // The same heartbeat carries the viewport: page in any objects now in view.
      if (m.hw > 0 && m.hh > 0) {
        this.viewports.set(pid, { cx: m.x, cy: m.y, hw: m.hw, hh: m.hh });
        this.#streamInterest(ws, pid, this.#boxFrom(m.x, m.y, m.hw, m.hh));
      }
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
    this.#bcast({ t: 'presence_gone', pid }, null);
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
    const changed = [], spawned = [], gone = [];
    const reclaimed = new Set(); // ids in `changed` that are an ownership release ⇒ persist now, don't defer
    // Season modulates how fast life grows and ages this tick.
    const sb = seasonBlend(this.season);
    const gMult = lerp(GROWTH_MULT[sb.cur], GROWTH_MULT[sb.next], sb.fade);
    const aMult = lerp(AGE_MULT[sb.cur], AGE_MULT[sb.next], sb.fade);
    // Thermal field first: it bends the flow (read during drift below) and slowly
    // grows stones in sustained-warm areas.
    for (const s of this.#updateHeat(now, sb)) spawned.push(s);
    const anomalies = [];
    for (const o of this.objects.values()) if (o.family === 'anomaly') anomalies.push(o);
    for (const o of this.objects.values()) {
      if (o.held !== '' && now - o.held_at > HOLD_TIMEOUT_MS) { // missed-close safety net
        o.held = ''; o.heldConn = ''; o.held_at = 0; changed.push(o); reclaimed.add(o.id); // ownership ⇒ persist now
      }
      if (o.held !== '') continue;          // growth paused while held
      if (o.family === 'crystal') {         // crystals slowly dissolve (a brief flash, then gone)
        o.decay = Math.min(1, (o.decay || 0) + CRYSTAL_DECAY);
        if (o.decay >= 1) gone.push(o);
        else this.dirty.add(o.id);          // decay advances with no discrete write — the checkpoint must catch it
        continue;
      }
      if (o.family !== 'seed') continue;    // stones / anomalies have no time-based change here

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
          if (o.shedAccum >= SHED_TICKS && this.objects.size + spawned.length < this.maxObjects) {
            o.shedAccum = 0;
            spawned.push(this.#shed(o, now));
          }
        }
        if (o.aged >= 1) {                  // dissolve: release final seeds, then gone
          for (let k = 0; k < FINAL_SHED && this.objects.size + spawned.length < this.maxObjects; k++) {
            spawned.push(this.#shed(o, now));
          }
          gone.push(o);
        }
      }

      // broadcast only on a meaningful lifecycle move (keeps a quiet world quiet)
      const mark = this.bcastMark.get(o.id) || { maturity: beforeMat, aged: beforeAged };
      const crossedSprout = (beforeMat < SPROUT) !== (o.maturity < SPROUT);
      if (Math.abs(o.maturity - mark.maturity) >= MAT_BCAST_DELTA ||
          Math.abs(o.aged - mark.aged) >= MAT_BCAST_DELTA ||
          crossedSprout) {
        this.bcastMark.set(o.id, { maturity: o.maturity, aged: o.aged });
        // !changed.includes guards against a double-push when a hold also timed out this tick
        if (!gone.includes(o) && !changed.includes(o)) changed.push(o);
      }
      // Sub-threshold lifecycle change (incl. checkpoint-only heat) that no
      // discrete write captured: mark it so the next checkpoint can't lose it.
      if ((o.maturity !== beforeMat || o.aged !== beforeAged || o.heat !== beforeHeat || o.shedAccum !== beforeShed) &&
          !changed.includes(o) && !gone.includes(o)) this.dirty.add(o.id);
    }

    // Water drift: eligible free objects near the pool creep along the flow.
    // Movement is sub-pixel/tick; we mark it dirty (a checkpoint persists the
    // creep) but BROADCAST only once an object has crept POS_BCAST_DELTA —
    // otherwise a pool full of drifters would spam object_state every tick.
    for (const o of this.objects.values()) {
      if (gone.includes(o) || !this.#driftEligible(o) ||
          Math.hypot(o.x - POOL.x, o.y - POOL.y) > POOL.r * FLOW_REACH) {
        // If it drifted some un-broadcast distance before becoming ineligible,
        // flush a final state so clients don't stay stuck up to POS_BCAST_DELTA behind.
        const m0 = this.driftMark.get(o.id);
        if (m0 && (o.x !== m0.x || o.y !== m0.y) && !gone.includes(o) && !changed.includes(o)) changed.push(o);
        this.driftMark.delete(o.id);
        continue;
      }
      const f = this.#flowAt(o.x, o.y, sb);
      o.x += f.vx * FLOW_SPEED; o.y += f.vy * FLOW_SPEED;
      this.#gridUpdate(o);                      // re-index the drifted object (no-op until it crosses a cell)
      this.dirty.add(o.id);                     // the creep is unpersisted until a checkpoint flushes it
      const mark = this.driftMark.get(o.id);
      if (!mark) { this.driftMark.set(o.id, { x: o.x, y: o.y }); continue; }
      if (Math.hypot(o.x - mark.x, o.y - mark.y) >= POS_BCAST_DELTA) {
        this.driftMark.set(o.id, { x: o.x, y: o.y });
        if (!changed.includes(o)) changed.push(o);
      }
    }

    // Isolation (PRD §4.3): derived from last_touched — no per-tick write. Warmth
    // refreshes the clock (in memory; persisted at the next checkpoint); a forgotten
    // free stone crumbles to grit. Anomalies, creatures, held, and stacked (cairn)
    // objects are tended/alive and never fade — and skipping creatures keeps them
    // from being dirtied every tick (their last_touched is never read).
    for (const o of this.objects.values()) {
      if (o.family === 'anomaly' || o.family === 'creature' || o.held !== '' || o.stack > 0) continue;
      if (this.#heatAt(o.x, o.y) > WARM_EPS) { o.last_touched = now; this.dirty.add(o.id); continue; } // refresh is checkpoint-only
      if (o.family === 'stone' && (now - o.last_touched) >= STONE_FADE_MS && !gone.includes(o)) {
        gone.push(o);
      }
    }

    // Ceiling (PRD §7.3): when the world is full, the longest-untouched (smallest
    // last_touched) objects are trimmed back to just under the cap so a packed
    // world keeps breathing. Anomalies and held objects are spared.
    const effective = this.objects.size - gone.length;
    if (effective >= this.maxObjects) {
      const goneSet = new Set(gone.map((o) => o.id)); // O(1) membership at ceiling scale
      const cands = [];
      for (const o of this.objects.values()) {
        if (o.family === 'anomaly' || o.family === 'creature' || o.held !== '' || goneSet.has(o.id)) continue;
        cands.push(o);
      }
      cands.sort((a, b) => a.last_touched - b.last_touched); // longest-untouched first
      const trim = Math.min(cands.length, effective - (this.maxObjects - CEIL_TRIM));
      // A forced eviction is not a natural death — it does NOT release final seeds
      // (that would fight the very trim we're doing); the object just leaves.
      for (let k = 0; k < trim; k++) gone.push(cands[k]);
    }

    // Prune stale presence so the warmth map can't grow unbounded from
    // connections that never closed cleanly.
    for (const [pid, p] of this.presencePos) {
      if (now - p.ts > PRESENCE_STALE_MS + 5000) this.presencePos.delete(pid);
    }

    // Rarely, a mature plant births an anomaly — only in generative seasons,
    // and only while the world holds fewer than a few. Seeing one is luck.
    if (anomalies.length < MAX_ANOMALIES && ANOMALY_SEASONS[sb.cur] &&
        this.objects.size + spawned.length < this.maxObjects && Math.random() < ANOMALY_SPAWN_CHANCE) {
      const matures = [];
      for (const o of this.objects.values()) if (o.family === 'seed' && o.maturity >= 1 && o.aged < 0.5) matures.push(o);
      if (matures.length) spawned.push(this.#spawnAnomaly(matures[Math.floor(Math.random() * matures.length)], now));
    }

    // Crystalline formations grow at the pool's edge, up to a few.
    let crystalCount = 0;
    for (const o of this.objects.values()) if (o.family === 'crystal') crystalCount++;
    if (crystalCount < CRYSTAL_CAP && this.objects.size + spawned.length < this.maxObjects && Math.random() < CRYSTAL_SPAWN_CHANCE) {
      spawned.push(this.#spawnCrystal(now));
    }

    // Creatures: ramp quickly to a baseline so the world feels inhabited, then top
    // up toward the cap. Only existence is written; their motion costs the tick
    // nothing. Gated BELOW the ceiling's breathing room (maxObjects − CEIL_TRIM) so
    // the guaranteed ramp can't keep refilling exactly what the trim just freed (a
    // full world would otherwise oscillate at the cap instead of breathing).
    const creRoom = this.maxObjects - CEIL_TRIM;
    const kindCount = {}; for (const k of CREATURE_KINDS) kindCount[k] = 0;
    let creatureCount = 0;
    for (const o of this.objects.values()) if (o.family === 'creature') { creatureCount++; kindCount[o.kind] = (kindCount[o.kind] || 0) + 1; }
    let creAdded = 0;
    // Per-species floor FIRST: refill any kind that has thinned below its floor, so a
    // run of losses (or lopsided breeding) can never drive a species extinct.
    for (const k of CREATURE_KINDS) {
      while ((kindCount[k] || 0) < MIN_PER_SPECIES && creatureCount + creAdded < MAX_CREATURES && this.objects.size + spawned.length < creRoom) {
        spawned.push(this.#spawnCreature(now, null, k)); kindCount[k]++; creAdded++;
      }
    }
    // Then ramp toward the baseline and (chance-gated) top up toward the cap — each
    // refill is the MINORITY kind, so the world trends toward a balanced mix instead
    // of letting random spawns pile onto whichever species is already ahead.
    const minorityKind = () => CREATURE_KINDS.reduce((a, b) => (kindCount[a] || 0) <= (kindCount[b] || 0) ? a : b);
    while (creatureCount + creAdded < MIN_CREATURES && this.objects.size + spawned.length < creRoom) {
      const k = minorityKind(); spawned.push(this.#spawnCreature(now, null, k)); kindCount[k]++; creAdded++;
    }
    if (creatureCount + creAdded < MAX_CREATURES && this.objects.size + spawned.length < creRoom && Math.random() < CREATURE_SPAWN_CHANCE) {
      const k = minorityKind(); spawned.push(this.#spawnCreature(now, null, k)); kindCount[k]++;
    }

    // Goal-seeking drift (Wave G1): step each free creature's HOME toward what it
    // needs this cycle (a plant / the pool / a stone). Broadcast the new home; the
    // client eases it, so it reads as a slow purposeful drift beneath the wander.
    // Marked dirty via `changed` below — rides the checkpoint, no per-tick write.
    for (const o of this.objects.values()) {
      if (o.family !== 'creature' || o.held !== '') continue;
      const goal = this.#creatureGoal(o);
      if (!goal) continue;
      const dx = goal.x - o.x, dy = goal.y - o.y, d = Math.hypot(dx, dy);
      if (d <= CREATURE_ARRIVE) continue;            // arrived — graze/rest in place (the wander keeps it alive)
      const step = Math.min(CREATURE_STEP, d - CREATURE_ARRIVE);
      o.x += (dx / d) * step; o.y += (dy / d) * step;
      this.#gridUpdate(o);
      if (!changed.includes(o)) changed.push(o);     // broadcast the new home (clients ease it smoothly)
    }

    // Social life (Wave G2): creatures sharing a patch mate (→ spawned) or clash
    // (→ gone, or a routed flee → changed). Self-balancing (cap + per-species floor).
    this.#socialCreatures(now, spawned, gone, changed);

    // Broadcast every threshold-crossing for smooth visuals, but DON'T write per
    // crossing: mark it dirty and let the periodic checkpoint persist it (the
    // broadcast/persist decouple — write rate tracks the checkpoint cadence, not the
    // broadcast rate). A reclaimed hold is the exception: ownership writes now, so a
    // missed-close release can't silently revive after a pre-checkpoint eviction.
    for (const o of changed) {
      if (reclaimed.has(o.id)) await this.#persist(o); else this.dirty.add(o.id);
      this.#bcast(this.#stateMsg(o, now), null);
    }
    for (const o of spawned) { this.objects.set(o.id, o); this.#gridAdd(o); await this.#persist(o); this.#bcast({ t: 'object_new', o: this.#pub(o) }, null); }
    for (const o of gone) {
      this.#gridRemove(o);
      this.objects.delete(o.id); this.bcastMark.delete(o.id); this.driftMark.delete(o.id); this.dirty.delete(o.id);
      await this.state.storage.delete('obj:' + o.id); this.objWrites++;
      this.#bcast({ t: 'object_gone', id: o.id }, null);
    }

    // Tall stacks are unstable: the world topples them on its own, sooner the
    // taller they are. (Height = top level + 1; the base is level 0.)
    const tops = new Map();               // baseId -> highest level in the stack
    for (const o of this.objects.values()) {
      if (o.family !== 'stone') continue;
      const baseId = o.stackBase || o.id; // base has stack 0, so o.stack is the level either way
      tops.set(baseId, Math.max(tops.get(baseId) || 0, o.stack));
    }
    for (const [baseId, top] of tops) {
      const height = top + 1;
      if (height < STACK_TALL) continue;
      if (height > STACK_MAX || Math.random() < TOPPLE_CHANCE * (height - STACK_TALL + 1)) {
        await this.#toppleStack(baseId, now);
      }
    }

    this.season += SEASON_PER_TICK; // advance the world's own season clock (in memory every tick)
    await this.state.storage.put('meta:season', this.season); // one tiny key; cheap
    // Persist the thermal field only when it's live (or just settled to zero) —
    // an idle, all-zero world shouldn't write the field every tick forever.
    if (this.heat && (this.heatActive || this.heatWasActive)) await this.state.storage.put('field:heat', this.heat);
    this.heatWasActive = this.heatActive;

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
    this.bounds = this.#computeBounds(); // refresh the camera bound (the world grows/shrinks)
    this.#bcast({ t: 'season', phase: this.season, bounds: this.bounds }, null); // feel the clock turn + keep the camera bound fresh

    return { spawned: spawned.length, gone: gone.length, checkpointed, checkpointWrote };
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
    let target = null, bestD = Infinity;
    for (const s of this.#gridNear(o.x, o.y, ro + MAX_STONE_R, (s) => s.family === 'stone')) {
      if (s.id === o.id || s.held !== '') continue;
      const d = Math.hypot(s.x - o.x, s.y - o.y);
      if (d < stoneRadiusOf(s) && d < bestD) { bestD = d; target = s; } // dropped onto its footprint → fuse
    }
    if (!target) { this.#settleStoneClear(o); return null; }
    target.r = Math.min(MAX_STONE_R, Math.hypot(ro, stoneRadiusOf(target))); // area-combine
    target.last_touched = now;
    this.#gridUpdate(target);
    return target;
  }
  // Break a stone into smaller pieces (double-click). Splits its radius area-
  // conservingly into 2-3 children with fresh seeds, scattered; a stone already near
  // the floor crumbles to grit instead. Returns the spawned children (for broadcast).
  #breakStone(o, now) {
    const r = stoneRadiusOf(o);
    if (r <= MIN_STONE_R * 1.35) return []; // too small to split — caller grits it
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

  // A stone dropped OVERLAPPING others — but not centred enough to stack — must not
  // pass THROUGH them. Ease it out to just-touching, biased toward the FRONT (down/+y)
  // so it settles against the near side rather than hiding behind. Each pass resolves
  // the deepest overlap; a few passes clear a small cluster. Fully deterministic (no
  // randomness) so every client agrees on where it came to rest.
  #settleStoneClear(o) {
    const ro = stoneRadiusOf(o);
    for (let iter = 0; iter < 10; iter++) {
      let worst = null, worstOver = 1e-3;     // ignore sub-unit grazes
      for (const s of this.#gridNear(o.x, o.y, ro + MAX_STONE_RADIUS, (s) => s.family === 'stone' && s.id !== o.id && s.held === '')) {
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

  // Lifting stone `o` out of its stack: everything resting above it scatters.
  async #detachFromStack(o, now) {
    const baseId = o.stackBase || o.id, lvl = o.stack || 0;
    const base = this.objects.get(baseId);
    const gx = base ? base.x : o.x, gy = base ? base.y : o.y;
    for (const s of this.objects.values()) {
      if (s.id !== o.id && (s.stackBase || '') === baseId && (s.stack || 0) > lvl) {
        await this.#scatterStone(s, gx, gy, now);
      }
    }
    o.stack = 0; o.stackBase = '';
  }

  // Topple a whole stack: base stays put, everything above it scatters around it.
  async #toppleStack(baseId, now) {
    const base = this.objects.get(baseId);
    const gx = base ? base.x : 0, gy = base ? base.y : 0;
    const members = [];
    for (const s of this.objects.values()) if ((s.stackBase || '') === baseId && s.stack > 0) members.push(s);
    for (const s of members) await this.#scatterStone(s, gx, gy, now);
    if (base) { base.stack = 0; base.stackBase = ''; } // base was already level 0; nothing to move
  }

  // Move a stone off a stack to a scattered spot around the stack's ground point.
  async #scatterStone(s, gx, gy, now) {
    const ang = Math.random() * Math.PI * 2, dist = 18 + s.stack * 10 + Math.random() * 28;
    s.x = gx + Math.cos(ang) * dist;
    s.y = gy + Math.sin(ang) * dist;
    this.#gridUpdate(s);
    s.stack = 0; s.stackBase = ''; s.last_touched = now; // a just-scattered stone is freshly disturbed
    await this.#persist(s);
    this.#bcast(this.#stateMsg(s, now), null);
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
    for (const s of this.#gridNear(x, y, FLOW_STONE_R, (s) => s.family === 'stone')) {
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
    if (this.heat) { // water flows toward cooler areas (PRD §4.2) — bend along -∇heat
      const g = this.#heatGrad(x, y);
      vx -= g.gx * FLOW_HEAT; vy -= g.gy * FLOW_HEAT;
    }
    const m = Math.hypot(vx, vy) || 1;
    const mag = lerp(FLOW_SEASON[sb.cur], FLOW_SEASON[sb.next], sb.fade);
    return { vx: (vx / m) * mag, vy: (vy / m) * mag };
  }

  // ---- thermal field ---------------------------------------------------------
  #ensureHeat() {
    if (!this.heat) {
      const w = Math.round((FIELD_HALF * 2) / HEAT_CELL);
      this.heat = { w, data: new Array(w * w).fill(0), form: new Array(w * w).fill(0) };
    }
    return this.heat;
  }
  #cellIndex(x, y) {
    const h = this.#ensureHeat();
    const cx = Math.max(0, Math.min(h.w - 1, Math.floor((x + FIELD_HALF) / HEAT_CELL)));
    const cy = Math.max(0, Math.min(h.w - 1, Math.floor((y + FIELD_HALF) / HEAT_CELL)));
    return cy * h.w + cx;
  }
  #heatAt(x, y) { return this.#ensureHeat().data[this.#cellIndex(x, y)]; }
  // Heat gradient as a raw cell-to-cell difference (range ~[-1,1]); flow bends along -grad.
  #heatGrad(x, y) {
    return { gx: this.#heatAt(x + HEAT_CELL, y) - this.#heatAt(x - HEAT_CELL, y),
             gy: this.#heatAt(x, y + HEAT_CELL) - this.#heatAt(x, y - HEAT_CELL) };
  }
  // One thermal tick: decay every cell (season-modulated), add warmth from live
  // presences, and let sustained-warm cells make progress toward forming a stone.
  // Returns any stones formed this tick (the maker is long gone — PRD §4.1).
  #updateHeat(now, sb) {
    const h = this.#ensureHeat();
    const decay = lerp(HEAT_SEASON_DECAY[sb.cur], HEAT_SEASON_DECAY[sb.next], sb.fade);
    for (let i = 0; i < h.data.length; i++) h.data[i] *= decay;
    const occupied = new Set();
    for (const p of this.presencePos.values()) {
      if (now - p.ts > PRESENCE_STALE_MS) continue;
      const i = this.#cellIndex(p.x, p.y);
      h.data[i] = Math.min(HEAT_MAX, h.data[i] + HEAT_GAIN_FIELD);
      occupied.add(i);
    }
    const formed = [];
    let active = false;
    for (let i = 0; i < h.data.length; i++) {
      // A cell makes progress toward a stone only while warm AND UNATTENDED — the
      // stone finishes after people leave (PRD §4.1: the maker is long gone). The
      // counter is capped at the threshold so warm-while-capped time isn't lost.
      if (h.data[i] >= STONE_HEAT && !occupied.has(i)) {
        h.form[i] = Math.min(STONE_FORM_TICKS, h.form[i] + 1);
        if (h.form[i] >= STONE_FORM_TICKS && this.objects.size + formed.length < this.maxObjects) {
          h.form[i] = 0;
          formed.push(this.#formStone(i, now));
        }
      } else if (h.data[i] < STONE_HEAT && h.form[i] > 0) {
        h.form[i] -= 1; // cooling unwinds the progress
      }
      if (h.data[i] > 0 || h.form[i] > 0) active = true;
    }
    this.heatActive = active; // lets the tick skip persisting a fully-inert field
    return formed;
  }
  #formStone(idx, now) {
    const h = this.heat, cx = idx % h.w, cy = Math.floor(idx / h.w);
    const wx = (cx + 0.5) * HEAT_CELL - FIELD_HALF + (Math.random() * 2 - 1) * HEAT_CELL * 0.4;
    const wy = (cy + 0.5) * HEAT_CELL - FIELD_HALF + (Math.random() * 2 - 1) * HEAT_CELL * 0.4;
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeRecord(crypto.randomUUID(), 'stone', seed, wx, wy, now);
  }

  // What drifts on the water: free, unheld, unstacked things that aren't stones
  // (the channel walls) or anomalies, and aren't pre-sprout seeds (those must be
  // left undisturbed to take root). So mature plants and crystals creep along.
  #driftEligible(o) {
    if (o.held !== '' || o.stack > 0) return false;
    if (o.family === 'stone' || o.family === 'anomaly' || o.family === 'creature') return false; // creatures move themselves
    if (o.family === 'seed' && o.maturity < SPROUT) return false;
    return true;
  }

  #shed(parent, now) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 55 + Math.random() * 105; // shed further out so growth doesn't re-clump the world
    const x = parent.x + Math.cos(ang) * dist;
    const y = parent.y + Math.sin(ang) * dist;
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeSeedRecord(crypto.randomUUID(), seed, x, y, now);
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
    const rr = POOL.r * (0.82 + Math.random() * 0.3); // at / just past the pool edge
    const x = at ? at.x : POOL.x + Math.cos(ang) * rr;
    const y = at ? at.y : POOL.y + Math.sin(ang) * rr;
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeCrystalRecord(crypto.randomUUID(), seed, x, y, now);
  }

  // Born among the living: a creature's home starts near a random plant/seed (or
  // the centre-of-gravity if the world is bare), so they inhabit the vegetated areas.
  #spawnCreature(now, at, kind) {
    const k = (kind && CREATURE_KINDS.includes(kind)) ? kind : CREATURE_KINDS[Math.floor(Math.random() * CREATURE_KINDS.length)];
    let x, y;
    if (at) { x = at.x; y = at.y; }
    else {
      const verdure = [];
      for (const o of this.objects.values()) if (o.family === 'seed') verdure.push(o);
      const base = verdure.length ? verdure[Math.floor(Math.random() * verdure.length)] : { x: this.cog.x, y: this.cog.y };
      const ang = Math.random() * Math.PI * 2, d = Math.random() * 120;
      x = base.x + Math.cos(ang) * d; y = base.y + Math.sin(ang) * d;
    }
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeCreatureRecord(crypto.randomUUID(), seed, k, x, y, now);
  }

  // What a creature is drawn toward THIS tick, or null to just roam. Its drive cycles
  // slowly (feed → drink → rest → roam), seed-desynced so the world isn't in lockstep;
  // the target is the nearest matching thing within reach (grid-local, cheap).
  #creatureDrive(c) {
    const ticks = this.season / SEASON_PER_TICK;     // monotonic tick count (season advances per tick)
    const phase = Math.floor(ticks / CREATURE_DRIVE_TICKS + (c.seed % 1000) / 250);
    return CREATURE_DRIVES[((phase % 4) + 4) % 4];
  }
  #creatureGoal(c) {
    const drive = this.#creatureDrive(c);
    if (drive === 'roam') return null;                // a stretch of free wandering, no pull
    if (drive === 'drink') {                          // head to the nearest point on the pool's rim
      const dx = c.x - POOL.x, dy = c.y - POOL.y, d = Math.hypot(dx, dy) || 1;
      if (d > CREATURE_SEEK_R + POOL.r) return null;  // too far from water to bother this cycle
      return { x: POOL.x + (dx / d) * POOL.r, y: POOL.y + (dy / d) * POOL.r };
    }
    const wantPlant = drive === 'feed';               // feed → a growing plant; rest → a stone
    let best = null, bestD = CREATURE_SEEK_R;
    for (const o of this.#gridNear(c.x, c.y, CREATURE_SEEK_R, (o) => wantPlant ? (o.family === 'seed' && o.maturity >= SPROUT) : o.family === 'stone')) {
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  // A creature's "strength" = its drawn size (mirrors public/creatures.js creatureR):
  // in a clash the smaller one is the loser. Server-only (it decides + broadcasts the
  // outcome), so it needn't be client-reproducible — but matching size keeps the
  // visibly-bigger creature the winner.
  #strength(c) { return (c.kind === 'flier' ? 11 : 14) + rng((c.seed ^ 0x9e37) >>> 0)() * 6; }

  // An offspring of two same-species creatures: home near their midpoint, kind
  // inherited, seed BLENDED (low bits from one parent, high from the other) plus a
  // small mutation — so it reads as related to both, never identical.
  #breed(a, b, now) {
    const mx = (a.x + b.x) / 2 + (Math.random() * 2 - 1) * 22;
    const my = (a.y + b.y) / 2 + (Math.random() * 2 - 1) * 22;
    const mask = 0xffff;
    const seed = ((((a.seed & mask) | (b.seed & ~mask)) >>> 0) ^ Math.floor(Math.random() * 0x10000)) >>> 0;
    return makeCreatureRecord(crypto.randomUUID(), seed, a.kind, mx, my, now);
  }

  // One pass of creature social life. Pairs are found via the grid (cheap at creature
  // scale); home-distance is the "same patch" proxy (their wanders overlap). Mating
  // pushes to `spawned`, a kill to `gone`, a rout (home jumps away) to `changed`.
  // Bounded: births stop at MAX_CREATURES; a kill never drops a kind below its floor
  // or the total below the baseline — so the population churns, never collapses.
  #socialCreatures(now, spawned, gone, changed) {
    const creatures = [], kindCount = {};
    for (const o of this.objects.values()) {
      if (o.family !== 'creature' || o.held !== '') continue;
      creatures.push(o); kindCount[o.kind] = (kindCount[o.kind] || 0) + 1;
    }
    let total = creatures.length;
    let pendingCre = 0; for (const s of spawned) if (s.family === 'creature') pendingCre++; // creature-only pending (floor refills) — NOT shed seeds/crystals/etc., so the mate cap is exact
    const dead = new Set();
    for (const a of creatures) {
      if (dead.has(a.id)) continue;
      let aFled = false;
      for (const b of this.#gridNear(a.x, a.y, SOCIAL_R, (o) => o.family === 'creature' && o.held === '' && o.id > a.id && !dead.has(o.id))) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (a.kind === b.kind) {
          if (d <= MATE_DIST && total + pendingCre < MAX_CREATURES &&  // count only pending CREATURES, not other lifecycle spawns this tick
              (kindCount[a.kind] || 0) < MAX_PER_SPECIES &&   // a kind can't breed past its ceiling — neither species hogs the cap
              this.objects.size + spawned.length < this.maxObjects && Math.random() < MATE_CHANCE) {
            spawned.push(this.#breed(a, b, now)); kindCount[a.kind] = (kindCount[a.kind] || 0) + 1; pendingCre++;
          }
        } else if (d <= FIGHT_DIST && Math.random() < FIGHT_CHANCE) {
          const loser = this.#strength(a) <= this.#strength(b) ? a : b;
          const winner = loser === a ? b : a;
          if (Math.random() < DEATH_CHANCE && (kindCount[loser.kind] || 0) > MIN_PER_SPECIES && total > MIN_CREATURES) {
            dead.add(loser.id); gone.push(loser); kindCount[loser.kind]--; total--;
            if (loser === a) { aFled = true; break; }
          } else {
            const fx = loser.x - winner.x, fy = loser.y - winner.y, fd = Math.hypot(fx, fy) || 1;
            loser.x += (fx / fd) * FLEE_DIST; loser.y += (fy / fd) * FLEE_DIST;
            this.#gridUpdate(loser);
            if (!changed.includes(loser) && !gone.includes(loser)) changed.push(loser);
            if (loser === a) { aFled = true; break; }   // a bolted — stop pairing it this tick
          }
        }
      }
      if (aFled) continue;
    }
  }

  async alarm() {
    // A bad tick must NOT freeze the world forever: catch, log, and ALWAYS
    // reschedule so the world keeps breathing (and the error surfaces in logs).
    try { await this.#tick(Date.now()); }
    catch (e) { console.error('tick failed:', (e && e.stack) || String(e)); }
    await this.state.storage.setAlarm(Date.now() + TICK_MS);
  }
}
