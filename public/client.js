// =============================================================================
// DRIFT — client: world render loop, camera, pointer input, realtime sync.
// No framework. Canvas 2D. Object forms are ALWAYS regenerated from `seed`;
// no visual data is ever stored or transmitted.
// =============================================================================
import * as PG from './drift-procgen.js';
import { paintGround, paintGlows, paintNoise, paintPresence, paintSeasonGrade, seasonGround, seasonSat, paintWaterWorld, paintFlow } from './render.js';
import { inViewport, CULL_MARGIN } from './cull.js';
import { Audio } from './audio.js';

// ---- tuning constants -------------------------------------------------------
const Z0 = 1.0, ZMIN = 0.2, ZMAX = 4.0;     // zoom = CSS px per world unit
const SLOP = 8;                              // px of movement that turns a tap into a pan
const HIT_MIN = 24;                          // min tap radius in CSS px (accessibility)
const LIFT_MS = 300, SETTLE_MS = 260;        // pickup / place timings (spec)
const CARRY_SEND_MS = 50;                    // throttle for streaming a carried object
const PRESENCE_SEND_MS = 500;                // presence cadence (spec)
const P_IN = 1500, P_OUT = 2500, P_IDLE = 2000; // bloom fade-in / fade-out / idle-before-fade
const SPROUT_C = 0.14;                        // maturity below this renders as a seed (mirrors server)
const ANOM_DISSOLVE_MS = 10000, ANOM_FADE_MS = 3000; // hold an anomaly 10s and it fades from your hands
const ATTEND_MS = 450;                        // long-press dwell before an object is "attended" (PRD §5.2)
const STACK_STEP_C = 12, STACK_TALL_C = 4;   // stone-stack rise/level + tall-stack-tap-to-scatter (mirror server)
const GRIT_MS = 500;                          // a worn-out stone's grit scatter lifetime (spec §4.3)
const POS_EASE_MAX = 24;                       // a position change up to this (a drift hop) eases; larger snaps

// Spec easing curves (Visual Bible §06).
const EASE_RISE = cubicBezier(0.22, 1, 0.36, 1);     // pickup / place lift
const EASE_SETTLE = cubicBezier(0.40, 0, 0.20, 1);   // place settle, no overshoot

// ---- session token ----------------------------------------------------------
// Opaque UUID, never transmitted with identifying info. Used server-side only
// for hold ownership / decay-pause. Last-active area is remembered CLIENT-side
// (here) so the server stores nothing per-token — keeping identity out of it.
let token = localStorage.getItem('drift_session');
if (!token) { token = crypto.randomUUID(); localStorage.setItem('drift_session', token); }

// ---- canvas + viewport sizing ----------------------------------------------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let dpr = 1, vw = 0, vh = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vv = window.visualViewport;
  vw = Math.round(vv ? vv.width : window.innerWidth);
  vh = Math.round(vv ? vv.height : window.innerHeight);
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  canvas.style.width = vw + 'px';
  canvas.style.height = vh + 'px';
}
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
}
window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);
if (window.visualViewport) {
  visualViewport.addEventListener('resize', queueResize);
  visualViewport.addEventListener('scroll', queueResize);
}
resize();

// ---- camera + transforms (all in CSS px; dpr only folded into the matrix) ---
const camera = { x: 0, y: 0, z: Z0 };
let arrive = null; // soft-pan-to-active-area animation

// Return thread (PRD §6.3): the area a visitor was last active in is remembered
// CLIENT-side (never sent as identity — only as a transient viewport hint) so a
// returning visitor is softly oriented back toward where they were, rather than the
// world's global centre-of-gravity. First-time visitors have no home and arrive at
// the cog (PRD §5.4). Stored as the camera centre, throttled while inhabiting.
let home = null;
try { const h = JSON.parse(localStorage.getItem('drift_home') || 'null'); if (h && Number.isFinite(h.x) && Number.isFinite(h.y)) home = h; } catch {}
let arrivedOnce = false, homeSavedAt = 0;
function saveHome(now) {
  if (now - homeSavedAt < 2000) return;          // at most every 2s
  homeSavedAt = now;
  home = { x: camera.x, y: camera.y };
  try { localStorage.setItem('drift_home', JSON.stringify(home)); } catch {}
}

