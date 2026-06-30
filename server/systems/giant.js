// ---- the giant: a shared, world-tending NPC (the gardener) -----------------
// TWO journeyer gardeners that walk the world tending its balance — ripen the
// young, thin the over-crowded, fill dug holes, build cairns, break runaway
// boulders, sow life where it's sparse. Their decision logic is a data table
// (#buildGiantJobs, one descriptor per goal.kind) driven by a need÷distance
// score; they coordinate to spread out and circumnavigate ponds.
//
// SEAM (extracted from world-do.js as increment 4.11). Unlike HeatField (which
// RETURNS the stones it forms so the tick's TickContext ledger spawns them), the
// giant TENDS the world IN PLACE: its act() functions mutate existing objects and
// write/broadcast IMMEDIATELY, OUTSIDE the per-tick ledger (this is load-bearing —
// #giantStep runs after the tick commits + checkpoints, and the write-economy test
// suite turns giants OFF precisely because their writes are not ledger-counted). So
// GiantManager keeps writing directly, through a small WORLD FACADE the DO passes
// in (`world.addObject`/`removeObject`/`persist`/`bcast`/… forward to the DO's own
// private methods, so objWrites accounting + broadcast order stay byte-identical).
//   - `world`  : DO-bound state + write methods (objects, grid, add/remove/persist,
//                bcast, stateMsg, tryFuse, breakStone) + the SHARED, DO-owned read-
//                throughs cog/bounds/season/maxObjects (cog has 6 non-giant readers,
//                so it stays DO-owned and the giant just reads it live).
//   - `tune`   : the LIVE-TUNABLE knobs (GIANT_REACH/SIGHT/BREAK_R, SEASON_PER_TICK,
//                STONE_EQ_R/CAP_R) — getters over world-do.js's module `let`s so the
//                operator panel's TUNE_REG closures keep tuning them at runtime.
//   - `pools`  : the static pond list (POOLS), passed once.
// The non-tunable GIANT_* consts live here; the live-tunable ones stay in world-do.js.
import { makeSeedRecord } from '../seed.js';
import { poolContaining as poolContainingIn, bankPoint } from '../../public/shared/geometry.js';
import { stoneRadius } from '../../public/shared/sizing.js';

const GIANT_STEP = 800;                   // world units it covers per tick — the client walks it CONTINUOUSLY along its heading between ticks (no longer looks parked). Brisk (not rushed) so it's always visibly going somewhere
const GIANT_MAX_HOPS = 5;                  // a tick resolves up to this many waypoints before settling — so a giant never burns a whole 60s tick standing still doing nothing
const GIANT_TENDS_PER_TICK = 2;            // it can finish up to this many tending jobs in one tick (2× throughput in a cluster) — half the time per job, while its body animates calmly
const GIANT_STUCK_TICKS = 4;              // no PROGRESS toward the goal this many ticks (e.g. a goal it can only circle) → give up + reroute (enough patience to round a pond first)
const GIANT_AVOID_TICKS = 30;            // after giving up a stuck goal, don't re-pick THAT object for this many ticks — breaks the re-pick-the-same-unreachable-goal oscillation
const GIANT_ROAM = 2600;                  // legacy stroll radius (now it explores the whole world via the bounds — see #giantPickGoal)
const GIANT_YIELD = 0.8;                   // a giant LEAVES a job to its companion if the companion is within this fraction of its own distance to it — so the closer one takes it and the pair spread out (no two-on-one pile-ups)
const GIANT_PERSONAL = 500;                // if the two come within this, the one farther from its own territory peels off home — they keep room between them (no standing on top of each other)
const GIANT_NEED_SCALE = 700;              // distance falloff for need-scoring: a job's pull = need ÷ (1 + dist/this). Higher = distance matters less, so an EGREGIOUS need wins even from across the field
const GIANT_FUSE_R = 78;                  // it presses two stones THIS close together into one (a small, eased nudge — a cairn)
const GIANT_THIN_R = 160;                 // it THINS a plant standing in a patch this crowded (same-family count within this radius)
const GIANT_THIN_N = 12;                  // ...crowded means at least this many neighbours (a patient force against runaway thickets)
const GIANT_SOW_CLEAR = 220;             // it SOWS a seed where there's no plant within this — breeding life back where it's scarce (the other half of balance)
// The gardener's JOBS are a data table (#buildGiantJobs); these two lists fix the
// ORDER pickGoal walks them — PRESSING jobs are need÷distance-scored (order is the
// stable-sort tie-break), IDLE jobs are rotated by g.cycle. Order is behaviour, so
// it's pinned here, not derived from the table's key order.
const GIANT_PRESSING = ['ripen', 'thin', 'fillhole', 'tendstone', 'breakstone'];
const GIANT_IDLE = ['sow', 'drink', 'watch'];

