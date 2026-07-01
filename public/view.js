// public/view.js — the client's VIEW substrate: camera transforms, canvas sizing,
// adaptive quality, and the pan/zoom/arrive machinery (4.14 mirror). A pure PROVIDER:
// it reads the shared state (camera/canvas/ctx + S.pool/S.worldBounds) and the DOM,
// and exports the transforms + camera ops everyone else calls — it never calls back
// into client.js, so there's no circular import. State it OWNS and others only READ
// (dpr/vw/vh/Q/home/Z0/ZMIN/ZMAX) is exported by binding: because view is the sole
// writer, consumers `import` the name and use it unchanged (a live read-only binding).
import { camera, canvas, ctx, S } from './state.js';

const clamp = (v, lo, hi) => (v !== v ? lo : v < lo ? lo : v > hi ? hi : v); // shared 1-liner (also in client.js)

// zoom = CSS px per world unit. Z0/ZMIN/ZMAX are also read by input's pinch/wheel/gesture.
export const Z0 = 1.0, ZMIN = 0.2, ZMAX = 4.0;
const EDGE_MARGIN = 320;   // how far past the furthest object the centre may go (when zoomed in)
const EDGE_SOFT = 0.72;    // fraction of the limit past which panning starts to resist
const VIEW_FRAC = 0.10;    // at most zoomed-out, the viewport covers ~this fraction of the world area

// ---- adaptive quality (graceful degradation — no config) -------------------
// An old/weak machine silently sheds the costliest work to stay smooth: measure smoothed
// frame time, step DOWN tiers when it can't keep up (and back UP, slowly, with headroom).
// Each tier dials the heavy levers — dpr, the full-screen passes, shadows, the LOD
// budget, litter. Hysteresis + a cooldown keep it from flapping. Tier 0 = full.
const QUALITY_TIERS = [
  { dprCap: 2,    noise: 1, glows: 1, flow: 1, sky: 1, grade: 1, sat: 1, patches: 1, shadows: 1, leaves: 1, detailBudget: 1300 }, // full — doubled headroom
  { dprCap: 1.5,  noise: 0, glows: 1, flow: 1, sky: 1, grade: 1, sat: 1, patches: 1, shadows: 1, leaves: 1, detailBudget: 840 }, // drop the full-screen noise; cap retina
  { dprCap: 1.25, noise: 0, glows: 0, flow: 0, sky: 1, grade: 1, sat: 0, patches: 1, shadows: 1, leaves: 0, detailBudget: 500 }, // drop glows/flow/litter + the sat-filter
  { dprCap: 1,    noise: 0, glows: 0, flow: 0, sky: 0, grade: 0, sat: 0, patches: 0, shadows: 0, leaves: 0, detailBudget: 260 }, // bare
];
let qTier = 0;
export let Q = QUALITY_TIERS[0];
let frameMsEMA = 16.7, qLastChangeMs = 0, qHotFrames = 0, qCoolFrames = 0;
const Q_COOLDOWN_MS = 4000;  // min ms between tier changes (don't thrash)
const Q_DOWN_MS = 27;        // smoothed frame time worse than this (~<37fps) for a spell → go leaner
// Climb back once frames sit comfortably inside the refresh budget again. This threshold
// MUST be ABOVE a 60Hz vsync interval (16.7ms): rAF is vsync-capped, so on a 60/75Hz
// display the measured frame time can NEVER fall below ~16.7ms no matter how much headroom
// the machine has. The old 14ms was therefore UNREACHABLE there — once the tier dropped
// from any transient hitch (a GC pause, a big world_patch, the pre-b4aa8fe pan/zoom
// exception storm) it could NEVER recover, stranding the world in low-detail "chunks" until
// reload. 20ms (a smoothly-vsynced 60Hz frame + a little slack, still clear of the 27ms
// down-trigger) lets it climb back while staying protective of genuinely weak devices.
const Q_UP_MS = 20;
// Manual override (?q=0..3): pin a tier for testing/diagnosis and freeze the adaptive loop.
// Absent/invalid → normal adaptive behaviour. Read once at load, before the first resize().
let qPinned = false;
{ const qp = new URLSearchParams(location.search).get('q');
  if (qp != null && /^[0-3]$/.test(qp)) { qPinned = true; qTier = +qp; Q = QUALITY_TIERS[qTier]; } }