function screenToWorld(sx, sy) {
  return { x: camera.x + (sx - vw / 2) / camera.z, y: camera.y + (sy - vh / 2) / camera.z };
}
function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.z + vw / 2, y: (wy - camera.y) * camera.z + vh / 2 };
}
// Is the water pool's drift band anywhere on screen? (gates the flow-trace pass)
function poolOnScreen() {
  if (!pool) return false;
  const s = worldToScreen(pool.x, pool.y), rr = pool.r * camera.z * 1.4;
  return s.x + rr >= 0 && s.x - rr <= vw && s.y + rr >= 0 && s.y - rr <= vh;
}
function startArrive(tx, ty) {
  arrive = { fromX: camera.x, fromY: camera.y, toX: tx, toY: ty, start: performance.now(), dur: 1200 };
}
function updateArrive(now) {
  if (!arrive) return;
  const t = Math.min(1, (now - arrive.start) / arrive.dur), e = 1 - Math.pow(1 - t, 3);
  camera.x = arrive.fromX + (arrive.toX - arrive.fromX) * e;
  camera.y = arrive.fromY + (arrive.toY - arrive.fromY) * e;
  if (t >= 1) arrive = null;
}

// ---- world state ------------------------------------------------------------
const objects = new Map();     // id -> { id, family, x, y, seed, handling, held(bool), _sg, _sgEr }
const presences = new Map();   // pid -> { x, y, born, last, gone }
const lifts = new Map();       // id -> lift animation state
const flashes = [];            // brief crystal-dissolution flashes { x, y, start }
const grits = [];              // brief stone-to-grit scatters { x, y, seed, r, start }
let pool = null;               // the world water pool { x, y, r }
let myPid = null;
let seasonPhase = 0;           // monotonic season clock from the server (feels, never labelled)
let lastSat = -1;              // last-applied canvas saturation (avoids per-frame style writes)
let animT = 0;                 // seconds, drives the only animated objects (anomalies)

// local hold
let heldId = null, carry = null, preGrab = null;
let heldSince = 0;             // when the local hold began (drives anomaly dissolution)

// ---- lift animation ---------------------------------------------------------
function setLift(id, target, dur, ease) {
  const cur = lifts.get(id), from = cur ? cur.value : 0;
  lifts.set(id, { value: from, from, target, start: performance.now(), dur, ease });
}
function liftValue(id) { const l = lifts.get(id); return l ? l.value : 0; }
function updateLifts(now) {
  for (const [id, l] of lifts) {
    const t = l.dur > 0 ? Math.min(1, (now - l.start) / l.dur) : 1;
    l.value = l.from + (l.target - l.from) * l.ease(t);
    if (t >= 1 && l.target === 0) lifts.delete(id);
  }
}
// An object is rendered in the lifted screen-space pass while it is being held
// (locally or remotely) or while it is settling. The world pass skips these.
function isLifted(id) { return id === heldId || liftValue(id) > 0.002; }

