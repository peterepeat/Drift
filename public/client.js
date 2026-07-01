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
import { SPROUT_C, BIG_TREE_MAT, GIANT_R, shownMat, shownAged, stoneSize, stoneGeom, anomalyR, crystalR, formOf } from './forms.js';
import { objRadius, isMovable, creaturePos, posOf, drawMark, drawObjectWorld, drawHeldScreen, paintAttend, FISH_SWIM_SPEED, FEED_RELEASE, FEED_RUSH_CAP_MS } from './draw.js'; // ctx-coupled object paint dispatch + position/geometry readers (4.14d)
import { IN, OUT } from './shared/protocol.js';
import { send, connect, setOnClearHold } from './net.js'; // WS connect/reconnect/send + the 9 message handlers + presence (4.14b)
import { setLift, liftValue, isLifted, updateLifts, updateGrowth, updatePositions, updateNudge, updateCollision, updateSway, updateLeaves, drawLeaves, drawCreatureEvts, GIANT_VIS_SPEED, LIFT_MS, SETTLE_MS, EASE_RISE, EASE_SETTLE } from './localfx.js'; // lift anim + per-frame cosmetic-fx passes (4.14e) // the wire single-source (2.6) — client now sends IN.* / switches on OUT.* (string-identical to the old raw types)
import { canvas, ctx, camera, objects, presences, lifts, flashes, ripples, feedRushes, grits, creatureEvts, giantFootprints, flying, swaying, mouseVelW, S } from './state.js'; // shared client state (4.14 mirror)
import { screenToWorld, worldToScreen, viewHalf, poolOnScreen, camLimits, zMin, clampCam, applyPan, startArrive, updateArrive, cancelArrive, saveHome, adaptQuality, setQTier, qStats, resize, queueResize, dpr, vw, vh, Q, home, Z0, ZMIN, ZMAX } from './view.js'; // camera/transforms/sizing/quality (4.14 mirror)

// ---- tuning constants -------------------------------------------------------
// Z0/ZMIN/ZMAX (zoom range) now live in view.js (imported above).
const SLOP = 8;                              // px of movement that turns a tap into a pan
// Camera bounds (Wave J): the camera centre is held within the object field (sent by
// the server as world half-extents) so you can never wander far into empty space —
// panning SLOWS as you approach the edge and STOPS at it. Zoom-aware: when zoomed out
// (the viewport already covers the world) the pannable range collapses toward centre.
// EDGE_MARGIN / EDGE_SOFT (camera edge-resistance) now live in view.js.
const HIT_MIN = 26;                          // min tap radius in CSS px (accessibility)
const HIT_PAD = 3, HIT_GROW = 1.18;          // grab area modestly exceeds the drawn form — easy to grab, but not so greedy it steals pans
const CARRY_SEND_MS = 50;                    // throttle for streaming a carried object
const THROW_MIN = 180;                       // release speed (world units/s) below which a drag just places — no fling
const THROW_FRICTION = 0.045;                // velocity retained per second mid-fling (fast, natural settle)
const THROW_STOP = 28;                        // a fling settles to a place once it slows below this (wu/s)
const THROW_MAX = 1600;                       // cap the launch speed so a hard flick can't hurl a thing across the world
const P_IN = 1500, P_OUT = 2500, P_IDLE = 2000; // bloom fade-in / fade-out / idle-before-fade
// Felt presence (Wave E): two people working the same patch share a warmth that
// blooms BETWEEN them (mutual, not two separate glows); a faint tether links a
// carried object to whoever is carrying it, so it reads that a PERSON is moving it.
const SHARED_RADIUS = 620;                   // world units within which two presences share warmth
const SHARED_BOOST = 3.2;                     // strength of the extra between-them bloom (intensifies the shared patch)
// SPROUT_C / BIG_TREE_MAT / GIANT_R now live in forms.js (the client form-const home)
const FOOT_FADE_MS = 4200;                    // a footprint fades this fast (so the giant doesn't track prints all over the world)
const GLOW_PARALLAX = 0.04;                   // ambient glows drift this fraction of the camera (Wave H depth)
const DEPTH_TOP = 0.2;                         // objects at the TOP of the screen draw this much smaller (Wave K recession — subtle)
const ANOM_DISSOLVE_MS = 10000, ANOM_FADE_MS = 3000; // hold an anomaly 10s and it fades from your hands
const ATTEND_MS = 450;                        // long-press dwell before an object is "attended" (PRD §5.2)
const DBLTAP_MS = 320;                        // two taps on a stone within this BREAK it into smaller stones
const GRIT_MS = 500;                          // a worn-out stone's grit scatter lifetime (spec §4.3)
const MARK_LIFE_MS = 10 * 60 * 1000;          // a ground mark heals over ~10 min (mirror server MARK_LIFE_MS)
// The nudge / collision / leaf-litter / sway-spring tuning consts now live in localfx.js (4.14e).
// Rooted trees (Wave C): the biggest plants are immovable landmarks. They show ROOTS
// gripping the earth (so it reads WHY they won't come) and SWAY in the drag direction,
// then spring back, when you try to drag across them — a render-only canopy lean.
const SWAY_IMPULSE = 0.0011;                   // how much a px of drag feeds the lean


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
// QUALITY_TIERS / qTier / Q / adaptQuality / setQTier now live in view.js (imported above);
// client.js reads the live `Q` binding to gate the render passes.
let qPrevNow = 0;              // frame-timing anchor for adaptQuality (the frame loop owns this)
// FOCUS LABELS (debug/troubleshooting): a tiny word under each creature naming its current
// focus. The world is deliberately wordless, so this is OFF by default — turn it on with
// ?focus=1 in the URL (the admin panel links here) or by pressing 'f'. The only text in Drift.
let showFocus = new URLSearchParams(location.search).has('focus');
const ACT_COLOR = { feed: 'rgba(150,210,120,0.95)', drink: 'rgba(130,190,235,0.95)', rest: 'rgba(225,200,150,0.95)', roam: 'rgba(200,195,185,0.9)', follow: 'rgba(240,150,150,0.96)' };
// PERF HUD (debug): a corner readout of the adaptive-quality tier + smoothed fps + the
// on-screen count vs the detail budget — so a chunky-looking world can be diagnosed as
// "tier dropped" vs "genuinely over budget". Off by default; ?perf=1 or press 'p'. To
// force full detail while testing, pin the tier with ?q=0 (see view.js adaptQuality).
let showPerf = new URLSearchParams(location.search).has('perf');
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') showFocus = !showFocus;
  else if (e.key === 'p' || e.key === 'P') showPerf = !showPerf;
});

