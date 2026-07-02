// ---- creatures (crawler/flier): drives, social life, population --------------
// Server-authoritative HOMES that ease toward goals (feed/drink/rest/roam, by a
// seed-desynced cycle + a seeded per-(creature,target) affinity so the crowd
// spreads), with anti-crowd separation, curiosity toward presence, and a tamed
// (befriended) creature following its person. Social life mates (→ spawn) or
// clashes (→ kill/rout) within per-species floor+ceiling caps. The deterministic
// shared-clock WANDER is client-side (zero per-frame sync); the server only moves
// the home + decides births/deaths on the tick.
//
// SEAM (extracted from world-do.js as increment 4.12). Like the giant, creatures
// MUTATE + spawn + remove — but they run INSIDE #tick, so the spawn/social/move
// passes take the per-tick TickContext (ctx.spawn/remove/change) and the DO's #tick
// calls them at the same points (so write-economy + RNG order stay byte-identical).
// They reach the rest of the world through the shared WORLD FACADE + `tune` getter
// port (the same the giant uses): read-throughs (objects/cog/season/maxObjects/
// SPROUT) + forwarders (gridNear/gridNearest/gridUpdate/nearestPresence — the last
// stays DO-side since it reads presence state). The live-tunable knobs (CREATURE_STEP
// /SEEK_R/PREF_SPREAD, SEASON_PER_TICK) are read at call time via the tune port; the
// non-tunable CREATURE_* consts live here. Befriend (the wire handler) + the anomaly
// tame/glow + the fish stay in the DO; creatures just READ o.tameUntil (record state).
import { makeCreatureRecord, CREATURE_KINDS, rng } from '../seed.js';
import { bankPoint } from '../../public/shared/geometry.js';

const MIN_CREATURES = 50;                 // a livelier world — you should spot several wherever you look
const MAX_CREATURES = 120;
const CREATURE_SPAWN_CHANCE = 0.12;       // per tick, between MIN and MAX (ramps up a touch quicker)
const SOCIAL_R = 80;                      // grid radius for "near enough to interact" (>= MATE/FIGHT dist)
const MATE_DIST = 64;                     // same-species homes this close may breed
const MATE_CHANCE = 0.05;                 // per eligible pair, per tick (gentle — a dense cluster has many pairs)
const FIGHT_DIST = 58;                    // different-species homes this close may clash
const FIGHT_CHANCE = 0.2;                 // per eligible pair, per tick
const DEATH_CHANCE = 0.28;                // a clash that kills the loser (else it just routs)
const FLEE_DIST = 130;                    // how far a routed creature bolts
const MIN_PER_SPECIES = 12;               // a kind never falls below this (no extinction)
const MAX_PER_SPECIES = 60;               // ...nor past this (== MAX_CREATURES/2, so the ceiling ITSELF enforces parity — no kind hogs the cap)
const CREATURE_DRIVES = ['feed', 'drink', 'rest', 'roam'];
const CREATURE_ARRIVE = 42;               // stop this near the goal (graze/rest beside it, don't pile on)
const CREATURE_DRIVE_TICKS = 5;           // a creature holds one drive ~this many ticks before it shifts
const CREATURE_SEP_R = 46;                // creature homes closer than this push apart
const CREATURE_SEP_STEP = 24;             // max world units the anti-crowd push moves a home per tick
const CURIOSITY_R = 760;                  // a creature this near a presence may amble over (during its roam phase)
const CURIOSITY_STANDOFF = 95;            // it stops this far off (curious, not crowding — the wander + anti-crowd keep it loose)
const CREATURE_FOLLOW_R = 1500;           // a bonded creature follows a person within this (beyond it, it just stays put + lives — no snap)
const CREATURE_FOLLOW_STANDOFF = 70;      // ...and settles this close to its person
const CREATURE_FOLLOW_STEP = 130;         // home units it closes toward its person per tick (≈3× a normal drive step — keeps up, but at its own pace, not glued)
const ANOMALY_STANDOFF = 130;             // a roaming creature drawn to a wonder rings it this far off (inside its ~200u halo, not piled on its centre) — anomalies become felt hubs where life gathers (idea #4)
const GRAZE_CHANCE = 0.5;                 // per-tick chance a FED creature (arrived at its plant) shows a visible nibble — seeded per (creature,tick), NOT global RNG (keeps the tick's RNG stream byte-identical)
const GRAZE_CUES_MAX = 24;                // cap graze cues per tick (bounds the wire chatter — the effect stays calm/legible, never a flood)
const WARM_SEEK_EPS = 0.06;               // a neighbouring cell must be at least this much warmer than HERE for a roaming creature to drift toward it (below → the field is flat/noise → free wander). Makes the warmth people LEAVE visibly gather life.
const WARM_SEEK_DIST = 320;               // how far toward the warmth the goal sits (well past ARRIVE so the home actually steps toward it, easing into the warm patch over ticks)
// sample points ~1-2 heat cells (200u) out in 8 directions — a creature senses warmth a few cells away,
// not just the immediate gradient, so it pools toward a warm spot from a legible distance.
const WARM_OFFSETS = [[300, 0], [-300, 0], [0, 300], [0, -300], [212, 212], [-212, 212], [212, -212], [-212, -212]];