// Stone footprint in world units — base size from seed; `o.r` overrides once fused/split.
const stoneRadiusOf = (o) => (o.r != null ? o.r : stoneRadius(o.seed));

export class GiantManager {
  constructor(world, tune, pools) {
    this.world = world;   // the DO facade (state read-throughs + write methods)
    this.tune = tune;     // live-tunable knobs (getters over world-do.js module lets)
    this.pools = pools;   // the static pond list (POOLS)
    // TWO gardeners — a pair of journeyers tending the world's balance, biased to roam
    // opposite sides so they spread their care. (In-memory; start from the cog on load.)
    this.giants = [
      { x: 0, y: 0, hx: 1, hy: 0, goal: null, bias: { x: 1000, y: 560 } },
      { x: 0, y: 0, hx: -1, hy: 0, goal: null, bias: { x: -1000, y: -560 } },
    ];
    this.giantJobs = this.#buildGiantJobs(); // the gardener's job catalogue (one descriptor per goal.kind)
  }

  // ---- DO-facing API ---------------------------------------------------------
  // Seat the gardeners near the world's heart on load (a little apart, per bias).
  load(cog) { for (const g of this.giants) { g.x = cog.x + g.bias.x * 0.3; g.y = cog.y + g.bias.y * 0.3; } }
  // A friendly tap lets the gardeners amble on (drop their current goal).
  reset() { for (const g of this.giants) { g.goal = null; g.stuck = 0; } }
  // One tick: each gardener strolls a step + tends what it reaches.
  async step(now) { for (const g of this.giants) await this.#giantStep(g, now); }
  // The wire projection embedded in world_state + season broadcasts.
  pub() { return this.giants.map((g) => this.#giantPub(g)); }
  // Ops/testing (/admin/giant): read a gardener, or set its position + clear its goal,
  // or toggle BOTH off. Returns the same JSON payload the route always sent.
  admin({ i, x, y, off }) {
    const idx = Math.max(0, Math.min(this.giants.length - 1, parseInt(i || '0', 10) || 0)); // which gardener (tests can drive either to check spreading)
    const gi = this.giants[idx];
    if (x != null && y != null) { gi.x = parseFloat(x); gi.y = parseFloat(y); gi.goal = null; }
    if (off != null) for (const g of this.giants) g.off = off === '1';                        // off toggles BOTH
    return { giant: { x: gi.x, y: gi.y, goal: gi.goal, off: !!gi.off }, giants: this.giants.map((g) => ({ x: g.x, y: g.y, goal: g.goal ? g.goal.kind : null })) };
  }

  // ---- movement --------------------------------------------------------------
  #pondAcross(x, y, dirX, dirY, s) {
    for (const p of this.pools) {
      const proj = Math.max(0, Math.min(s, (p.x - x) * dirX + (p.y - y) * dirY));
      const cx = x + dirX * proj, cy = y + dirY * proj;
      if (Math.hypot(p.x - cx, p.y - cy) < p.r + this.tune.REACH) return p;
    }
    return null;
  }
  async #giantStep(g, now) {
    if (g.off) return; // disabled (tests that isolate write-economy turn the giants off)
    // A tick ends in exactly one of two states: WALKING toward something (the client
    // glides it there), or doing a beat of visible WORK (mouth dipped to the spot). It
    // never ends "standing still doing nothing": a non-tending waypoint (drink/watch/
    // stroll) is resolved and the giant walks straight on within the same tick, so the
    // pair always reads as busy — and the brisk GIANT_STEP makes that motion quick.
    let tended = 0;
    for (let hop = 0; hop < GIANT_MAX_HOPS; hop++) {
      if (!g.goal || !this.#giantGoalValid(g.goal)) { g.goal = this.#giantPickGoal(g); g.stuck = 0; g.bestDist = Infinity; }
      const dx = g.goal.x - g.x, dy = g.goal.y - g.y, d = Math.hypot(dx, dy) || 1;
      if (d > this.tune.REACH) {
        const s = Math.min(GIANT_STEP, d);
        let dirX = dx / d, dirY = dy / d;
        // If a pond's body lies across the straight path, CIRCUMNAVIGATE — steer along its
        // rim toward the goal (rather than ramming the bank + getting stuck). Catches both
        // stepping-into and stepping-over a pond (segment-vs-circle).
        const block = this.#pondAcross(g.x, g.y, dirX, dirY, s);
        // only route AROUND a pond that's BETWEEN us and the goal — not one the goal sits on
        // (a drink/watch spot at the rim is approached directly; the wade-backstop keeps it dry).
        if (block && Math.hypot(g.goal.x - block.x, g.goal.y - block.y) > block.r + this.tune.REACH * 2) {
          const rx = g.x - block.x, ry = g.y - block.y, rl = Math.hypot(rx, ry) || 1;
          let tx = -ry / rl, ty = rx / rl;                 // a rim tangent...
          if (tx * dirX + ty * dirY < 0) { tx = -tx; ty = -ty; } // ...the way that heads toward the goal
          dirX = tx; dirY = ty;
        }
        let nx = g.x + dirX * s, ny = g.y + dirY * s;
        const wade = poolContainingIn(this.pools, nx, ny);  // backstop: never wade — hug the bank if even the tangent dips in
        if (wade) { const b = bankPoint(wade, nx, ny, 0); nx = b.x; ny = b.y; }
        g.x = nx; g.y = ny; g.hx = dirX; g.hy = dirY; g.walk = 1; g.tending = 0;
        // PROGRESS-based stuck: quit only if it isn't getting CLOSER to the goal (e.g. a goal
        // across/inside a pond it can only circle). Rounding a REACHABLE goal closes the gap,
        // so it won't quit mid-route.
        const after = Math.hypot(g.goal.x - g.x, g.goal.y - g.y);
        if (after < (g.bestDist != null ? g.bestDist : Infinity) - GIANT_STEP * 0.25) { g.bestDist = after; g.stuck = 0; }
        else if (++g.stuck >= GIANT_STUCK_TICKS) { if (!g.avoid) g.avoid = new Map(); if (g.goal.id) g.avoid.set(g.goal.id, this.world.season / this.tune.SEASON_PER_TICK + GIANT_AVOID_TICKS); g.goal = null; g.stuck = 0; g.bestDist = Infinity; } // blacklist the unreachable goal a while so we don't immediately re-pick it
        return; // walking this tick
      }
      // arrived
      const tends = this.giantJobs[g.goal.kind]?.tend;
      await this.#giantAct(g, now); g.goal = null; g.bestDist = Infinity;
      if (tends) {
        if (++tended >= GIANT_TENDS_PER_TICK) { g.walk = 0; g.tending = 1; return; } // worked its quota — a beat of visible work
        // else loop: it may reach + tend ANOTHER nearby job this same tick (2× throughput in a cluster)
      }
      // a non-tending arrival, or room for another tend: loop and walk on
    }
    g.walk = 0; g.tending = tended > 0 ? 1 : 0; // ran out of hops — show work if we tended, else a brief pause
  }

  // ---- the job catalogue -----------------------------------------------------
  // One descriptor per goal.kind, collapsing the three parallel ladders (pickGoal's
  // need-scored finds, goalValid's by-kind re-check, act's by-kind execution) into a
  // single table. Per descriptor:
  //   find(g)   → locate a candidate goal ({kind,id,x,y} or a point {kind,x,y}), or null
  //   need      → urgency weight in pickGoal — a number, or fn(o) when it scales with the
  //               target (a boulder's pull grows with how far past the break threshold)
  //   valid(o)  → re-check an OBJECT goal each hop (find's filter can be stricter, e.g.
  //               ripen's find needs maturity>0.06 but valid only >0.02 — a hysteresis)
  //   act(g,now)→ perform the job on arrival (absent = a pure pause, e.g. drink/watch)
  //   tend      → counts toward GIANT_TENDS_PER_TICK (the 2×-throughput cluster work)
  //   point     → goal validated by POSITION alone (re-checked on arrival, not by id)
  #buildGiantJobs() {
    const removeReached = async (g, now) => { const o = this.world.objects.get(g.goal.id); if (!o || o.held !== '') return; await this.world.removeObject(o); };
    return Object.assign(Object.create(null), {
      ripen: { tend: true, need: 1.0, find: (g) => this.#giantFindRipen(g),
        valid: (o) => o.family === 'seed' && (o.maturity || 0) > 0.02 && (o.maturity || 0) < 1,
        act: async (g, now) => { const o = this.world.objects.get(g.goal.id); if (o && o.family === 'seed' && (o.maturity || 0) < 1) { o.maturity = 1; o.aged = 0; o.heat = 0; o.last_touched = now; await this.world.persist(o); this.world.bcast(this.world.stateMsg(o, now), null); } } },
      thin: { tend: true, need: 3.0, find: (g) => this.#giantFindThin(g),     // a thicket is a real imbalance
        valid: (o) => o.family === 'seed' && this.#giantOvercrowded(o), act: removeReached },
      fillhole: { tend: true, need: 1.4, find: (g) => this.#giantFindFillhole(g),
        valid: (o) => o.family === 'mark', act: removeReached },             // thin a surplus plant or fill a dug hole — either way the thing it reached is gently removed
      tendstone: { tend: true, need: 0.6, find: (g) => this.#giantFindStone(g), // merging pebbles is low-stakes
        valid: (o) => o.family === 'stone' && stoneRadiusOf(o) < this.tune.STONE_EQ_R && !!this.#giantStonePartner(o),
        act: async (g, now) => {
          const o = this.world.objects.get(g.goal.id); if (!o || o.held !== '') return;
          const partner = this.#giantStonePartner(o); if (!partner) return;
          o.x = partner.x; o.y = partner.y; o.last_touched = now; this.world.gridUpdate(o); // nudge the stray onto its partner → fuse into a larger stone
          const fused = this.world.tryFuse(o, now);
          if (fused) { await this.world.removeObject(o, { fused: fused.id }); await this.world.persist(fused); this.world.bcast(this.world.stateMsg(fused, now), null); }
          else { this.world.gridUpdate(o); await this.world.persist(o); this.world.bcast(this.world.stateMsg(o, now), null); }
        } },
      breakstone: { tend: true, need: (o) => 4.5 + ((o ? stoneRadiusOf(o) : this.tune.BREAK_R) - this.tune.BREAK_R) / 9, find: (g) => this.#giantFindBoulder(g), // a big boulder is URGENT — scales steeply with how far past the break threshold
        valid: (o) => o.family === 'stone' && stoneRadiusOf(o) > this.tune.BREAK_R,
        act: async (g, now) => { // EQUILIBRIUM: break a boulder back down into middling pieces (mirrors a hand-break)
          const o = this.world.objects.get(g.goal.id); if (!o || o.held !== '' || o.family !== 'stone' || stoneRadiusOf(o) <= this.tune.BREAK_R) return;
          const pieces = this.world.breakStone(o, now); if (!pieces.length) return;
          await this.world.removeObject(o, { grit: true }); // a soft dust puff, like a hand-break
          for (const c of pieces) await this.world.addObject(c);
        } },
      sow: { tend: true, point: true, find: (g) => this.#giantFindSow(g),
        act: async (g, now) => { // breed life where it's scarce — a young sprout at this still-empty spot
          if (this.world.objects.size < this.world.maxObjects && !poolContainingIn(this.pools, g.x, g.y) && this.#giantSparse(g.x, g.y)) {
            const s = makeSeedRecord(crypto.randomUUID(), (Math.random() * 4294967296) >>> 0, g.x, g.y, now);
            s.maturity = 0.08 + Math.random() * 0.05; // clearly a sprout, not dormant
            await this.world.addObject(s);
          }
        } },
      drink: { point: true, find: (g) => this.#giantFindDrink(g) }, // no act — pause a beat at the water's edge
      watch: { point: true, find: (g) => this.#giantFindWatch(g) }, // no act — pause beside a creature, watching
      stroll: { point: true },                                      // the explore/home fallback — its goal is built inline in pickGoal
    });
  }
  #giantGoalValid(goal) {
    const job = this.giantJobs[goal.kind];
    if (!job) return false;
    if (job.point) return true;                       // point goals (stroll/sow/drink/watch) — re-checked on arrival
    const o = this.world.objects.get(goal.id);
    if (!o || o.held !== '') return false;
    return job.valid(o);
  }
  // A patient force toward balance: it CYCLES its attention so over time it does a variety
  // of work — ripen the young, THIN the over-crowded, FILL dug holes, build cairns —
  // rather than only ever the first thing it sees. (Breeding-where-sparse is handled by
  // the density-throttled shedding; the giant actively reduces the surplus.)
  #giantPickGoal(g) {
    g.cycle = (g.cycle || 0) + 1;
    if (g.avoid) { const t = this.world.season / this.tune.SEASON_PER_TICK; for (const [id, exp] of g.avoid) if (exp <= t) g.avoid.delete(id); } // expire stale avoid entries
    // GIVE EACH OTHER ROOM: when the two crowd the same spot, the one FARTHER from its own
    // territory peels off toward home (the nearer-home one keeps working) — so a co-located
    // pair fans back out instead of standing on top of each other.
    const sib = this.#giantSibling(g);
    if (sib && Math.hypot(sib.x - g.x, sib.y - g.y) < GIANT_PERSONAL) {
      const hx = this.world.cog.x + g.bias.x, hy = this.world.cog.y + g.bias.y;        // my territory centre
      const dHome = Math.hypot(g.x - hx, g.y - hy);
      const dSibHome = Math.hypot(sib.x - (this.world.cog.x + sib.bias.x), sib.y - (this.world.cog.y + sib.bias.y));
      if (dHome >= dSibHome) return { kind: 'stroll', x: hx, y: hy };      // I'm the visitor here → head home, leave this patch to my companion
    }
    // FIRST, pick the most PRESSING tending job — not just the nearest. Each candidate
    // scores by NEED (how egregious the imbalance) ÷ distance, so a big boulder or a packed
    // thicket pulls a gardener from across the field while a lone sapling waits its turn. A
    // little jitter keeps the pair from being robotic / always picking the identical thing.
    // Severity is weighted HARD (≈2× the gentle jobs, per the table's `need`) so a real
    // imbalance pulls a gardener from across the field instead of it puttering on whatever
    // sapling is nearest. (Walk GIANT_PRESSING in order so the score-tie stable-sort is
    // stable; a job whose need scales with its target reads it via need(o).)
    const cands = [];
    for (const kind of GIANT_PRESSING) {
      const job = this.giantJobs[kind];
      const goal = job.find(g);
      if (!goal) continue;
      const need = typeof job.need === 'function' ? job.need(this.world.objects.get(goal.id)) : job.need;
      const d = Math.hypot(goal.x - g.x, goal.y - g.y);
      cands.push({ goal, score: need * (0.85 + Math.random() * 0.3) / (1 + d / GIANT_NEED_SCALE) });
    }
    if (cands.length) { cands.sort((p, q) => q.score - p.score); return cands[0].goal; }
    // THEN, with nothing pressing nearby: sow life into a barren patch, or pause by the
    // water / beside a creature. (So in a dense grove it tends; out in the open it seeds.)
    const rot = (arr) => { const s = g.cycle % arr.length; for (let i = 0; i < arr.length; i++) { const goal = arr[(s + i) % arr.length](); if (goal) return goal; } return null; };
    const idle = rot(GIANT_IDLE.map((kind) => () => this.giantJobs[kind].find(g)));
    if (idle) return idle;
    // truly nothing nearby → EXPLORE the world widely: a random point across the whole bounds,
    // leaning toward this giant's home half (so the pair still favour opposite sides). Wide
    // roaming means far things — a lone monstrous boulder — eventually come into sight + get tended.
    const bx = (this.world.bounds && this.world.bounds.x) || GIANT_ROAM, by = (this.world.bounds && this.world.bounds.y) || GIANT_ROAM;
    const ex = this.world.cog.x + (Math.random() * 2 - 1) * bx, ey = this.world.cog.y + (Math.random() * 2 - 1) * by;
    const hx = this.world.cog.x + g.bias.x, hy = this.world.cog.y + g.bias.y; // its home (its side of the world)
    return { kind: 'stroll', x: ex * 0.6 + hx * 0.4, y: ey * 0.6 + hy * 0.4 }; // 60% explore-anywhere, 40% toward home
  }
  #giantSibling(g) { for (const x of this.giants) if (x !== g && !x.off) return x; return null; }
  // Nearest matching object — but the two gardeners coordinate so they spread out instead
  // of piling onto the same spot: a giant (1) never targets the job its companion has
  // already CLAIMED (its current goal), and (2) YIELDS any job the companion is clearly
  // closer to (comparative distance to where the companion is headed). So the nearer one
  // takes each job and the other drifts off to its own work — more interesting to watch.
  #giantNearest(g, kind, filter, extra) {
    const sib = this.#giantSibling(g);
    const claimed = sib && sib.goal ? sib.goal.id : null;                 // the companion already called this one
    const sx = sib ? (sib.goal ? sib.goal.x : sib.x) : 0;                 // where the companion is headed (its goal, else itself)
    const sy = sib ? (sib.goal ? sib.goal.y : sib.y) : 0;
    let best = null, bd = this.tune.SIGHT;
    for (const o of this.world.gridNear(g.x, g.y, this.tune.SIGHT, filter)) {
      if (o.id === claimed) continue;
      if (g.avoid && g.avoid.get(o.id) > this.world.season / this.tune.SEASON_PER_TICK) continue; // recently gave up on this one (unreachable) — leave it be for a while
      const d = Math.hypot(o.x - g.x, o.y - g.y);
      if (d >= bd) continue;
      if (sib && Math.hypot(o.x - sx, o.y - sy) < d * GIANT_YIELD) continue; // the companion is clearly closer — leave it to them
      if (extra && !extra(o)) continue;
      bd = d; best = o;
    }
    return best ? { kind, id: best.id, x: best.x, y: best.y } : null;
  }
  #giantFindRipen(g) { return this.#giantNearest(g, 'ripen', (o) => o.family === 'seed' && o.held === '' && (o.maturity || 0) > 0.06 && (o.maturity || 0) < 1); }
  #giantFindThin(g) { return this.#giantNearest(g, 'thin', (o) => o.family === 'seed' && o.held === '', (o) => this.#giantOvercrowded(o)); }
  #giantFindFillhole(g) { return this.#giantNearest(g, 'fillhole', (o) => o.family === 'mark'); }
  // EQUILIBRIUM (stones, the merge half): nudge a PEBBLE onto a nearby pebble so two
  // tiny stones become one middling one — never fusing decent stones into a boulder.
  #giantFindStone(g) { return this.#giantNearest(g, 'tendstone', (o) => o.family === 'stone' && o.held === '' && stoneRadiusOf(o) < this.tune.STONE_EQ_R, (o) => !!this.#giantStonePartner(o)); }
  // EQUILIBRIUM (stones, the break half): find a BOULDER (grown past the cap — e.g. a
  // legacy uncapped pile) and break it back down toward the middle.
  #giantFindBoulder(g) { return this.#giantNearest(g, 'breakstone', (o) => o.family === 'stone' && o.held === '' && stoneRadiusOf(o) > this.tune.BREAK_R); }
  // SOW: breed life back where it's scarce — find a nearby SPARSE spot (no plant within
  // GIANT_SOW_CLEAR) and seed it. With THIN (cull the dense), this is the giant moving
  // life from where there's too much to where there's too little — a sway toward balance.
  #giantFindSow(g) {
    if (this.world.objects.size >= this.world.maxObjects - 50) return null;        // don't sow into a full world
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2, r = 220 + Math.random() * (this.tune.SIGHT - 220);
      const x = g.x + Math.cos(a) * r, y = g.y + Math.sin(a) * r;
      if (!poolContainingIn(this.pools, x, y) && this.#giantSparse(x, y)) return { kind: 'sow', x, y };
    }
    return null;
  }
  #giantSparse(x, y) { for (const o of this.world.gridNear(x, y, GIANT_SOW_CLEAR, (o) => o.family === 'seed')) { if (Math.hypot(o.x - x, o.y - y) <= GIANT_SOW_CLEAR) return false; } return true; }
  // DRINK: amble to the rim of the nearest pond and pause there (a beat at the water's edge).
  #giantFindDrink(g) {
    let best = null, bd = this.tune.SIGHT;
    for (const p of this.pools) { const e = Math.hypot(g.x - p.x, g.y - p.y) - p.r; if (e < bd) { bd = e; best = p; } }
    if (!best) return null;
    const dx = g.x - best.x, dy = g.y - best.y, dd = Math.hypot(dx, dy) || 1;
    return { kind: 'drink', x: best.x + (dx / dd) * (best.r + 30), y: best.y + (dy / dd) * (best.r + 30) }; // just off the rim, on land
  }
  // WATCH: stand a little way off from a creature and watch it a beat (the giant, curious).
  #giantFindWatch(g) {
    const c = this.#giantNearest(g, 'watch', (o) => o.family === 'creature' && o.held === '');
    if (!c) return null;
    const dx = g.x - c.x, dy = g.y - c.y, dd = Math.hypot(dx, dy) || 1;
    return { kind: 'watch', x: c.x + (dx / dd) * 70, y: c.y + (dy / dd) * 70 };
  }
  // Is this plant standing in an over-crowded patch (≥ GIANT_THIN_N same-family neighbours)?
  #giantOvercrowded(o) {
    let n = 0; const r2 = GIANT_THIN_R * GIANT_THIN_R;
    for (const s of this.world.gridNear(o.x, o.y, GIANT_THIN_R, (s) => s.family === 'seed')) {
      if (s.id === o.id) continue;
      const dx = s.x - o.x, dy = s.y - o.y;
      if (dx * dx + dy * dy <= r2 && ++n >= GIANT_THIN_N) return true;
    }
    return false;
  }
  #giantStonePartner(stone) { // another small free stone within fuse-gather range (pebble + pebble → one middling stone, never a boulder)
    const rs = stoneRadiusOf(stone);
    for (const o of this.world.gridNear(stone.x, stone.y, GIANT_FUSE_R, (o) => o.family === 'stone' && o.held === '')) {
      if (o.id === stone.id || stoneRadiusOf(o) >= this.tune.STONE_EQ_R) continue; // only merge two pebbles
      if (Math.hypot(o.x - stone.x, o.y - stone.y) <= GIANT_FUSE_R && Math.hypot(rs, stoneRadiusOf(o)) <= this.tune.STONE_CAP_R) return o;
    }
    return null;
  }
  async #giantAct(g, now) {
    const job = this.giantJobs[g.goal.kind];
    // drink/watch/stroll have no act — the giant simply pauses a beat (walk=0); the visual
    // is the journeyer at the water's edge / standing beside a creature, watching.
    if (job && job.act) await job.act(g, now);
  }
  #giantPub(g) { return { x: g.x, y: g.y, hx: g.hx, hy: g.hy, walk: g.walk || 0, tending: g.tending || 0, act: g.goal ? g.goal.kind : 'roam', stuck: g.stuck || 0 }; }
}