// For the ?perf HUD (client.js): the live tier / smoothed frame time / detail budget.
export function qStats() { return { tier: qTier, ema: frameMsEMA, budget: Q.detailBudget, pinned: qPinned }; }
export function adaptQuality(dtMs, nowMs) {
  if (dtMs > 0 && dtMs < 400) frameMsEMA += (dtMs - frameMsEMA) * 0.08; // ignore tab-hidden / GC outliers (still tracked for the HUD)
  if (qPinned) return;                                                  // ?q= pins the tier — honour it
  if (frameMsEMA > Q_DOWN_MS) { qHotFrames++; qCoolFrames = 0; }
  else if (frameMsEMA < Q_UP_MS) { qCoolFrames++; qHotFrames = 0; }
  else { qHotFrames = 0; qCoolFrames = 0; }
  if (nowMs - qLastChangeMs < Q_COOLDOWN_MS) return;
  if (qHotFrames > 40 && qTier < QUALITY_TIERS.length - 1) setQTier(qTier + 1, nowMs);        // struggling now → shed quickly
  else if (qCoolFrames > 240 && qTier > 0) setQTier(qTier - 1, nowMs);                        // sustained headroom → climb back gently
}
export function setQTier(t, nowMs) {
  const prevDpr = Q.dprCap;
  qTier = t; Q = QUALITY_TIERS[t]; qLastChangeMs = nowMs; qHotFrames = 0; qCoolFrames = 0;
  if (Q.dprCap !== prevDpr) resize(); // the canvas backing store changes with the dpr cap
}

// ---- canvas + viewport sizing ----------------------------------------------
export let dpr = 1, vw = 0, vh = 0;
export function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, Q.dprCap);
  const vv = window.visualViewport;
  vw = Math.round(vv ? vv.width : window.innerWidth);
  vh = Math.round(vv ? vv.height : window.innerHeight);
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  canvas.style.width = vw + 'px';
  canvas.style.height = vh + 'px';
}
let resizeQueued = false;
export function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
}

// ---- camera + transforms (all in CSS px; dpr only folded into the matrix) ---
let arrive = null; // soft-pan-to-active-area animation

// Return thread (PRD §6.3): the area a visitor was last active in is remembered
// CLIENT-side (never sent as identity — only as a transient viewport hint) so a
// returning visitor is softly oriented back toward where they were. First-time
// visitors have no home and arrive at the cog. Stored as the camera centre.
export let home = null;
try { const h = JSON.parse(localStorage.getItem('drift_home') || 'null'); if (h && Number.isFinite(h.x) && Number.isFinite(h.y)) home = h; } catch {}
let homeSavedAt = 0;
export function saveHome(now) {
  if (now - homeSavedAt < 2000) return;          // at most every 2s
  homeSavedAt = now;
  home = { x: camera.x, y: camera.y };
  try { localStorage.setItem('drift_home', JSON.stringify(home)); } catch {}
}