// ---- deterministic-from-seed sizing (never stored) --------------------------
function stoneSize(seed) { return 12 + PG.rng(seed >>> 0)() * 34; }            // pebble..rock, world units
function seedScale(seed) { return 0.9 + PG.rng((seed ^ 0x9e3779b9) >>> 0)() * 0.9; }
function anomalyR(o) { return 18 + PG.rng(o.seed >>> 0)() * 14; } // luminous, ~18-32 wu
function crystalR(o) { return 6 + PG.rng(o.seed >>> 0)() * 7; }   // small, ~6-13 wu
// Smoothly-tweened lifecycle the renderer reads (eased toward server values so
// the 60s growth steps don't pop). Falls back to the raw value before first tween.
function shownMat(o) { return o._matShown != null ? o._matShown : (o.maturity || 0); }
function shownAged(o) { return o._agedShown != null ? o._agedShown : (o.aged || 0); }
function objRadius(o) {
  if (o.family === 'stone') return stoneSize(o.seed);
  if (o.family === 'anomaly') return anomalyR(o);
  if (o.family === 'crystal') return crystalR(o);
  const mat = shownMat(o);
  return mat < SPROUT_C ? 10 * seedScale(o.seed) : 10 + mat * 26; // plants present a larger tap target
}
function stoneGeom(o) {
  const er = Math.min(0.95, o.handling * 0.04); // handling erodes the stone (PRD §3.2)
  if (!o._sg || o._sgEr !== er) { o._sg = PG.makeStone(o.seed >>> 0, stoneSize(o.seed), er); o._sgEr = er; }
  return o._sg;
}
// Draw any object (stone, seed, or plant) at (cx, cy) in the current transform.
// FORM is always regenerated from seed (+ maturity/aged for growth) — never stored.
function paintObject(o, cx, cy) {
  if (o.family === 'stone') { PG.drawStone(ctx, stoneGeom(o), cx, cy); return; }
  if (o.family === 'anomaly') { PG.drawAnomaly(ctx, o.kind || 'breath', animT, cx, cy, anomalyR(o)); return; }
  if (o.family === 'crystal') { PG.drawCrystal(ctx, o.seed >>> 0, cx, cy, crystalR(o), animT); return; }
  const mat = shownMat(o), aged = shownAged(o);
  if (mat < SPROUT_C) PG.drawSeed(ctx, o.seed >>> 0, cx, cy, seedScale(o.seed) * (1 + mat * 1.4));
  else PG.drawPlant(ctx, o.seed >>> 0, cx, cy, mat, aged);
}
function drawObjectWorld(o) {
  if (o.family === 'stone' && (o.stack || 0) > 0) { // seat each stacked stone with a soft contact shadow
    const rad = objRadius(o);
    ctx.save();
    ctx.fillStyle = PG.rgba('#000000', 0.22);
    ctx.beginPath(); ctx.ellipse(o.x, o.y + rad * 0.5, rad * 0.8, rad * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  paintObject(o, o.x, o.y);
}
// The "reveal of age" (PRD §5.2): how far along its life an attended object is, so
// the attend-bloom is larger and warmer the older/more-worn the object — its history
// made briefly legible without a single word or number.
function ageFactor(o) {
  if (o.family === 'stone') return Math.min(1, (o.handling || 0) / 26);   // worn smooth = old (mirror GRIT_HANDLING)
  if (o.family === 'crystal') return Math.min(1, o.decay || 0);           // closer to its flash-dissolution
  if (o.family === 'anomaly') return 0.5;                                 // timeless — a steady, even reveal
  return Math.min(1, shownMat(o) * 0.55 + shownAged(o) * 0.65);           // seed → plant → aged
}
// A soft warm bloom that breathes around the attended object (its "response").
function paintAttend(o, t) {
  const age = ageFactor(o);
  const rad = objRadius(o) * (1.7 + 1.3 * age);
  const breath = 0.6 + 0.4 * Math.sin(animT * 1.6);     // slow pulse = the object responding
  const a = 0.16 * t * breath * (0.55 + 0.45 * age);    // older → warmer reveal
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, rad);
  g.addColorStop(0, PG.rgba('#e8c87a', a));
  g.addColorStop(1, PG.rgba('#e8c87a', 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(o.x, o.y, rad, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// A stack's ground line (the base sits here; each level is stored STACK_STEP up).
function groundY(o) { return o.y + (o.stack || 0) * STACK_STEP_C; }
// Height of the stack a stone belongs to (1 = a lone stone on the ground).
function stackHeight(o) {
  const baseId = o.stackBase || o.id;
  let top = 0;
  for (const s of objects.values()) {
    if (s.family !== 'stone') continue;
    if ((s.stackBase || s.id) === baseId) top = Math.max(top, s.stackBase ? (s.stack || 0) : 0);
  }
  return top + 1;
}
// Lifted object drawn in screen space so the 10px rise / shadow stay constant
// regardless of zoom; intrinsic size still scales with zoom via camera.z.
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
  paintObject(o, 0, 0);
  ctx.restore();
}
// Ease each object's rendered maturity/aged toward the server's value.
let _lastGrowthFrame = 0;
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
// Ease each object's rendered position toward its target so a water-drift hop
// (a small server position update) creeps instead of popping. Snap updates set
// _tx==x so this is a no-op for them; the locally-carried object is excluded.
let _lastPosFrame = 0;
function updatePositions(now) {
  const dt = _lastPosFrame ? (now - _lastPosFrame) / 1000 : 0;
  _lastPosFrame = now;
  const k = dt > 0 ? 1 - Math.pow(0.0002, dt) : 0; // ~reaches target in ~1s
  for (const o of objects.values()) {
    if (o._tx == null) { o._tx = o.x; o._ty = o.y; continue; }
    if (o.id === heldId) { o._tx = o.x; o._ty = o.y; continue; } // locally carried — follows the finger
    o.x += (o._tx - o.x) * k;
    o.y += (o._ty - o.y) * k;
  }
}
// Holding an anomaly for 10s dissolves it (it fades from your hands — never explained).
function updateDissolve(now) {
  if (!heldId) return;
  const ho = objects.get(heldId);
  if (ho && ho.family === 'anomaly' && (now - heldSince) >= ANOM_DISSOLVE_MS) {
    send({ t: 'dissolve', id: heldId, token, ts: Date.now() });
    objects.delete(heldId); lifts.delete(heldId);
    heldId = null; carry = null; preGrab = null;
  }
}

// ---- presence fade envelope -------------------------------------------------
function presenceIntensity(p, now) {
  let inF = Math.min(1, (now - p.born) / P_IN); inF = 1 - Math.pow(1 - inF, 3);
  let outF = 1;
  if (p.gone) outF = 1 - Math.min(1, (now - p.gone) / P_OUT);
  else { const idle = now - p.last; if (idle > P_IDLE) outF = 1 - Math.min(1, (idle - P_IDLE) / P_OUT); }
  return Math.max(0, inF * outF);
}

// ---- attend (PRD §5.2): hover (desktop) / long-press (mobile) reveals an object's
// age. Purely a visual response — no server message, no state change. `attendId` is
// the object under attention; `attendT` eases its reveal in/out in the render loop.
let attendId = null, attendT = 0;
let lpTimer = null, lpFired = false;   // long-press arming (touch)
function clearLongPress() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
// Topmost free object under world point w (shared by tap-to-pick and attend).
function hitTest(w) {
  let pick = null, best = -Infinity;
  for (const o of objects.values()) {
    if (o.held) continue;
    const r = Math.max(objRadius(o), HIT_MIN / camera.z);
    if (Math.hypot(o.x - w.x, o.y - w.y) > r) continue;
    const score = (o.stack || 0) * 1e6 + o.y;
    if (score > best) { best = score; pick = o; }
  }
  return pick;
}
function updateHover(cx, cy) { // desktop: attend whatever the mouse rests on
  if (heldId) { attendId = null; return; }
  const o = hitTest(screenToWorld(cx, cy));
  attendId = o ? o.id : null;
}

// ---- pointer input (Pointer Events only) ------------------------------------
const pointers = new Map(); // id -> { x, y, sx, sy, maxMove }
let pinch = null, multiTouched = false;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, maxMove: 0 });
  attendId = null; clearLongPress(); lpFired = false;   // any press interrupts a hover/long-press
  if (pointers.size >= 2) {
    multiTouched = true;
    const [a, b] = [...pointers.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: camera.z };
  } else if (!heldId) {
    // arm a long-press: dwell stationary on an object → attend it (mobile §5.2)
    const hit = hitTest(screenToWorld(e.clientX, e.clientY));
    if (hit) lpTimer = setTimeout(() => { attendId = hit.id; lpFired = true; lpTimer = null; }, ATTEND_MS);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) { if (e.pointerType === 'mouse') updateHover(e.clientX, e.clientY); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  p.maxMove = Math.max(p.maxMove, Math.hypot(e.clientX - p.sx, e.clientY - p.sy));
  if (p.maxMove > SLOP) clearLongPress(); // moved → it's a pan/carry, not an attend

  if (pointers.size >= 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const before = screenToWorld(mx, my);
    camera.z = clamp(pinch.z0 * (d / pinch.d0), ZMIN, ZMAX);
    const after = screenToWorld(mx, my);
    camera.x += before.x - after.x; camera.y += before.y - after.y;
    arrive = null;
  } else if (pointers.size === 1) {
    if (heldId) {
      carry = screenToWorld(e.clientX, e.clientY);
      const o = objects.get(heldId); if (o) { o.x = carry.x; o.y = carry.y; }
      maybeSendCarry();
    } else if (p.maxMove > SLOP) {
      camera.x -= dx / camera.z; camera.y -= dy / camera.z; arrive = null;
    }
  }
});

function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  if (pointers.size < 2) pinch = null;
  clearLongPress();
  const wasLong = lpFired; lpFired = false;
  if (e.pointerType !== 'mouse') attendId = null; // touch attend ends on release (a mouse keeps hovering)
  // Tap = single stationary pointer, no multi-touch, and NOT a long-press attend.
  const wasTap = p && p.maxMove < SLOP && pointers.size === 0 && !multiTouched && !wasLong;
  if (pointers.size === 0) multiTouched = false;
  if (wasTap) handleTap(e.clientX, e.clientY);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) multiTouched = false;
  clearLongPress(); lpFired = false; attendId = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = screenToWorld(e.clientX, e.clientY);
  camera.z = clamp(camera.z * Math.exp(-e.deltaY * 0.0015), ZMIN, ZMAX);
  const after = screenToWorld(e.clientX, e.clientY);
  camera.x += before.x - after.x; camera.y += before.y - after.y; arrive = null;
}, { passive: false });

