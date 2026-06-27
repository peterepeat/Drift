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
// The world now seeds wider and fuller (was 200 in one central σ=400 clump, which
// read as "everything piled at the centre, emptiness around"). Objects gather into
// GROVES scattered across a wide area with open clearings between, plus a few loners
// in the open — so arrival feels spacious and inhabited, not a clump in a void. The
// population still grows into the 10k cap over time; this just spreads the start.
const N = 900;                   // default population (prod). env.SEED_N overrides it per-deploy
const SEED_FRAC = 0.64;          // ~64% seeds / ~36% stones
const GROVES = 18;               // thickets spread across a RECTANGLE (not radially) — nothing centred
const WORLD_W = 2600, WORLD_H = 2000; // grove centres + loners scatter across ±this
const GROVE_SIGMA = 240;         // local spread of objects within a grove
const LONER_FRAC = 0.18;         // fraction scattered in the open between groves
const MIN_SPACE = 56;            // no two objects end up closer than this — relaxation kills the dense clump
const RELAX_ITERS = 16;          // relaxation passes (one-time, at seed)

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
    stack: 0, stackBase: '', // stone stacking: level above the ground stone, and its base id
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
// Push apart any objects closer than minDist (grid-accelerated, in place). A few
// passes turn an overlapping clump into evenly-spaced groves with no hyper-density.
// Deterministic — rand is used only to jitter exactly-coincident points apart.
function relaxSpacing(pts, iters, minDist, rand, clampX, clampY) {
  const cell = minDist;
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
  // "all piled in the middle of a circle"). Grove 0 sits near the origin so an arrival
  // at the cog still lands by some life — but it's just a normal grove, no dense heart.
  const groves = [{ x: +uniform(rand, -160, 160).toFixed(2), y: +uniform(rand, -160, 160).toFixed(2) }];
  for (let g = 1; g < GROVES; g++) {
    groves.push({ x: +uniform(rand, -W, W).toFixed(2), y: +uniform(rand, -H, H).toFixed(2) });
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
      x = grove.x + gaussian(rand) * sigma;
      y = grove.y + gaussian(rand) * sigma;
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
  // Relax so nothing piles up — the dense central clump becomes evenly-spaced groves.
  // Only for sane populations (prod is 900): the relaxation is the one super-linear
  // step, so a huge SEED_N skips it (the scaled grove spread already distributes it)
  // rather than stalling DO construction. n<=3000 keeps prod + tests fully relaxed.
  if (n <= 3000) relaxSpacing(out, RELAX_ITERS, MIN_SPACE, rand, W + 500, H + 500);
  for (const o of out) { o.x = +o.x.toFixed(2); o.y = +o.y.toFixed(2); }
  return out;
}

export { N as SEED_COUNT };

// Bump when generateWorld changes meaningfully: a stored world stamped with an
// older version is reseeded ONCE on load (see the DO's #load), so a deployed
// generator change actually reaches the live world without an admin key or a wipe
// route. 1 = the old single central clump; 2 = groves spread across a wide world.
export const SEED_VERSION = 3;
// Decide what a loading world needs: seed a fresh empty world, reseed a world left
// by an older generator (one-time, version-gated), or nothing. Pure + unit-tested —
// it carries the only loop-risk (a wrong "reseed" would wipe on every restart), so
// it is isolated here and exhaustively tested.
export function reseedAction(size, storedVersion) {
  if (size === 0) return 'seed-fresh';
  if (storedVersion !== SEED_VERSION) return 'reseed';
  return 'none';
}
