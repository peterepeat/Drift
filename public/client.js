// =============================================================================
// DRIFT — client: world render loop, camera, pointer input, realtime sync.
// No framework. Canvas 2D. Object forms are ALWAYS regenerated from `seed`;
// no visual data is ever stored or transmitted.
// =============================================================================
import * as PG from './drift-procgen.js';
import { paintGround, paintGlows, paintNoise, paintPresence, paintSeasonGrade, seasonGround, seasonSat } from './render.js';

// ---- tuning constants -------------------------------------------------------
const Z0 = 1.0, ZMIN = 0.2, ZMAX = 4.0;     // zoom = CSS px per world unit
const SLOP = 8;                              // px of movement that turns a tap into a pan
const HIT_MIN = 24;                          // min tap radius in CSS px (accessibility)
const LIFT_MS = 300, SETTLE_MS = 260;        // pickup / place timings (spec)
const CARRY_SEND_MS = 50;                    // throttle for streaming a carried object
const PRESENCE_SEND_MS = 500;                // presence cadence (spec)
const P_IN = 1500, P_OUT = 2500, P_IDLE = 2000; // bloom fade-in / fade-out / idle-before-fade
const SPROUT_C = 0.14;                        // maturity below this renders as a seed (mirrors server)

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

function screenToWorld(sx, sy) {
  return { x: camera.x + (sx - vw / 2) / camera.z, y: camera.y + (sy - vh / 2) / camera.z };
}
function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.z + vw / 2, y: (wy - camera.y) * camera.z + vh / 2 };
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
let myPid = null;
let seasonPhase = 0;           // monotonic season clock from the server (feels, never labelled)
let lastSat = -1;              // last-applied canvas saturation (avoids per-frame style writes)

// local hold
let heldId = null, carry = null, preGrab = null;

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
// Smoothly-tweened lifecycle the renderer reads (eased toward server values so
// the 60s growth steps don't pop). Falls back to the raw value before first tween.
function shownMat(o) { return o._matShown != null ? o._matShown : (o.maturity || 0); }
function shownAged(o) { return o._agedShown != null ? o._agedShown : (o.aged || 0); }
function objRadius(o) {
  if (o.family === 'stone') return stoneSize(o.seed);
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
  const mat = shownMat(o), aged = shownAged(o);
  if (mat < SPROUT_C) PG.drawSeed(ctx, o.seed >>> 0, cx, cy, seedScale(o.seed) * (1 + mat * 1.4));
  else PG.drawPlant(ctx, o.seed >>> 0, cx, cy, mat, aged);
}
function drawObjectWorld(o) { paintObject(o, o.x, o.y); }
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

// ---- presence fade envelope -------------------------------------------------
function presenceIntensity(p, now) {
  let inF = Math.min(1, (now - p.born) / P_IN); inF = 1 - Math.pow(1 - inF, 3);
  let outF = 1;
  if (p.gone) outF = 1 - Math.min(1, (now - p.gone) / P_OUT);
  else { const idle = now - p.last; if (idle > P_IDLE) outF = 1 - Math.min(1, (idle - P_IDLE) / P_OUT); }
  return Math.max(0, inF * outF);
}

// ---- pointer input (Pointer Events only) ------------------------------------
const pointers = new Map(); // id -> { x, y, sx, sy, maxMove }
let pinch = null, multiTouched = false;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, maxMove: 0 });
  if (pointers.size >= 2) {
    multiTouched = true;
    const [a, b] = [...pointers.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: camera.z };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  p.maxMove = Math.max(p.maxMove, Math.hypot(e.clientX - p.sx, e.clientY - p.sy));

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
  // Tap = single stationary pointer, no multi-touch this gesture, any duration.
  const wasTap = p && p.maxMove < SLOP && pointers.size === 0 && !multiTouched;
  if (pointers.size === 0) multiTouched = false;
  if (wasTap) handleTap(e.clientX, e.clientY);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) multiTouched = false;
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
    if (o) { o.x = w.x; o.y = w.y; o.held = false; }
    send({ t: 'place', id: heldId, token, x: w.x, y: w.y, ts: Date.now() });
    setLift(heldId, 0, SETTLE_MS, EASE_SETTLE);
    heldId = null; carry = null; preGrab = null;
    return;
  }
  // pick up topmost (largest y is drawn last / on top)
  const w = screenToWorld(cx, cy);
  let pick = null, best = -Infinity;
  for (const o of objects.values()) {
    if (o.held) continue;
    const r = Math.max(objRadius(o), HIT_MIN / camera.z);
    if (Math.hypot(o.x - w.x, o.y - w.y) <= r && o.y > best) { best = o.y; pick = o; }
  }
  if (pick) {
    preGrab = { x: pick.x, y: pick.y };
    heldId = pick.id; carry = { x: pick.x, y: pick.y };
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

function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
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
      for (const o of m.objects) objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0 });
      if (m.season != null) seasonPhase = m.season;
      if (m.cog) startArrive(m.cog.x, m.cog.y);
      break;
    }
    case 'object_state': {
      const o = objects.get(m.id);
      if (!o) break; // unknown (already dissolved) — ignore
      const wasHeld = o.held;
      o.x = m.x; o.y = m.y; o.handling = m.handling; o.held = !!m.held;
      if (m.maturity != null) o.maturity = m.maturity;
      if (m.aged != null) o.aged = m.aged;
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
      objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0 });
      break;
    }
    case 'object_gone': {
      objects.delete(m.id); lifts.delete(m.id);
      if (heldId === m.id) { heldId = null; carry = null; preGrab = null; }
      break;
    }
    case 'pickup_ack': {
      if (!m.ok && heldId === m.id) { // lost the race — snap back
        const o = objects.get(m.id);
        // held=false so the server's corrective object_state (held:true, from the
        // real holder) re-lifts it; leaving it true would suppress that re-lift.
        if (o && preGrab) { o.x = preGrab.x; o.y = preGrab.y; o.held = false; }
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
  send({ t: 'presence_move', x: c.x, y: c.y, ts: Date.now() });
}, PRESENCE_SEND_MS);

// ---- render loop ------------------------------------------------------------
const bgSeed = PG.seedFrom('drift-ground');
function frame(now) {
  updateLifts(now);
  updateGrowth(now);
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
  const list = [];
  for (const o of objects.values()) if (!isLifted(o.id)) list.push(o);
  list.sort((a, b) => (a.y - b.y) || (a.id < b.id ? -1 : 1)); // painter's depth, stable
  for (const o of list) drawObjectWorld(o);

  // overlays (screen space)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const [pid, p] of presences) {
    const inten = presenceIntensity(p, now);
    if (inten <= 0) {
      if ((p.gone && now - p.gone > P_OUT) || (now - p.last > P_IDLE + P_OUT)) presences.delete(pid);
      continue;
    }
    const s = worldToScreen(p.x, p.y);
    paintPresence(ctx, vw, vh, s.x, s.y, vw * 0.55, inten);
  }
  for (const o of objects.values()) {
    if (!isLifted(o.id)) continue;
    const s = (o.id === heldId && carry) ? worldToScreen(carry.x, carry.y) : worldToScreen(o.x, o.y);
    drawHeldScreen(o, s.x, s.y, liftValue(o.id));
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
