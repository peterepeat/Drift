// =============================================================================
// DRIFT — client: world render loop, camera, pointer input, realtime sync.
// No framework. Canvas 2D. Object forms are ALWAYS regenerated from `seed`;
// no visual data is ever stored or transmitted.
// =============================================================================
import * as PG from './drift-procgen.js';
import { paintGround, paintGlows, paintNoise, paintGroundPatches, paintPresence, paintCarryTether, paintSky, paintSeasonGrade, seasonGround, seasonSat, paintWaterWorld, paintFlow } from './render.js';
import { inViewport, CULL_MARGIN } from './cull.js';
import { Audio } from './audio.js';
import { flingStep, ema, nudge, spring, deflectCircles } from './physics.js';
import { wanderAt, drawCreature, creatureR, drawFish, fishR } from './creatures.js';
import { drawGiant } from './giant.js';
import { seedScale } from './shared/sizing.js';
import { SPROUT_C, BIG_TREE_MAT, GIANT_R, shownMat, stoneSize, anomalyR, crystalR, formOf } from './forms.js';

// ---- tuning constants -------------------------------------------------------
const Z0 = 1.0, ZMIN = 0.2, ZMAX = 4.0;     // zoom = CSS px per world unit
const SLOP = 8;                              // px of movement that turns a tap into a pan
// Camera bounds (Wave J): the camera centre is held within the object field (sent by
// the server as world half-extents) so you can never wander far into empty space —
// panning SLOWS as you approach the edge and STOPS at it. Zoom-aware: when zoomed out
// (the viewport already covers the world) the pannable range collapses toward centre.
const EDGE_MARGIN = 320;                      // how far past the furthest object the centre may go (when zoomed in)
const EDGE_SOFT = 0.72;                        // fraction of the limit past which panning starts to resist
const HIT_MIN = 26;                          // min tap radius in CSS px (accessibility)
const HIT_PAD = 3, HIT_GROW = 1.18;          // grab area modestly exceeds the drawn form — easy to grab, but not so greedy it steals pans
const LIFT_MS = 300, SETTLE_MS = 260;        // pickup / place timings (spec)
const CARRY_SEND_MS = 50;                    // throttle for streaming a carried object
const THROW_MIN = 180;                       // release speed (world units/s) below which a drag just places — no fling
const THROW_FRICTION = 0.045;                // velocity retained per second mid-fling (fast, natural settle)
const THROW_STOP = 28;                        // a fling settles to a place once it slows below this (wu/s)
const THROW_MAX = 1600;                       // cap the launch speed so a hard flick can't hurl a thing across the world
const PRESENCE_SEND_MS = 500;                // presence cadence (spec)
const P_IN = 1500, P_OUT = 2500, P_IDLE = 2000; // bloom fade-in / fade-out / idle-before-fade
// Felt presence (Wave E): two people working the same patch share a warmth that
// blooms BETWEEN them (mutual, not two separate glows); a faint tether links a
// carried object to whoever is carrying it, so it reads that a PERSON is moving it.
const SHARED_RADIUS = 620;                   // world units within which two presences share warmth
const SHARED_BOOST = 3.2;                     // strength of the extra between-them bloom (intensifies the shared patch)
// SPROUT_C / BIG_TREE_MAT / GIANT_R now live in forms.js (the client form-const home)
const GIANT_EASE = 0.4;                       // per-second retention for the giant's correction toward each broadcast spot
const GIANT_VIS_SPEED = 13;                   // world u/s it WALKS along its heading between ticks (≈ GIANT_STEP/tick) — brisk, continuous motion (not rushed, never parked)
const FOOT_FADE_MS = 4200;                    // a footprint fades this fast (so the giant doesn't track prints all over the world)
const FOOT_STEP = 52;                         // drop a print every this-many world units walked
const GLOW_PARALLAX = 0.04;                   // ambient glows drift this fraction of the camera (Wave H depth)
const DEPTH_TOP = 0.2;                         // objects at the TOP of the screen draw this much smaller (Wave K recession — subtle)
const ANOM_DISSOLVE_MS = 10000, ANOM_FADE_MS = 3000; // hold an anomaly 10s and it fades from your hands
const ATTEND_MS = 450;                        // long-press dwell before an object is "attended" (PRD §5.2)
const DBLTAP_MS = 320;                        // two taps on a stone within this BREAK it into smaller stones
const GRIT_MS = 500;                          // a worn-out stone's grit scatter lifetime (spec §4.3)
const MARK_LIFE_MS = 10 * 60 * 1000;          // a ground mark heals over ~10 min (mirror server MARK_LIFE_MS)
const MARK_SIZE = 24;                          // ground-mark footprint (world units) — small, rock-shaped
const MARK_TINT = '#d3c6ab';                   // pale warm stain — a drawn mark visible on the dark ground
const POS_EASE_MAX = 24;                       // a position change up to this (a drift hop) eases; larger snaps
// Mouse-displacement (Wave 6): a moving cursor brushes light things (leaves, seeds)
// aside and they spring back. PURELY LOCAL & cosmetic — a render-only offset, never
// the object's real position, so it touches no network, no storage, and can't desync.
const NUDGE_RADIUS = 78;                      // world units the cursor disturbs around itself
const NUDGE_STR = 6;                          // how strongly cursor speed transfers into a nudge
const NUDGE_SPRING = 95;                      // spring pulling a displaced thing back to rest
const NUDGE_DAMP = 0.02;                      // velocity retained per second (heavy damping → quick settle)
const NUDGE_MAX = 150;                        // clamp the displacement so nothing flies off absurdly
const NUDGE_MIN_SPEED = 45;                   // cursor must move faster than this (wu/s) to stir anything
// Collision (Wave E): a held / thrown object bumps nearby movable things aside (a
// render-only push on the same _ox/_oy spring — local & cosmetic, no network).
const COLLIDE_R = 26;                         // bump reach beyond the carried object's own radius
const COLLIDE_STR = 620;                      // how hard it shoves neighbours out of the way (gentle — they part, not fly)
// Cosmetic leaf litter (Wave F): a sparse field of small leaves drifting on the breeze,
// brushed aside by the cursor and stirred when you pan — purely LOCAL & cosmetic (no
// network, no storage, like the nudge), so moving through the world feels alive.
const LEAF_N = 46;                            // leaves populating the viewport
const LEAF_MARGIN = 1.15;                      // keep them within this many viewport half-extents (respawn beyond)
const LEAF_DRIFT = 9;                          // initial drift speed (world units/s)
const LEAF_BREEZE = 13;                        // gentle wandering-breeze drift amplitude (world units/s)
const LEAF_PAN = 0.35;                          // fraction of pan velocity the leaves are blown by (bounded — no streaking)
const LEAF_CURSOR = 4;                         // how strongly the moving cursor scatters them
// Rooted trees (Wave C): the biggest plants are immovable landmarks. They show ROOTS
// gripping the earth (so it reads WHY they won't come) and SWAY in the drag direction,
// then spring back, when you try to drag across them — a render-only canopy lean.
const SWAY_K = 150;                           // spring stiffness pulling a swayed tree upright
const SWAY_DAMP = 0.05;                        // velocity retained/s (light → a small bounce on the way back)
const SWAY_MAX = 0.17;                         // max lean in radians (~10°) — a sway, never a topple
const SWAY_IMPULSE = 0.0011;                   // how much a px of drag feeds the lean
const BEND_FROM_CURSOR = 0.0011;               // a cursor brush sways a plant's canopy (per wu/s of cursor speed, falloff-scaled)

// Spec easing curves (Visual Bible §06).
const EASE_RISE = cubicBezier(0.22, 1, 0.36, 1);     // pickup / place lift
const EASE_SETTLE = cubicBezier(0.40, 0, 0.20, 1);   // place settle, no overshoot

// ---- session token ----------------------------------------------------------
// Opaque UUID, never transmitted with identifying info. Used server-side only
// for hold ownership / decay-pause. Last-active area is remembered CLIENT-side
// (here) so the server stores nothing per-token — keeping identity out of it.
let token = localStorage.getItem('drift_session');
if (!token) { token = crypto.randomUUID(); localStorage.setItem('drift_session', token); }

