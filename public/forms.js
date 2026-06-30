// =============================================================================
// DRIFT — the client FORM registry (render half of the FAMILIES keystone)
// -----------------------------------------------------------------------------
// public/shared/families.js holds the runtime-agnostic per-family DATA the SERVER
// branches on. This module is the CLIENT companion: one render descriptor per
// DRAWABLE family — the 7 object families PLUS `giant` (the NPC, drawn from a
// synthetic per-frame entry, never in this.objects). It replaces the scattered
// `o.family === '...'` ladders in client.js's render/footprint/pick code with one
// table. It is browser-loaded as a static ES module AND Node-importable (its deps
// — sizing.js, creatures.js, drift-procgen.js — are pure), so the render contract
// gets its FIRST automated coverage in the unit suite (the old client blind spot).
//
// 3.9d scope: the form FOOTPRINT + the scalar render flags. (The draw functions +
// lodColor/ageFactor/lightness/collisionGive land in 3.9e.) A descriptor takes the
// live object `o` so it can read the sub-family discriminators (o.kind, o._matShown,
// o.kinds) — family alone is not enough.
//
//   sizeFn(o)    — world-unit footprint (depth-sort + tap target), form-from-seed
//   movable(o)   — can be picked up / shoved (a rooted big tree cannot)
//   castsShadow  — paints a soft ground contact shadow (luminous/airborne: none)
//   alwaysFull   — never LOD-blobbed and exempt from the detail budget (rare/small)
//   pickable     — eligible for hit-testing (fish swim free; marks are stains)
// =============================================================================
import { stoneRadius, anomalyRadius, crystalRadius, plantRadius } from './shared/sizing.js';
import { creatureR, fishR } from './creatures.js';

// Client render consts — owned here (the single source). SPROUT_C was a hand-copied
// "mirrors server" duplicate of the server's SPROUT (0.14); it now lives in one place.
export const SPROUT_C = 0.14;     // maturity below this renders as a loose seed/leaf
export const BIG_TREE_MAT = 0.8;  // a plant this mature has ROOTED — an immovable landmark
export const GIANT_R = 150;       // the journeyer's overall height in world units

// Smoothly-tweened maturity the renderer reads (eased toward the server value so the
// 60s growth steps don't pop); falls back to the raw value before the first tween.
export const shownMat = (o) => (o._matShown != null ? o._matShown : (o.maturity || 0));

// Per-family form footprints (form-from-seed — the SHAPE is regenerated, never stored).
export const stoneSize = (o) => (o.r != null ? o.r : stoneRadius(o.seed)); // `r` overrides once fused/split
export const anomalyR = (o) => anomalyRadius(o.seed, (o.kinds && o.kinds.length) || 1); // a fused hybrid grows per kind
export const crystalR = (o) => crystalRadius(o.seed);
const plantSize = (o) => plantRadius(shownMat(o), o.seed, SPROUT_C); // plants present a larger tap target

const yes = () => true;
const F = (d) => Object.freeze(d);
// The render registry — null-proto so an unknown / synthetic family can't reach an
// inherited Object.prototype member. giant + mark are FIRST-CLASS entries.
const FORM = Object.assign(Object.create(null), {
  stone:    F({ sizeFn: stoneSize, movable: yes, castsShadow: true,  alwaysFull: false, pickable: true  }),
  seed:     F({ sizeFn: plantSize, movable: (o) => shownMat(o) < BIG_TREE_MAT, castsShadow: true, alwaysFull: false, pickable: true }),
  anomaly:  F({ sizeFn: anomalyR,  movable: yes, castsShadow: false, alwaysFull: true,  pickable: true  }),
  crystal:  F({ sizeFn: crystalR,  movable: yes, castsShadow: true,  alwaysFull: false, pickable: true  }),
  creature: F({ sizeFn: (o) => creatureR(o.seed >>> 0, o.kind || 'crawler'), movable: yes, castsShadow: true,  alwaysFull: false, pickable: true  }),
  fish:     F({ sizeFn: (o) => fishR(o.seed >>> 0), movable: yes, castsShadow: false, alwaysFull: true,  pickable: false }),
  mark:     F({ sizeFn: plantSize, movable: yes, castsShadow: false, alwaysFull: false, pickable: false }), // drawn in its own pre-pass; never depth-sorted / hit-tested
  giant:    F({ sizeFn: () => GIANT_R * 0.5, movable: yes, castsShadow: false, alwaysFull: true,  pickable: false }), // an NPC: its own tap path, draws its own foot shadow
});

// The footprint fall-through for an unknown family matches client.js's old default
// (a plant): cast a shadow, LOD normally, be pickable. Unreachable in practice.
const NONE_FORM = F({ sizeFn: plantSize, movable: yes, castsShadow: true, alwaysFull: false, pickable: true });
export const formOf = (family) => FORM[family] || NONE_FORM;
export { FORM };
