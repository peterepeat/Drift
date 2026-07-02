// public/localfx.js — the client's LOCAL COSMETIC EFFECTS: the lift animation, the
// per-frame ease/nudge/collision/sway/leaf passes, and the leaf-litter + birth/death
// draws (4.14e mirror). All of it is purely LOCAL & cosmetic — never networked, never
// the authoritative world — so it can't desync. A clean LEAF module: it reads the shared
// state (state.js) + the pure helpers (view/forms/draw/render/physics/procgen) and mutates
// render-only fields (o._ox/_oy/_bend, lift values, the leaves buffer); it never calls back
// into client.js, so there's no circular import. The frame loop + input + net import back
// the passes + the lift API. The hold/throw/dissolve lifecycle (send/clearHold-coupled)
// stays in client.js; only the cosmetic fx live here.
import { objects, lifts, camera, ctx, S, giantFootprints, creatureEvts, worldEvts, flying, swaying, mouseVelW } from './state.js';
import { vw, vh } from './view.js';
import { shownMat, SPROUT_C, formOf, GIANT_R } from './forms.js';
import { objRadius, isMovable } from './draw.js';
import { seasonSat } from './render.js';
import { nudge, spring } from './physics.js';
import * as PG from './drift-procgen.js';

const clamp = (v, lo, hi) => (v !== v ? lo : v < lo ? lo : v > hi ? hi : v); // shared 1-liner (also in client.js/view.js)

// ---- the lift API's timings + easing (co-located with setLift/updateLifts; net + input +
// client.js's throw/place all pass these to setLift, so they're exported from the lift home) ----
function cubicBezier(x1, y1, x2, y2) { // spec easing curve (Visual Bible §06)
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return function (x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const xe = sampleX(t) - x; if (Math.abs(xe) < 1e-4) break;
      const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= xe / d;
    }
    return sampleY(clamp(t, 0, 1));
  };
}
export const LIFT_MS = 300, SETTLE_MS = 260;              // pickup / place timings (spec)
export const EASE_RISE = cubicBezier(0.22, 1, 0.36, 1);   // pickup / place lift
export const EASE_SETTLE = cubicBezier(0.40, 0, 0.20, 1); // place settle, no overshoot

// ---- tuning consts (owned here; GIANT_VIS_SPEED is also read by the frame's giant entry) ----
export const GIANT_VIS_SPEED = 13;                   // world u/s it WALKS along its heading between ticks (≈ GIANT_STEP/tick) — brisk, continuous motion (not rushed, never parked)
const GIANT_EASE = 0.4;                       // per-second retention for the giant's correction toward each broadcast spot
const FOOT_STEP = 52;                         // drop a print every this-many world units walked
const NUDGE_RADIUS = 78;                      // world units the cursor disturbs around itself
const NUDGE_STR = 6;                          // how strongly cursor speed transfers into a nudge
const NUDGE_SPRING = 95;                      // spring pulling a displaced thing back to rest
const NUDGE_DAMP = 0.02;                      // velocity retained per second (heavy damping → quick settle)
const NUDGE_MAX = 150;                        // clamp the displacement so nothing flies off absurdly
const NUDGE_MIN_SPEED = 45;                   // cursor must move faster than this (wu/s) to stir anything
const COLLIDE_R = 26;                         // bump reach beyond the carried object's own radius
const COLLIDE_STR = 620;                      // how hard it shoves neighbours out of the way (gentle — they part, not fly)
const LEAF_N = 46;                            // leaves populating the viewport
const LEAF_MARGIN = 1.15;                      // keep them within this many viewport half-extents (respawn beyond)
const LEAF_DRIFT = 9;                          // initial drift speed (world units/s)
const LEAF_BREEZE = 13;                        // gentle wandering-breeze drift amplitude (world units/s)
const LEAF_PAN = 0.35;                          // fraction of pan velocity the leaves are blown by (bounded — no streaking)
const LEAF_CURSOR = 4;                         // how strongly the moving cursor scatters them
const SWAY_K = 150;                           // spring stiffness pulling a swayed tree upright
const SWAY_DAMP = 0.05;                        // velocity retained/s (light → a small bounce on the way back)
const SWAY_MAX = 0.17;                         // max lean in radians (~10°) — a sway, never a topple
const BEND_FROM_CURSOR = 0.0011;               // a cursor brush sways a plant's canopy (per wu/s of cursor speed, falloff-scaled)
const CREATURE_EVT_MS = 760;   // lifetime of a birth/death cue

