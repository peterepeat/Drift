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
const N = 200, N_SEED = 130;     // ~65% seeds / ~35% stones

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
    handling: 0, maturity, aged, heat: 0, shedAccum: 0, isolation: 0,
    stack: 0, stackBase: '', // stone stacking: level above the ground stone, and its base id
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

// `now` anchors creation time to the moment the world is born. The procedural
// FORM of each object (id, position, seed) is fully deterministic; the starting
// lifecycle mix makes the arrival world feel already in progress.
export function generateWorld(now = Date.now()) {
  const rand = rng(WORLD_SEED);
  const out = [];
  for (let i = 0; i < N; i++) {
    // Fixed draw order so DO and script agree byte-for-byte:
    // id (16) -> x -> y -> seed -> [seed-family lifecycle].
    const family = i < N_SEED ? 'seed' : 'stone';
    const id = detUuid(rand);
    const x = +(gaussian(rand) * 400).toFixed(2);
    const y = +(gaussian(rand) * 400).toFixed(2);
    const seed = Math.floor(rand() * 4294967296) >>> 0; // 32-bit procgen seed
    let maturity = 0, aged = 0;
    if (family === 'seed') {
      const roll = rand();
      if (roll < 0.5) maturity = rand() * 0.10;                 // dormant seeds / just stirring
      else if (roll < 0.82) maturity = 0.20 + rand() * 0.55;    // young .. near-mature plants
      else { maturity = 0.86 + rand() * 0.14; aged = rand() * 0.35; } // mature, a little aged
    }
    out.push(makeRecord(id, family, seed, x, y, now, maturity, aged));
  }
  return out;
}

export { N as SEED_COUNT };