// Kill Safari's page pinch-zoom that touch-action alone misses.
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));

function handleTap(cx, cy) {
  if (heldId) { // place
    const w = screenToWorld(cx, cy);
    const o = objects.get(heldId);
    if (o) { o.x = w.x; o.y = w.y; o._tx = w.x; o._ty = w.y; o.held = false; }
    send({ t: 'place', id: heldId, token, x: w.x, y: w.y, ts: Date.now() });
    setLift(heldId, 0, SETTLE_MS, EASE_SETTLE);
    heldId = null; carry = null; preGrab = null;
    return;
  }
  // pick up topmost: the top of a stack wins, else the frontmost (largest y)
  const pick = hitTest(screenToWorld(cx, cy));
  // Tapping a tall stack topples it instead of lifting a stone off the top.
  if (pick && pick.family === 'stone' && stackHeight(pick) >= STACK_TALL_C) {
    send({ t: 'scatter', id: pick.id, token, ts: Date.now() });
    return;
  }
  if (pick) {
    preGrab = { x: pick.x, y: pick.y };
    heldId = pick.id; carry = { x: pick.x, y: pick.y }; heldSince = performance.now();
    pick.held = true;                       // optimistic
    setLift(pick.id, 1, LIFT_MS, EASE_RISE);
    send({ t: 'pickup', id: pick.id, token, ts: Date.now() });
  }
}