export class CreatureManager {
  constructor(world, tune, pools) {
    this.world = world;   // shared DO facade (state read-throughs + grid forwarders)
    this.tune = tune;     // live-tunable knobs (getters over world-do.js module lets)
    this.pools = pools;   // the static pond list (POOLS) — drink goals
  }

  // ---- projection ------------------------------------------------------------
  // What a creature is drawn toward THIS tick, or null to just roam. Its drive cycles
  // slowly (feed → drink → rest → roam), seed-desynced so the world isn't in lockstep.
  driveLabel(c) {
    const ticks = this.world.season / this.tune.SEASON_PER_TICK;     // monotonic tick count (season advances per tick)
    const phase = Math.floor(ticks / CREATURE_DRIVE_TICKS + (c.seed % 1000) / 250);
    return CREATURE_DRIVES[((phase % 4) + 4) % 4];
  }

  // ---- spawning --------------------------------------------------------------
  // Born among the living: a creature's home starts near a random plant/seed (or
  // the centre-of-gravity if the world is bare), so they inhabit the vegetated areas.
  spawnCreature(now, at, kind) {
    const k = (kind && CREATURE_KINDS.includes(kind)) ? kind : CREATURE_KINDS[Math.floor(Math.random() * CREATURE_KINDS.length)];
    let x, y;
    if (at) { x = at.x; y = at.y; }
    else {
      const verdure = [];
      for (const o of this.world.objects.values()) if (o.family === 'seed') verdure.push(o);
      const base = verdure.length ? verdure[Math.floor(Math.random() * verdure.length)] : { x: this.world.cog.x, y: this.world.cog.y };
      const ang = Math.random() * Math.PI * 2, d = Math.random() * 120;
      x = base.x + Math.cos(ang) * d; y = base.y + Math.sin(ang) * d;
    }
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeCreatureRecord(crypto.randomUUID(), seed, k, x, y, now);
  }

  // Per-species floor FIRST (a run of losses can never drive a kind extinct), then
  // ramp toward the baseline + a chance-gated top-up toward the cap — each refill is
  // the MINORITY kind, so the world trends toward a balanced mix. `creRoom` (the
  // ceiling's breathing room, maxObjects − CEIL_TRIM) is passed by the tick (shared
  // with the fish refill); spawns ride the ledger via ctx.spawn.
  maintainPopulation(now, ctx, creRoom) {
    const kindCount = {}; for (const k of CREATURE_KINDS) kindCount[k] = 0;
    let creatureCount = 0;
    for (const o of this.world.objects.values()) if (o.family === 'creature') { creatureCount++; kindCount[o.kind] = (kindCount[o.kind] || 0) + 1; }
    let creAdded = 0;
    for (const k of CREATURE_KINDS) {
      while ((kindCount[k] || 0) < MIN_PER_SPECIES && creatureCount + creAdded < MAX_CREATURES && this.world.objects.size + ctx.spawned.length < creRoom) {
        ctx.spawn(this.spawnCreature(now, null, k)); kindCount[k]++; creAdded++;
      }
    }
    const minorityKind = () => CREATURE_KINDS.reduce((a, b) => (kindCount[a] || 0) <= (kindCount[b] || 0) ? a : b);
    while (creatureCount + creAdded < MIN_CREATURES && this.world.objects.size + ctx.spawned.length < creRoom) {
      const k = minorityKind(); ctx.spawn(this.spawnCreature(now, null, k)); kindCount[k]++; creAdded++;
    }
    if (creatureCount + creAdded < MAX_CREATURES && this.world.objects.size + ctx.spawned.length < creRoom && Math.random() < CREATURE_SPAWN_CHANCE) {
      const k = minorityKind(); ctx.spawn(this.spawnCreature(now, null, k)); kindCount[k]++;
    }
  }