export function screenToWorld(sx, sy) {
  return { x: camera.x + (sx - vw / 2) / camera.z, y: camera.y + (sy - vh / 2) / camera.z };
}
export function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.z + vw / 2, y: (wy - camera.y) * camera.z + vh / 2 };
}
export function viewHalf() { return { hw: (vw / 2) / camera.z, hh: (vh / 2) / camera.z }; }
// Is the water pool's drift band anywhere on screen? (gates the flow-trace pass)
export function poolOnScreen() {
  if (!S.pool) return false;
  const s = worldToScreen(S.pool.x, S.pool.y), rr = S.pool.r * camera.z * 1.4;
  return s.x + rr >= 0 && s.x - rr <= vw && s.y + rr >= 0 && s.y - rr <= vh;
}
// How far the camera CENTRE may stray from origin on each axis right now. Shrinks as you
// zoom out, so the view always overlaps the object field — collapses toward 0 once the
// whole world fits on screen.
export function camLimits() {
  if (!S.worldBounds) return { x: Infinity, y: Infinity };
  const h = viewHalf();
  return { x: Math.max(0, S.worldBounds.x + EDGE_MARGIN - h.hw), y: Math.max(0, S.worldBounds.y + EDGE_MARGIN - h.hh) };
}
// Zoom-out is LIMITED so you can't take in the whole world at once. At the most
// zoomed-out, the viewport covers ~VIEW_FRAC of the WORLD's area — derived from the live
// world bounds, so the limit scales as the world grows. (Zoom-IN is unchanged, up to ZMAX.)
export function zMin() {
  if (!S.worldBounds || !vw || !vh) return ZMIN;
  const bx = Math.max(500, S.worldBounds.x), by = Math.max(500, S.worldBounds.y);
  const z = Math.sqrt((vw * vh) / (VIEW_FRAC * 4 * bx * by)); // (vw/z)(vh/z) = VIEW_FRAC · worldArea
  return clamp(z, 0.05, ZMAX * 0.9);
}
// Hard backstop: pull the camera within the limits + the zoom within range.
export function clampCam() {
  camera.z = clamp(camera.z, zMin(), ZMAX);
  const L = camLimits();
  camera.x = clamp(camera.x, -L.x, L.x);
  camera.y = clamp(camera.y, -L.y, L.y);
}
// Apply a pan (world-unit deltas) with edge RESISTANCE: free near the centre, easing to a
// stop at the limit. Only OUTWARD motion is resisted — you can always pan back in.
function approachLimit(cur, d, limit) {
  let next = cur + d;
  if (Math.abs(next) > Math.abs(cur) && Math.abs(cur) > limit * EDGE_SOFT) {
    const slack = Math.max(1, limit * (1 - EDGE_SOFT));
    const t = Math.min(1, (Math.abs(cur) - limit * EDGE_SOFT) / slack);
    next = cur + d * (1 - t); // scale the outward step toward 0 at the limit
  }
  return clamp(next, -limit, limit);
}
export function applyPan(wdx, wdy) {
  const L = camLimits();
  camera.x = approachLimit(camera.x, wdx, L.x);
  camera.y = approachLimit(camera.y, wdy, L.y);
}
export function startArrive(tx, ty) {
  arrive = { fromX: camera.x, fromY: camera.y, toX: tx, toY: ty, start: performance.now(), dur: 1200 };
}
// Cancel any in-flight return-thread animation. Manual camera control (pan/zoom/pinch)
// calls this so the soft-arrive doesn't fight the user's own movement. `arrive` is
// module-private (an imported `let` is read-only at the import site), so client.js
// clears it through this setter rather than assigning the binding.
export function cancelArrive() { arrive = null; }
export function updateArrive(now) {
  if (!arrive) return;
  const t = Math.min(1, (now - arrive.start) / arrive.dur), e = 1 - Math.pow(1 - t, 3);
  camera.x = arrive.fromX + (arrive.toX - arrive.fromX) * e;
  camera.y = arrive.fromY + (arrive.toY - arrive.fromY) * e;
  clampCam(); // a remembered home from before bounds existed (or a stranded one) is pulled back into the world
  if (t >= 1) arrive = null;
}

// ---- load-time effects (run when this module is imported, before client.js's body) ----
window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);
if (window.visualViewport) {
  visualViewport.addEventListener('resize', queueResize);
  visualViewport.addEventListener('scroll', queueResize);
}
resize();