// ---- per-pass frame-time anchors + the leaf-litter buffer (module-local) ----
let _lastGrowthFrame = 0, _lastPosFrame = 0, _lastNudgeT = 0, _lastColT = 0, _lastSwayT = 0;
let _lastLeafT = 0, _leafCamX = null, _leafCamY = null;
const leaves = [];

function setLift(id, target, dur, ease) {
  const cur = lifts.get(id), from = cur ? cur.value : 0;
  lifts.set(id, { value: from, from, target, start: performance.now(), dur, ease });
}
function liftValue(id) { const l = lifts.get(id); return l ? l.value : 0; }
// Write a lift value DIRECTLY, bypassing the timer tween — used by the throw glide so a flung
// object DESCENDS as it slows (the lift tracks its remaining speed) instead of dropping via a
// fixed timer only once it has already stopped. The `manual` flag makes updateLifts skip it; a
// later setLift() (on landing) reads the residual value and hands it back to a normal ease-to-0.
function setLiftValue(id, v) { lifts.set(id, { value: v < 0 ? 0 : v > 1 ? 1 : v, manual: true }); }
function updateLifts(now) {
  for (const [id, l] of lifts) {
    if (l.manual) continue;                                 // a flight-lift value owned by updateFlying — don't tween or GC it here
    const t = l.dur > 0 ? Math.min(1, (now - l.start) / l.dur) : 1;
    l.value = l.from + (l.target - l.from) * l.ease(t);
    if (t >= 1 && l.target === 0) lifts.delete(id);
  }
}
function isLifted(id) { return id === S.heldId || liftValue(id) > 0.002; }
function updateGrowth(now) {
  const dt = _lastGrowthFrame ? (now - _lastGrowthFrame) / 1000 : 0;
  _lastGrowthFrame = now;
  const k = dt > 0 ? 1 - Math.pow(0.0002, dt) : 0; // ~reaches target in ~1s
  for (const o of objects.values()) {
    if (o.family === 'stone') continue;
    if (o._matShown == null) o._matShown = o.maturity || 0;
    if (o._agedShown == null) o._agedShown = o.aged || 0;
    o._matShown += ((o.maturity || 0) - o._matShown) * k;
    o._agedShown += ((o.aged || 0) - o._agedShown) * k;
  }
}
function updatePositions(now) {
  const dt = _lastPosFrame ? (now - _lastPosFrame) / 1000 : 0;
  _lastPosFrame = now;
  const k = dt > 0 ? 1 - Math.pow(0.0002, dt) : 0;  // most objects: settle in ~1s
  const kc = dt > 0 ? 1 - Math.pow(0.15, dt) : 0;    // creatures: a gentle ~2-3s glide for the migrating home
  const kr = dt > 0 ? 1 - Math.pow(0.06, dt) : 0;    // a rock rolling out of water: a slower, visible ~1.2s roll to the bank
  for (const o of objects.values()) {
    if (o._tx == null) { o._tx = o.x; o._ty = o.y; continue; }
    if (o.id === S.heldId) { o._tx = o.x; o._ty = o.y; continue; } // locally carried — follows the finger
    const r = o._roll ? kr : (o.family === 'creature' ? kc : k);
    o.x += (o._tx - o.x) * r;
    o.y += (o._ty - o.y) * r;
    if (o._roll && Math.hypot(o._tx - o.x, o._ty - o.y) < 0.6) o._roll = 0; // arrived at the bank — back to normal easing
  }
  for (const giant of S.giants) {
    if (giant._tx == null) continue;
    // It WALKS continuously along its heading between the (slow) broadcasts, only gently
    // correcting toward the latest broadcast spot — so it always looks like it's going
    // somewhere instead of teleport-then-wait. When tending (walk 0) it just settles.
    const ox = giant.x, oy = giant.y;
    const moving = (giant.walk || 0) > 0.1;
    if (moving) { giant.x += (giant.hx || 0) * GIANT_VIS_SPEED * dt; giant.y += (giant.hy || 0) * GIANT_VIS_SPEED * dt; }
    const kg = dt > 0 ? 1 - Math.pow(GIANT_EASE, dt) : 0;
    const corr = moving ? 0.5 : 1;
    giant.x += (giant._tx - giant.x) * kg * corr;
    giant.y += (giant._ty - giant.y) * kg * corr;
    // GAIT from ACTUAL frame speed (so ANY motion — including a correction slide — walks
    // the legs, never a frozen slide); the neck-dip eases toward the server's tending flag.
    const spd = dt > 0 ? Math.hypot(giant.x - ox, giant.y - oy) / dt : 0;
    giant._spd = (giant._spd || 0) + (spd - (giant._spd || 0)) * Math.min(1, dt * 6);
    giant._tend = (giant._tend || 0) + ((giant.tending || 0) - (giant._tend || 0)) * Math.min(1, dt * 3);
    // leave a fading footprint every so many units walked (perpendicular L/R of the heading)
    if (giant._fx == null) { giant._fx = giant.x; giant._fy = giant.y; giant._fside = 1; }
    if (moving && Math.hypot(giant.x - giant._fx, giant.y - giant._fy) >= FOOT_STEP) {
      const px = -(giant.hy || 0), py = (giant.hx || 0); // perpendicular to heading
      giant._fside = -giant._fside;
      giantFootprints.push({ x: giant.x + px * GIANT_R * 0.1 * giant._fside, y: giant.y + py * GIANT_R * 0.1 * giant._fside, start: now });
      giant._fx = giant.x; giant._fy = giant.y;
      if (giantFootprints.length > 60) giantFootprints.shift();
    }
  }
}
function lightnessOf(o) { return o.held ? 0 : formOf(o.family).lightness(o); } // per-family — see forms.js
function collisionGive(o) {
  if (o.held || o.id === S.heldId || flying.has(o.id) || !isMovable(o)) return 0; // held / carried / flying / rooted don't yield
  return formOf(o.family).collisionGive(o); // per-family give — see forms.js
}
function updateNudge(now) {
  const dt = _lastNudgeT ? Math.min(0.05, (now - _lastNudgeT) / 1000) : 0; _lastNudgeT = now;
  if (dt <= 0) return;
  const speed = (now - S.lastHoverT) < 60 ? Math.hypot(mouseVelW.x, mouseVelW.y) : 0;
  const active = speed > NUDGE_MIN_SPEED;
  for (const o of objects.values()) {
    // A sprouted plant SWAYS when the moving cursor brushes it — the canopy leans in the
    // cursor's travel direction (trunk anchored at the base), never sliding the whole
    // tree. Feeds the same _bend spring updateSway settles (Wave M).
    if (active && o.family === 'seed' && shownMat(o) >= SPROUT_C && !o.held && o.id !== S.heldId &&
        Math.abs(o.x - S.mouseWorld.x) < NUDGE_RADIUS && Math.abs(o.y - S.mouseWorld.y) < NUDGE_RADIUS) {
      const d = Math.hypot(o.x - S.mouseWorld.x, o.y - S.mouseWorld.y);
      if (d < NUDGE_RADIUS) { const fall = 1 - d / NUDGE_RADIUS; o._bendV = (o._bendV || 0) + mouseVelW.x * fall * fall * BEND_FROM_CURSOR; swaying.add(o.id); }
    }
    const resting = !o._ox && !o._oy && !o._ovx && !o._ovy;
    // Only objects near the moving cursor are stirred; already-displaced ones still
    // spring back. A resting object that's neither is skipped — so the cost is ~the
    // few things near the cursor + the few in motion, not the whole population.
    const near = active && Math.abs(o.x - S.mouseWorld.x) < NUDGE_RADIUS && Math.abs(o.y - S.mouseWorld.y) < NUDGE_RADIUS;
    if (resting && !near) continue;
    // light things are stirred by the cursor; heavier things still spring back from a
    // collision bump (collisionGive) — only truly fixed things (held/anomaly) are zeroed.
    if (lightnessOf(o) <= 0 && collisionGive(o) <= 0) { if (!resting) { o._ox = o._oy = o._ovx = o._ovy = 0; } continue; }
    o._ox = o._ox || 0; o._oy = o._oy || 0; o._ovx = o._ovx || 0; o._ovy = o._ovy || 0;
    if (near && o.id !== S.heldId) {
      const n = nudge(S.mouseWorld.x, S.mouseWorld.y, o.x + o._ox, o.y + o._oy, NUDGE_RADIUS, speed, NUDGE_STR, lightnessOf(o));
      o._ovx += n.vx * dt; o._ovy += n.vy * dt;
    }
    const sx = spring(o._ox, o._ovx, dt, NUDGE_SPRING, NUDGE_DAMP); // damped spring-back to rest
    const sy = spring(o._oy, o._ovy, dt, NUDGE_SPRING, NUDGE_DAMP);
    o._ox = sx.pos; o._ovx = sx.vel; o._oy = sy.pos; o._ovy = sy.vel;
    const off = Math.hypot(o._ox, o._oy);
    if (off > NUDGE_MAX) { const k = NUDGE_MAX / off; o._ox *= k; o._oy *= k; }
    if (Math.abs(o._ox) < 0.02 && Math.abs(o._oy) < 0.02 && Math.abs(o._ovx) < 0.5 && Math.abs(o._ovy) < 0.5)
      { o._ox = o._oy = o._ovx = o._ovy = 0; }        // settle exactly to rest (no lingering jitter)
  }
}
function updateCollision(now) {
  const dt = _lastColT ? Math.min(0.05, (now - _lastColT) / 1000) : 0; _lastColT = now;
  if (dt <= 0) return;
  const bumpers = [];
  if (S.heldId && S.carry) { const ho = objects.get(S.heldId); if (ho) bumpers.push({ x: S.carry.x, y: S.carry.y, r: objRadius(ho) }); }
  for (const id of flying.keys()) { const o = objects.get(id); if (o) bumpers.push({ x: o.x, y: o.y, r: objRadius(o) }); }
  if (!bumpers.length) return;
  for (const b of bumpers) {
    const R = b.r + COLLIDE_R;
    for (const o of objects.values()) {
      if (Math.abs(o.x - b.x) > R || Math.abs(o.y - b.y) > R) continue;
      const give = collisionGive(o); if (give <= 0) continue;
      const ex = (o.x + (o._ox || 0)) - b.x, ey = (o.y + (o._oy || 0)) - b.y, d = Math.hypot(ex, ey);
      if (d >= R) continue;
      const ux = d > 0.001 ? ex / d : 0, uy = d > 0.001 ? ey / d : 1;
      const f = 1 - d / R, push = COLLIDE_STR * f * f * give;
      o._ovx = (o._ovx || 0) + ux * push * dt; o._ovy = (o._ovy || 0) + uy * push * dt;
    }
  }
}
function updateSway(now) {
  const dt = _lastSwayT ? Math.min(0.05, (now - _lastSwayT) / 1000) : 0; _lastSwayT = now;
  if (dt <= 0 || !swaying.size) return;
  for (const id of swaying) {
    const o = objects.get(id);
    if (!o) { swaying.delete(id); continue; }
    const s = spring(o._bend || 0, o._bendV || 0, dt, SWAY_K, SWAY_DAMP);
    o._bend = clamp(s.pos, -SWAY_MAX, SWAY_MAX); o._bendV = s.vel;
    if (id !== S.swayId && Math.abs(o._bend) < 1e-4 && Math.abs(o._bendV) < 1e-3) { o._bend = 0; o._bendV = 0; swaying.delete(id); }
  }
}
function initLeaves() {
  const r = PG.rng(0x1eaf5);
  for (let i = 0; i < LEAF_N; i++) leaves.push({ x: 0, y: 0, vx: 0, vy: 0, rot: r() * Math.PI * 2, rotV: (r() * 2 - 1) * 0.5, seed: (r() * 4294967296) >>> 0, scale: 0.6 + r() * 0.8, placed: false });
}
function updateLeaves(now) {
  const dt = _lastLeafT ? Math.min(0.05, (now - _lastLeafT) / 1000) : 0; _lastLeafT = now;
  if (dt <= 0) return;
  if (!leaves.length) initLeaves();
  let pvx = 0, pvy = 0;                                    // camera pan velocity (world units/s)
  if (_leafCamX != null) { pvx = (camera.x - _leafCamX) / dt; pvy = (camera.y - _leafCamY) / dt; }
  _leafCamX = camera.x; _leafCamY = camera.y;
  const hw = (vw / 2) / camera.z * LEAF_MARGIN, hh = (vh / 2) / camera.z * LEAF_MARGIN;
  const minX = camera.x - hw, maxX = camera.x + hw, minY = camera.y - hh, maxY = camera.y + hh;
  const cursorSpeed = (now - S.lastHoverT) < 60 ? Math.hypot(mouseVelW.x, mouseVelW.y) : 0;
  const relax = 1 - Math.pow(0.02, dt); // velocity relaxes toward its ambient drift in ~0.5s
  for (const lf of leaves) {
    if (!lf.placed) {                                       // first fill: spread across the whole view
      lf.x = minX + Math.random() * (maxX - minX); lf.y = minY + Math.random() * (maxY - minY);
      lf.vx = (Math.random() * 2 - 1) * LEAF_DRIFT; lf.vy = (Math.random() * 2 - 1) * LEAF_DRIFT;
      lf.placed = true;
    } else if (lf.x < minX || lf.x > maxX || lf.y < minY || lf.y > maxY) { // drifted out → re-enter from an EDGE (streams in, no mid-view pop)
      const e = Math.floor(Math.random() * 4);
      if (e === 0) { lf.x = minX; lf.y = minY + Math.random() * (maxY - minY); }
      else if (e === 1) { lf.x = maxX; lf.y = minY + Math.random() * (maxY - minY); }
      else if (e === 2) { lf.y = minY; lf.x = minX + Math.random() * (maxX - minX); }
      else { lf.y = maxY; lf.x = minX + Math.random() * (maxX - minX); }
      lf.vx = (Math.random() * 2 - 1) * LEAF_DRIFT; lf.vy = (Math.random() * 2 - 1) * LEAF_DRIFT;
    }
    // velocity relaxes toward an AMBIENT drift = breeze minus a fraction of the pan,
    // so panning gently blows the leaves but can never accumulate into a streak.
    const ambVx = Math.sin(now * 0.0003 + lf.seed) * LEAF_BREEZE - pvx * LEAF_PAN;
    const ambVy = Math.cos(now * 0.00027 + lf.seed * 1.3) * LEAF_BREEZE * 0.6 - pvy * LEAF_PAN;
    lf.vx += (ambVx - lf.vx) * relax; lf.vy += (ambVy - lf.vy) * relax;
    if (cursorSpeed > NUDGE_MIN_SPEED && Math.abs(lf.x - S.mouseWorld.x) < NUDGE_RADIUS && Math.abs(lf.y - S.mouseWorld.y) < NUDGE_RADIUS) {
      const n = nudge(S.mouseWorld.x, S.mouseWorld.y, lf.x, lf.y, NUDGE_RADIUS, cursorSpeed, LEAF_CURSOR, 1);
      lf.vx += n.vx * dt; lf.vy += n.vy * dt;                               // a cursor swipe scatters them
    }
    lf.x += lf.vx * dt; lf.y += lf.vy * dt;
    lf.rot += lf.rotV * dt + lf.vx * 0.0008;                               // tumble, swayed by motion
  }
}
function drawLeaves() {
  if (!leaves.length) return;
  const base = PG.mix(PG.PALETTE.growthLight, PG.PALETTE.growthDeep, 0.35);
  const col = PG.applySat(base, seasonSat(S.seasonPhase));
  ctx.save();
  for (const lf of leaves) {
    if (!lf.placed) continue;
    const s = 3.0 * lf.scale;
    ctx.save(); ctx.translate(lf.x, lf.y); ctx.rotate(lf.rot);
    ctx.fillStyle = PG.rgba(col, 0.32);
    ctx.beginPath(); ctx.moveTo(0, -s * 1.6); ctx.bezierCurveTo(s, -s * 0.3, s, s, 0, s * 1.6); ctx.bezierCurveTo(-s, s, -s, -s * 0.3, 0, -s * 1.6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
function drawCreatureEvts(now) {
  for (let i = creatureEvts.length - 1; i >= 0; i--) {
    const e = creatureEvts[i], age = now - e.start;
    if (age > CREATURE_EVT_MS) { creatureEvts.splice(i, 1); continue; }
    const p = age / CREATURE_EVT_MS;                  // 0..1
    const fade = (1 - p) * Math.min(1, p * 5);        // fade in fast, out slow
    ctx.save();
    if (e.birth) {                                    // a spark of new life: an expanding warm-green ring + bloom
      const r = 6 + p * 30;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = PG.rgba('#cfe6a8', 0.5 * fade); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.stroke();
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 0.7);
      g.addColorStop(0, PG.rgba('#cfe6a8', 0.38 * fade)); g.addColorStop(1, PG.rgba('#cfe6a8', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.7, 0, Math.PI * 2); ctx.fill();
    } else {                                          // a passing: a soft grey puff dispersing
      const r = 7 + p * 18, a = 0.42 * (1 - p);
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      g.addColorStop(0, PG.rgba('#8a8076', a)); g.addColorStop(0.6, PG.rgba('#5a5048', a * 0.6)); g.addColorStop(1, PG.rgba('#5a5048', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// ---- wordless "something happened HERE" cues (world space) --------------------
// A single self-expiring buffer (state.worldEvts) makes hidden interactions legible: the
// gardener's touch ('tend'), a creature feeding ('graze'), a communion ('bloom'). Each is a
// soft light bloom at a world point — no text, additive 'lighter' compositing, drawn under
// the same band as the birth/death cues. Cosmetic & client-local (rides a one-shot bcast).
const WORLD_EVT_MS = { tend: 950, graze: 600, bloom: 1500 };
function drawWorldEvts(now) {
  for (let i = worldEvts.length - 1; i >= 0; i--) {
    const e = worldEvts[i], life = WORLD_EVT_MS[e.kind] || 900, age = now - e.start;
    if (age > life) { worldEvts.splice(i, 1); continue; }
    const p = age / life;                             // 0..1
    const fade = (1 - p) * Math.min(1, p * 5);        // in fast, out slow
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (e.kind === 'tend') {
      // the gardener's touch: a warm parchment ring + a green nurture bloom (bigger + gentler than a birth)
      const r = 16 + p * 52;
      ctx.strokeStyle = PG.rgba('#f6efda', 0.40 * fade); ctx.lineWidth = 2.0;
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = PG.rgba('#bcd79a', 0.26 * fade); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.66, 0, Math.PI * 2); ctx.stroke();
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 0.6);
      g.addColorStop(0, PG.rgba('#f6efda', 0.30 * fade)); g.addColorStop(1, PG.rgba('#f6efda', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.6, 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'graze') {
      // a creature nibbling: a small quick warm-green pulse at the plant
      const r = 5 + p * 15;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      g.addColorStop(0, PG.rgba('#cfe6a8', 0.34 * fade)); g.addColorStop(1, PG.rgba('#cfe6a8', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    } else { // 'bloom' — a communion: a slow, wide rose-and-amber gathering of light
      const r = 20 + p * 80;
      ctx.strokeStyle = PG.rgba('#ff9fb0', 0.30 * fade); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.stroke();
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 0.7);
      g.addColorStop(0, PG.rgba('#ffd0b0', 0.26 * fade)); g.addColorStop(0.6, PG.rgba('#ff9fb0', 0.12 * fade)); g.addColorStop(1, PG.rgba('#ff9fb0', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

export { setLift, setLiftValue, liftValue, isLifted, updateLifts, updateGrowth, updatePositions, updateNudge, updateCollision, updateSway, updateLeaves, drawLeaves, drawCreatureEvts, drawWorldEvts };
