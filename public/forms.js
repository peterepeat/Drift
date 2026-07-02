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
// Scope: the form FOOTPRINT + scalar flags (3.9d) + the per-family render VALUE fns
// (3.9e) + the per-family DRAW dispatch (3.9/4.14d.2). A descriptor takes the live object
// `o` so it can read the sub-family discriminators (o.kind, o._matShown, o.kinds) — family
// alone is not enough. The `draw` fn is the only ctx-coupled cell: it takes the canvas
// context + per-frame values through an `env` object (NOT a module import), so this file
// stays a pure, Node-importable data module — parity.test asserts the draw contract too.
//
//   sizeFn(o)        — world-unit footprint (depth-sort + tap target), form-from-seed
//   movable(o)       — can be picked up / shoved (a rooted big tree cannot)
//   castsShadow      — paints a soft ground contact shadow (luminous/airborne: none)
//   alwaysFull       — never LOD-blobbed and exempt from the detail budget (rare/small)
//   pickable         — eligible for hit-testing (fish swim free; marks are stains)
//   lodColor(o)      — colour of its far/tiny LOD blob (matched to the full form)
//   ageFactor(o)     — "reveal of age" 0..1 driving the attend-bloom size/warmth
//   lightness(o)     — how easily a passing cursor stirs it (0 = unmoved)
//   collisionGive(o) — how much it YIELDS when bumped (0 = immovable); the caller
//                      keeps the held/heldId/flying/rooted state guards
//   draw(o,cx,cy,ang,env) — paint the full form at (cx,cy). env = { ctx, t (=animT),
//                      glowOf(o)/tameOf(o) (creature buffs, injected by draw.js so this
//                      file needs no state.js). The mark family draws in its own bespoke
//                      pre-pass (needs `life`), so its draw cell is moot (never invoked).
// =============================================================================
import { stoneRadius, anomalyRadius, crystalRadius, plantRadius, seedScale } from './shared/sizing.js';
import { creatureR, fishR, drawCreature, drawFish } from './creatures.js';
import { drawGiant } from './giant.js';
import * as PG from './drift-procgen.js';

// Client render consts — owned here (the single source). SPROUT_C was a hand-copied
// "mirrors server" duplicate of the server's SPROUT (0.14); it now lives in one place.
export const SPROUT_C = 0.14;       // maturity below this renders as a loose seed/leaf
export const BIG_TREE_MAT = 0.8;    // a plant this mature has ROOTED — an immovable landmark
export const GIANT_R = 150;         // the journeyer's overall height in world units
export const GRIT_HANDLING_C = 26;  // a stone handled this many times reads fully "old" (mirrors the server GRIT_HANDLING)

// Smoothly-tweened lifecycle the renderer reads (eased toward the server value so the
// 60s growth steps don't pop); falls back to the raw value before the first tween.
export const shownMat = (o) => (o._matShown != null ? o._matShown : (o.maturity || 0));
export const shownAged = (o) => (o._agedShown != null ? o._agedShown : (o.aged || 0));

// Per-family form footprints (form-from-seed — the SHAPE is regenerated, never stored).
export const stoneSize = (o) => (o.r != null ? o.r : stoneRadius(o.seed)); // `r` overrides once fused/split
export const anomalyR = (o) => anomalyRadius(o.seed, (o.kinds && o.kinds.length) || 1); // a fused hybrid grows per kind
export const crystalR = (o) => crystalRadius(o.seed);
const plantSize = (o) => plantRadius(shownMat(o), o.seed, SPROUT_C); // plants present a larger tap target
// Stone procedural geometry (form-from-seed), cached on the object + regenerated on
// erosion (handling) or a fuse/split (r). Shared by the stone draw + its LOD colour.
export const stoneGeom = (o) => {
  const er = Math.min(0.95, o.handling * 0.04);
  if (!o._sg || o._sgEr !== er || o._sgR !== (o.r || 0)) { o._sg = PG.makeStone(o.seed >>> 0, stoneSize(o), er); o._sgEr = er; o._sgR = o.r || 0; }
  return o._sg;
};

