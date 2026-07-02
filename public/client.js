// =============================================================================
// DRIFT — client: world render loop, camera, pointer input, realtime sync.
// No framework. Canvas 2D. Object forms are ALWAYS regenerated from `seed`;
// no visual data is ever stored or transmitted.
// =============================================================================
import * as PG from './drift-procgen.js';
import { paintBackdrop, paintGlowsBuffered, paintNoise, paintGroundPatches, paintPresence, paintCarryTether, paintSky, paintSeasonGrade, seasonGround, seasonSat, paintWaterWorld, paintFlow } from './render.js';
import { inViewport, CULL_MARGIN } from './cull.js';
import { Audio } from './audio.js';
import { flingStep, ema, nudge, spring, deflectCircles } from './physics.js';
import { wanderAt, drawCreature, creatureR, drawFish, fishR } from './creatures.js';
import { drawGiant } from './giant.js';
import { SPROUT_C, BIG_TREE_MAT, GIANT_R, shownMat, shownAged, stoneSize, stoneGeom, anomalyR, crystalR, formOf } from './forms.js';
import { objRadius, isMovable, creaturePos, posOf, drawMark, drawObjectWorld, drawHeldScreen, paintAttend, drawStats, SPRITE_Z_MAX, FISH_SWIM_SPEED, FEED_RELEASE, FEED_RUSH_CAP_MS } from './draw.js'; // ctx-coupled object paint dispatch + position/geometry readers (4.14d)
import { spriteStats } from './spritecache.js'; // Stage B plant-canopy sprite cache — stats for the perf HUD
import { IN, OUT } from './shared/protocol.js';
import { attendId, clearHold, updateBefriend, updateDissolve, updateFlying, settleFlying } from './input.js'; // pointer/gesture/hold/throw/attend/befriend (4.14f)
import { send, connect, setOnClearHold } from './net.js'; // WS connect/reconnect/send + the 9 message handlers + presence (4.14b)
import { setLift, liftValue, isLifted, updateLifts, updateGrowth, updatePositions, updateNudge, updateCollision, updateSway, updateLeaves, drawLeaves, drawCreatureEvts, GIANT_VIS_SPEED, LIFT_MS, SETTLE_MS, EASE_RISE, EASE_SETTLE } from './localfx.js'; // lift anim + per-frame cosmetic-fx passes (4.14e) // the wire single-source (2.6) — client now sends IN.* / switches on OUT.* (string-identical to the old raw types)
import { canvas, ctx, camera, objects, presences, lifts, flashes, ripples, feedRushes, grits, creatureEvts, giantFootprints, flying, swaying, mouseVelW, S } from './state.js'; // shared client state (4.14 mirror)
import { screenToWorld, worldToScreen, viewHalf, poolOnScreen, camLimits, zMin, clampCam, applyPan, startArrive, updateArrive, cancelArrive, saveHome, adaptQuality, setQTier, qStats, resize, queueResize, dpr, vw, vh, Q, home, Z0, ZMIN, ZMAX } from './view.js'; // camera/transforms/sizing/quality (4.14 mirror)

// ---- tuning constants -------------------------------------------------------
// Z0/ZMIN/ZMAX (zoom range) now live in view.js (imported above).
// Camera bounds (Wave J): the camera centre is held within the object field (sent by
// the server as world half-extents) so you can never wander far into empty space —
// panning SLOWS as you approach the edge and STOPS at it. Zoom-aware: when zoomed out
// (the viewport already covers the world) the pannable range collapses toward centre.
// EDGE_MARGIN / EDGE_SOFT (camera edge-resistance) now live in view.js.
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
const GRIT_MS = 500;                          // a worn-out stone's grit scatter lifetime (spec §4.3)
const MARK_LIFE_MS = 10 * 60 * 1000;          // a ground mark heals over ~10 min (mirror server MARK_LIFE_MS)
// The nudge / collision / leaf-litter / sway-spring tuning consts now live in localfx.js (4.14e).
// Rooted trees (Wave C): the biggest plants are immovable landmarks. They show ROOTS
// gripping the earth (so it reads WHY they won't come) and SWAY in the drag direction,
// then spring back, when you try to drag across them — a render-only canopy lean.



// ---- adaptive quality (graceful degradation — no config) -------------------
// An old/weak machine silently sheds the costliest work to stay smooth: we measure
// smoothed frame time and step DOWN through quality tiers when it can't keep up (and
// back UP, slowly, when it has headroom). The whole BACKDROP (ground/noise/patches/glows/
// sky/grade) is now always-on cheap cached buffers (A2/A3) — never a lever, so it never
// pops with the tier. The remaining levers are render resolution (dpr — the first + softest),
// per-object shadows, the LOD budget, the pool-flow pass, the season saturation filter, and
// drifting litter. Hysteresis + a cooldown keep it from flapping. Tier 0 = full, higher = leaner.
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
// PERF TRACE (deep diagnosis): ?perftrace=1 accumulates per-pass wall-time and console.logs the
// averaged breakdown every 30 frames — to find WHICH pass dominates a slow frame (e.g. a dense
// zoomed-out view). Near-zero overhead when off.
const showTrace = new URLSearchParams(location.search).has('perftrace');
const _tr = { updates: 0, backdrop: 0, cull: 0, sort: 0, drawObj: 0, overlay: 0, tail: 0, total: 0, n: 0, sprite: 0, plantMiss: 0, blob: 0, paint: 0 };
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



