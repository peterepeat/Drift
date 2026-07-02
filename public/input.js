// public/input.js — the client's DIRECT-MANIPULATION layer (4.14f mirror): the pointer /
// wheel / gesture handlers, pick-up / carry / throw, tap / double-tap (break / mark /
// giant-skip), long-press + hover ATTEND, and the BEFRIEND dwell. It reads the shared model
// (state.js) + the pure providers (view transforms, draw hit-test, localfx lift API, net
// send) and drives them; it never calls back into client.js, so there's no circular import.
// The frame loop imports the per-frame passes (updateBefriend/Dissolve/Flying) + `attendId`;
// the visibilitychange coordinator imports settleFlying; the bootstrap registers clearHold
// into net via setOnClearHold. The session token + giantChime live here (input-only).
import { canvas, camera, objects, lifts, S, mouseVelW, flying, swaying, creatureEvts } from './state.js';
import { screenToWorld, applyPan, clampCam, zMin, ZMAX, Z0, cancelArrive, startPanGlide, vw, vh } from './view.js';
import { creaturePos, posOf, objRadius, isMovable } from './draw.js';
import { ema, flingStep } from './physics.js'; // hover/carry velocity EMA + the throw integrator (used by trackMouseHover + the fling)
import { setLift, isLifted, LIFT_MS, SETTLE_MS, EASE_RISE, EASE_SETTLE } from './localfx.js';
import { send } from './net.js';
import { formOf, SPROUT_C, shownMat, GIANT_R } from './forms.js';
import { Audio } from './audio.js';
import { IN } from './shared/protocol.js';

const clamp = (v, lo, hi) => (v !== v ? lo : v < lo ? lo : v > hi ? hi : v); // shared 1-liner (also in view/localfx/client)

const pointers = new Map(); // id -> { x, y, sx, sy, maxMove }
const SLOP = 8;                              // px of movement that turns a tap into a pan
const HIT_MIN = 26;                          // min tap radius in CSS px (accessibility)
const HIT_PAD = 3, HIT_GROW = 1.18;          // grab area modestly exceeds the drawn form — easy to grab, but not so greedy it steals pans
const CARRY_SEND_MS = 50;                    // throttle for streaming a carried object
const THROW_MIN = 110;                       // release speed (world units/s) below which a drag just places — no fling (low: a gentle toss flings, esp. on touch)
const THROW_RECENT_MS = 130;                 // the last carry-move must be this recent at release to count as a flick (touch events are sparser → widened from 90)
const THROW_FRICTION = 0.045;                // velocity retained per second mid-fling — LOWER = more friction / harder deceleration (was 0.1 = too floaty/linear); a thrown thing now bleeds speed and settles sooner
const THROW_STOP = 28;                        // a fling settles to a place once it slows below this (wu/s)
const THROW_MAX = 1600;                       // cap the launch speed so a hard flick can't hurl a thing across the world
const PAN_MIN = 170;                          // release speed (world u/s) below which a pan just stops — no inertia glide
const ATTEND_MS = 450;                        // long-press dwell before an object is "attended" (PRD §5.2)
const DBLTAP_MS = 320;                        // two taps on a stone within this BREAK it into smaller stones
const SWAY_IMPULSE = 0.0011;                   // how much a px of drag feeds the lean
const BEFRIEND_DWELL = 4400;            // ms of unbroken attention on one creature to befriend it (doubled: harder to do inadvertently)

// ---- session token ----------------------------------------------------------
// Opaque UUID, never transmitted with identifying info. Used server-side only
// for hold ownership / decay-pause. Last-active area is remembered CLIENT-side
// (here) so the server stores nothing per-token — keeping identity out of it.
let token = localStorage.getItem('drift_session');
if (!token) { token = crypto.randomUUID(); localStorage.setItem('drift_session', token); }