// ---- adaptive quality (graceful degradation — no config) -------------------
// An old/weak machine silently sheds the costliest work to stay smooth: we measure
// smoothed frame time and step DOWN through quality tiers when it can't keep up (and
// back UP, slowly, when it has headroom). Each tier dials the heavy levers — canvas
// resolution (dpr), the full-screen passes (noise/glows/flow/grade/sat-filter), per-
// object shadows, the LOD pixel threshold, and drifting litter. Hysteresis + a cooldown
// keep it from flapping. No UI, no toggle: it just adapts. Tier 0 = full, higher = leaner.
// detailBudget: the max objects drawn at FULL detail in a frame. LOD is keyed to the actual
// cost — the on-screen object COUNT — not zoom or absolute size. Under budget, EVERYTHING
// draws full (a close-up sprout is never chunky); over budget, only the smallest-on-screen
// overflow simplifies. So chunkiness happens solely under genuine load, and a leaner tier
// just lowers the budget.
const QUALITY_TIERS = [
  { dprCap: 2,    noise: 1, glows: 1, flow: 1, sky: 1, grade: 1, sat: 1, patches: 1, shadows: 1, leaves: 1, detailBudget: 1300 }, // full — doubled headroom: ~2× as many on-screen objects stay full-detail before any chunk
  { dprCap: 1.5,  noise: 0, glows: 1, flow: 1, sky: 1, grade: 1, sat: 1, patches: 1, shadows: 1, leaves: 1, detailBudget: 840 }, // drop the full-screen noise; cap retina
  { dprCap: 1.25, noise: 0, glows: 0, flow: 0, sky: 1, grade: 1, sat: 0, patches: 1, shadows: 1, leaves: 0, detailBudget: 500 }, // drop glows/flow/litter + the sat-filter (a real GPU win)
  { dprCap: 1,    noise: 0, glows: 0, flow: 0, sky: 0, grade: 0, sat: 0, patches: 0, shadows: 0, leaves: 0, detailBudget: 260 }, // bare: no sky/grade/patches/shadows, tight budget
];
let qTier = 0, Q = QUALITY_TIERS[0];
let frameMsEMA = 16.7, qLastChangeMs = 0, qHotFrames = 0, qCoolFrames = 0, qPrevNow = 0;
// FOCUS LABELS (debug/troubleshooting): a tiny word under each creature naming its current
// focus. The world is deliberately wordless, so this is OFF by default — turn it on with
// ?focus=1 in the URL (the admin panel links here) or by pressing 'f'. The only text in Drift.
let showFocus = new URLSearchParams(location.search).has('focus');
const ACT_COLOR = { feed: 'rgba(150,210,120,0.95)', drink: 'rgba(130,190,235,0.95)', rest: 'rgba(225,200,150,0.95)', roam: 'rgba(200,195,185,0.9)', follow: 'rgba(240,150,150,0.96)' };
addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') showFocus = !showFocus; });
const Q_COOLDOWN_MS = 4000;  // min ms between tier changes (don't thrash)
const Q_DOWN_MS = 27;        // smoothed frame time worse than this (~<37fps) for a sustained spell → go leaner
const Q_UP_MS = 14;          // ...better than this (~>71fps) for a longer spell → go richer
function adaptQuality(dtMs, nowMs) {
  if (dtMs > 0 && dtMs < 400) frameMsEMA += (dtMs - frameMsEMA) * 0.08; // ignore tab-hidden / GC outliers
  if (frameMsEMA > Q_DOWN_MS) { qHotFrames++; qCoolFrames = 0; }
  else if (frameMsEMA < Q_UP_MS) { qCoolFrames++; qHotFrames = 0; }
  else { qHotFrames = 0; qCoolFrames = 0; }
  if (nowMs - qLastChangeMs < Q_COOLDOWN_MS) return;
  if (qHotFrames > 40 && qTier < QUALITY_TIERS.length - 1) setQTier(qTier + 1, nowMs);        // struggling now → shed quickly
  else if (qCoolFrames > 240 && qTier > 0) setQTier(qTier - 1, nowMs);                        // sustained headroom → climb back gently
}
function setQTier(t, nowMs) {
  const prevDpr = Q.dprCap;
  qTier = t; Q = QUALITY_TIERS[t]; qLastChangeMs = nowMs; qHotFrames = 0; qCoolFrames = 0;
  if (Q.dprCap !== prevDpr) resize(); // the canvas backing store changes with the dpr cap
}

// ---- canvas + viewport sizing ----------------------------------------------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let dpr = 1, vw = 0, vh = 0;

