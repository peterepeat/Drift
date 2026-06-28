// =============================================================================
// DRIFT — deterministic world generation (the ~200-object pre-seed).
// Shared by the Durable Object (self-seeds an empty world) and the operator
// script. Pure: no DOM, no platform APIs. Uses only rng() from the lifted
// procgen module so a given WORLD_SEED always rebuilds the identical world.
// =============================================================================
import { rng, makeNoise } from '../public/drift-procgen.js';
export { rng, makeNoise }; // re-exported so the DO shares the client's EXACT primitives
// (rng -> identical stone footprints; makeNoise -> identical water flow field)

const WORLD_SEED = 0x44524946;   // 'DRIF'
// The world seeds wider, fuller, and SIZE-AWARE (was a denser 900 with uniform
// spacing, where big trees and boulders crowded each other). Objects gather into
// GROVES scattered across a wide area with open clearings between, plus a few loners
// in the open — so arrival feels spacious and inhabited, not a clump in a void. The
// relaxation now spaces by each object's FOOTPRINT, so the biggest plants and stones
// get real room while seeds still pack close. Grows toward the 10k cap over time.
const N = 1700;                  // arrival population — eased down so clusters breathe (was 2000); grows over time
const SEED_FRAC = 0.62;          // ~62% seeds / ~38% stones
const GROVES = 22;               // thickets spread across a RECTANGLE (not radially) — nothing centred
const WORLD_W = 3700, WORLD_H = 2800; // grove centres + loners scatter across ±this (wide — spacious arrival)
const GROVE_SIGMA = 540;         // LOOSER groves (was 420) — objects spread within a grove, so clusters aren't dense
const HEART_SIGMA = 240;         // grove 0 (the origin "heart") stays tighter, so an arrival always lands by life
const LONER_FRAC = 0.22;         // more scattered in the open between groves — less clumping
const SPACE_GAP = 50;            // MORE breathing space BETWEEN footprints (was 34) — directly thins the clusters
const RELAX_ITERS = 32;          // relaxation passes (one-time, at seed) — enough to separate at the wider gap