let lastCarry = 0;
function maybeSendCarry() {
  const n = performance.now();
  if (n - lastCarry < CARRY_SEND_MS) return;
  lastCarry = n;
  if (heldId && carry) send({ t: 'carry', id: heldId, token, x: carry.x, y: carry.y, ts: Date.now() });
}

// ---- websocket + reconnect --------------------------------------------------
let ws = null, wsReady = false, attempts = 0, reconnectT = null;
const dot = document.getElementById('dot');
const dothit = document.getElementById('dothit');
let dotTimer = null;

function flashDot() { dot.classList.add('show'); clearTimeout(dotTimer); dotTimer = setTimeout(() => dot.classList.remove('show'), 2000); }
function setDot(connected) {
  dot.classList.toggle('connected', connected);
  dot.classList.toggle('reconnecting', !connected);
  flashDot();
}
dothit.addEventListener('pointerenter', () => { dot.classList.add('show'); clearTimeout(dotTimer); });
dothit.addEventListener('pointerleave', () => { dotTimer = setTimeout(() => dot.classList.remove('show'), 2000); });

// ---- ambient sound: one corner glyph, opt-in (PRD §8.4) ---------------------
const snd = document.getElementById('snd');
const sndhit = document.getElementById('sndhit');
let sndTimer = null;
let aDensity = 0, aWarmth = 0, aWater = 0;            // world -> sound, gathered each frame
const audioState = () => ({ seasonPhase, density: aDensity, warmth: aWarmth, water: aWater });
function flashSnd() { snd.classList.add('show'); clearTimeout(sndTimer); sndTimer = setTimeout(() => snd.classList.remove('show'), 2000); }
function reflectSnd() { snd.classList.toggle('on', Audio.isEnabled()); flashSnd(); }
sndhit.addEventListener('pointerenter', () => { snd.classList.add('show'); clearTimeout(sndTimer); });
sndhit.addEventListener('pointerleave', () => { sndTimer = setTimeout(() => snd.classList.remove('show'), 2000); });
sndhit.addEventListener('click', () => {
  const on = Audio.toggle(audioState());           // the tap is what unlocks the AudioContext
  localStorage.setItem('drift_sound', on ? '1' : '0');
  reflectSnd();
});
// Remembered "on": reflect it immediately, but only actually start from the next
// user gesture (browsers block autoplay) — don't auto-start on load. A tap on the
// control itself is left to its own click handler (so we don't enable-then-toggle
// it straight back off); any other first gesture starts the remembered sound.
if (localStorage.getItem('drift_sound') === '1') {
  snd.classList.add('on'); flashSnd();
  const armStart = (e) => {
    if (Audio.isEnabled()) { window.removeEventListener('pointerdown', armStart); return; }
    if (e.target === sndhit) return; // the control's click will start it
    Audio.enable(audioState()); reflectSnd();
    window.removeEventListener('pointerdown', armStart);
  };
  window.addEventListener('pointerdown', armStart);
}
document.addEventListener('visibilitychange', () => { document.hidden ? Audio.onHidden() : Audio.onVisible(); });