function resize() {
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
let worldBounds = null; // {x,y} half-extents of the object field (from the server) — the camera is clamped to it

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
// How far the camera CENTRE may stray from origin on each axis right now. Shrinks as
// you zoom out (the viewport already covers more world), so the view always overlaps
// the object field — collapses toward 0 once the whole world fits on screen.
function camLimits() {
  if (!worldBounds) return { x: Infinity, y: Infinity };
  const h = viewHalf();
  return { x: Math.max(0, worldBounds.x + EDGE_MARGIN - h.hw), y: Math.max(0, worldBounds.y + EDGE_MARGIN - h.hh) };
}
// Zoom-out is LIMITED so you can't take in the whole world at once (more to discover, and
// it keeps the on-screen object count sane). At the most zoomed-out, the viewport covers
// ~VIEW_FRAC of the WORLD's area — and since that's derived from the live world bounds, the
// limit scales as the world grows. (Zoom-IN is unchanged, up to ZMAX.)
const VIEW_FRAC = 0.10;
function zMin() {
  if (!worldBounds || !vw || !vh) return ZMIN;
  const bx = Math.max(500, worldBounds.x), by = Math.max(500, worldBounds.y);
  const z = Math.sqrt((vw * vh) / (VIEW_FRAC * 4 * bx * by)); // (vw/z)(vh/z) = VIEW_FRAC · worldArea
  return clamp(z, 0.05, ZMAX * 0.9);
}
// Hard backstop: pull the camera within the limits + the zoom within range (after a jump,
// a resize, or the world bounds changing under it).
function clampCam() {
  camera.z = clamp(camera.z, zMin(), ZMAX);
  const L = camLimits();
  camera.x = clamp(camera.x, -L.x, L.x);
  camera.y = clamp(camera.y, -L.y, L.y);
}
// Apply a pan (world-unit deltas) with edge RESISTANCE: free near the centre, easing
// to a stop at the limit. Only OUTWARD motion is resisted — you can always pan back in.
function approachLimit(cur, d, limit) {
  let next = cur + d;
  if (Math.abs(next) > Math.abs(cur) && Math.abs(cur) > limit * EDGE_SOFT) {
    const slack = Math.max(1, limit * (1 - EDGE_SOFT));
    const t = Math.min(1, (Math.abs(cur) - limit * EDGE_SOFT) / slack);
    next = cur + d * (1 - t); // scale the outward step toward 0 at the limit
  }
  return clamp(next, -limit, limit);
}
function applyPan(wdx, wdy) {
  const L = camLimits();
  camera.x = approachLimit(camera.x, wdx, L.x);
  camera.y = approachLimit(camera.y, wdy, L.y);
}
function startArrive(tx, ty) {
  arrive = { fromX: camera.x, fromY: camera.y, toX: tx, toY: ty, start: performance.now(), dur: 1200 };
}
function updateArrive(now) {
  if (!arrive) return;
  const t = Math.min(1, (now - arrive.start) / arrive.dur), e = 1 - Math.pow(1 - t, 3);
  camera.x = arrive.fromX + (arrive.toX - arrive.fromX) * e;
  camera.y = arrive.fromY + (arrive.toY - arrive.fromY) * e;
  clampCam(); // a remembered home from before bounds existed (or a stranded one) is pulled back into the world
  if (t >= 1) arrive = null;
}

// ---- world state ------------------------------------------------------------
const objects = new Map();     // id -> { id, family, x, y, seed, handling, held(bool), _sg, _sgEr }
const presences = new Map();   // pid -> { x, y, born, last, gone }
const lifts = new Map();       // id -> lift animation state
const flashes = [];            // brief crystal-dissolution flashes { x, y, start }
const ripples = [];            // brief water ripples — a bug dropped in a pond becomes fish food { x, y, start }
const feedRushes = [];         // a pond's fish swim over to eat a dropped bug { x, y, start, pond, eatT } — local/cosmetic
const FISH_SWIM_SPEED = 150;   // world u/s the fish swim toward food (a brisk, natural pursuit — the NEAREST reaches first + eats it)
const FEED_RELEASE = 0.9;      // seconds for fish to ease back to their wander once the bug is eaten
const FEED_RUSH_CAP_MS = 5000; // hard cap on a feed-rush (safety; normally it ends when the bug is eaten)
const grits = [];              // brief stone-to-grit scatters { x, y, seed, r, start }
const creatureEvts = [];       // brief birth-shimmer / death-puff cues { x, y, start, birth } — the ecosystem made legible
const CREATURE_EVT_MS = 760;   // lifetime of a birth/death cue
let pool = null;               // the central water pool { x, y, r } (flow + audio anchor)
let pools = [];                // every pond the world carries (Wave P) — all rendered as water
let giants = [];               // the TWO gardener NPCs { x, y, hx, hy, walk, tending, _tx, _ty } — server-authoritative; walked continuously client-side
const giantFootprints = [];    // fading prints the journeyer leaves as it walks { x, y, start } — cosmetic, local
let myPid = null;
let seasonPhase = 0;           // monotonic season clock from the server (feels, never labelled)
let lastSat = -1;              // last-applied canvas saturation (avoids per-frame style writes)
let animT = 0;                 // seconds, drives the only animated objects (anomalies)
let clockSkew = 0;             // (server now − local now), from world_state — aligns the creature wander clock across clients
function syncedT() { return (Date.now() + clockSkew) / 1000; }

// local hold
let heldId = null, carry = null, preGrab = null;
let heldSince = 0;             // when the local hold began (drives anomaly dissolution)
// Throw momentum: the carried object's recent velocity (world units/s), sampled as
// it moves, so releasing a moving drag flings it on instead of freezing it (Wave 3).
let flingVel = { x: 0, y: 0 }, lastCarryPos = null, lastCarryT = 0;
// Thrown objects glide FREE of the pointer (id -> {vx,vy}): a throw releases the
// pointer immediately so you can pan / grab again while the object flies on. It
// stays server-held by our token until it lands (so carry streams), then places.
let flying = new Map();

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

// ---- deterministic-from-seed forms (footprints + render flags now in forms.js) ----
// A plain anomaly draws its one kind; a fused hybrid layers each constituent kind
// (offset in time + slightly shrunk, translucent) so its form reads as a luminous blend.
function drawAnomalyForm(ctx, o, t, cx, cy, R) {
  const kinds = (o.kinds && o.kinds.length) ? o.kinds : [o.kind || 'breath'];
  if (kinds.length === 1) { PG.drawAnomaly(ctx, kinds[0], t, cx, cy, R); return; }
  ctx.save();
  ctx.globalAlpha = 0.55 + 0.4 / kinds.length; // translucent layers merge instead of occluding
  for (let i = 0; i < kinds.length; i++) PG.drawAnomaly(ctx, kinds[i], t + i * 1.7, cx, cy, R * (1 - i * 0.06));
  ctx.restore();
}
// Smoothly-tweened lifecycle the renderer reads (eased toward server values so the
// 60s growth steps don't pop). shownMat lives in forms.js (the footprint needs it).
function shownAged(o) { return o._agedShown != null ? o._agedShown : (o.aged || 0); }
function objRadius(o) { return formOf(o.family).sizeFn(o); } // per-family footprint — see forms.js
// A creature's LIVE position: home (its stored x/y) + the deterministic wander
// ANCHORED at wanderT0, so the offset is exactly zero at t0 and the creature sits ON
// its home the instant it's placed — then drifts out on a new route (no snap). Heading
// is the wander's near-future direction (the anchor cancels in the delta). Same
// (seed, kind, home, wanderT0, clock) → same point on every client.
const GLOW_SEC = 180; // glow-buff duration in seconds (mirror server GLOW_MS)
// Warp a creature's wander time: 2× during a glow buff. Continuous at both edges of the
// buff (no jump) — after it ends the wander simply carries a constant phase offset.
function creatureWarpT(o, t) {
  if (!o.glowUntil) return t;
  const gu = o.glowUntil / 1000, gs = gu - GLOW_SEC;
  if (t <= gs) return t;
  if (t < gu) return gs + (t - gs) * 2;       // 2× speed while glowing
  return gs + GLOW_SEC * 2 + (t - gu);         // after: normal speed, phase-shifted (invisible)
}
// Is this creature currently glowing? → its rainbow hue, else null.
function glowHueOf(o) { return (o.glowUntil && (Date.now() + clockSkew) < o.glowUntil) ? (o.glowHue || 0) : null; }
// How strong the BOND is right now, 0..1: eases in when befriended, holds, then FADES over
// the final ~10s as it lapses — a visible end (the red glow wanes and the creature drifts
// back to its own life). The server moves a bonded creature; this only drives the glow.
function tameFactor(o) {
  if (!o.tameUntil) return 0;
  const remain = o.tameUntil - (Date.now() + clockSkew);
  if (remain <= 0) return 0;
  const inF = o._tameStart ? Math.min(1, (performance.now() - o._tameStart) / 2500) : 1;
  return Math.max(0, Math.min(1, Math.min(inF, remain / 10000)));
}
// A friendly little 3-note flourish when you greet the giant — all on the season
// pentatonic (so it's consonant + musical), silent unless sound is on.
function giantChime() {
  const x = giants[0] ? giants[0].x : 0;
  Audio.event('pickup', { seed: 0x51b1, family: 'anomaly', x });
  setTimeout(() => Audio.event('pickup', { seed: 0x7c33, family: 'anomaly', x }), 120);
  setTimeout(() => Audio.event('place', { seed: 0x2e9f, family: 'anomaly', x }), 250);
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
      const elapsed = (animT * 1000 - fr.start) / 1000;
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
  // frameStones is last frame's visible rocks (a frame's lag is imperceptible).
  if (kind === 'crawler' && frameStones.length) { const p = deflectCircles(x, y, creatureR(seed, kind) * 0.7, frameStones, 5); x = p.x; y = p.y; }
  return { x, y, ang };
}
// Where an object is drawn / tested THIS frame: a free creature wanders; everything
// else sits at its true position plus any local cursor-displacement offset.
function posOf(o) {
  if ((o.family === 'creature' || o.family === 'fish') && !o.held && o.id !== heldId) return creaturePos(o);
  return { x: o.x + (o._ox || 0), y: o.y + (o._oy || 0) };
}
// The biggest trees have ROOTED — they're immovable landmarks (never grabbed; you
// drag straight across them to pan). Everything else can be picked up.
function isMovable(o) { return formOf(o.family).movable(o); } // a rooted big tree can't be lifted — see forms.js
function stoneGeom(o) {
  const er = Math.min(0.95, o.handling * 0.04); // handling erodes the stone (PRD §3.2)
  if (!o._sg || o._sgEr !== er || o._sgR !== (o.r || 0)) { o._sg = PG.makeStone(o.seed >>> 0, stoneSize(o), er); o._sgEr = er; o._sgR = o.r || 0; } // regen on fuse/split
  return o._sg;
}
// Draw any object (stone, seed, or plant) at (cx, cy) in the current transform.
// FORM is always regenerated from seed (+ maturity/aged for growth) — never stored.
function paintObject(o, cx, cy, ang = 0) {
  if (o.family === 'stone') { PG.drawStone(ctx, stoneGeom(o), cx, cy); return; }
  if (o.family === 'anomaly') { drawAnomalyForm(ctx, o, animT, cx, cy, anomalyR(o)); return; }
  if (o.family === 'crystal') { PG.drawCrystal(ctx, o.seed >>> 0, cx, cy, crystalR(o), animT); return; }
  if (o.family === 'giant') { // the journeyer (a being apart) — see giant.js
    drawGiant(ctx, cx, cy, GIANT_R, animT, Math.atan2(o.hy || 0, o.hx || 1), { gait: o.gait, tend: o.tend, lookX: o.lookX, lookY: o.lookY });
    return;
  }
  if (o.family === 'creature') { drawCreature(ctx, o.seed >>> 0, o.kind || 'crawler', cx, cy, animT, ang, glowHueOf(o), tameFactor(o)); return; }
  if (o.family === 'fish') { drawFish(ctx, o.seed >>> 0, cx, cy, animT, ang); return; }
  const mat = shownMat(o), aged = shownAged(o);
  if (mat < SPROUT_C) { PG.drawSeed(ctx, o.seed >>> 0, cx, cy, seedScale(o.seed) * (1 + mat * 1.4)); return; }
  if (mat >= BIG_TREE_MAT) drawRoots(ctx, o.seed >>> 0, cx, cy, mat); // roots only on the biggest (rooted) plants
  // Any sprouted plant SWAYS by leaning its canopy about its base (trunk anchored at
  // the ground) — used by the rooted-tree drag AND the cursor brush (Wave M). Never a
  // whole-object slide.
  const bend = o._bend || 0;
  if (bend) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(bend); PG.drawPlant(ctx, o.seed >>> 0, 0, 0, mat, aged); ctx.restore(); return; }
  PG.drawPlant(ctx, o.seed >>> 0, cx, cy, mat, aged);
}
// A soft contact shadow grounds an object on the plane (a little perspective — it
// sits ON the ground instead of floating like clip-art). Flattened ellipse, offset
// for a high upper-left light; plants root at their base, compact things sit below
// centre. Anomalies (luminous, floating) and fliers (airborne) cast none/less.
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
// Roots for the biggest plants (those rooted immovable, maturity ≥ BIG_TREE_MAT):
// short tapering tendrils splaying from the base across the ground plane (vertically
// compressed, like the contact shadow), so it READS why the tree won't be lifted.
// Deterministic from seed; drawn beneath the trunk so the canopy overlaps them.
function drawRoots(ctx, seed, cx, cy, mat) {
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
}
// A ground mark (Wave S): a rock-shaped tinted STAIN drawn flat on the ground (it's a
// disturbance of the earth, not an object sitting on it — so no shadow/depth), fading
// as it heals. `life` runs 1→0 over the mark's ~10-min life. Shape reuses the stone
// polygon (so it's "oddly shaped like a rock"); a soft radial alpha keeps the edge calm.
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
  // LOD only when over the detail budget (frameLodCut > 0, set in the cull pass): the
  // smallest-on-screen overflow draws as a cheap blob, everything else full. Plus a hard
  // sub-pixel floor (a thing under ~1.5px is invisible anyway). Anomalies/fish/giant: always full.
  if (!formOf(o.family).alwaysFull) { // anomalies/fish/giant always draw full (never LOD-blobbed)
    const px = rad * camera.z;
    if (px < 1.5 || (frameLodCut > 0 && px < frameLodCut)) { drawLOD(o, cx, cy, rad); return; }
  }
  if (Q.shadows) paintGroundShadow(o, cx, cy, rad);
  if (ds === 1) { paintObject(o, cx, cy, ang); return; }
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(ds, ds); ctx.translate(-cx, -cy); // scale about the object's base point
  paintObject(o, cx, cy, ang);
  ctx.restore();
}
// A cheap stand-in for a far/tiny object: one opaque disc in its family colour (the
// global season grade tints it to match), at the foliage height for plants (which rise
// from their base). No shadow, no procgen — this is the whole point of the LOD.
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
// The representative base colour of an object for its LOD blob — matched to the full
// form's colour (the plant `core` ramp / the stone's fill) so zooming in/out doesn't shift hue.
function lodColor(o) {
  if (o.family === 'stone') return stoneGeom(o).fill;
  if (o.family === 'crystal') return '#9ec3d6';
  if (o.family === 'creature') return o.kind === 'flier' ? '#5c564e' : '#2f2c28';
  const mat = shownMat(o);
  if (mat < SPROUT_C) return PG.mix(PG.PALETTE.growthDeep, PG.PALETTE.growthLight, 0.5); // a loose seed/leaf — green, matching drawSeed (was wrongly brown)
  return mat < 0.5 ? PG.mix(PG.PALETTE.growthYoung, PG.PALETTE.growthLight, mat / 0.5)
                   : PG.mix(PG.PALETTE.growthLight, PG.PALETTE.growthDeep, (mat - 0.5) / 0.5);
}
// The "reveal of age" (PRD §5.2): how far along its life an attended object is, so
// the attend-bloom is larger and warmer the older/more-worn the object — its history
// made briefly legible without a single word or number.
function ageFactor(o) {
  if (o.family === 'stone') return Math.min(1, (o.handling || 0) / 26);   // worn smooth = old (mirror GRIT_HANDLING)
  if (o.family === 'crystal') return 0.4;                                 // decay isn't on the wire — a steady, modest reveal
  if (o.family === 'anomaly') return 0.5;                                 // timeless — a steady, even reveal
  if (o.family === 'creature') return 0.35;                              // alive — a steady, gentle reveal
  return Math.min(1, shownMat(o) * 0.55 + shownAged(o) * 0.65);           // seed → plant → aged
}
// A soft warm bloom that breathes around the attended object (its "response").
function paintAttend(o, t) {
  const age = ageFactor(o);
  const c = posOf(o);                                   // bloom at the live position (a creature wanders)
  const rad = objRadius(o) * (1.7 + 1.3 * age);
  const breath = 0.6 + 0.4 * Math.sin(animT * 1.6);     // slow pulse = the object responding
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
// An object's ground line — where it sits and sorts in the painter's order.
function groundY(o) { return o.y; }
// Fliers are airborne, so their DEPTH (paint order) is lifted above ground clutter —
// they always pass OVER rocks instead of being hidden behind one they overfly. A
// per-seed amount spreads them through the canopy height, so each reads as weaving
// behind some trees and in front of others rather than all sitting on one plane.
function flierLift(o) { return 56 + PG.rng((o.seed ^ 0x5f5e10) >>> 0)() * 120; }
// Size-by-depth (Wave K): an object's draw scale by its SCREEN height — full size at
// the bottom (nearest), receding to DEPTH_TOP smaller at the top (furthest back). A
// breath of pseudo-depth; subtle so the pan-time "breathing" stays imperceptible.
// Stored per object each frame (in the cull pass) so the draw AND the hit-test agree.
function depthScaleAt(screenY) { return 1 - (1 - clamp(screenY / vh, 0, 1)) * DEPTH_TOP; }
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
  // A held creature keeps facing its live wander heading (not a fixed "up"), so
  // picking it up and setting it down don't snap its rotation — the in-hand heading
  // is continuous with the wander it resumes (heading is position-independent).
  const ang = o.family === 'creature' ? creaturePos(o).ang : 0;
  paintObject(o, 0, 0, ang);
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
  const k = dt > 0 ? 1 - Math.pow(0.0002, dt) : 0;  // most objects: settle in ~1s
  const kc = dt > 0 ? 1 - Math.pow(0.15, dt) : 0;    // creatures: a gentle ~2-3s glide for the migrating home
  const kr = dt > 0 ? 1 - Math.pow(0.06, dt) : 0;    // a rock rolling out of water: a slower, visible ~1.2s roll to the bank
  for (const o of objects.values()) {
    if (o._tx == null) { o._tx = o.x; o._ty = o.y; continue; }
    if (o.id === heldId) { o._tx = o.x; o._ty = o.y; continue; } // locally carried — follows the finger
    const r = o._roll ? kr : (o.family === 'creature' ? kc : k);
    o.x += (o._tx - o.x) * r;
    o.y += (o._ty - o.y) * r;
    if (o._roll && Math.hypot(o._tx - o.x, o._ty - o.y) < 0.6) o._roll = 0; // arrived at the bank — back to normal easing
  }
  for (const giant of giants) {
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
// Holding an anomaly for 10s dissolves it (it fades from your hands — never explained).
function updateDissolve(now) {
  if (!heldId) return;
  const ho = objects.get(heldId);
  if (ho && ho.family === 'anomaly' && (now - heldSince) >= ANOM_DISSOLVE_MS) {
    send({ t: 'dissolve', id: heldId, token, ts: Date.now() });
    objects.delete(heldId); lifts.delete(heldId);
    clearHold();
  }
}

// Advance every thrown object: friction decays its velocity, it glides, and once
// slow enough it settles into a place. Streams carry so others see the glide (it
// stays owned until it rests). dt is clamped so a backgrounded tab doesn't teleport.
let _lastFlingT = 0, _flyCarryAt = 0;
function updateFlying(now) {
  if (!flying.size) { _lastFlingT = now; return; }
  const dt = _lastFlingT ? Math.min(0.05, (now - _lastFlingT) / 1000) : 0; _lastFlingT = now;
  if (dt <= 0) return;
  const sendNow = (now - _flyCarryAt) >= CARRY_SEND_MS;
  for (const [id, f] of flying) {
    const o = objects.get(id);
    if (!o || !o.held) { flying.delete(id); continue; } // gone, or the server reclaimed it → stop gliding
    const s = flingStep({ x: o.x, y: o.y }, f, dt, THROW_FRICTION, THROW_STOP);
    // If a position ever goes non-finite, settle at the known-finite launch point
    // rather than stream null (→ a phantom at world 0,0 that never lands).
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      o.x = f.x0; o.y = f.y0; o._tx = f.x0; o._ty = f.y0; o.held = false; reanchorCreature(o);
      setLift(id, 0, SETTLE_MS, EASE_SETTLE);
      send({ t: 'place', id, token, x: f.x0, y: f.y0, ts: Date.now() });
      flying.delete(id);
      continue;
    }
    o.x = s.x; o.y = s.y; o._tx = s.x; o._ty = s.y; f.vx = s.vx; f.vy = s.vy;
    if (s.stopped) {
      o.held = false; reanchorCreature(o);
      setLift(id, 0, SETTLE_MS, EASE_SETTLE);        // settle down where it came to rest
      send({ t: 'place', id, token, x: o.x, y: o.y, ts: Date.now() });
      Audio.event('land', { seed: o.seed, family: o.family, x: o.x });
      flying.delete(id);
    } else if (sendNow) {
      send({ t: 'carry', id, token, x: o.x, y: o.y, ts: Date.now() });
    }
  }
  if (sendNow) _flyCarryAt = now;
}
// Place every in-flight object NOW (used when the tab hides — rAF stops, so they'd
// otherwise sit server-held until the 45s reaper). Releases our hold cleanly.
function settleFlying() {
  for (const id of flying.keys()) {
    const o = objects.get(id);
    if (o) { o.held = false; reanchorCreature(o); o._tx = o.x; o._ty = o.y; setLift(id, 0, SETTLE_MS, EASE_SETTLE); send({ t: 'place', id, token, x: o.x, y: o.y, ts: Date.now() }); }
  }
  flying.clear();
}

// How easily a thing is stirred by a passing cursor (Wave 6): seeds & leaves fly,
// growing plants get heavier as they mature and root, crystals stir a little, and
// stones / anomalies / held things don't move at all.
function lightnessOf(o) {
  if (o.held || o.family === 'stone' || o.family === 'anomaly' || o.family === 'creature' || o.family === 'fish') return 0; // creatures + fish move themselves
  if (o.family === 'crystal') return 0.45;
  // only a LOOSE pre-sprout seed/leaf (no trunk) slides under the cursor; a sprouted
  // plant has a trunk, so it SWAYS instead (handled in updateNudge) — never slides.
  return shownMat(o) < SPROUT_C ? 1 : 0;
}
// How much an object YIELDS to being bumped by a carried/thrown object — lighter
// things give a lot, stones bump but resist, held/rooted/luminous things don't move.
function collisionGive(o) {
  if (o.held || o.id === heldId || flying.has(o.id) || o.family === 'anomaly' || o.family === 'creature' || o.family === 'fish' || !isMovable(o)) return 0;
  if (o.family === 'stone') return 0.4;
  if (o.family === 'crystal') return 0.7;
  if (o.family === 'seed') return shownMat(o) < SPROUT_C ? 0.8 : 0; // loose seeds shove aside; a sprouted plant doesn't slide (it sways)
  return 0;
}
// Local, cosmetic displacement: a moving cursor brushes light things aside (a render
// offset _ox/_oy on a damped spring), and they settle back to rest. Never the real
// position — no network, no storage. Idle objects are skipped, so a still cursor is
// free and a moving one costs ~the cull pass already does.
let _lastNudgeT = 0;
function updateNudge(now) {
  const dt = _lastNudgeT ? Math.min(0.05, (now - _lastNudgeT) / 1000) : 0; _lastNudgeT = now;
  if (dt <= 0) return;
  const speed = (now - lastHoverT) < 60 ? Math.hypot(mouseVelW.x, mouseVelW.y) : 0;
  const active = speed > NUDGE_MIN_SPEED;
  for (const o of objects.values()) {
    // A sprouted plant SWAYS when the moving cursor brushes it — the canopy leans in the
    // cursor's travel direction (trunk anchored at the base), never sliding the whole
    // tree. Feeds the same _bend spring updateSway settles (Wave M).
    if (active && o.family === 'seed' && shownMat(o) >= SPROUT_C && !o.held && o.id !== heldId &&
        Math.abs(o.x - mouseWorld.x) < NUDGE_RADIUS && Math.abs(o.y - mouseWorld.y) < NUDGE_RADIUS) {
      const d = Math.hypot(o.x - mouseWorld.x, o.y - mouseWorld.y);
      if (d < NUDGE_RADIUS) { const fall = 1 - d / NUDGE_RADIUS; o._bendV = (o._bendV || 0) + mouseVelW.x * fall * fall * BEND_FROM_CURSOR; swaying.add(o.id); }
    }
    const resting = !o._ox && !o._oy && !o._ovx && !o._ovy;
    // Only objects near the moving cursor are stirred; already-displaced ones still
    // spring back. A resting object that's neither is skipped — so the cost is ~the
    // few things near the cursor + the few in motion, not the whole population.
    const near = active && Math.abs(o.x - mouseWorld.x) < NUDGE_RADIUS && Math.abs(o.y - mouseWorld.y) < NUDGE_RADIUS;
    if (resting && !near) continue;
    // light things are stirred by the cursor; heavier things still spring back from a
    // collision bump (collisionGive) — only truly fixed things (held/anomaly) are zeroed.
    if (lightnessOf(o) <= 0 && collisionGive(o) <= 0) { if (!resting) { o._ox = o._oy = o._ovx = o._ovy = 0; } continue; }
    o._ox = o._ox || 0; o._oy = o._oy || 0; o._ovx = o._ovx || 0; o._ovy = o._ovy || 0;
    if (near && o.id !== heldId) {
      const n = nudge(mouseWorld.x, mouseWorld.y, o.x + o._ox, o.y + o._oy, NUDGE_RADIUS, speed, NUDGE_STR, lightnessOf(o));
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
// Collision: a carried / thrown object shoves nearby movable things out of its way
// (adds to the same _ox/_oy spring updateNudge settles). Runs only while something is
// in hand or in flight; the displacement is cosmetic (real positions never change).
let _lastColT = 0;
function updateCollision(now) {
  const dt = _lastColT ? Math.min(0.05, (now - _lastColT) / 1000) : 0; _lastColT = now;
  if (dt <= 0) return;
  const bumpers = [];
  if (heldId && carry) { const ho = objects.get(heldId); if (ho) bumpers.push({ x: carry.x, y: carry.y, r: objRadius(ho) }); }
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
// Rooted-tree sway (Wave C): a tree being drag-panned across leans in the drag
// direction (impulses fed in from pointermove) and springs back upright when released,
// with a small bounce. Purely a render-only canopy lean (o._bend) — no network, no
// real movement; the tree never actually goes anywhere. Only swaying trees are
// touched (tracked in `swaying`), so a still world costs nothing.
const swaying = new Set();
let swayId = null;        // the rooted tree currently held under a drag-pan
let _lastSwayT = 0;
function updateSway(now) {
  const dt = _lastSwayT ? Math.min(0.05, (now - _lastSwayT) / 1000) : 0; _lastSwayT = now;
  if (dt <= 0 || !swaying.size) return;
  for (const id of swaying) {
    const o = objects.get(id);
    if (!o) { swaying.delete(id); continue; }
    const s = spring(o._bend || 0, o._bendV || 0, dt, SWAY_K, SWAY_DAMP);
    o._bend = clamp(s.pos, -SWAY_MAX, SWAY_MAX); o._bendV = s.vel;
    if (id !== swayId && Math.abs(o._bend) < 1e-4 && Math.abs(o._bendV) < 1e-3) { o._bend = 0; o._bendV = 0; swaying.delete(id); }
  }
}
// ---- cosmetic leaf litter (Wave F) ------------------------------------------
// A sparse field of drifting leaves that follows the camera (respawning at the far
// edge as you pan), wanders on a breeze, scatters from a fast cursor, and is STIRRED
// when you pan — so movement feels alive. Purely local & cosmetic: never networked,
// never the true world, so it can't desync and costs only these few dozen leaves.
const leaves = [];
function initLeaves() {
  const r = PG.rng(0x1eaf5);
  for (let i = 0; i < LEAF_N; i++) leaves.push({ x: 0, y: 0, vx: 0, vy: 0, rot: r() * Math.PI * 2, rotV: (r() * 2 - 1) * 0.5, seed: (r() * 4294967296) >>> 0, scale: 0.6 + r() * 0.8, placed: false });
}
let _lastLeafT = 0, _leafCamX = null, _leafCamY = null;
function updateLeaves(now) {
  const dt = _lastLeafT ? Math.min(0.05, (now - _lastLeafT) / 1000) : 0; _lastLeafT = now;
  if (dt <= 0) return;
  if (!leaves.length) initLeaves();
  let pvx = 0, pvy = 0;                                    // camera pan velocity (world units/s)
  if (_leafCamX != null) { pvx = (camera.x - _leafCamX) / dt; pvy = (camera.y - _leafCamY) / dt; }
  _leafCamX = camera.x; _leafCamY = camera.y;
  const hw = (vw / 2) / camera.z * LEAF_MARGIN, hh = (vh / 2) / camera.z * LEAF_MARGIN;
  const minX = camera.x - hw, maxX = camera.x + hw, minY = camera.y - hh, maxY = camera.y + hh;
  const cursorSpeed = (now - lastHoverT) < 60 ? Math.hypot(mouseVelW.x, mouseVelW.y) : 0;
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
    if (cursorSpeed > NUDGE_MIN_SPEED && Math.abs(lf.x - mouseWorld.x) < NUDGE_RADIUS && Math.abs(lf.y - mouseWorld.y) < NUDGE_RADIUS) {
      const n = nudge(mouseWorld.x, mouseWorld.y, lf.x, lf.y, NUDGE_RADIUS, cursorSpeed, LEAF_CURSOR, 1);
      lf.vx += n.vx * dt; lf.vy += n.vy * dt;                               // a cursor swipe scatters them
    }
    lf.x += lf.vx * dt; lf.y += lf.vy * dt;
    lf.rot += lf.rotV * dt + lf.vx * 0.0008;                               // tumble, swayed by motion
  }
}
// Drawn in the world transform (faint, small), so the litter sits in the world and
// parallaxes with it. Season-tinted to match the growth palette.
function drawLeaves() {
  if (!leaves.length) return;
  const base = PG.mix(PG.PALETTE.growthLight, PG.PALETTE.growthDeep, 0.35);
  const col = PG.applySat(base, seasonSat(seasonPhase));
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
// Birth / death cues (Wave L): a birth shimmers a soft warm-green bloom where new life
// appears; a passing disperses a faint grey puff. Brief and subtle — the ecosystem made
// legible without a word, in the same spirit as the crystal flash and stone grit.
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
  if (heldId) { attendId = null; return; }
  const o = hitTest(screenToWorld(cx, cy));
  attendId = o ? o.id : null;
}

// ---- befriend (the come-back hook): hold your attention on a creature ~4.4s and it BONDS
// to you — the server tames it (it then hovers near you, trailing you, drawn aglow) and we
// remember it. All the client adds is the steady-attention dwell; tame does the rest.
const BEFRIEND_DWELL = 4400;            // ms of unbroken attention on one creature to befriend it (doubled: harder to do inadvertently)
let befriendTrack = null, befriendSince = 0, befriendSent = false;
let myFriendId = (() => { try { return localStorage.getItem('drift_friend'); } catch { return null; } })(); // a befriended creature, remembered across visits
function updateBefriend(now) {
  const o = (attendId && !heldId) ? objects.get(attendId) : null;
  if (!o || o.family !== 'creature' || isLifted(o.id)) { befriendTrack = null; befriendSent = false; return; }
  if (o.id !== befriendTrack) { befriendTrack = o.id; befriendSince = now; befriendSent = false; return; } // a new creature → restart the dwell
  if (!befriendSent && now - befriendSince >= BEFRIEND_DWELL) {
    befriendSent = true;
    myFriendId = o.id; try { localStorage.setItem('drift_friend', o.id); } catch {}
    send({ t: 'befriend', id: o.id, token, ts: Date.now() });
    const p = creaturePos(o);
    creatureEvts.push({ x: p.x, y: p.y, start: now, birth: true }); // a warm confirming bloom where it stands
    giantChime();                                                   // a soft little flourish (silent unless sound is on)
  }
}

// ---- pointer input (Pointer Events only) — direct manipulation --------------
// A pointerdown on a free object becomes a CARRY as soon as it moves (drag to
// move); a press-release without moving is a "follow" pickup that tracks the
// cursor until you tap to place. Dragging the empty background pans; two pointers
// pinch-zoom; hover (mouse) / long-press (touch) on an object attends it (§5.2).
const pointers = new Map(); // id -> { x, y, sx, sy, maxMove }
let pinch = null, multiTouched = false;
let lastMouse = { x: 0, y: 0 };  // last mouse screen position (anchors desktop gesture-zoom)
// Hover velocity in WORLD units (Wave 6): a moving cursor stirs nearby light things.
let mouseWorld = { x: 0, y: 0 }, mouseVelW = { x: 0, y: 0 }, lastHoverT = 0, lastHoverW = null;
function trackMouseHover(cx, cy) {
  const w = screenToWorld(cx, cy), t = performance.now();
  if (lastHoverW && lastHoverT) {
    const dt = (t - lastHoverT) / 1000;
    if (dt > 0.001) {
      mouseVelW.x = ema(mouseVelW.x, (w.x - lastHoverW.x) / dt, 0.5);
      mouseVelW.y = ema(mouseVelW.y, (w.y - lastHoverW.y) / dt, 0.5);
    }
  }
  mouseWorld = w; lastHoverW = w; lastHoverT = t;
}
let grab = null;                 // pending press on an object: { id, ox, oy } (object-centre − pointer, world units)
let lastTapId = null, lastTapT = 0; // double-tap-a-stone detection (→ break)
let frameStones = [];            // visible rock footprints {x,y,r} this frame — ground creatures steer around them (Unit ⑥)
let frameLodCut = 0;             // on-screen radius below which to LOD this frame (0 = LOD nothing); set by the detail budget in the cull pass
let holdMode = null;             // null | 'drag' (an object carried by a pressed pointer)
let holdOff = { x: 0, y: 0 };    // world-unit offset object-centre − pointer, so a grab doesn't snap to centre

function beginHold(o, mode, off) {
  // Start the carry where the object is actually DRAWN: a free creature wanders off
  // its stored home, so seeding carry from o.x/o.y would snap it home on pickup.
  const live = (o.family === 'creature') ? creaturePos(o) : { x: o.x, y: o.y };
  preGrab = { x: o.x, y: o.y };                   // the true stored position (restore target if rejected)
  heldId = o.id; holdMode = mode; holdOff = off || { x: 0, y: 0 };
  heldSince = performance.now();
  carry = { x: live.x, y: live.y };
  flingVel.x = 0; flingVel.y = 0; lastCarryPos = null; lastCarryT = 0; // fresh velocity
  o.held = true;                                  // optimistic; the server confirms via pickup_ack
  setLift(o.id, 1, LIFT_MS, EASE_RISE);
  send({ t: 'pickup', id: o.id, token, ts: Date.now() });
  Audio.event('pickup', { seed: o.seed, family: o.family, x: o.x }); // a generative lift tone (silent unless sound is on)
}
function carryTo(cx, cy) {                         // keep the grab point under the pointer
  if (!heldId) return;
  const w = screenToWorld(cx, cy);
  carry = { x: w.x + holdOff.x, y: w.y + holdOff.y };
  const o = objects.get(heldId); if (o) { o.x = carry.x; o.y = carry.y; }
  trackVel();
  maybeSendCarry();
}
// Sample carry velocity (EMA toward the latest), so a release can throw the object.
function trackVel() {
  const t = performance.now();
  if (lastCarryPos && lastCarryT) {
    const dt = (t - lastCarryT) / 1000;
    if (dt > 0.001) {
      flingVel.x = ema(flingVel.x, (carry.x - lastCarryPos.x) / dt, 0.6);
      flingVel.y = ema(flingVel.y, (carry.y - lastCarryPos.y) / dt, 0.6);
    }
  }
  lastCarryPos = { x: carry.x, y: carry.y }; lastCarryT = t;
}
// A drag released while moving is THROWN: the object detaches from the pointer
// immediately (so you can pan or grab again at once) and glides free under friction
// until it settles into a place. It stays server-held by our token mid-flight.
function startFling() {
  const id = heldId;
  const o = objects.get(id);
  let vx = flingVel.x, vy = flingVel.y;
  // A non-finite velocity (the THROW_MAX clamp divides by speed — Infinity/Infinity →
  // NaN) must never reach the glide: it would fly forever, streaming null → (0,0).
  if (!o || !Number.isFinite(vx) || !Number.isFinite(vy)) { placeHold(); return; }
  const sp = Math.hypot(vx, vy);
  if (sp > THROW_MAX) { const k = THROW_MAX / sp; vx *= k; vy *= k; }
  // Remember a KNOWN-FINITE launch point so a corrupted glide can always settle home.
  const x0 = Number.isFinite(o.x) ? o.x : (carry ? carry.x : 0);
  const y0 = Number.isFinite(o.y) ? o.y : (carry ? carry.y : 0);
  flying.set(id, { vx, vy, x0, y0 });               // stays lifted (from the drag) for the whole arc — settles on land
  clearHold();                                      // release the pointer NOW (the object flies on its own)
}
// Re-anchor a just-placed creature's wander to NOW (server-aligned) so it continues
// from the drop point immediately — without waiting for the server's echo, which would
// otherwise leave it jumped-out for one round-trip. The server's authoritative t0
// follows and matches within the clock skew (an imperceptible settle).
function reanchorCreature(o) { if (o && o.family === 'creature') o.wanderT0 = Date.now() + clockSkew; }
function placeHold(kind) {                         // settle the held object where it is
  if (!heldId) return;
  const o = objects.get(heldId);
  if (o) { o.x = carry.x; o.y = carry.y; o._tx = carry.x; o._ty = carry.y; o.held = false; reanchorCreature(o); }
  send({ t: 'place', id: heldId, token, x: carry.x, y: carry.y, ts: Date.now() });
  setLift(heldId, 0, SETTLE_MS, EASE_SETTLE);
  if (o) Audio.event(kind || 'place', { seed: o.seed, family: o.family, x: o.x }); // generative settle/land tone
  clearHold();
}
function clearHold() { heldId = null; holdMode = null; carry = null; preGrab = null; grab = null; }

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, maxMove: 0 });
  attendId = null; clearLongPress(); lpFired = false;   // any press interrupts a hover/long-press
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
  else if (hit) { swayId = hit.id; swaying.add(hit.id); }
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
  if (p.maxMove > SLOP) clearLongPress(); // moved → it's a pan/carry, not an attend

  if (pointers.size >= 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const before = screenToWorld(mx, my);
    camera.z = clamp(pinch.z0 * (d / pinch.d0), zMin(), ZMAX);
    const after = screenToWorld(mx, my);
    camera.x += before.x - after.x; camera.y += before.y - after.y;     // zoom, anchored at the centroid
    applyPan(-(mx - pinch.mx) / camera.z, -(my - pinch.my) / camera.z); // + two-finger pan (resisted at the edge)
    pinch.mx = mx; pinch.my = my;
    clampCam(); // keep the zoom-anchor jump inside the world too
    arrive = null;
    return;
  }
  if (pointers.size !== 1) return;

  if (holdMode === 'drag') {
    carryTo(e.clientX, e.clientY);                       // actively carrying
  } else if (grab && p.maxMove > SLOP) {                 // a press on a movable object that moved → pick it up + carry
    const o = objects.get(grab.id);
    if (!o) { grab = null; }
    else { beginHold(o, 'drag', { x: grab.ox, y: grab.oy }); carryTo(e.clientX, e.clientY); }
  } else if (!grab && p.maxMove > SLOP) {                // empty ground or a rooted tree → pan
    if (swayId) { const o = objects.get(swayId); if (o) { o._bendV = (o._bendV || 0) + dx * SWAY_IMPULSE; swaying.add(swayId); } } // lean the pressed tree with the drag
    applyPan(-dx / camera.z, -dy / camera.z); arrive = null;
  }
});