// Deterministic, UUID-formatted id (valid 8-4-4-4-12, version/variant bits set).
// Derived from the seeded master RNG, so re-seeding upserts the same 200 ids
// (idempotent) while remaining a real UUID string.
function detUuid(rand) {
  const b = new Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(rand() * 256) & 0xff;
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

// Standard-normal sample (Box-Muller) from the master RNG.
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// One object record. Lifecycle fields (maturity/aged/heat/shedAccum) are STATE,
// not visual data — the form is always re-derived from seed+maturity+aged.
export function makeRecord(id, family, seed, x, y, now, maturity = 0, aged = 0) {
  return {
    id, family, x, y, seed,
    handling: 0, maturity, aged, heat: 0, shedAccum: 0,
    last_touched: now,        // ms timestamp; drives the derived isolation/fade clock
    last_eval: now, created_at: now,
    held: '', heldConn: '', held_at: 0,
  };
}
export const makeSeedRecord = (id, seed, x, y, now, maturity = 0, aged = 0) =>
  makeRecord(id, 'seed', seed, x, y, now, maturity, aged);

// Anomalies (Family 4): rare, luminous, NO lifecycle. `kind` selects the form.
export const ANOMALY_KINDS = ['rotor', 'point', 'prism', 'breath'];
export function makeAnomalyRecord(id, seed, kind, x, y, now) {
  const r = makeRecord(id, 'anomaly', seed, x, y, now);
  r.kind = kind;
  return r;
}

// Crystalline formations (Family 3): small, geometric, glinting, pickable; they
// form at the edge of a water pool and slowly dissolve in a brief flash.
export const makeCrystalRecord = (id, seed, x, y, now) => {
  const r = makeRecord(id, 'crystal', seed, x, y, now);
  r.decay = 0; // crystals carry a slow decay clock (others don't)
  return r;
};

// Creatures (Family 5): a few gentle insects that wander on their own. NO stored
// position-over-time — the record holds only existence + a HOME (x/y); the live
// position is home + a deterministic wander(seed, kind, sharedClock) the clients
// compute (see public/creatures.js). Pickable like anything else; placed, its home
// moves there. `kind` selects crawler vs flier.
export const CREATURE_KINDS = ['crawler', 'flier'];

// Fish (Family 6): they swim within a pond (Wave P/Q). Like creatures, the record
// holds only existence + a HOME (x/y inside the pond); the live position is a
// deterministic, BOUNDED wander the clients compute (public/creatures.js), so a fish
// never leaves the water and costs the always-ticking world nothing to keep moving.
export const makeFishRecord = (id, seed, x, y, now) => {
  const r = makeRecord(id, 'fish', seed, x, y, now);
  r.wanderT0 = now;
  return r;
};

export const makeCreatureRecord = (id, seed, kind, x, y, now) => {
  const r = makeRecord(id, 'creature', seed, x, y, now);
  r.kind = kind;
  // wanderT0 ANCHORS the deterministic wander: live pos = home + (wander(t) −
  // wander(t0)), which is exactly home at t=t0. Set at spawn (starts on its home)
  // and reset to the moment of release on place, so a re-placed creature continues
  // from where you set it down instead of snapping by its current wander offset.
  r.wanderT0 = now;
  return r;
};

// `now` anchors creation time to the moment the world is born. The procedural
// FORM of each object (id, position, seed) is fully deterministic; the starting
// lifecycle mix makes the arrival world feel already in progress.
const uniform = (rand, lo, hi) => lo + rand() * (hi - lo);
// Footprint of an object for spacing (world units): a stone's own radius, or a plant
// scaled by its seeded maturity — so a mature tree reserves far more room than a seed.
// Mirrors the client/server radii closely enough to keep seeded forms from overlapping.
export function spacingRadius(o) {
  if (o.family === 'stone') return 12 + rng(o.seed >>> 0)() * 34;   // == stoneRadius
  return 12 + (o.maturity || 0) * 54;                                // seed → mature tree
}
// Push apart any objects whose footprints (radius_i + radius_j + gap) overlap — grid-
// accelerated, in place. SIZE-AWARE: big trees/boulders claim more space than seeds,
// killing the "big objects feel too dense" crowding. A few passes turn an overlapping
// clump into evenly-spaced groves. Deterministic — rand only jitters coincident points.
function relaxSpacing(pts, iters, gap, radiusFn, rand, clampX, clampY) {
  const radii = pts.map(radiusFn);
  let maxR = 0; for (const r of radii) if (r > maxR) maxR = r;
  const cell = 2 * maxR + gap;                       // ≥ any pair's interaction range, so ±1 cell catches all overlaps
  for (let it = 0; it < iters; it++) {
    const grid = new Map();
    for (let i = 0; i < pts.length; i++) {
      const k = Math.floor(pts[i].x / cell) + ',' + Math.floor(pts[i].y / cell);
      let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(i);
    }
    const dx = new Float64Array(pts.length), dy = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = grid.get(gx + ',' + gy); if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const minDist = radii[i] + radii[j] + gap;
          const q = pts[j]; let ex = p.x - q.x, ey = p.y - q.y; const d = Math.hypot(ex, ey);
          if (d > minDist) continue;
          let push;
          if (d < 0.001) { const a = rand() * 6.2831853; ex = Math.cos(a); ey = Math.sin(a); push = minDist * 0.5; }
          else { push = (minDist - d) / d * 0.5; }
          dx[i] += ex * push; dy[i] += ey * push; dx[j] -= ex * push; dy[j] -= ey * push;
        }
      }
    }
    for (let i = 0; i < pts.length; i++) {
      pts[i].x = Math.max(-clampX, Math.min(clampX, pts[i].x + dx[i]));
      pts[i].y = Math.max(-clampY, Math.min(clampY, pts[i].y + dy[i]));
    }
  }
}