// --- per-family render VALUE helpers (the shared bodies the FORM table assigns) ---
const yes = () => true, zero = () => 0;
// a plant's representative colour, matched to drawSeed / drawPlant so LOD doesn't shift hue
const plantColor = (o) => {
  const mat = shownMat(o);
  if (mat < SPROUT_C) return PG.mix(PG.PALETTE.growthDeep, PG.PALETTE.growthLight, 0.5);
  return mat < 0.5 ? PG.mix(PG.PALETTE.growthYoung, PG.PALETTE.growthLight, mat / 0.5)
                   : PG.mix(PG.PALETTE.growthLight, PG.PALETTE.growthDeep, (mat - 0.5) / 0.5);
};
const plantAge = (o) => Math.min(1, shownMat(o) * 0.55 + shownAged(o) * 0.65); // seed → plant → aged
const looseLight = (o) => (shownMat(o) < SPROUT_C ? 1 : 0); // a loose pre-sprout seed slides; a sprouted plant sways (0)
const looseGive = (o) => (shownMat(o) < SPROUT_C ? 0.8 : 0);

// --- per-family DRAW helpers (ctx-coupled; ctx arrives via a param/env, never imported) ---
// A plain anomaly draws its one kind; a fused hybrid layers each constituent kind (offset
// in time + slightly shrunk, translucent) so its form reads as a luminous blend.
const drawAnomalyForm = (ctx, o, t, cx, cy, R) => {
  const kinds = (o.kinds && o.kinds.length) ? o.kinds : [o.kind || 'breath'];
  if (kinds.length === 1) { PG.drawAnomaly(ctx, kinds[0], t, cx, cy, R); return; }
  ctx.save();
  ctx.globalAlpha = 0.55 + 0.4 / kinds.length; // translucent layers merge instead of occluding
  for (let i = 0; i < kinds.length; i++) PG.drawAnomaly(ctx, kinds[i], t + i * 1.7, cx, cy, R * (1 - i * 0.06));
  ctx.restore();
};
// Roots for the biggest plants (rooted immovable, maturity ≥ BIG_TREE_MAT): short tapering
// tendrils splaying from the base across the ground plane (vertically compressed, like the
// contact shadow), so it READS why the tree won't be lifted. Deterministic from seed.
export const drawRoots = (ctx, seed, cx, cy, mat) => {
  const r = PG.rng((seed ^ 0x9b7c3) >>> 0);
  const n = 4 + Math.floor(r() * 3);                 // 4..6 surface roots
  const reach = 12 + mat * 28;                        // grows with the tree
  ctx.save();
  ctx.lineCap = 'round';
  const col = PG.mix(PG.PALETTE.growthDeep, '#1c1206', 0.7); // deep green → dark earth
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) / n * Math.PI * 2 + (r() - 0.5) * 0.5;
    const len = reach * (0.6 + r() * 0.7);
    const ex = cx + Math.cos(a) * len;
    const ey = cy + Math.sin(a) * len * 0.42 + len * 0.16; // ground-plane compression + a touch toward the viewer
    const mx = cx + (ex - cx) * 0.45 + (r() * 2 - 1) * len * 0.16;
    const my = cy + (ey - cy) * 0.45 + (r() * 2 - 1) * len * 0.08;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 1);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.lineWidth = Math.max(0.7, (2.6 - i * 0.18) * (0.55 + mat * 0.45));
    ctx.strokeStyle = PG.rgba(col, 0.55);
    ctx.stroke();
  }
  ctx.restore();
};
// The plant cascade (form-from-seed, never stored): a loose pre-sprout seed, else a sprouted
// plant — rooted (roots) and/or swaying (bend about its base). The seed/default draw cell.
const drawPlantForm = (o, cx, cy, ang, e) => { // ang unused (plants don't rotate as a whole), but keep the slot: draw() is called (o,cx,cy,ang,env)
  const mat = shownMat(o), aged = shownAged(o);
  if (mat < SPROUT_C) { PG.drawSeed(e.ctx, o.seed >>> 0, cx, cy, seedScale(o.seed) * (1 + mat * 1.4)); return; }
  if (mat >= BIG_TREE_MAT) drawRoots(e.ctx, o.seed >>> 0, cx, cy, mat); // roots only on the biggest (rooted) plants
  const bend = o._bend || 0; // any sprouted plant SWAYS by leaning its canopy about its base (never a whole-object slide)
  if (bend) { e.ctx.save(); e.ctx.translate(cx, cy); e.ctx.rotate(bend); PG.drawPlant(e.ctx, o.seed >>> 0, 0, 0, mat, aged); e.ctx.restore(); return; }
  PG.drawPlant(e.ctx, o.seed >>> 0, cx, cy, mat, aged);
};