export let attendId = null; // the object currently under attention (hover/long-press); the frame reads it to bloom paintAttend
// The HOLD state (heldId/carry/heldSince/preGrab) lives on S (state.js): input + net WRITE it, draw +
// localfx READ it. preGrab is the pickup restore-target — net.js's PICKUP_ACK reads it on a lost race.
// Anomaly-dissolve timings owned here (updateDissolve lives in this module); client.js imports them.
export const ANOM_DISSOLVE_MS = 10000, ANOM_FADE_MS = 3000; // hold an anomaly 10s → it fades from your hands over the last 3s
let carryHist = [], lastCarryT = 0; // recent {x,y,t} carried positions → a robust release velocity for the throw
let panVel = { x: 0, y: 0 }, lastPanT = 0; // pan velocity (world u/s, ema-smoothed) for release-inertia
const throwDbg = new URLSearchParams(location.search).has('throwdbg'); // ?throwdbg=1 → an on-screen readout of each toss's release speed (mobile)
let dbgEl = null;
function showThrowDbg(msg) {
  if (!dbgEl) { dbgEl = document.createElement('div'); dbgEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.72);color:#9f9;font:12px/1.35 ui-monospace,monospace;padding:6px 9px;border-radius:5px;pointer-events:none;white-space:pre'; document.body.appendChild(dbgEl); }
  dbgEl.textContent = msg;
}
let _lastFlingT = 0, _flyCarryAt = 0; // updateFlying's per-frame throttle anchors
let lpTimer = null, lpFired = false;   // long-press arming (touch)
let befriendTrack = null, befriendSince = 0, befriendSent = false;
let myFriendId = (() => { try { return localStorage.getItem('drift_friend'); } catch { return null; } })(); // a befriended creature, remembered across visits
let pinch = null, multiTouched = false;
let lastMouse = { x: 0, y: 0 };  // last mouse screen position (anchors desktop gesture-zoom)
let lastHoverW = null;              // previous hover world-point (for the velocity sample); S.mouseWorld/mouseVelW/S.lastHoverT now on state.js
let grab = null;                 // pending press on an object: { id, ox, oy } (object-centre − pointer, world units)
let lastTapId = null, lastTapT = 0; // double-tap-a-stone detection (→ break)
let holdMode = null;             // null | 'drag' (an object carried by a pressed pointer)
let holdOff = { x: 0, y: 0 };    // world-unit offset object-centre − pointer, so a grab doesn't snap to centre
let gestureZ0 = Z0, gestureAnchor = null;
let lastCarry = 0;