function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  if (pointers.size < 2) pinch = null;
  clearLongPress();
  const wasLong = lpFired; lpFired = false;
  const moved = p ? p.maxMove >= SLOP : false;

  if (holdMode === 'drag') {
    // released an active carry: if it was still moving, throw it (detaches); else place it.
    const speed = Math.hypot(flingVel.x, flingVel.y);
    if (speed > THROW_MIN && (performance.now() - lastCarryT) < 90) startFling();
    else placeHold();
  } else if (!moved && !wasLong && !multiTouched) {       // a still, deliberate tap
    const tnow = performance.now();
    const wpt = p ? screenToWorld(p.sx, p.sy) : null;
    const o = grab ? objects.get(grab.id) : null;
    if (wpt && giants.some((g) => Math.hypot(wpt.x - g.x, wpt.y - g.y) < GIANT_R * 0.55)) { // a friendly tap on a journeyer
      giantChime();                                       // a warm little chime...
      send({ t: 'giant_skip', token, ts: Date.now() });   // ...and it lets go of this task and ambles to the next
    } else if (o && (o.family === 'stone' || (o.family === 'anomaly' && o.kinds && o.kinds.length > 1))) { // double-tap a stone → smaller stones; a fused anomaly → split back into its kinds
      if (lastTapId === o.id && tnow - lastTapT < DBLTAP_MS) { send({ t: 'break', id: o.id, token, ts: Date.now() }); lastTapId = null; }
      else { lastTapId = o.id; lastTapT = tnow; }
    } else if (!grab && p) {                               // a tap on BARE ground → double-tap leaves a mark (Wave S)
      const w = screenToWorld(p.sx, p.sy);
      if (!hitTest(w)) {                                   // truly empty (not over a rooted tree / object)
        if (lastTapId === 'ground' && tnow - lastTapT < DBLTAP_MS) { send({ t: 'mark', x: w.x, y: w.y, ts: Date.now() }); lastTapId = null; }
        else { lastTapId = 'ground'; lastTapT = tnow; }
      }
    }
    grab = null;                                          // a single tap does nothing (no sticky pickup)
  } else {
    grab = null;
  }
  if (e.pointerType !== 'mouse') attendId = null; // touch attend ends on release (a mouse keeps hovering)
  if (pointers.size === 0) multiTouched = false;
  swayId = null;                                  // release the swayed tree — it springs back upright
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) multiTouched = false;
  clearLongPress(); lpFired = false; attendId = null; swayId = null;
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
  arrive = null;
}, { passive: false });