// Half-extents of the current viewport in world units — what the server needs to
// know which objects we can see (interest management). dpr is already folded out.
function viewHalf() { return { hw: (vw / 2) / camera.z, hh: (vh / 2) / camera.z }; }
function wsUrl() {
  const h = viewHalf();
  let q = `?hw=${Math.round(h.hw)}&hh=${Math.round(h.hh)}`;
  if (home) q += `&cx=${Math.round(home.x)}&cy=${Math.round(home.y)}`; // return thread: land the initial payload on our area, not the cog
  return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws' + q;
}
function connect() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => { wsReady = true; attempts = 0; setDot(true); });
  ws.addEventListener('message', (ev) => onMessage(ev.data));
  ws.addEventListener('close', () => { wsReady = false; setDot(false); onDisconnect(); scheduleReconnect(); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
function scheduleReconnect() {
  if (reconnectT) return;
  const base = Math.min(30000, 1000 * Math.pow(2, attempts)); // exponential backoff, max 30s
  const delay = base * (0.7 + Math.random() * 0.6);           // jitter
  attempts++;
  reconnectT = setTimeout(() => { reconnectT = null; connect(); }, delay);
}
function send(o) { if (ws && wsReady) { try { ws.send(JSON.stringify(o)); } catch {} } }
function onDisconnect() {
  // Our hold is lost; the server reclaims it and drops the object server-side.
  if (heldId) { const o = objects.get(heldId); if (o) o.held = false; setLift(heldId, 0, SETTLE_MS, EASE_SETTLE); }
  heldId = null; carry = null; preGrab = null;
}

function onMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'world_state': {
      myPid = m.pid;
      objects.clear(); lifts.clear();
      for (const o of m.objects) objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      if (m.season != null) seasonPhase = m.season;
      if (m.pool) pool = m.pool;
      // Orient on the FIRST arrival only (a reconnect must not yank the camera back):
      // a returning visitor drifts toward their remembered home, a new one toward the cog.
      if (!arrivedOnce) { arrivedOnce = true; const t = home || m.cog; if (t) startArrive(t.x, t.y); }
      break;
    }
    case 'object_state': {
      const o = objects.get(m.id);
      if (!o) break; // unknown (already dissolved) — ignore
      const wasHeld = o.held;
      // A small move on a free object is water-drift — ease it (no pop), like growth.
      // Larger jumps (place, scatter, topple, initial) snap. Held objects always snap.
      const dx = m.x - o.x, dy = m.y - o.y;
      if (!m.held && m.id !== heldId && dx * dx + dy * dy <= POS_EASE_MAX * POS_EASE_MAX) {
        o._tx = m.x; o._ty = m.y; // leave o.x/o.y to glide toward the target
      } else {
        o.x = m.x; o.y = m.y; o._tx = m.x; o._ty = m.y;
      }
      o.handling = m.handling; o.held = !!m.held;
      if (m.maturity != null) o.maturity = m.maturity;
      if (m.aged != null) o.aged = m.aged;
      if (m.stack != null) o.stack = m.stack;
      if (m.stackBase != null) o.stackBase = m.stackBase;
      if (m.id !== heldId) {
        if (o.held && !wasHeld) setLift(o.id, 1, LIFT_MS, EASE_RISE);
        else if (!o.held && wasHeld) setLift(o.id, 0, SETTLE_MS, EASE_SETTLE);
      }
      break;
    }
    case 'season': { // the world's slow clock advanced
      if (m.phase != null) seasonPhase = m.phase;
      break;
    }
    case 'object_new': { // a shed seed (or other runtime-spawned object)
      const o = m.o;
      objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      break;
    }
    case 'world_patch': { // interest streaming: objects paging into view as we pan
      for (const o of m.objects) {
        if (objects.has(o.id)) continue; // already known — leave its animation state alone
        objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      }
      break;
    }
    case 'object_gone': {
      const og = objects.get(m.id);
      if (og && og.family === 'crystal') flashes.push({ x: og.x, y: og.y, start: performance.now() }); // brief flash
      else if (og && (og.family === 'stone' || m.grit)) // worn to grit — a brief scatter of dust
        grits.push({ x: og.x, y: og.y, seed: og.seed, r: objRadius(og), start: performance.now() });
      objects.delete(m.id); lifts.delete(m.id);
      if (heldId === m.id) { heldId = null; carry = null; preGrab = null; }
      break;
    }
    case 'pickup_ack': {
      if (!m.ok && heldId === m.id) { // lost the race — snap back
        const o = objects.get(m.id);
        // held=false so the server's corrective object_state (held:true, from the
        // real holder) re-lifts it; leaving it true would suppress that re-lift.
        if (o && preGrab) { o.x = preGrab.x; o.y = preGrab.y; o._tx = preGrab.x; o._ty = preGrab.y; o.held = false; }
        setLift(m.id, 0, SETTLE_MS, EASE_SETTLE);
        heldId = null; carry = null; preGrab = null;
      }
      break;
    }
    case 'presence': {
      if (m.pid === myPid) break;
      const now = performance.now();
      const p = presences.get(m.pid);
      if (!p) presences.set(m.pid, { x: m.x, y: m.y, born: now, last: now, gone: 0 });
      else { p.x = m.x; p.y = m.y; p.last = now; } // never un-set `gone`: presence_gone must finish its fade
      break;
    }
    case 'presence_gone': {
      const p = presences.get(m.pid); if (p) p.gone = performance.now();
      break;
    }
  }
}