function giantChime() {
  const x = S.giants[0] ? S.giants[0].x : 0;
  Audio.event('pickup', { seed: 0x51b1, family: 'anomaly', x });
  setTimeout(() => Audio.event('pickup', { seed: 0x7c33, family: 'anomaly', x }), 120);
  setTimeout(() => Audio.event('place', { seed: 0x2e9f, family: 'anomaly', x }), 250);
}
function clearLongPress() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
function hitRadius(o) {
  const base = objRadius(o) * (o._depthScale || 1) * HIT_GROW + HIT_PAD; // depth-scaled (Wave K)
  // Loose seeds/leaves skip the accessible-min floor, so they're only an easy grab when
  // you're zoomed IN (their tiny true size) — picking up litter no longer hijacks a pan.
  if (o.family === 'seed' && shownMat(o) < SPROUT_C) return base;
  return Math.max(base, HIT_MIN / camera.z); // everything else keeps the accessible min tap target
}
function hitTest(w) {
  let pick = null, best = -Infinity;
  for (const o of objects.values()) {
    if (o.held) continue;
    if (!formOf(o.family).pickable) continue; // fish swim free, marks are ground stains — neither pickable
    const p = posOf(o);
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d > hitRadius(o)) continue;
    // The object whose centre is NEAREST the tap wins — so a small thing directly
    // under the cursor beats a larger neighbour whose body merely overlaps the point.
    const score = -d;
    if (score > best) { best = score; pick = o; }
  }
  return pick;
}
function updateHover(cx, cy) { // desktop: attend whatever the mouse rests on
  if (S.heldId) { attendId = null; return; }
  const o = hitTest(screenToWorld(cx, cy));
  attendId = o ? o.id : null;
}
function updateBefriend(now) {
  const o = (attendId && !S.heldId) ? objects.get(attendId) : null;
  if (!o || o.family !== 'creature' || isLifted(o.id)) { befriendTrack = null; befriendSent = false; return; }
  if (o.id !== befriendTrack) { befriendTrack = o.id; befriendSince = now; befriendSent = false; return; } // a new creature → restart the dwell
  if (!befriendSent && now - befriendSince >= BEFRIEND_DWELL) {
    befriendSent = true;
    myFriendId = o.id; try { localStorage.setItem('drift_friend', o.id); } catch {}
    send({ t: IN.BEFRIEND, id: o.id, token, ts: Date.now() });
    const p = creaturePos(o);
    creatureEvts.push({ x: p.x, y: p.y, start: now, birth: true }); // a warm confirming bloom where it stands
    giantChime();                                                   // a soft little flourish (silent unless sound is on)
  }
}
function trackMouseHover(cx, cy) {
  const w = screenToWorld(cx, cy), t = performance.now();
  if (lastHoverW && S.lastHoverT) {
    const dt = (t - S.lastHoverT) / 1000;
    if (dt > 0.001) {
      mouseVelW.x = ema(mouseVelW.x, (w.x - lastHoverW.x) / dt, 0.5);
      mouseVelW.y = ema(mouseVelW.y, (w.y - lastHoverW.y) / dt, 0.5);
    }
  }
  S.mouseWorld = w; lastHoverW = w; S.lastHoverT = t;
}
function beginHold(o, mode, off) {
  // Start the S.carry where the object is actually DRAWN: a free creature wanders off
  // its stored home, so seeding S.carry from o.x/o.y would snap it home on pickup.
  const live = (o.family === 'creature') ? creaturePos(o) : { x: o.x, y: o.y };
  S.preGrab = { x: o.x, y: o.y };                 // the true stored position (net restores to it if the server rejects the grab)
  S.heldId = o.id; holdMode = mode; holdOff = off || { x: 0, y: 0 };
  S.heldSince = performance.now();
  S.carry = { x: live.x, y: live.y };
  carryHist = []; lastCarryT = 0;                 // fresh release-velocity history
  o.held = true;                                  // optimistic; the server confirms via pickup_ack
  setLift(o.id, 1, LIFT_MS, EASE_RISE);
  send({ t: IN.PICKUP, id: o.id, token, ts: Date.now() });
  Audio.event('pickup', { seed: o.seed, family: o.family, x: o.x }); // a generative lift tone (silent unless sound is on)
}
function carryTo(cx, cy) {                         // keep the grab point under the pointer
  if (!S.heldId) return;
  const w = screenToWorld(cx, cy);
  S.carry = { x: w.x + holdOff.x, y: w.y + holdOff.y };
  const o = objects.get(S.heldId); if (o) { o.x = S.carry.x; o.y = S.carry.y; }
  trackVel();
  maybeSendCarry();
}
function trackVel() {
  const t = performance.now();
  carryHist.push({ x: S.carry.x, y: S.carry.y, t });                 // keep ~160ms of carried-position history
  while (carryHist.length > 2 && t - carryHist[0].t > 160) carryHist.shift();
  lastCarryT = t;
}
// Release velocity (world u/s) = the AVERAGE motion over the last ~120ms of the drag. Robust where an
// ema-over-the-whole-drag under-reads a flick and a single last-sample delta is noisy — and it tolerates
// sparse touch pointer events (a flick may only fire a few moves). A paused-before-release drag → the
// window is stationary → ~0 → the object just places. This is why the mouse worked but touch didn't.
function releaseVel() {
  const n = carryHist.length;
  if (n < 2) return { x: 0, y: 0 };
  const last = carryHist[n - 1];
  let ref = carryHist[0];
  for (let i = n - 1; i >= 0; i--) { if (last.t - carryHist[i].t <= 120) ref = carryHist[i]; else break; } // oldest sample within 120ms
  const dt = (last.t - ref.t) / 1000;
  if (dt <= 0.001) return { x: 0, y: 0 };
  return { x: (last.x - ref.x) / dt, y: (last.y - ref.y) / dt };
}
function startFling(vx, vy) {
  const id = S.heldId;
  const o = objects.get(id);
  // A non-finite velocity (the THROW_MAX clamp divides by speed — Infinity/Infinity →
  // NaN) must never reach the glide: it would fly forever, streaming null → (0,0).
  if (!o || !Number.isFinite(vx) || !Number.isFinite(vy)) { placeHold(); return; }
  const sp = Math.hypot(vx, vy);
  if (sp > THROW_MAX) { const k = THROW_MAX / sp; vx *= k; vy *= k; }
  // Remember a KNOWN-FINITE launch point so a corrupted glide can always settle home.
  const x0 = Number.isFinite(o.x) ? o.x : (S.carry ? S.carry.x : 0);
  const y0 = Number.isFinite(o.y) ? o.y : (S.carry ? S.carry.y : 0);
  flying.set(id, { vx, vy, x0, y0, x: x0, y: y0 }); // the fling owns x/y locally (immune to server echoes); stays lifted for the arc
  clearHold();                                      // release the pointer NOW (the object flies on its own)
}
function reanchorCreature(o) { if (o && o.family === 'creature') o.wanderT0 = Date.now() + S.clockSkew; }
function placeHold(kind) {                         // settle the held object where it is
  if (!S.heldId) return;
  const o = objects.get(S.heldId);
  if (o) { o.x = S.carry.x; o.y = S.carry.y; o._tx = S.carry.x; o._ty = S.carry.y; o.held = false; reanchorCreature(o); }
  send({ t: IN.PLACE, id: S.heldId, token, x: S.carry.x, y: S.carry.y, ts: Date.now() });
  setLift(S.heldId, 0, SETTLE_MS, EASE_SETTLE);
  if (o) Audio.event(kind || 'place', { seed: o.seed, family: o.family, x: o.x }); // generative settle/land tone
  clearHold();
}
function clearHold() { S.heldId = null; holdMode = null; S.carry = null; S.preGrab = null; grab = null; }
function maybeSendCarry() {
  const n = performance.now();
  if (n - lastCarry < CARRY_SEND_MS) return;
  lastCarry = n;
  if (S.heldId && S.carry) send({ t: IN.CARRY, id: S.heldId, token, x: S.carry.x, y: S.carry.y, ts: Date.now() });
}
function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  if (pointers.size < 2) pinch = null;
  clearLongPress();
  const wasLong = lpFired; lpFired = false;
  const moved = p ? p.maxMove >= SLOP : false;

  if (holdMode === 'drag') {
    // released an active S.carry: if it was still moving, throw it (detaches); else place it.
    const rv = releaseVel(), speed = Math.hypot(rv.x, rv.y), recent = performance.now() - lastCarryT;
    const willFling = speed > THROW_MIN && recent < THROW_RECENT_MS;
    if (throwDbg) showThrowDbg(`toss  speed ${speed.toFixed(0)}  v(${rv.x.toFixed(0)},${rv.y.toFixed(0)})\nrecent ${recent.toFixed(0)}ms  samples ${carryHist.length}  z ${camera.z.toFixed(2)}\n→ ${willFling ? 'FLING' : 'place (no throw)'}   [min ${THROW_MIN}]`);
    if (willFling) startFling(rv.x, rv.y);
    else placeHold();
  } else if (!moved && !wasLong && !multiTouched) {       // a still, deliberate tap
    const tnow = performance.now();
    const wpt = p ? screenToWorld(p.sx, p.sy) : null;
    const o = grab ? objects.get(grab.id) : null;
    if (wpt && S.giants.some((g) => Math.hypot(wpt.x - g.x, wpt.y - g.y) < GIANT_R * 0.55)) { // a friendly tap on a journeyer
      giantChime();                                       // a warm little chime...
      send({ t: IN.GIANT_SKIP, token, ts: Date.now() });   // ...and it lets go of this task and ambles to the next
    } else if (o && (o.family === 'stone' || (o.family === 'anomaly' && o.kinds && o.kinds.length > 1))) { // double-tap a stone → smaller stones; a fused anomaly → split back into its kinds
      if (lastTapId === o.id && tnow - lastTapT < DBLTAP_MS) { send({ t: IN.BREAK, id: o.id, token, ts: Date.now() }); lastTapId = null; }
      else { lastTapId = o.id; lastTapT = tnow; }
    } else if (!grab && p) {                               // a tap on BARE ground → double-tap leaves a mark (Wave S)
      const w = screenToWorld(p.sx, p.sy);
      if (!hitTest(w)) {                                   // truly empty (not over a rooted tree / object)
        if (lastTapId === 'ground' && tnow - lastTapT < DBLTAP_MS) { send({ t: IN.MARK, x: w.x, y: w.y, ts: Date.now() }); lastTapId = null; }
        else { lastTapId = 'ground'; lastTapT = tnow; }
      }
    }
    grab = null;                                          // a single tap does nothing (no sticky pickup)
  } else {
    // a PAN release — ONE- or TWO-finger: if it was still flicking at the LAST finger up, glide on
    // with momentum. Gated on the final release (pointers.size 0), a recent + fast pan velocity, so a
    // pinch-ZOOM (≈no centroid velocity → below PAN_MIN) and a mid-gesture finger-lift (size > 0) don't.
    if (pointers.size === 0 && (performance.now() - lastPanT) < 130 && Math.hypot(panVel.x, panVel.y) > PAN_MIN) {
      startPanGlide(panVel.x, panVel.y);
    }
    grab = null;
  }
  if (e.pointerType !== 'mouse') attendId = null; // touch attend ends on release (a mouse keeps hovering)
  if (pointers.size === 0) multiTouched = false;
  S.swayId = null;                                  // release the swayed tree — it springs back upright
}
function updateDissolve(now) {
  if (!S.heldId) return;
  const ho = objects.get(S.heldId);
  if (ho && ho.family === 'anomaly' && (now - S.heldSince) >= ANOM_DISSOLVE_MS) {
    send({ t: IN.DISSOLVE, id: S.heldId, token, ts: Date.now() });
    objects.delete(S.heldId); lifts.delete(S.heldId);
    clearHold();
  }
}
function updateFlying(now) {
  if (!flying.size) { _lastFlingT = now; return; }
  const dt = _lastFlingT ? Math.min(0.05, (now - _lastFlingT) / 1000) : 0; _lastFlingT = now;
  if (dt <= 0) return;
  const sendNow = (now - _flyCarryAt) >= CARRY_SEND_MS;
  for (const [id, f] of flying) {
    const o = objects.get(id);
    // Stop ONLY if the object is gone (dissolved). A genuine reclaim/lost-hold deletes `flying`
    // explicitly (PICKUP_ACK ok=false; the disconnect handler clears it) — so we must NOT abort on
    // o.held here: a server ECHO of our own drag can momentarily clear o.held, and that must not kill
    // a valid throw. The fling is CLIENT-authoritative until it lands.
    if (!o) { flying.delete(id); continue; }
    const s = flingStep({ x: f.x, y: f.y }, { x: f.vx, y: f.vy }, dt, THROW_FRICTION, THROW_STOP); // integrate from the fling's OWN x/y; flingStep reads vel.x/.y — MUST pass {x:vx,y:vy} (passing `f` fed it f.x/f.y = undefined→NaN→settle-at-launch: THE reason a fired throw still "dropped")
    // If a position ever goes non-finite, settle at the known-finite launch point rather than stream
    // null (→ a phantom at world 0,0 that never lands).
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      o.x = f.x0; o.y = f.y0; o._tx = f.x0; o._ty = f.y0; o.held = false; reanchorCreature(o);
      setLift(id, 0, SETTLE_MS, EASE_SETTLE);
      send({ t: IN.PLACE, id, token, x: f.x0, y: f.y0, ts: Date.now() });
      flying.delete(id);
      continue;
    }
    f.x = s.x; f.y = s.y; f.vx = s.vx; f.vy = s.vy;                      // advance the fling's own position
    o.x = s.x; o.y = s.y; o._tx = s.x; o._ty = s.y; o.held = true;      // write it onto the object + keep it held, overriding any echo that landed this frame
    if (s.stopped) {
      o.held = false; reanchorCreature(o);
      setLift(id, 0, SETTLE_MS, EASE_SETTLE);        // settle down where it came to rest
      send({ t: IN.PLACE, id, token, x: o.x, y: o.y, ts: Date.now() });
      Audio.event('land', { seed: o.seed, family: o.family, x: o.x });
      flying.delete(id);
    } else if (sendNow) {
      send({ t: IN.CARRY, id, token, x: o.x, y: o.y, ts: Date.now() });
    }
    if (throwDbg) showThrowDbg(`FLYING  pos(${o.x.toFixed(0)},${o.y.toFixed(0)})  v ${Math.hypot(f.vx, f.vy).toFixed(0)}`);
  }
  if (sendNow) _flyCarryAt = now;
}
function settleFlying() {
  for (const id of flying.keys()) {
    const o = objects.get(id);
    if (o) { o.held = false; reanchorCreature(o); o._tx = o.x; o._ty = o.y; setLift(id, 0, SETTLE_MS, EASE_SETTLE); send({ t: IN.PLACE, id, token, x: o.x, y: o.y, ts: Date.now() }); }
  }
  flying.clear();
}