const F = (d) => Object.freeze(d);
// The render registry — null-proto so an unknown / synthetic family can't reach an
// inherited Object.prototype member. giant + mark are FIRST-CLASS entries.
const FORM = Object.assign(Object.create(null), {
  stone:    F({ sizeFn: stoneSize, movable: yes, castsShadow: true,  alwaysFull: false, pickable: true,
                lodColor: (o) => stoneGeom(o).fill, ageFactor: (o) => Math.min(1, (o.handling || 0) / GRIT_HANDLING_C), lightness: zero, collisionGive: () => 0.4,
                draw: (o, cx, cy, ang, e) => PG.drawStone(e.ctx, stoneGeom(o), cx, cy) }),
  seed:     F({ sizeFn: plantSize, movable: (o) => shownMat(o) < BIG_TREE_MAT, castsShadow: true, alwaysFull: false, pickable: true,
                lodColor: plantColor, ageFactor: plantAge, lightness: looseLight, collisionGive: looseGive,
                draw: drawPlantForm }),
  anomaly:  F({ sizeFn: anomalyR,  movable: yes, castsShadow: false, alwaysFull: true,  pickable: true,
                lodColor: plantColor, ageFactor: () => 0.5, lightness: zero, collisionGive: zero,
                draw: (o, cx, cy, ang, e) => drawAnomalyForm(e.ctx, o, e.t, cx, cy, anomalyR(o)) }),
  crystal:  F({ sizeFn: crystalR,  movable: yes, castsShadow: true,  alwaysFull: false, pickable: true,
                lodColor: () => '#9ec3d6', ageFactor: () => 0.4, lightness: () => 0.45, collisionGive: () => 0.7,
                draw: (o, cx, cy, ang, e) => PG.drawCrystal(e.ctx, o.seed >>> 0, cx, cy, crystalR(o), e.t) }),
  creature: F({ sizeFn: (o) => creatureR(o.seed >>> 0, o.kind || 'crawler'), movable: yes, castsShadow: true, alwaysFull: false, pickable: true,
                lodColor: (o) => (o.kind === 'flier' ? '#5c564e' : '#2f2c28'), ageFactor: () => 0.35, lightness: zero, collisionGive: zero,
                draw: (o, cx, cy, ang, e) => drawCreature(e.ctx, o.seed >>> 0, o.kind || 'crawler', cx, cy, e.t, ang, e.glowOf(o), e.tameOf(o)) }),
  fish:     F({ sizeFn: (o) => fishR(o.seed >>> 0), movable: yes, castsShadow: false, alwaysFull: true, pickable: false,
                lodColor: plantColor, ageFactor: plantAge, lightness: zero, collisionGive: zero,
                draw: (o, cx, cy, ang, e) => drawFish(e.ctx, o.seed >>> 0, cx, cy, e.t, ang) }),
  mark:     F({ sizeFn: plantSize, movable: yes, castsShadow: false, alwaysFull: false, pickable: false,
                lodColor: plantColor, ageFactor: plantAge, lightness: looseLight, collisionGive: zero,
                draw: drawPlantForm }), // drawn in its own bespoke pre-pass (needs `life`); this draw cell + the render-value cells are moot
  giant:    F({ sizeFn: () => GIANT_R * 0.5, movable: yes, castsShadow: false, alwaysFull: true, pickable: false,
                lodColor: plantColor, ageFactor: plantAge, lightness: looseLight, collisionGive: zero,
                draw: (o, cx, cy, ang, e) => drawGiant(e.ctx, cx, cy, GIANT_R, e.t, Math.atan2(o.hy || 0, o.hx || 1), { gait: o.gait, tend: o.tend, lookX: o.lookX, lookY: o.lookY }) }), // an NPC: the object-pipeline value cells are moot
});

// The fall-through for an unknown family matches client.js's old default (a plant):
// cast a shadow, LOD normally, be pickable, a plant's colour/age/lightness/draw. Unreachable.
const NONE_FORM = F({ sizeFn: plantSize, movable: yes, castsShadow: true, alwaysFull: false, pickable: true,
                      lodColor: plantColor, ageFactor: plantAge, lightness: looseLight, collisionGive: zero, draw: drawPlantForm });
export const formOf = (family) => FORM[family] || NONE_FORM;
export { FORM };