export function generateWorld(now = Date.now(), count = N) {
  const n = Math.max(1, count | 0);              // env-overridable population (small for fast tests)
  const nSeed = Math.round(n * SEED_FRAC);
  // Scale the scatter area with the population so DENSITY stays ~constant: at the prod
  // default (900) scale is 1 — positions UNCHANGED — while a large SEED_N gets a
  // proportionally bigger world, keeping MIN_SPACE satisfiable and relaxSpacing ~O(N)
  // (not O(N^2)). A small test world is just a denser-packed miniature.
  const scale = Math.sqrt(n / N);
  const W = WORLD_W * scale, H = WORLD_H * scale, sigma = GROVE_SIGMA * scale;
  const rand = rng(WORLD_SEED);
  // Grove centres spread across the RECTANGLE, not radially from a centre (so it isn't
  // "all piled in the middle of a circle"). Grove 0 sits AT the origin with a tighter
  // spread (the "heart") so an arrival at the cog always lands by life; the rest are
  // loose so their clusters breathe.
  const heartSig = HEART_SIGMA * scale;
  const groves = [{ x: +uniform(rand, -60, 60).toFixed(2), y: +uniform(rand, -60, 60).toFixed(2), sig: heartSig }];
  for (let g = 1; g < GROVES; g++) {
    groves.push({ x: +uniform(rand, -W, W).toFixed(2), y: +uniform(rand, -H, H).toFixed(2), sig: sigma });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    // Fixed per-object draw order so DO and script agree byte-for-byte:
    // family(by index) -> id(16) -> loner-roll -> position -> seed -> [lifecycle].
    const family = i < nSeed ? 'seed' : 'stone';
    const id = detUuid(rand);
    let x, y;
    if (rand() < LONER_FRAC) {                                  // scattered in the open between groves
      x = uniform(rand, -W, W); y = uniform(rand, -H, H);
    } else {                                                    // gathered loosely into a grove
      const grove = groves[Math.floor(rand() * groves.length)];
      x = grove.x + gaussian(rand) * grove.sig;             // heart grove is tighter; the rest are loose
      y = grove.y + gaussian(rand) * grove.sig;
    }
    const seed = Math.floor(rand() * 4294967296) >>> 0;        // 32-bit procgen seed
    let maturity = 0, aged = 0;
    if (family === 'seed') {
      const roll = rand();
      if (roll < 0.5) maturity = rand() * 0.10;                 // dormant seeds / just stirring
      else if (roll < 0.82) maturity = 0.20 + rand() * 0.55;    // young .. near-mature plants
      else { maturity = 0.86 + rand() * 0.14; aged = rand() * 0.35; } // mature, a little aged
    }
    out.push(makeRecord(id, family, seed, x, y, now, maturity, aged));
  }
  // Relax so footprints don't overlap — the dense clump becomes evenly-spaced groves
  // with the big trees/boulders given real room. Only for sane populations (prod is
  // 2400): the relaxation is the one super-linear step, so a huge SEED_N skips it (the
  // scaled grove spread already distributes it) rather than stalling DO construction.
  // n<=3000 keeps prod + tests fully relaxed.
  if (n <= 3000) relaxSpacing(out, RELAX_ITERS, SPACE_GAP, spacingRadius, rand, W + 600, H + 600);
  for (const o of out) { o.x = +o.x.toFixed(2); o.y = +o.y.toFixed(2); }
  return out;
}

export { N as SEED_COUNT };

// Bump when generateWorld changes meaningfully: a stored world stamped with an
// older version is reseeded ONCE on load (see the DO's #load), so a deployed
// generator change actually reaches the live world without an admin key or a wipe
// route. 1 = the old single central clump; 2/3 = groves spread across a wide world;
// 4 = wider, fuller, SIZE-AWARE spacing; 5 = looser groves + wider gaps + fewer
// objects so clusters breathe (the "still too dense" fix).
export const SEED_VERSION = 5;
// Decide what a loading world needs: seed a fresh empty world, reseed a world left
// by an older generator (one-time, version-gated), or nothing. Pure + unit-tested —
// it carries the only loop-risk (a wrong "reseed" would wipe on every restart), so
// it is isolated here and exhaustively tested.
export function reseedAction(size, storedVersion) {
  if (size === 0) return 'seed-fresh';
  if (storedVersion !== SEED_VERSION) return 'reseed';
  return 'none';
}