canvas.addEventListener('pointerup', endPointer);
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, maxMove: 0 });
  attendId = null; clearLongPress(); lpFired = false;   // any press interrupts a hover/long-press
  cancelArrive();                                        // a new touch stops any camera auto-motion (arrive OR pan-inertia glide)
  panVel.x = 0; panVel.y = 0; lastPanT = 0;              // fresh pan-velocity for a possible new pan
  if (pointers.size >= 2) {                              // second finger → pinch-zoom + two-finger pan
    multiTouched = true; grab = null;
    if (holdMode === 'drag') placeHold();                // a second finger sets a dragged thing down
    const [a, b] = [...pointers.values()];
    pinch = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: camera.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(w);
  // A movable object becomes a grab candidate — it's picked up once the press MOVES
  // (a still tap does nothing). A rooted tree or empty ground leaves grab null → pan;
  // a press on a rooted tree also arms its SWAY, so a drag across it leans the canopy.
  if (hit && isMovable(hit)) { const c = posOf(hit); grab = { id: hit.id, ox: c.x - w.x, oy: c.y - w.y }; }
  else if (hit) { S.swayId = hit.id; swaying.add(hit.id); }
  // touch/pen: a still long-press attends whatever's under the finger (§5.2), movable or not.
  if (hit && e.pointerType !== 'mouse') lpTimer = setTimeout(() => { attendId = hit.id; lpFired = true; lpTimer = null; grab = null; }, ATTEND_MS);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') { lastMouse.x = e.clientX; lastMouse.y = e.clientY; }
  const p = pointers.get(e.pointerId);
  if (!p) {                                       // no pressed pointer for this id
    if (e.pointerType === 'mouse') { updateHover(e.clientX, e.clientY); trackMouseHover(e.clientX, e.clientY); } // attend + stir light things
    return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  p.maxMove = Math.max(p.maxMove, Math.hypot(e.clientX - p.sx, e.clientY - p.sy));
  if (p.maxMove > SLOP) clearLongPress(); // moved → it's a pan/S.carry, not an attend

  if (pointers.size >= 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const before = screenToWorld(mx, my);
    camera.z = clamp(pinch.z0 * (d / pinch.d0), zMin(), ZMAX);
    const after = screenToWorld(mx, my);
    camera.x += before.x - after.x; camera.y += before.y - after.y;     // zoom, anchored at the centroid
    const panDX = -(mx - pinch.mx) / camera.z, panDY = -(my - pinch.my) / camera.z; // two-finger pan world delta
    const tp = performance.now();                                       // track the CENTROID velocity for release-inertia (same as one-finger)
    if (lastPanT) { const dtp = (tp - lastPanT) / 1000; if (dtp > 0.001) {
      panVel.x = ema(panVel.x, panDX / dtp, 0.4);
      panVel.y = ema(panVel.y, panDY / dtp, 0.4);
    } }
    lastPanT = tp;
    applyPan(panDX, panDY);                                             // two-finger pan (resisted at the edge)
    pinch.mx = mx; pinch.my = my;
    clampCam(); // keep the zoom-anchor jump inside the world too
    cancelArrive();
    return;
  }
  if (pointers.size !== 1) return;

  if (holdMode === 'drag') {
    carryTo(e.clientX, e.clientY);                       // actively carrying
  } else if (grab && p.maxMove > SLOP) {                 // a press on a movable object that moved → pick it up + S.carry
    const o = objects.get(grab.id);
    if (!o) { grab = null; }
    else { beginHold(o, 'drag', { x: grab.ox, y: grab.oy }); carryTo(e.clientX, e.clientY); }
  } else if (!grab && p.maxMove > SLOP) {                // empty ground or a rooted tree → pan
    if (S.swayId) { const o = objects.get(S.swayId); if (o) { o._bendV = (o._bendV || 0) + dx * SWAY_IMPULSE; swaying.add(S.swayId); } } // lean the pressed tree with the drag
    const tp = performance.now();                         // track pan velocity (world u/s) for release-inertia
    if (lastPanT) { const dtp = (tp - lastPanT) / 1000; if (dtp > 0.001) {
      panVel.x = ema(panVel.x, (-dx / camera.z) / dtp, 0.4);
      panVel.y = ema(panVel.y, (-dy / camera.z) / dtp, 0.4);
    } }
    lastPanT = tp;
    applyPan(-dx / camera.z, -dy / camera.z); cancelArrive();
  }
});
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) multiTouched = false;
  clearLongPress(); lpFired = false; attendId = null; S.swayId = null;
  if (holdMode === 'drag') placeHold();           // don't leave a dragged object stuck held
  else grab = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // A trackpad PINCH arrives as a ctrlKey wheel (Chrome/Edge/Firefox) — that zooms,
  // anchored at the cursor. A two-finger SWIPE (no ctrlKey) PANS the landscape — the
  // same gesture moves the world on desktop as on mobile (the spec: "two finger to
  // move across the landscape on both"). Ctrl+wheel still zooms for mouse users.
  if (e.ctrlKey) {
    const before = screenToWorld(e.clientX, e.clientY);
    camera.z = clamp(camera.z * Math.exp(-e.deltaY * 0.01), zMin(), ZMAX);
    const after = screenToWorld(e.clientX, e.clientY);
    camera.x += before.x - after.x; camera.y += before.y - after.y;
    clampCam();
  } else {
    // deltaX/deltaY are in CSS px (or lines, mode 1) — fold zoom out so the world
    // tracks the fingers 1:1; a line-mode wheel gets a per-line nudge.
    const k = e.deltaMode === 1 ? 16 : 1;
    applyPan((e.deltaX * k) / camera.z, (e.deltaY * k) / camera.z);
  }
  cancelArrive();
}, { passive: false });
document.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureZ0 = camera.z;
  gestureAnchor = { x: Number.isFinite(e.clientX) ? e.clientX : lastMouse.x, y: Number.isFinite(e.clientY) ? e.clientY : lastMouse.y };
}, { passive: false });
document.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  const ax = gestureAnchor ? gestureAnchor.x : vw / 2, ay = gestureAnchor ? gestureAnchor.y : vh / 2;
  const before = screenToWorld(ax, ay);
  camera.z = clamp(gestureZ0 * (e.scale || 1), zMin(), ZMAX);
  const after = screenToWorld(ax, ay);
  camera.x += before.x - after.x; camera.y += before.y - after.y; clampCam(); cancelArrive();
}, { passive: false });

export { clearHold, updateBefriend, updateDissolve, updateFlying, settleFlying };