// ---- canvas + viewport sizing ----------------------------------------------
// canvas/ctx (state.js) + dpr/vw/vh + resize/queueResize + the resize listeners now
// live in view.js (the render substrate + sizing; 4.14 mirror). client.js reads the
// live dpr/vw/vh bindings.

// ---- camera + transforms ---------------------------------------------------
// The camera transforms / sizing / adaptive-quality / pan-zoom-arrive machinery + the
// remembered `home` live in view.js; the WS layer + its `arrivedOnce` orient-once flag
// live in net.js (both imported above). client.js is now the orchestrator + input.

// ---- world state ------------------------------------------------------------
// The shared containers — objects/presences/lifts + the cosmetic FX buffers
// (flashes/ripples/feedRushes/grits/creatureEvts/giantFootprints) — now live in
// state.js so the extracted subsystems mutate the same references (4.14 mirror).
// pool/pools/giants/myPid/seasonPhase/animT/clockSkew now live on S (state.js) — the
// world MODEL: net writes them, render/draw/view read them (4.14 mirror).
let lastSat = -1;              // last-applied canvas saturation (avoids per-frame style writes)

// local hold
let preGrab = null; // S.heldId / S.carry / S.heldSince now live on S (state.js) — the HOLD state (input+net write, draw+localfx read)
// Throw momentum: the carried object's recent velocity (world units/s), sampled as
// it moves, so releasing a moving drag flings it on instead of freezing it (Wave 3).
let flingVel = { x: 0, y: 0 }, lastCarryPos = null, lastCarryT = 0;
// Thrown objects glide FREE of the pointer (id -> {vx,vy}): a throw releases the
// pointer immediately so you can pan / grab again while the object flies on. It
// stays server-held by our token until it lands (so S.carry streams), then places.

// ---- lift animation ---------------------------------------------------------
// An object is rendered in the lifted screen-space pass while it is being held
// (locally or remotely) or while it is settling. The world pass skips these.

