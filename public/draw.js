// public/draw.js — the client's OBJECT PAINT dispatch + position/geometry readers
// (4.14d mirror). Everything ctx-coupled about drawing a world object lives here:
// the per-family paint cascade (paintObject + drawAnomalyForm/drawRoots/drawMark/
// drawLOD/paintGroundShadow), the world/held/attend draw entry points, and the live
// position + render-state readers (creaturePos/posOf/objRadius, glow/tame/warp). It is
// a pure PROVIDER: it reads the shared state (state.js) + the view's quality binding and
// paints; it never calls back into client.js, so there is no circular import. The frame
// loop, hit-test, and net handlers import back what they still call (objRadius/creaturePos/
// posOf + the draw entry points). Per-frame scratch it reads (S.frameStones/S.frameLodCut)
// lives on S so the cull pass (client.js) and these readers share it by reference.
import { ctx, camera, feedRushes, S } from './state.js';
import { Q } from './view.js';
import { SPROUT_C, shownMat, formOf } from './forms.js'; // per-family FORM.draw dispatch owns the primitives now (4.14d.2)
import { wanderAt, creatureR } from './creatures.js';
import { deflectCircles } from './physics.js';
import * as PG from './drift-procgen.js';

// Client render consts owned here (only the moved draw code reads them).
export const FISH_SWIM_SPEED = 150; // world u/s the fish swim toward food (a brisk, natural pursuit — the NEAREST reaches first + eats it)
export const FEED_RELEASE = 0.9;    // seconds for fish to ease back to their wander once the bug is eaten
const GLOW_SEC = 180;               // glow-buff duration in seconds (mirror server GLOW_MS)
const MARK_SIZE = 24;               // ground-mark footprint (world units) — small, rock-shaped
const MARK_TINT = '#d3c6ab';        // pale warm stain — a drawn mark visible on the dark ground