// presence: broadcast where we are inhabiting (camera centre), every 500ms.
setInterval(() => {
  if (!wsReady) return;
  const c = screenToWorld(vw / 2, vh / 2);
  const h = viewHalf();
  send({ t: 'presence_move', x: c.x, y: c.y, hw: h.hw, hh: h.hh, ts: Date.now() });
  saveHome(performance.now()); // remember where we've been inhabiting (return thread, §6.3)
}, PRESENCE_SEND_MS);

// ---- render loop ------------------------------------------------------------
const bgSeed = PG.seedFrom('drift-ground');
function frame(now) {
  animT = now / 1000;
  updateLifts(now);
  updateGrowth(now);
  updatePositions(now);
  updateDissolve(now);
  updateArrive(now);

  // background (screen space) — world-locked objects pan over a near-fixed
  // backdrop, which reads as subtle parallax depth.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  paintGround(ctx, vw, vh, seasonGround(seasonPhase));
  paintGlows(ctx, vw, vh, bgSeed);
  paintNoise(ctx, vw, vh, bgSeed + 1);

  // objects (world space) — single matrix folds dpr + zoom + pan
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z,
    dpr * (vw / 2 - camera.x * camera.z), dpr * (vh / 2 - camera.y * camera.z));
  paintWaterWorld(ctx, pool, animT); // wet sheen beneath the objects
  if (poolOnScreen()) paintFlow(ctx, pool, animT); // faint flow streaks — only when the pool is in view
  const list = [];
  // Viewport culling: only the objects on (or just off) screen are sorted/drawn.
  // Lifted/held objects are never culled — they're drawn in the screen-space pass.
  for (const o of objects.values()) {
    if (isLifted(o.id)) continue;
    const s = worldToScreen(o.x, o.y);
    if (!inViewport(s.x, s.y, vw, vh, CULL_MARGIN)) continue;
    list.push(o);
  }
  // painter's depth by ground line, then bottom-up within a stack so the top stone occludes
  list.sort((a, b) => (groundY(a) - groundY(b)) || ((a.stack || 0) - (b.stack || 0)) || (a.id < b.id ? -1 : 1));
  // attend (§5.2): ease the reveal in/out and bloom it behind the attended object
  attendT += ((attendId ? 1 : 0) - attendT) * 0.14;
  if (attendT > 0.01 && attendId) { const ao = objects.get(attendId); if (ao && !isLifted(ao.id)) paintAttend(ao, attendT); }
  for (const o of list) drawObjectWorld(o);
  // worn-out stones crumble to a brief scatter of grit (world space, ~500ms)
  for (let i = grits.length - 1; i >= 0; i--) {
    const g = grits[i], age = now - g.start;
    if (age > GRIT_MS) { grits.splice(i, 1); continue; }
    const p = age / GRIT_MS;
    PG.drawGrit(ctx, g.seed >>> 0, g.x, g.y, g.r * (0.4 + p * 1.5), 0.8 * (1 - p));
  }

  aDensity = list.length; // objects on screen — feeds the ambient sound's richness

  // overlays (screen space)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let warmth = 0;
  for (const [pid, p] of presences) {
    const inten = presenceIntensity(p, now);
    if (inten <= 0) {
      if ((p.gone && now - p.gone > P_OUT) || (now - p.last > P_IDLE + P_OUT)) presences.delete(pid);
      continue;
    }
    if (inten > warmth) warmth = inten;
    const s = worldToScreen(p.x, p.y);
    paintPresence(ctx, vw, vh, s.x, s.y, vw * 0.55, inten);
  }
  aWarmth = warmth; // free (piggybacks the presence pass)
  if (Audio.isEnabled()) {
    aWater = poolOnScreen() ? 0.5 + 0.5 * Math.sin(animT * 0.4) : 0; // matches the visible sheen's shimmer
    Audio.setState(audioState());
  }
  for (const o of objects.values()) {
    if (!isLifted(o.id)) continue;
    const s = (o.id === heldId && carry) ? worldToScreen(carry.x, carry.y) : worldToScreen(o.x, o.y);
    let alpha = 1;
    if (o.id === heldId && o.family === 'anomaly') { // fade out over the last seconds of the 10s hold
      alpha = 1 - clamp((now - heldSince - (ANOM_DISSOLVE_MS - ANOM_FADE_MS)) / ANOM_FADE_MS, 0, 1);
    }
    ctx.globalAlpha = alpha;
    drawHeldScreen(o, s.x, s.y, liftValue(o.id));
    ctx.globalAlpha = 1;
  }
  // brief crystal-dissolution flashes (~180ms expanding ring)
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i], age = now - f.start;
    if (age > 180) { flashes.splice(i, 1); continue; }
    const p = age / 180, s = worldToScreen(f.x, f.y);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = PG.rgba('#eaf4ff', 0.85 * (1 - p)); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, 4 + p * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  paintSeasonGrade(ctx, vw, vh, seasonPhase); // season composite (crossfaded), last

  // season saturation as a GPU CSS filter on the canvas (set only on change)
  const sat = seasonSat(seasonPhase);
  if (Math.abs(sat - lastSat) > 0.001) { canvas.style.filter = sat < 0.999 ? `saturate(${sat.toFixed(3)})` : 'none'; lastSat = sat; }

  requestAnimationFrame(frame);
}

// ---- helpers ----------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cubicBezier(x1, y1, x2, y2) {
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

// ---- go ---------------------------------------------------------------------
connect();
requestAnimationFrame(frame);