  // ---- per-tick movement -----------------------------------------------------
  // Goal-seeking drift (Wave G1): step each free creature's HOME toward what it needs
  // this cycle (a plant / the pool / a stone). Broadcast the new home (ctx.change); the
  // client eases it, so it reads as a slow purposeful drift beneath the wander.
  moveHomes(ctx) {
    let grazeBudget = GRAZE_CUES_MAX;                          // per-tick graze-cue cap (bounds the wire)
    const tickInt = Math.floor(this.world.season / this.tune.SEASON_PER_TICK); // for a per-(creature,tick) seeded graze roll
    for (const o of this.world.objects.values()) {
      if (o.family !== 'creature' || o.held !== '') continue;
      let mx = 0, my = 0;
      const goal = this.#creatureGoal(o);
      const bonded = o.tameUntil && o.tameUntil > Date.now();
      if (goal) {                                    // step toward what it needs this cycle (a bonded creature follows FASTER, to keep up with you)
        const dx = goal.x - o.x, dy = goal.y - o.y, d = Math.hypot(dx, dy);
        if (d > CREATURE_ARRIVE) { const step = Math.min(bonded ? CREATURE_FOLLOW_STEP : this.tune.STEP, d - CREATURE_ARRIVE); mx += (dx / d) * step; my += (dy / d) * step; }
        else if (!bonded && grazeBudget > 0 && this.driveLabel(o) === 'feed' && rng(((o.seed ^ tickInt) >>> 0) || 1)() < GRAZE_CHANCE) {
          this.world.grazeCue(goal.x, goal.y); grazeBudget--; // arrived at its plant + feeding → a visible nibble at the plant (seeded, bounded, zero-write)
        }
      }
      const sep = this.#creatureSeparation(o);        // ALWAYS shove off the crowd (even while grazing) — no pile-ups
      if (sep.x || sep.y) { const sl = Math.hypot(sep.x, sep.y); const push = Math.min(CREATURE_SEP_STEP, sl * CREATURE_SEP_STEP); mx += (sep.x / sl) * push; my += (sep.y / sl) * push; }
      if (!mx && !my) continue;                       // settled — the wander keeps it alive in place
      o.x += mx; o.y += my;
      this.world.gridUpdate(o);
      ctx.change(o);     // broadcast the new home (clients ease it smoothly)
    }
  }