// ---- object paint dispatch + geometry/position readers — now in draw.js (4.14d) ----
// (paintObject cascade + drawObjectWorld/drawLOD/drawMark/paintAttend/drawHeldScreen +
//  creaturePos/posOf/objRadius + glow/tame/warp; the form footprints live in forms.js.)
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
let attendT = 0; // attendId now lives in input.js (input writes, this frame gate reads it)



// The pointer/gesture/hold/throw/attend/befriend interaction layer + the session token
// now live in input.js (4.14f). client.js is the orchestrator: frame() + bootstrap + wiring.


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
  let _tm = showTrace ? performance.now() : 0; const _t0 = _tm;
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
  if (showTrace) { const t = performance.now(); _tr.updates += t - _tm; _tm = t; }

  // background (screen space) — world-locked objects pan over a near-fixed backdrop,
  // which reads as subtle parallax depth. Ground + glows are pre-baked buffers (A3): a
  // straight blit each frame instead of re-evaluating full-screen radial gradients.
  paintBackdrop(ctx, vw, vh, dpr, seasonGround(S.seasonPhase)); // baked ground, blitted 1:1 (device px, opaque → no clear needed)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintGlowsBuffered(ctx, vw, vh, dpr, bgSeed, -camera.x * camera.z * GLOW_PARALLAX, -camera.y * camera.z * GLOW_PARALLAX); // ambient glows — always on (a clamped blit of the baked glow field); parallax drift
  paintNoise(ctx, vw, vh, bgSeed + 1); // the ground GRAIN — always on (a cached blit): the backdrop's texture must never pop in/out with the quality tier
  if (showTrace) { const t = performance.now(); _tr.backdrop += t - _tm; _tm = t; }

  // objects (world space) — single matrix folds dpr + zoom + pan
  ctx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z,
    dpr * (vw / 2 - camera.x * camera.z), dpr * (vh / 2 - camera.y * camera.z));
  paintGroundPatches(ctx); // world-anchored terrain COLOUR (cached, one blit) — always on: the backdrop stays consistent regardless of tier (only the OBJECTS chunk under load)
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
  if (showTrace) { const t = performance.now(); _tr.cull += t - _tm; _tm = t; }
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
  if (showTrace) { const t = performance.now(); _tr.sort += t - _tm; _tm = t; }
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
  if (showTrace) { const t = performance.now(); _tr.drawObj += t - _tm; _tm = t; }

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
  paintSky(ctx, vw, vh, S.seasonPhase); // atmospheric horizon — always on (memoized): hazes the up-screen world (depth), beneath held objects

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
  if (showTrace) { const t = performance.now(); _tr.overlay += t - _tm; _tm = t; }

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
    const q = qStats(), fps = q.ema > 0 ? Math.round(1000 / q.ema) : 0, ss = spriteStats();
    const lines = [
      `tier ${q.tier}${q.pinned ? ' ·pinned' : ''}   ~${fps}fps (${q.ema.toFixed(1)}ms)`,
      `on-screen ${list.length} / budget ${q.budget}`,
      S.frameLodCut > 0 ? `LOD: chunk < ${S.frameLodCut.toFixed(1)}px on screen` : 'LOD: all full detail',
      `sprites ${ss.count} (${ss.mb} / ${ss.cap}MB)${camera.z > SPRITE_Z_MAX ? ' ·live (zoomed in)' : ''}`,
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

  paintSeasonGrade(ctx, vw, vh, S.seasonPhase); // season composite (crossfaded), always on (memoized), last

  // season saturation as a GPU CSS filter on the canvas (set only on change). A struggling
  // machine drops it (Q.sat 0 → filter off): re-filtering the whole canvas every frame is
  // one of the costliest things on a weak GPU.
  const sat = Q.sat ? seasonSat(S.seasonPhase) : 1;
  if (Math.abs(sat - lastSat) > 0.001) { canvas.style.filter = sat < 0.999 ? `saturate(${sat.toFixed(3)})` : 'none'; lastSat = sat; }

  if (showTrace) {
    const t = performance.now(); _tr.tail += t - _tm; _tr.total += t - _t0; _tr.n++;
    const s = drawStats(); _tr.sprite += s.sprite; _tr.plantMiss += s.plantMiss; _tr.blob += s.blob; _tr.paint += s.paint;
    if (_tr.n >= 30) {
      const p = (k) => (_tr[k] / _tr.n).toFixed(1);
      console.log(`[perftrace] on-screen ${list.length} | total ${p('total')}ms = updates ${p('updates')} + backdrop ${p('backdrop')} + cull ${p('cull')} + sort ${p('sort')} + drawObj ${p('drawObj')} + overlay ${p('overlay')} + tail ${p('tail')}  ||  per-frame draws: sprite ${p('sprite')} + plantMISS ${p('plantMiss')} + blob ${p('blob')} + paint ${p('paint')}`);
      for (const k in _tr) _tr[k] = 0;
    }
  }

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