function syncedT() { return (Date.now() + S.clockSkew) / 1000; }
function creatureWarpT(o, t) {
  if (!o.glowUntil) return t;
  const gu = o.glowUntil / 1000, gs = gu - GLOW_SEC;
  if (t <= gs) return t;
  if (t < gu) return gs + (t - gs) * 2;       // 2× speed while glowing
  return gs + GLOW_SEC * 2 + (t - gu);         // after: normal speed, phase-shifted (invisible)
}
function glowHueOf(o) { return (o.glowUntil && (Date.now() + S.clockSkew) < o.glowUntil) ? (o.glowHue || 0) : null; }
function tameFactor(o) {
  if (!o.tameUntil) return 0;
  const remain = o.tameUntil - (Date.now() + S.clockSkew);
  if (remain <= 0) return 0;
  const inF = o._tameStart ? Math.min(1, (performance.now() - o._tameStart) / 2500) : 1;
  return Math.max(0, Math.min(1, Math.min(inF, remain / 10000)));
}
function creaturePos(o) {
  const t = syncedT(), seed = o.seed >>> 0, kind = o.family === 'fish' ? 'fish' : (o.kind || 'crawler');
  const t0 = (o.wanderT0 || 0) / 1000;
  const tg = creatureWarpT(o, t), tg2 = creatureWarpT(o, t + 0.2);
  const w = wanderAt(seed, kind, tg), a = wanderAt(seed, kind, t0), w2 = wanderAt(seed, kind, tg2);
  let x = o.x + (w.x - a.x), y = o.y + (w.y - a.y);
  let ang = Math.atan2(w2.y - w.y, w2.x - w.x);
  // A befriended creature is NOT glued to the viewport — its HOME drifts toward you on the
  // server (slow, at its own pace), and here it just wanders normally around that moving
  // home. So it approaches and trails you naturally, never snapping to centre or vanishing.
  // A bug dropped in a pond becomes every nearby fish's objective: each SWIMS toward it at
  // a constant speed (turning to face it), so the closest reaches it first + eats it (`eatT`,
  // set when the rush began). Once eaten, the fish ease back to their wander. Purely local &
  // cosmetic (the splash event drives it on every client); the fish's home/wander is untouched.
  if (kind === 'fish' && feedRushes.length) {
    let target = null, bestF = 0;
    for (const fr of feedRushes) {
      if (Math.hypot(x - fr.pond.x, y - fr.pond.y) > fr.pond.r + 40) continue; // only the food's own pond
      const elapsed = (S.animT * 1000 - fr.start) / 1000;
      if (elapsed < 0) continue;
      const dist = Math.hypot(fr.x - x, fr.y - y) || 1;
      const approachT = dist / FISH_SWIM_SPEED;                 // secs for THIS fish to reach the bug at swim speed
      let f;
      if (elapsed <= fr.eatT) f = Math.min(1, elapsed / approachT); // still swimming in (constant speed)
      else { const fAtEat = Math.min(1, fr.eatT / approachT); f = fAtEat * Math.max(0, 1 - (elapsed - fr.eatT) / FEED_RELEASE); } // eaten → ease back from where it had got to
      if (f > bestF) { bestF = f; target = fr; }
    }
    if (target) { ang = Math.atan2(target.y - y, target.x - x); x += (target.x - x) * bestF; y += (target.y - y) * bestF; }
  }
  // Unit ⑥: a ground creature steers AROUND rock footprints instead of walking over
  // them — solids read as solid. Purely local & cosmetic: the creature's server-side
  // home/wander is untouched, only where it's drawn (so two viewports can fence it
  // slightly differently against their own visible rocks — fine, like the cursor nudge).
  // S.frameStones is last frame's visible rocks (a frame's lag is imperceptible).
  if (kind === 'crawler' && S.frameStones.length) { const p = deflectCircles(x, y, creatureR(seed, kind) * 0.7, S.frameStones, 5); x = p.x; y = p.y; }
  return { x, y, ang };
}
function posOf(o) {
  if ((o.family === 'creature' || o.family === 'fish') && !o.held && o.id !== S.heldId) return creaturePos(o);
  return { x: o.x + (o._ox || 0), y: o.y + (o._oy || 0) };
}
function objRadius(o) { return formOf(o.family).sizeFn(o); } // per-family footprint — see forms.js
// Paint the full form of any object at (cx, cy) in the current transform by dispatching to
// its family's FORM.draw descriptor (forms.js — the 3.9 registry, folded in at 4.14d.2).
// `env` is a SHARED object: only `t` (=animT) changes per call; glowOf/tameOf are the
// creature-buff readers, injected here because they read S (forms.js stays pure).
const paintEnv = { ctx, t: 0, glowOf: glowHueOf, tameOf: tameFactor };
function paintObject(o, cx, cy, ang = 0) {
  paintEnv.t = S.animT;
  formOf(o.family).draw(o, cx, cy, ang, paintEnv);
}
function paintGroundShadow(o, cx, cy, rad) {
  if (!formOf(o.family).castsShadow) return; // anomalies float, fish are under the water, the giant draws its own foot shadow
  const rooted = o.family === 'seed' && shownMat(o) >= SPROUT_C;   // a plant roots at cy; everything else sits below centre
  const flier = o.family === 'creature' && (o.kind === 'flier');
  const baseY = rooted ? cy + rad * 0.12 : cy + rad * 0.42;
  const rx = rad * (o.family === 'creature' ? 0.7 : 0.82) * (flier ? 0.7 : 1);
  const a = (0.12 + Math.min(0.13, rad / 380)) * (flier ? 0.45 : 1); // bigger casts darker; a flier's is faint
  ctx.save();
  ctx.fillStyle = PG.rgba('#000000', a);
  ctx.beginPath(); ctx.ellipse(cx + rad * 0.14, baseY + (flier ? rad * 0.5 : 0), rx, rx * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function markGeom(o) { if (!o._mg) o._mg = PG.makeStone(o.seed >>> 0, MARK_SIZE, 0.4); return o._mg; }
function drawMark(o, life) {
  const g = markGeom(o), a = 0.34 * Math.min(1, life * 1.4); // hold near-full, then ease out as it heals
  const P = g.pts.map((p) => ({ x: o.x + Math.cos(p.a) * p.rad, y: o.y + Math.sin(p.a) * p.rad }));
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= P.length; i++) { // rounded polygon — quad-smooth through edge midpoints (like a stone)
    const b0 = P[i % P.length], b1 = P[(i + 1) % P.length];
    const mx = (b0.x + b1.x) / 2, my = (b0.y + b1.y) / 2;
    if (i === 0) ctx.moveTo(mx, my); else ctx.quadraticCurveTo(b0.x, b0.y, mx, my);
  }
  ctx.closePath();
  // Feather the fill FULLY to nothing at the rim (was 0.35·a) so the rock's hard edge
  // vanishes — overlapping digs then melt into one soft stain instead of stacking into
  // crisp lens-shaped overlaps. The dug centre stays as visible as before.
  const rg = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, g.radius * 1.18);
  rg.addColorStop(0, PG.rgba(MARK_TINT, a));
  rg.addColorStop(0.5, PG.rgba(MARK_TINT, a * 0.5));
  rg.addColorStop(1, PG.rgba(MARK_TINT, 0));
  ctx.fillStyle = rg; ctx.fill();
  ctx.restore();
}
function drawObjectWorld(o) {
  let cx, cy, ang = 0;
  if (o.family === 'creature' || o.family === 'fish') { const p = creaturePos(o); cx = p.x; cy = p.y; ang = p.ang; } // live wander + heading
  else { cx = o.x + (o._ox || 0); cy = o.y + (o._oy || 0); } // + local cursor-displacement (Wave 6)
  const ds = o._depthScale || 1; // size-by-depth (Wave K) — set in the cull pass
  const rad = objRadius(o) * ds;
  // LOD (zoom-out perf): when an object is only a handful of pixels on screen, a full
  // procedural tree is hundreds of wasted strokes — draw one colour blob instead. This
  // is the standard "when a tree is 5px, draw a dot" technique; only the zoomed-out view
  // is affected, close-up is untouched. Anomalies (luminous, rare) + fish always draw full.
  // LOD only when over the detail budget (S.frameLodCut > 0, set in the cull pass): the
  // smallest-on-screen overflow draws as a cheap blob, everything else full. Plus a hard
  // sub-pixel floor (a thing under ~1.5px is invisible anyway). Anomalies/fish/giant: always full.
  if (!formOf(o.family).alwaysFull) { // anomalies/fish/giant always draw full (never LOD-blobbed)
    const px = rad * camera.z;
    if (px < 1.5 || (S.frameLodCut > 0 && px < S.frameLodCut)) { drawLOD(o, cx, cy, rad); return; }
  }
  if (Q.shadows) paintGroundShadow(o, cx, cy, rad);
  if (ds === 1) { paintObject(o, cx, cy, ang); return; }
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(ds, ds); ctx.translate(-cx, -cy); // scale about the object's base point
  paintObject(o, cx, cy, ang);
  ctx.restore();
}
function drawLOD(o, cx, cy, rad) {
  if (o.family === 'seed') {
    const mat = shownMat(o), col = lodColor(o);
    if (mat >= SPROUT_C) { // a sprouted plant reads as a thin vertical LINE approximating its height (not a dot) + a small crown
      const h = rad * (1.5 + mat * 2.3);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(0.5, rad * 0.14); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - h); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy - h, rad * 0.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      return;
    }
    ctx.beginPath(); ctx.arc(cx, cy, rad * 0.42, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); // a loose seed/leaf → a small green dab (half the old size)
    return;
  }
  ctx.beginPath(); ctx.arc(cx, cy, rad * 0.85, 0, Math.PI * 2);
  ctx.fillStyle = lodColor(o); ctx.fill();
}
function lodColor(o) { return formOf(o.family).lodColor(o); } // per-family LOD blob colour — see forms.js
function ageFactor(o) { return formOf(o.family).ageFactor(o); } // "reveal of age" 0..1 — see forms.js
function paintAttend(o, t) {
  const age = ageFactor(o);
  const c = posOf(o);                                   // bloom at the live position (a creature wanders)
  const rad = objRadius(o) * (1.7 + 1.3 * age);
  const breath = 0.6 + 0.4 * Math.sin(S.animT * 1.6);     // slow pulse = the object responding
  const a = 0.16 * t * breath * (0.55 + 0.45 * age);    // older → warmer reveal
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
  g.addColorStop(0, PG.rgba('#e8c87a', a));
  g.addColorStop(1, PG.rgba('#e8c87a', 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c.x, c.y, rad, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawHeldScreen(o, sx, sy, lift) {
  const z = camera.z, sc = 1 + lift * 0.06, rise = lift * 10, rad = objRadius(o) * z;
  ctx.save();
  ctx.fillStyle = PG.rgba('#000000', 0.34 * (1 - lift * 0.4));
  ctx.beginPath();
  ctx.ellipse(sx, sy + rad * 0.55 + 4, rad * 0.9 * (1 + lift * 0.5), rad * 0.3 + (4 + lift * 10) * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(sx, sy - rise);
  ctx.scale(z * sc, z * sc);
  // A held creature keeps facing its live wander heading (not a fixed "up"), so
  // picking it up and setting it down don't snap its rotation — the in-hand heading
  // is continuous with the wander it resumes (heading is position-independent).
  const ang = o.family === 'creature' ? creaturePos(o).ang : 0;
  paintObject(o, 0, 0, ang);
  ctx.restore();
}

export { objRadius, creaturePos, posOf, drawMark, drawObjectWorld, drawHeldScreen, paintAttend };