// ---- object paint dispatch + geometry/position readers — now in draw.js (4.14d) ----
// (paintObject cascade + drawObjectWorld/drawLOD/drawMark/paintAttend/drawHeldScreen +
//  creaturePos/posOf/objRadius + glow/tame/warp; the form footprints live in forms.js.)
// A friendly little 3-note flourish when you greet the giant — all on the season
// pentatonic (so it's consonant + musical), silent unless sound is on.
function giantChime() {
  const x = S.giants[0] ? S.giants[0].x : 0;
  Audio.event('pickup', { seed: 0x51b1, family: 'anomaly', x });
  setTimeout(() => Audio.event('pickup', { seed: 0x7c33, family: 'anomaly', x }), 120);
  setTimeout(() => Audio.event('place', { seed: 0x2e9f, family: 'anomaly', x }), 250);
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
// Holding an anomaly for 10s dissolves it (it fades from your hands — never explained).
function updateDissolve(now) {
  if (!S.heldId) return;
  const ho = objects.get(S.heldId);
  if (ho && ho.family === 'anomaly' && (now - S.heldSince) >= ANOM_DISSOLVE_MS) {
    send({ t: IN.DISSOLVE, id: S.heldId, token, ts: Date.now() });
    objects.delete(S.heldId); lifts.delete(S.heldId);
    clearHold();
  }
}

// Advance every thrown object: friction decays its velocity, it glides, and once
// slow enough it settles into a place. Streams S.carry so others see the glide (it
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
      send({ t: IN.PLACE, id, token, x: f.x0, y: f.y0, ts: Date.now() });
      flying.delete(id);
      continue;
    }
    o.x = s.x; o.y = s.y; o._tx = s.x; o._ty = s.y; f.vx = s.vx; f.vy = s.vy;
    if (s.stopped) {
      o.held = false; reanchorCreature(o);
      setLift(id, 0, SETTLE_MS, EASE_SETTLE);        // settle down where it came to rest
      send({ t: IN.PLACE, id, token, x: o.x, y: o.y, ts: Date.now() });
      Audio.event('land', { seed: o.seed, family: o.family, x: o.x });
      flying.delete(id);
    } else if (sendNow) {
      send({ t: IN.CARRY, id, token, x: o.x, y: o.y, ts: Date.now() });
    }
  }
  if (sendNow) _flyCarryAt = now;
}
// Place every in-flight object NOW (used when the tab hides — rAF stops, so they'd
// otherwise sit server-held until the 45s reaper). Releases our hold cleanly.
function settleFlying() {
  for (const id of flying.keys()) {
    const o = objects.get(id);
    if (o) { o.held = false; reanchorCreature(o); o._tx = o.x; o._ty = o.y; setLift(id, 0, SETTLE_MS, EASE_SETTLE); send({ t: IN.PLACE, id, token, x: o.x, y: o.y, ts: Date.now() }); }
  }
  flying.clear();
}

// The lift animation + per-frame cosmetic-fx passes (growth/positions/nudge/collision/
// sway/leaves + the leaf & creature-event draws) now live in localfx.js (4.14e).

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
  if (S.heldId) { attendId = null; return; }
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

// ---- pointer input (Pointer Events only) — direct manipulation --------------
// A pointerdown on a free object becomes a CARRY as soon as it moves (drag to
// move); a press-release without moving is a "follow" pickup that tracks the
// cursor until you tap to place. Dragging the empty background pans; two pointers
// pinch-zoom; hover (mouse) / long-press (touch) on an object attends it (§5.2).
const pointers = new Map(); // id -> { x, y, sx, sy, maxMove }
let pinch = null, multiTouched = false;
let lastMouse = { x: 0, y: 0 };  // last mouse screen position (anchors desktop gesture-zoom)
// Hover velocity in WORLD units (Wave 6): a moving cursor stirs nearby light things.
let lastHoverW = null;              // previous hover world-point (for the velocity sample); S.mouseWorld/mouseVelW/S.lastHoverT now on state.js
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
let grab = null;                 // pending press on an object: { id, ox, oy } (object-centre − pointer, world units)
let lastTapId = null, lastTapT = 0; // double-tap-a-stone detection (→ break)
let holdMode = null;             // null | 'drag' (an object carried by a pressed pointer)
let holdOff = { x: 0, y: 0 };    // world-unit offset object-centre − pointer, so a grab doesn't snap to centre