// Safari (desktop) reports a trackpad pinch as non-standard gesture* events, NOT a
// ctrlKey wheel — without handling these, pinch-to-zoom is dead on Safari. Anchor
// the zoom on the gesture's cursor position (falling back to the last mouse point).
let gestureZ0 = Z0, gestureAnchor = null;
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
  camera.x += before.x - after.x; camera.y += before.y - after.y; clampCam(); arrive = null;
}, { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

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
} else if (!localStorage.getItem('drift_sound_hinted')) {
  // First visit with sound OFF: pulse the glyph a few times (once ever) so the one
  // sound control is findable — the answer to "I can't hear anything". Wordless.
  localStorage.setItem('drift_sound_hinted', '1');
  setTimeout(() => { snd.classList.add('show', 'hint'); setTimeout(() => snd.classList.remove('hint', 'show'), 5600); }, 1800);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { settleFlying(); Audio.onHidden(); } // rAF pauses when hidden — don't leave thrown objects held
  else Audio.onVisible();
});

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
  for (const id of flying.keys()) { const o = objects.get(id); if (o) o.held = false; } // thrown objects are reclaimed too
  flying.clear();
  clearHold();
}

function onMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'world_state': {
      myPid = m.pid;
      objects.clear(); lifts.clear();
      for (const o of m.objects) objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      if (m.season != null) seasonPhase = m.season;
      if (m.now != null) clockSkew = m.now - Date.now(); // lock the creature wander clock to the server's
      if (m.pool) pool = m.pool;
      if (Array.isArray(m.pools) && m.pools.length) pools = m.pools; else if (pool) pools = [pool]; // every pond (fallback: the central one)
      if (Array.isArray(m.giants)) giants = m.giants.map((g) => ({ ...g, _tx: g.x, _ty: g.y })); // the gardeners (snap to their spots on (re)connect)
      if (m.bounds && Number.isFinite(m.bounds.x) && Number.isFinite(m.bounds.y)) worldBounds = m.bounds; // before the arrive, so a stranded home is pulled back in
      // Orient on the FIRST arrival only (a reconnect must not yank the camera back):
      // a returning visitor drifts toward their remembered home, a new one toward the cog.
      // A home saved BEFORE camera bounds existed could be out in the void — if it's
      // beyond the world, fall back to the cog so a stranded visitor lands among objects.
      if (!arrivedOnce) {
        arrivedOnce = true;
        let t = home || m.cog;
        if (t && worldBounds && (Math.abs(t.x) > worldBounds.x || Math.abs(t.y) > worldBounds.y)) t = m.cog;
        if (t) startArrive(t.x, t.y);
      }
      break;
    }
    case 'object_state': {
      const o = objects.get(m.id);
      if (!o) break; // unknown (already dissolved) — ignore
      const wasHeld = o.held;
      // A small move on a free object is water-drift — ease it (no pop), like growth.
      // Larger jumps (place, initial) snap. Held objects always snap.
      const dx = m.x - o.x, dy = m.y - o.y;
      // A free creature's home migrates each tick (goal-seeking, Wave G1) — ALWAYS ease
      // it (never snap), so it drifts smoothly. Others ease a small water-drift hop and
      // snap larger jumps (place, initial).
      const easeCreature = o.family === 'creature' && !m.held && m.id !== heldId;
      // A stone the server rolled out of water (m.roll), OR bounced off an already-capped
      // rock (m.bounce), ALWAYS eases to its resting spot — a smooth roll/slide, never a snap.
      const roll = m.roll && m.id !== heldId;
      const bounce = m.bounce && m.id !== heldId;
      if (roll || bounce || easeCreature || (!m.held && m.id !== heldId && dx * dx + dy * dy <= POS_EASE_MAX * POS_EASE_MAX)) {
        o._tx = m.x; o._ty = m.y; // leave o.x/o.y to glide toward the target
        if (roll || bounce) o._roll = 1;    // a slower, deliberate ease until it settles (updatePositions)
      } else {
        o.x = m.x; o.y = m.y; o._tx = m.x; o._ty = m.y;
      }
      if (bounce) Audio.event('land', { seed: o.seed, family: o.family, x: m.x }); // a soft clack as the maxed rock shoulders it off
      o.handling = m.handling; o.held = !!m.held;
      if (m.act != null) o.act = m.act; // current focus word (debug label)
      if (m.maturity != null) o.maturity = m.maturity;
      if (m.aged != null) o.aged = m.aged;
      if (m.wanderT0 != null) o.wanderT0 = m.wanderT0; // a placed creature re-anchored its wander
      if (m.glowUntil != null) { o.glowUntil = m.glowUntil; o.glowHue = m.glowHue; } // anomaly glow buff
      if (m.tameUntil != null) { const sNow = Date.now() + clockSkew; if (!(o.tameUntil > sNow)) o._tameStart = performance.now(); o.tameUntil = m.tameUntil; } // tamed (hovers near + follows its person); stamp when the bond began so it eases in
      if (m.r != null) o.r = m.r; // a fused stone grew (regens its geometry via stoneGeom)
      if (m.kinds) o.kinds = m.kinds; // a fused anomaly's hybrid kinds (blended form + breakability)
      o.heldBy = m.heldBy || ''; // who's carrying it (ephemeral pid) — drives the felt-presence tether
      if (m.id !== heldId) {
        if (o.held && !wasHeld) setLift(o.id, 1, LIFT_MS, EASE_RISE);
        else if (!o.held && wasHeld) setLift(o.id, 0, SETTLE_MS, EASE_SETTLE);
      }
      break;
    }
    case 'season': { // the world's slow clock advanced
      if (m.phase != null) seasonPhase = m.phase;
      if (m.bounds && Number.isFinite(m.bounds.x) && Number.isFinite(m.bounds.y)) worldBounds = m.bounds; // keep the camera bound fresh as the world grows
      if (Array.isArray(m.giants)) { // the gardeners stepped — glide toward their new spots
        for (let i = 0; i < m.giants.length; i++) {
          const mg = m.giants[i];
          if (giants[i]) { const g = giants[i]; g._tx = mg.x; g._ty = mg.y; g.hx = mg.hx; g.hy = mg.hy; g.walk = mg.walk; g.tending = mg.tending; g.act = mg.act; g.stuck = mg.stuck; }
          else giants[i] = { ...mg, _tx: mg.x, _ty: mg.y };
        }
      }
      break;
    }
    case 'object_new': { // a shed seed (or other runtime-spawned object)
      const o = m.o;
      objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      // a creature born (mated into being) shimmers softly where it appears — life made legible
      if (o.family === 'creature') creatureEvts.push({ x: o.x, y: o.y, start: performance.now(), birth: true });
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
      if (m.splash) { // a bug dropped in a pond → fish food: a ripple + the pond's fish rush over to eat
        ripples.push({ x: m.x, y: m.y, start: performance.now() });
        const pond = pools.find((p) => Math.hypot(m.x - p.x, m.y - p.y) <= p.r + 30);
        if (pond) {
          // the NEAREST fish reaches the bug first + eats it — find its swim time so the rush ends then
          let minD = Infinity;
          for (const o of objects.values()) {
            if (o.family !== 'fish') continue;
            const fp = creaturePos(o);
            if (Math.hypot(fp.x - pond.x, fp.y - pond.y) > pond.r + 40) continue;
            const d = Math.hypot(fp.x - m.x, fp.y - m.y); if (d < minD) minD = d;
          }
          const eatT = Math.min(FEED_RUSH_CAP_MS / 1000, minD === Infinity ? 0.6 : minD / FISH_SWIM_SPEED);
          feedRushes.push({ x: m.x, y: m.y, start: performance.now(), pond, eatT });
        }
      }
      else if (m.burst) ripples.push({ x: m.x, y: m.y, start: performance.now(), burst: true }); // an anomaly burst a tree into saplings
      else if (og && og.family === 'crystal') flashes.push({ x: og.x, y: og.y, start: performance.now() }); // brief flash
      else if (og && (og.family === 'stone' || m.grit)) // worn to grit — a brief scatter of dust
        grits.push({ x: og.x, y: og.y, seed: og.seed, r: objRadius(og), start: performance.now() });
      else if (og && og.family === 'creature') { const p = creaturePos(og); creatureEvts.push({ x: p.x, y: p.y, start: performance.now(), birth: false }); } // a passing — a soft puff
      objects.delete(m.id); lifts.delete(m.id); flying.delete(m.id);
      if (heldId === m.id) clearHold();
      break;
    }
    case 'pickup_ack': {
      if (!m.ok) { // lost the race — stop owning it (whether still in hand or already thrown)
        flying.delete(m.id);                  // a rejected throw stops gliding; the real holder's state wins
        const o = objects.get(m.id);
        // held=false so the server's corrective object_state (held:true, from the real
        // holder) re-lifts it; leaving it true would suppress that re-lift.
        if (o) { if (heldId === m.id && preGrab) { o.x = preGrab.x; o.y = preGrab.y; o._tx = preGrab.x; o._ty = preGrab.y; } o.held = false; }
        setLift(m.id, 0, SETTLE_MS, EASE_SETTLE);
        if (heldId === m.id) clearHold();
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
  adaptQuality(qPrevNow ? now - qPrevNow : 16.7, now); qPrevNow = now; // measure + maybe shed/restore detail
  animT = now / 1000;
  updateLifts(now);
  updateGrowth(now);
  updatePositions(now);
  updateFlying(now);
  updateCollision(now);
  updateNudge(now);
  updateSway(now);
  if (Q.leaves) updateLeaves(now);
  updateDissolve(now);
  updateBefriend(now); // steady attention on a creature bonds it to you (come-back hook)
  updateArrive(now);
  clampCam(); // backstop: keep the camera in bounds across resize / a shrinking world bound

  // background (screen space) — world-locked objects pan over a near-fixed
  // backdrop, which reads as subtle parallax depth.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  paintGround(ctx, vw, vh, seasonGround(seasonPhase));
  if (Q.glows) paintGlows(ctx, vw, vh, bgSeed, -camera.x * camera.z * GLOW_PARALLAX, -camera.y * camera.z * GLOW_PARALLAX); // parallax drift
  if (Q.noise) paintNoise(ctx, vw, vh, bgSeed + 1);

  // objects (world space) — single matrix folds dpr + zoom + pan
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z,
    dpr * (vw / 2 - camera.x * camera.z), dpr * (vh / 2 - camera.y * camera.z));
  if (Q.patches) paintGroundPatches(ctx); // world-anchored terrain tint (precomputed buffer, one blit), beneath water + objects
  for (const pd of pools) paintWaterWorld(ctx, pd, animT); // every pond, beneath the objects
  if (Q.flow && poolOnScreen()) paintFlow(ctx, pool, animT); // faint flow streaks — only the central pool's drift band
  // ground marks (Wave S): flat rock-shaped stains, beneath objects, healing over ~10 min
  const markNow = Date.now() + clockSkew; // server clock for the heal age
  for (const o of objects.values()) {
    if (o.family !== 'mark') continue;
    const life = 1 - (markNow - (o.created_at || markNow)) / MARK_LIFE_MS;
    if (life <= 0) continue;
    const s = worldToScreen(o.x, o.y);
    if (!inViewport(s.x, s.y, vw, vh, CULL_MARGIN)) continue;
    drawMark(o, life);
  }
  // the journeyer's footprints — soft, quick-fading dabs on the ground (beneath objects)
  for (let i = giantFootprints.length - 1; i >= 0; i--) {
    const fp = giantFootprints[i], age = now - fp.start;
    if (age > FOOT_FADE_MS) { giantFootprints.splice(i, 1); continue; }
    const a = (1 - age / FOOT_FADE_MS) * 0.22;
    ctx.fillStyle = PG.rgba('#2a2620', a);
    ctx.beginPath(); ctx.ellipse(fp.x, fp.y, GIANT_R * 0.06, GIANT_R * 0.035, 0, 0, Math.PI * 2); ctx.fill();
  }
  const list = [];
  const nextStones = []; // visible rocks → next frame's creature-fencing footprints (Unit ⑥)
  // Viewport culling: only the objects on (or just off) screen are sorted/drawn.
  // Lifted/held objects are never culled — they're drawn in the screen-space pass.
  for (const o of objects.values()) {
    if (isLifted(o.id) || o.family === 'mark') continue; // marks are drawn in their own pass above
    const p = posOf(o);
    const s = worldToScreen(p.x, p.y);
    if (!inViewport(s.x, s.y, vw, vh, CULL_MARGIN)) continue;
    // Depth = ground line; a free creature sorts by its LIVE wander y (where it's
    // actually drawn, not its home), and a flier rides above ground clutter.
    o._sortY = ((o.family === 'creature' || o.family === 'fish') && o.id !== heldId && !o.held)
      ? p.y + (o.kind === 'flier' ? flierLift(o) : 0)
      : groundY(o);
    o._depthScale = depthScaleAt(s.y); // size-by-depth (Wave K) — used by draw + hit-test
    if (o.family === 'stone') nextStones.push({ x: p.x, y: p.y, r: stoneSize(o) }); // a rock fences ground creatures
    list.push(o);
  }
  frameStones = nextStones; // creaturePos reads this next frame (a frame's lag is invisible)
  // The gardeners: a synthetic draw entry each so they sort + shadow + depth-scale with
  // everything else (not in `objects`, so never hit-tested or pickable). Each one's eye
  // follows the OTHER, wherever it is in the world.
  for (let gi = 0; gi < giants.length; gi++) {
    const G = giants[gi]; if (G._tx == null) continue;
    const gs = worldToScreen(G.x, G.y);
    if (!inViewport(gs.x, gs.y, vw, vh, CULL_MARGIN)) continue;
    const other = giants[(gi + 1) % giants.length];
    const ge = { family: 'giant', id: '__giant' + gi, x: G.x, y: G.y, hx: G.hx || 1, hy: G.hy || 0, gait: Math.min(1, (G._spd || 0) / GIANT_VIS_SPEED), tend: G._tend || 0 };
    if (other && other !== G) { ge.lookX = other.x; ge.lookY = other.y; } // its gaze tracks its companion
    ge._sortY = G.y; ge._depthScale = depthScaleAt(gs.y);
    list.push(ge);
  }
  // LOD-by-LOAD: if more objects are visible than the detail budget, LOD the smallest-on-
  // screen overflow (find the budget-th largest size → cut below it). Under budget → 0 → all
  // full detail, however small. So chunkiness is purely a function of on-screen count (cost).
  frameLodCut = 0;
  if (list.length > Q.detailBudget) {
    const sizes = [];
    for (const o of list) { if (formOf(o.family).alwaysFull) continue; sizes.push(objRadius(o) * (o._depthScale || 1) * camera.z); }
    if (sizes.length > Q.detailBudget) { sizes.sort((a, b) => b - a); frameLodCut = sizes[Q.detailBudget] || 0; }
  }
  // painter's depth by ground line; ties broken by id for a stable, deterministic order
  list.sort((a, b) => (a._sortY - b._sortY) || (a.id < b.id ? -1 : 1));
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
  if (Q.leaves) drawLeaves(); // cosmetic drifting litter, above the objects (Wave F)
  drawCreatureEvts(now); // brief birth/death cues (world space)

  aDensity = list.length; // objects on screen — feeds the ambient sound's richness

  // overlays (screen space)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let warmth = 0;
  const active = []; // live presences this frame — reused for shared warmth + carry tethers
  for (const [pid, p] of presences) {
    const inten = presenceIntensity(p, now);
    if (inten <= 0) {
      if ((p.gone && now - p.gone > P_OUT) || (now - p.last > P_IDLE + P_OUT)) presences.delete(pid);
      continue;
    }
    if (inten > warmth) warmth = inten;
    const s = worldToScreen(p.x, p.y);
    paintPresence(ctx, vw, vh, s.x, s.y, vw * 0.55, inten);
    active.push({ pid, wx: p.x, wy: p.y, inten });
  }
  // Shared warmth: working the same patch as someone blooms a brighter warmth BETWEEN
  // you — presence felt as mutual, intensifying the closer you are (Wave E). My OWN
  // position (the camera centre) joins the pairing so the warmth blooms between me and
  // others, not only between two other people; my standalone bloom is never drawn.
  const myC = screenToWorld(vw / 2, vh / 2);
  const pairing = active.concat([{ wx: myC.x, wy: myC.y, inten: 1 }]);
  for (let i = 0; i < pairing.length; i++) for (let j = i + 1; j < pairing.length; j++) {
    const a = pairing[i], b = pairing[j];
    const near = 1 - Math.min(1, Math.hypot(a.wx - b.wx, a.wy - b.wy) / SHARED_RADIUS);
    if (near <= 0) continue;
    const mid = worldToScreen((a.wx + b.wx) / 2, (a.wy + b.wy) / 2);
    paintPresence(ctx, vw, vh, mid.x, mid.y, vw * 0.42, near * Math.min(a.inten, b.inten) * SHARED_BOOST);
    warmth = Math.max(warmth, near * Math.min(a.inten, b.inten)); // shared work warms the world (and its sound)
  }
  // Carry tethers: link each object being carried by SOMEONE ELSE to that person, so
  // it reads that a person is moving it (not a thing drifting on its own).
  for (const o of objects.values()) {
    if (!o.heldBy || o.heldBy === myPid) continue;
    const p = presences.get(o.heldBy);
    if (!p) continue;
    const ps = worldToScreen(p.x, p.y), os = worldToScreen(o.x, o.y);
    paintCarryTether(ctx, ps.x, ps.y, os.x, os.y, presenceIntensity(p, now));
  }
  aWarmth = warmth; // free (piggybacks the presence pass)
  if (Audio.isEnabled()) {
    aWater = poolOnScreen() ? 0.5 + 0.5 * Math.sin(animT * 0.4) : 0; // matches the visible sheen's shimmer
    Audio.setState(audioState());
  }
  if (Q.sky) paintSky(ctx, vw, vh, seasonPhase); // atmospheric horizon — hazes the up-screen world (depth), beneath held objects

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
  // brief water ripples (~650ms expanding rings) — a bug dropped in a pond became fish food
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i], age = now - rp.start;
    if (age > 650) { ripples.splice(i, 1); continue; }
    const p = age / 650, s = worldToScreen(rp.x, rp.y), z = camera.z;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const hue = rp.burst ? '#bfe6a4' : '#bfe2f2'; // burst = a green shimmer; splash = water-blue
    for (let k = 0; k < 2; k++) { // two staggered rings spreading outward
      const pk = p - k * 0.2; if (pk <= 0) continue;
      ctx.strokeStyle = PG.rgba(hue, 0.5 * (1 - pk)); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(s.x, s.y, (5 + pk * 34) * z, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  for (let i = feedRushes.length - 1; i >= 0; i--) { const fr = feedRushes[i]; if (now - fr.start > Math.min(FEED_RUSH_CAP_MS, (fr.eatT + FEED_RELEASE) * 1000)) feedRushes.splice(i, 1); } // expire once the bug is eaten + the fish have eased back

  // FOCUS LABELS (debug): the world's only text — a small word under each on-screen creature
  // naming its current focus (feed/drink/rest/roam/follow). Screen space, so zoom-independent.
  if (showFocus) {
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const o of list) {
      if (o.family !== 'creature' || !o.act) continue;
      const p = creaturePos(o), s = worldToScreen(p.x, p.y);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(o.act, s.x + 0.7, s.y + 13.7); // a soft shadow for legibility on any ground
      ctx.fillStyle = ACT_COLOR[o.act] || 'rgba(240,236,228,0.95)'; ctx.fillText(o.act, s.x, s.y + 13);
    }
    // the gardeners share their focus too (and flag when stuck — for diagnosing the wander)
    for (const g of giants) {
      if (g._tx == null || !g.act) continue;
      const s = worldToScreen(g.x, g.y), word = g.act + (g.stuck >= 2 ? ' ·stuck' : ''), yo = GIANT_R * camera.z * 0.5 + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(word, s.x + 0.7, s.y + yo + 0.7);
      ctx.fillStyle = g.stuck >= 2 ? 'rgba(240,150,150,0.98)' : 'rgba(190,225,170,0.96)'; ctx.fillText(word, s.x, s.y + yo);
    }
  }

  if (Q.grade) paintSeasonGrade(ctx, vw, vh, seasonPhase); // season composite (crossfaded), last

  // season saturation as a GPU CSS filter on the canvas (set only on change). A struggling
  // machine drops it (Q.sat 0 → filter off): re-filtering the whole canvas every frame is
  // one of the costliest things on a weak GPU.
  const sat = Q.sat ? seasonSat(seasonPhase) : 1;
  if (Math.abs(sat - lastSat) > 0.001) { canvas.style.filter = sat < 0.999 ? `saturate(${sat.toFixed(3)})` : 'none'; lastSat = sat; }

  requestAnimationFrame(frame);
}

// ---- helpers ----------------------------------------------------------------
// NaN-safe: a NaN slips through Math.max/min unchanged, which once let a degenerate
// pinch (coincident touch points → 0/0) poison camera.z and, through it, every
// throw/carry position. Collapsing NaN to `lo` keeps the camera (and everything
// derived from it) finite no matter what upstream produced.
function clamp(v, lo, hi) { return v !== v ? lo : v < lo ? lo : v > hi ? hi : v; }
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