  // A push off every too-close creature home (summed, falls to zero at CREATURE_SEP_R) —
  // the anti-crowd force that keeps the population a living scatter, never a dense blob.
  #creatureSeparation(c) {
    let px = 0, py = 0;
    for (const o of this.world.gridNear(c.x, c.y, CREATURE_SEP_R, (o) => o.family === 'creature' && o.held === '')) {
      if (o.id === c.id) continue;
      const dx = c.x - o.x, dy = c.y - o.y, d = Math.hypot(dx, dy);
      if (d >= CREATURE_SEP_R) continue;
      let ux, uy;
      if (d > 0.01) { ux = dx / d; uy = dy / d; }
      else { // exactly coincident → split along a deterministic axis, OPPOSITE for the two
        const a = rng(((c.seed ^ o.seed) >>> 0) || 1)() * Math.PI * 2, s = c.id < o.id ? 1 : -1;
        ux = Math.cos(a) * s; uy = Math.sin(a) * s;
      }
      const w = (CREATURE_SEP_R - Math.max(d, 0.01)) / CREATURE_SEP_R;
      px += ux * w; py += uy * w;
    }
    return { x: px, y: py };
  }
  #creatureGoal(c) {
    // BONDED: a befriended (tamed) creature follows its person — its home drifts toward the
    // nearest presence within range, overriding its ordinary drives while you're around, and
    // resuming normal life when you leave (or the bond lapses). The drift loop steps a bonded
    // creature by the larger CREATURE_FOLLOW_STEP so it actually keeps up, at its own pace.
    if (c.tameUntil && c.tameUntil > Date.now()) {
      const fp = this.world.nearestPresence(c.x, c.y, CREATURE_FOLLOW_R);
      if (fp) { const dx = c.x - fp.x, dy = c.y - fp.y, d = Math.hypot(dx, dy) || 1; return { x: fp.x + (dx / d) * CREATURE_FOLLOW_STANDOFF, y: fp.y + (dy / d) * CREATURE_FOLLOW_STANDOFF }; }
    }
    const drive = this.driveLabel(c);
    if (drive === 'roam') {                            // a free-wander phase — but if someone is lingering nearby, amble over to them
      const p = this.world.nearestPresence(c.x, c.y, CURIOSITY_R);
      if (p) { const dx = c.x - p.x, dy = c.y - p.y, d = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / d) * CURIOSITY_STANDOFF, y: p.y + (dy / d) * CURIOSITY_STANDOFF }; } // mill a little way off, curious
      // a nearby WONDER draws roaming life toward it — anomalies become felt hubs where creatures gather
      // (idea #4). Anomalies are rare (≤4 world-wide), so this is a gentle, occasional pull, not a stampede.
      const an = this.world.gridNearest(c.x, c.y, this.tune.SEEK_R, (a) => a.family === 'anomaly' && a.held === '');
      if (an) { const dx = c.x - an.x, dy = c.y - an.y, d = Math.hypot(dx, dy) || 1; return { x: an.x + (dx / d) * ANOMALY_STANDOFF, y: an.y + (dy / d) * ANOMALY_STANDOFF }; }
      // no one lingering in sight → drift toward the WARMTH people have left (the heat field decays
      // over ~an hour, so life visibly gathers at tended spots even after you leave) — idea #1.
      const here = this.world.heatAt(c.x, c.y); let bh = here + WARM_SEEK_EPS, bx = 0, by = 0;
      for (const [ox, oy] of WARM_OFFSETS) { const h = this.world.heatAt(c.x + ox, c.y + oy); if (h > bh) { bh = h; bx = ox; by = oy; } }
      if (bx || by) { const d = Math.hypot(bx, by); return { x: c.x + (bx / d) * WARM_SEEK_DIST, y: c.y + (by / d) * WARM_SEEK_DIST }; } // head toward the warmest nearby cell
      return null;                                     // cold everywhere near → truly free wander
    }
    if (drive === 'drink') {                          // head to the nearest point on the NEAREST pond's rim
      let p = null, pd = Infinity;                    // (was hardcoded to the central POOL — so every thirsty bug in a huge radius streamed to 0,0)
      for (const q of this.pools) { const e = Math.hypot(c.x - q.x, c.y - q.y) - q.r; if (e < pd) { pd = e; p = q; } }
      if (!p || pd > this.tune.SEEK_R) return null;   // too far from any water to bother this cycle
      return bankPoint(p, c.x, c.y, c.seed);          // the (elliptical) water's edge nearest the creature
    }
    const wantPlant = drive === 'feed';               // feed → a growing plant; rest → a stone
    // Pick by SEEDED preference, not raw distance: each (creature,target) pair has a stable
    // affinity in [0,1), so two creatures near the same tree usually favour DIFFERENT nearby
    // trees and the crowd spreads across the grove. A lone creature still usually takes the
    // nearest; the affinity only tips the balance among trees within ~CREATURE_PREF_SPREAD.
    const best = this.world.gridNearest(c.x, c.y, this.tune.SEEK_R,
      (o) => wantPlant ? (o.family === 'seed' && o.maturity >= this.world.SPROUT) : o.family === 'stone',
      (o, d) => d - rng((Math.imul(c.seed >>> 0, 2654435761) ^ (o.seed >>> 0)) >>> 0)() * this.tune.PREF_SPREAD); // stable per (creature,target) affinity nudge
    return best ? { x: best.x, y: best.y } : null;
  }

  // ---- social life -----------------------------------------------------------
  // A creature's "strength" = its drawn size (mirrors public/creatures.js creatureR):
  // in a clash the smaller one is the loser. Server-only (it decides + broadcasts the
  // outcome), so it needn't be client-reproducible — but matching size keeps the
  // visibly-bigger creature the winner.
  #strength(c) { return (c.kind === 'flier' ? 11 : 14) + rng((c.seed ^ 0x9e37) >>> 0)() * 6; }

  // An offspring of two same-species creatures: home near their midpoint, kind
  // inherited, seed BLENDED (low bits from one parent, high from the other) plus a
  // small mutation — so it reads as related to both, never identical.
  #breed(a, b, now) {
    // spawn the offspring with ROOM (a random direction, well clear of the parents) so a
    // new birth doesn't instantly pile onto them — the anti-crowd force then keeps it loose.
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 70;
    const mx = (a.x + b.x) / 2 + Math.cos(ang) * dist;
    const my = (a.y + b.y) / 2 + Math.sin(ang) * dist;
    const mask = 0xffff;
    const seed = ((((a.seed & mask) | (b.seed & ~mask)) >>> 0) ^ Math.floor(Math.random() * 0x10000)) >>> 0;
    return makeCreatureRecord(crypto.randomUUID(), seed, a.kind, mx, my, now);
  }

  // One pass of creature social life. Pairs are found via the grid (cheap at creature
  // scale); home-distance is the "same patch" proxy (their wanders overlap). Mating
  // pushes to `spawned`, a kill to `gone`, a rout (home jumps away) to `changed`.
  // Bounded: births stop at MAX_CREATURES; a kill never drops a kind below its floor
  // or the total below the baseline — so the population churns, never collapses.
  social(now, ctx) {
    const creatures = [], kindCount = {};
    for (const o of this.world.objects.values()) {
      if (o.family !== 'creature' || o.held !== '') continue;
      creatures.push(o); kindCount[o.kind] = (kindCount[o.kind] || 0) + 1;
    }
    let total = creatures.length;
    let pendingCre = 0; for (const s of ctx.spawned) if (s.family === 'creature') pendingCre++; // creature-only pending (floor refills) — NOT shed seeds/crystals/etc., so the mate cap is exact
    const dead = new Set();
    for (const a of creatures) {
      if (dead.has(a.id)) continue;
      let aFled = false;
      for (const b of this.world.gridNear(a.x, a.y, SOCIAL_R, (o) => o.family === 'creature' && o.held === '' && o.id > a.id && !dead.has(o.id))) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (a.kind === b.kind) {
          if (d <= MATE_DIST && total + pendingCre < MAX_CREATURES &&  // count only pending CREATURES, not other lifecycle spawns this tick
              (kindCount[a.kind] || 0) < MAX_PER_SPECIES &&   // a kind can't breed past its ceiling — neither species hogs the cap
              this.world.objects.size + ctx.spawned.length < this.world.maxObjects && Math.random() < MATE_CHANCE) {
            ctx.spawn(this.#breed(a, b, now)); kindCount[a.kind] = (kindCount[a.kind] || 0) + 1; pendingCre++;
          }
        } else if (d <= FIGHT_DIST && Math.random() < FIGHT_CHANCE) {
          const loser = this.#strength(a) <= this.#strength(b) ? a : b;
          const winner = loser === a ? b : a;
          if (Math.random() < DEATH_CHANCE && (kindCount[loser.kind] || 0) > MIN_PER_SPECIES && total > MIN_CREATURES) {
            dead.add(loser.id); ctx.remove(loser); kindCount[loser.kind]--; total--;
            if (loser === a) { aFled = true; break; }
          } else {
            const fx = loser.x - winner.x, fy = loser.y - winner.y, fd = Math.hypot(fx, fy) || 1;
            loser.x += (fx / fd) * FLEE_DIST; loser.y += (fy / fd) * FLEE_DIST;
            this.world.gridUpdate(loser);
            if (!ctx.isGone(loser)) ctx.change(loser);
            if (loser === a) { aFled = true; break; }   // a bolted — stop pairing it this tick
          }
        }
      }
      if (aFled) continue;
    }
  }
}