function beginHold(o, mode, off) {
  // Start the S.carry where the object is actually DRAWN: a free creature wanders off
  // its stored home, so seeding S.carry from o.x/o.y would snap it home on pickup.
  const live = (o.family === 'creature') ? creaturePos(o) : { x: o.x, y: o.y };
  preGrab = { x: o.x, y: o.y };                   // the true stored position (restore target if rejected)
  S.heldId = o.id; holdMode = mode; holdOff = off || { x: 0, y: 0 };
  S.heldSince = performance.now();
  S.carry = { x: live.x, y: live.y };
  flingVel.x = 0; flingVel.y = 0; lastCarryPos = null; lastCarryT = 0; // fresh velocity
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
// Sample S.carry velocity (EMA toward the latest), so a release can throw the object.
function trackVel() {
  const t = performance.now();
  if (lastCarryPos && lastCarryT) {
    const dt = (t - lastCarryT) / 1000;
    if (dt > 0.001) {
      flingVel.x = ema(flingVel.x, (S.carry.x - lastCarryPos.x) / dt, 0.6);
      flingVel.y = ema(flingVel.y, (S.carry.y - lastCarryPos.y) / dt, 0.6);
    }
  }
  lastCarryPos = { x: S.carry.x, y: S.carry.y }; lastCarryT = t;
}
// A drag released while moving is THROWN: the object detaches from the pointer
// immediately (so you can pan or grab again at once) and glides free under friction
// until it settles into a place. It stays server-held by our token mid-flight.
function startFling() {
  const id = S.heldId;
  const o = objects.get(id);
  let vx = flingVel.x, vy = flingVel.y;
  // A non-finite velocity (the THROW_MAX clamp divides by speed — Infinity/Infinity →
  // NaN) must never reach the glide: it would fly forever, streaming null → (0,0).
  if (!o || !Number.isFinite(vx) || !Number.isFinite(vy)) { placeHold(); return; }
  const sp = Math.hypot(vx, vy);
  if (sp > THROW_MAX) { const k = THROW_MAX / sp; vx *= k; vy *= k; }
  // Remember a KNOWN-FINITE launch point so a corrupted glide can always settle home.
  const x0 = Number.isFinite(o.x) ? o.x : (S.carry ? S.carry.x : 0);
  const y0 = Number.isFinite(o.y) ? o.y : (S.carry ? S.carry.y : 0);
  flying.set(id, { vx, vy, x0, y0 });               // stays lifted (from the drag) for the whole arc — settles on land
  clearHold();                                      // release the pointer NOW (the object flies on its own)
}
// Re-anchor a just-placed creature's wander to NOW (server-aligned) so it continues
// from the drop point immediately — without waiting for the server's echo, which would
// otherwise leave it jumped-out for one round-trip. The server's authoritative t0
// follows and matches within the clock skew (an imperceptible settle).
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
function clearHold() { S.heldId = null; holdMode = null; S.carry = null; preGrab = null; grab = null; }

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
    applyPan(-(mx - pinch.mx) / camera.z, -(my - pinch.my) / camera.z); // + two-finger pan (resisted at the edge)
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
    applyPan(-dx / camera.z, -dy / camera.z); cancelArrive();
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
    // released an active S.carry: if it was still moving, throw it (detaches); else place it.
    const speed = Math.hypot(flingVel.x, flingVel.y);
    if (speed > THROW_MIN && (performance.now() - lastCarryT) < 90) startFling();
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
    grab = null;
  }
  if (e.pointerType !== 'mouse') attendId = null; // touch attend ends on release (a mouse keeps hovering)
  if (pointers.size === 0) multiTouched = false;
  S.swayId = null;                                  // release the swayed tree — it springs back upright
}
canvas.addEventListener('pointerup', endPointer);
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
  camera.x += before.x - after.x; camera.y += before.y - after.y; clampCam(); cancelArrive();
}, { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

let lastCarry = 0;
function maybeSendCarry() {
  const n = performance.now();
  if (n - lastCarry < CARRY_SEND_MS) return;
  lastCarry = n;
  if (S.heldId && S.carry) send({ t: IN.CARRY, id: S.heldId, token, x: S.carry.x, y: S.carry.y, ts: Date.now() });
}

// ---- websocket + reconnect --------------------------------------------------


// ---- ambient sound: one corner glyph, opt-in (PRD §8.4) ---------------------
const snd = document.getElementById('snd');
const sndhit = document.getElementById('sndhit');
let sndTimer = null;
let aDensity = 0, aWarmth = 0, aWater = 0;            // world -> sound, gathered each frame
const audioState = () => ({ seasonPhase: S.seasonPhase, density: aDensity, warmth: aWarmth, water: aWater });
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

// viewHalf() (half-extents of the viewport in world units) now lives in view.js.



// ---- render loop ------------------------------------------------------------
const bgSeed = PG.seedFrom('drift-ground');
function frame(now) {
  adaptQuality(qPrevNow ? now - qPrevNow : 16.7, now); qPrevNow = now; // measure + maybe shed/restore detail
  S.animT = now / 1000;
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
  paintGround(ctx, vw, vh, seasonGround(S.seasonPhase));
  if (Q.glows) paintGlows(ctx, vw, vh, bgSeed, -camera.x * camera.z * GLOW_PARALLAX, -camera.y * camera.z * GLOW_PARALLAX); // parallax drift
  if (Q.noise) paintNoise(ctx, vw, vh, bgSeed + 1);

  // objects (world space) — single matrix folds dpr + zoom + pan
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z,
    dpr * (vw / 2 - camera.x * camera.z), dpr * (vh / 2 - camera.y * camera.z));
  if (Q.patches) paintGroundPatches(ctx); // world-anchored terrain tint (precomputed buffer, one blit), beneath water + objects
  for (const pd of S.pools) paintWaterWorld(ctx, pd, S.animT); // every pond, beneath the objects
  if (Q.flow && poolOnScreen()) paintFlow(ctx, S.pool, S.animT); // faint flow streaks — only the central pool's drift band
  // ground marks (Wave S): flat rock-shaped stains, beneath objects, healing over ~10 min
  const markNow = Date.now() + S.clockSkew; // server clock for the heal age
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
    o._sortY = ((o.family === 'creature' || o.family === 'fish') && o.id !== S.heldId && !o.held)
      ? p.y + (o.kind === 'flier' ? flierLift(o) : 0)
      : groundY(o);
    o._depthScale = depthScaleAt(s.y); // size-by-depth (Wave K) — used by draw + hit-test
    if (o.family === 'stone') nextStones.push({ x: p.x, y: p.y, r: stoneSize(o) }); // a rock fences ground creatures
    list.push(o);
  }
  S.frameStones = nextStones; // creaturePos reads this next frame (a frame's lag is invisible)
  // The gardeners: a synthetic draw entry each so they sort + shadow + depth-scale with
  // everything else (not in `objects`, so never hit-tested or pickable). Each one's eye
  // follows the OTHER, wherever it is in the world.
  for (let gi = 0; gi < S.giants.length; gi++) {
    const G = S.giants[gi]; if (G._tx == null) continue;
    const gs = worldToScreen(G.x, G.y);
    if (!inViewport(gs.x, gs.y, vw, vh, CULL_MARGIN)) continue;
    const other = S.giants[(gi + 1) % S.giants.length];
    const ge = { family: 'giant', id: '__giant' + gi, x: G.x, y: G.y, hx: G.hx || 1, hy: G.hy || 0, gait: Math.min(1, (G._spd || 0) / GIANT_VIS_SPEED), tend: G._tend || 0 };
    if (other && other !== G) { ge.lookX = other.x; ge.lookY = other.y; } // its gaze tracks its companion
    ge._sortY = G.y; ge._depthScale = depthScaleAt(gs.y);
    list.push(ge);
  }
  // LOD-by-LOAD: if more objects are visible than the detail budget, LOD the smallest-on-
  // screen overflow (find the budget-th largest size → cut below it). Under budget → 0 → all
  // full detail, however small. So chunkiness is purely a function of on-screen count (cost).
  S.frameLodCut = 0;
  if (list.length > Q.detailBudget) {
    const sizes = [];
    for (const o of list) { if (formOf(o.family).alwaysFull) continue; sizes.push(objRadius(o) * (o._depthScale || 1) * camera.z); }
    if (sizes.length > Q.detailBudget) { sizes.sort((a, b) => b - a); S.frameLodCut = sizes[Q.detailBudget] || 0; }
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
  const active = []; // live presences this frame — reused for shared warmth + S.carry tethers
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
    if (!o.heldBy || o.heldBy === S.myPid) continue;
    const p = presences.get(o.heldBy);
    if (!p) continue;
    const ps = worldToScreen(p.x, p.y), os = worldToScreen(o.x, o.y);
    paintCarryTether(ctx, ps.x, ps.y, os.x, os.y, presenceIntensity(p, now));
  }
  aWarmth = warmth; // free (piggybacks the presence pass)
  if (Audio.isEnabled()) {
    aWater = poolOnScreen() ? 0.5 + 0.5 * Math.sin(S.animT * 0.4) : 0; // matches the visible sheen's shimmer
    Audio.setState(audioState());
  }
  if (Q.sky) paintSky(ctx, vw, vh, S.seasonPhase); // atmospheric horizon — hazes the up-screen world (depth), beneath held objects

  for (const o of objects.values()) {
    if (!isLifted(o.id)) continue;
    const s = (o.id === S.heldId && S.carry) ? worldToScreen(S.carry.x, S.carry.y) : worldToScreen(o.x, o.y);
    let alpha = 1;
    if (o.id === S.heldId && o.family === 'anomaly') { // fade out over the last seconds of the 10s hold
      alpha = 1 - clamp((now - S.heldSince - (ANOM_DISSOLVE_MS - ANOM_FADE_MS)) / ANOM_FADE_MS, 0, 1);
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
    for (const g of S.giants) {
      if (g._tx == null || !g.act) continue;
      const s = worldToScreen(g.x, g.y), word = g.act + (g.stuck >= 2 ? ' ·stuck' : ''), yo = GIANT_R * camera.z * 0.5 + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(word, s.x + 0.7, s.y + yo + 0.7);
      ctx.fillStyle = g.stuck >= 2 ? 'rgba(240,150,150,0.98)' : 'rgba(190,225,170,0.96)'; ctx.fillText(word, s.x, s.y + yo);
    }
  }

  // PERF HUD: tier + smoothed fps + on-screen count vs budget + the live LOD cut. Lets a
  // "why is everything chunky" moment be read at a glance — a dropped tier (low budget) vs a
  // genuinely over-budget viewport. Screen space, top-left, above everything.
  if (showPerf) {
    const q = qStats(), fps = q.ema > 0 ? Math.round(1000 / q.ema) : 0;
    const lines = [
      `tier ${q.tier}${q.pinned ? ' ·pinned' : ''}   ~${fps}fps (${q.ema.toFixed(1)}ms)`,
      `on-screen ${list.length} / budget ${q.budget}`,
      S.frameLodCut > 0 ? `LOD: chunk < ${S.frameLodCut.toFixed(1)}px on screen` : 'LOD: all full detail',
    ];
    ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let yy = 12;
    for (const ln of lines) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(ln, 12.7, yy + 0.7);
      ctx.fillStyle = S.frameLodCut > 0 && ln.startsWith('LOD') ? 'rgba(240,200,150,0.96)' : 'rgba(210,230,205,0.95)'; ctx.fillText(ln, 12, yy);
      yy += 15;
    }
  }

  if (Q.grade) paintSeasonGrade(ctx, vw, vh, S.seasonPhase); // season composite (crossfaded), last

  // season saturation as a GPU CSS filter on the canvas (set only on change). A struggling
  // machine drops it (Q.sat 0 → filter off): re-filtering the whole canvas every frame is
  // one of the costliest things on a weak GPU.
  const sat = Q.sat ? seasonSat(S.seasonPhase) : 1;
  if (Math.abs(sat - lastSat) > 0.001) { canvas.style.filter = sat < 0.999 ? `saturate(${sat.toFixed(3)})` : 'none'; lastSat = sat; }

  requestAnimationFrame(frame);
}

// ---- helpers ----------------------------------------------------------------
// NaN-safe: a NaN slips through Math.max/min unchanged, which once let a degenerate
// pinch (coincident touch points → 0/0) poison camera.z and, through it, every
// throw/S.carry position. Collapsing NaN to `lo` keeps the camera (and everything
// derived from it) finite no matter what upstream produced.
function clamp(v, lo, hi) { return v !== v ? lo : v < lo ? lo : v > hi ? hi : v; }

// ---- go ---------------------------------------------------------------------
setOnClearHold(clearHold); // wire input's hold-release into net's disconnect/reclaim handlers
connect();
requestAnimationFrame(frame);
