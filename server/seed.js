// =============================================================================
// DRIFT — deterministic world generation (the ~200-object pre-seed).
// Shared by the Durable Object (self-seeds an empty world) and the operator
// script. Pure: no DOM, no platform APIs. Uses only rng() from the lifted
// procgen module so a given WORLD_SEED always rebuilds the identical world.
// =============================================================================
import { rng } from '../public/drift-procgen.js';

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

// `now` anchors each object's decay clock and creation time to the moment the
// world is born — NOT a backdated constant, or the first 60s tick would compute
// a huge elapsed dt and dissolve everything at once. The procedural FORM of
// each object (id, position, seed) stays fully deterministic regardless of `now`.
export function generateWorld(now = Date.now()) {
  const rand = rng(WORLD_SEED);
  const out = [];
  for (let i = 0; i < N; i++) {
    // Fixed draw order per object so DO and script agree byte-for-byte:
    // id (16) -> x (gauss) -> y (gauss) -> seed.
    const family = i < N_SEED ? 'seed' : 'stone';
    const id = detUuid(rand);
    const x = +(gaussian(rand) * 400).toFixed(2);
    const y = +(gaussian(rand) * 400).toFixed(2);
    const seed = Math.floor(rand() * 4294967296) >>> 0; // 32-bit procgen seed
    out.push({
      id, family, x, y, seed,
      handling: 0, decay: 0,
      last_eval: now, created_at: now,
      held: '', heldConn: '', held_at: 0,
    });
  }
  return out;
}

export { N as SEED_COUNT };
