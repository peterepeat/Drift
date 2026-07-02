// public/net.js — the client's REALTIME layer (4.14b mirror): the WebSocket connect/
// reconnect/send, the onMessage dispatcher + its 9 OUT.* handlers, the connection dot, and
// the 500ms presence heartbeat. It OWNS the wire: it writes the shared model (objects/
// presences/lifts + S.*) from server deltas and reads it back out through send(). It imports
// the pure providers (state/view/draw/localfx/audio/protocol) one-directionally; the one
// call BACK into client.js — release-the-hold on disconnect/reclaim — is inverted into a
// registered callback (setOnClearHold), so net imports nothing from client.js (no cycle).
import { objects, presences, lifts, S, creatureEvts, worldEvts, ripples, flashes, feedRushes, flying, grits } from './state.js';
import { viewHalf, home, startArrive, saveHome, screenToWorld, vw, vh } from './view.js';
import { creaturePos, objRadius, FISH_SWIM_SPEED, FEED_RUSH_CAP_MS } from './draw.js';
import { setLift, LIFT_MS, SETTLE_MS, EASE_RISE, EASE_SETTLE } from './localfx.js';
import { Audio } from './audio.js';
import { IN, OUT } from './shared/protocol.js';

const PRESENCE_SEND_MS = 500;                // presence cadence (spec)
const POS_EASE_MAX = 24;                     // a position change up to this (a drift hop) eases; larger snaps

// Release-the-hold callback: input owns clearHold() (it clears the pointer/hold locals), and
// net's disconnect/reclaim handlers must call it. Inverted to a setter so net doesn't import
// client.js (which would be a cycle). client.js registers it once at bootstrap.
let _onClearHold = () => {};
export function setOnClearHold(fn) { _onClearHold = fn; }

// ---- websocket + reconnect --------------------------------------------------
let ws = null, wsReady = false, attempts = 0, reconnectT = null;
const dot = document.getElementById('dot');
const dothit = document.getElementById('dothit');
let dotTimer = null;
let arrivedOnce = false; // orient the camera on the FIRST world_state only (a reconnect must not yank it)

function flashDot() { dot.classList.add('show'); clearTimeout(dotTimer); dotTimer = setTimeout(() => dot.classList.remove('show'), 2000); }
function setDot(connected) {
  dot.classList.toggle('connected', connected);
  dot.classList.toggle('reconnecting', !connected);
  flashDot();
}
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
  if (S.heldId) { const o = objects.get(S.heldId); if (o) o.held = false; setLift(S.heldId, 0, SETTLE_MS, EASE_SETTLE); }
  for (const id of flying.keys()) { const o = objects.get(id); if (o) o.held = false; } // thrown objects are reclaimed too
  flying.clear();
  _onClearHold();
}
function onMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case OUT.WORLD_STATE: {
      S.myPid = m.pid;
      objects.clear(); lifts.clear();
      for (const o of m.objects) objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      if (m.season != null) S.seasonPhase = m.season;
      if (m.now != null) S.clockSkew = m.now - Date.now(); // lock the creature wander clock to the server's
      if (m.pool) S.pool = m.pool;
      if (Array.isArray(m.pools) && m.pools.length) S.pools = m.pools; else if (S.pool) S.pools = [S.pool]; // every pond (fallback: the central one)
      if (Array.isArray(m.giants)) S.giants = m.giants.map((g) => ({ ...g, _tx: g.x, _ty: g.y })); // the gardeners (snap to their spots on (re)connect)
      if (m.bounds && Number.isFinite(m.bounds.x) && Number.isFinite(m.bounds.y)) S.worldBounds = m.bounds; // before the arrive, so a stranded home is pulled back in
      // Orient on the FIRST arrival only (a reconnect must not yank the camera back):
      // a returning visitor drifts toward their remembered home, a new one toward the cog.
      // A home saved BEFORE camera bounds existed could be out in the void — if it's
      // beyond the world, fall back to the cog so a stranded visitor lands among objects.
      if (!arrivedOnce) {
        arrivedOnce = true;
        let t = home || m.cog;
        if (t && S.worldBounds && (Math.abs(t.x) > S.worldBounds.x || Math.abs(t.y) > S.worldBounds.y)) t = m.cog;
        if (t) startArrive(t.x, t.y);
      }
      break;
    }
    case OUT.OBJECT_STATE: {
      const o = objects.get(m.id);
      if (!o) break; // unknown (already dissolved) — ignore
      // A locally-flung object (in `flying`) is CLIENT-authoritative until it settles: updateFlying
      // computes its arc + streams CARRY. Applying the server's (lagging) echo of our own CARRY here
      // would snap its position back and/or clear o.held — and a cleared o.held makes updateFlying drop
      // it. That's why a thrown object "just dropped" despite the fling firing. Ignore it until it lands.
      if (flying.has(m.id)) break;
      const wasHeld = o.held;
      // A small move on a free object is water-drift — ease it (no pop), like growth.
      // Larger jumps (place, initial) snap. Held objects always snap.
      const dx = m.x - o.x, dy = m.y - o.y;
      // A free creature's home migrates each tick (goal-seeking, Wave G1) — ALWAYS ease
      // it (never snap), so it drifts smoothly. Others ease a small water-drift hop and
      // snap larger jumps (place, initial).
      const easeCreature = o.family === 'creature' && !m.held && m.id !== S.heldId;
      // A stone the server rolled out of water (m.roll), OR bounced off an already-capped
      // rock (m.bounce), ALWAYS eases to its resting spot — a smooth roll/slide, never a snap.
      const roll = m.roll && m.id !== S.heldId;
      const bounce = m.bounce && m.id !== S.heldId;
      if (roll || bounce || easeCreature || (!m.held && m.id !== S.heldId && dx * dx + dy * dy <= POS_EASE_MAX * POS_EASE_MAX)) {
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
      if (m.tameUntil != null) { const sNow = Date.now() + S.clockSkew; if (!(o.tameUntil > sNow)) o._tameStart = performance.now(); o.tameUntil = m.tameUntil; } // tamed (hovers near + follows its person); stamp when the bond began so it eases in
      if (m.r != null) o.r = m.r; // a fused stone grew (regens its geometry via stoneGeom)
      if (m.kinds) o.kinds = m.kinds; // a fused anomaly's hybrid kinds (blended form + breakability)
      o.heldBy = m.heldBy || ''; // who's carrying it (ephemeral pid) — drives the felt-presence tether
      if (m.id !== S.heldId) {
        if (o.held && !wasHeld) setLift(o.id, 1, LIFT_MS, EASE_RISE);
        else if (!o.held && wasHeld) setLift(o.id, 0, SETTLE_MS, EASE_SETTLE);
      }
      break;
    }
    case OUT.SEASON: { // the world's slow clock advanced
      if (m.phase != null) S.seasonPhase = m.phase;
      if (m.bounds && Number.isFinite(m.bounds.x) && Number.isFinite(m.bounds.y)) S.worldBounds = m.bounds; // keep the camera bound fresh as the world grows
      if (Array.isArray(m.giants)) { // the gardeners stepped — glide toward their new spots
        for (let i = 0; i < m.giants.length; i++) {
          const mg = m.giants[i];
          if (S.giants[i]) { const g = S.giants[i]; g._tx = mg.x; g._ty = mg.y; g.hx = mg.hx; g.hy = mg.hy; g.walk = mg.walk; g.tending = mg.tending; g.act = mg.act; g.stuck = mg.stuck; }
          else S.giants[i] = { ...mg, _tx: mg.x, _ty: mg.y };
        }
      }
      break;
    }
    case OUT.OBJECT_NEW: { // a shed seed (or other runtime-spawned object)
      const o = m.o;
      objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      // a creature born (mated into being) shimmers softly where it appears — life made legible
      if (o.family === 'creature') creatureEvts.push({ x: o.x, y: o.y, start: performance.now(), birth: true });
      break;
    }
    case OUT.WORLD_PATCH: { // interest streaming: objects paging into view as we pan
      for (const o of m.objects) {
        if (objects.has(o.id)) continue; // already known — leave its animation state alone
        objects.set(o.id, { ...o, held: !!o.held, _matShown: o.maturity || 0, _agedShown: o.aged || 0, _tx: o.x, _ty: o.y });
      }
      break;
    }
    case OUT.OBJECT_GONE: {
      const og = objects.get(m.id);
      if (m.splash) { // a bug dropped in a pond → fish food: a ripple + the pond's fish rush over to eat
        ripples.push({ x: m.x, y: m.y, start: performance.now() });
        const pond = S.pools.find((p) => Math.hypot(m.x - p.x, m.y - p.y) <= p.r + 30);
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
      if (S.heldId === m.id) _onClearHold();
      break;
    }
    case OUT.PICKUP_ACK: {
      if (!m.ok) { // lost the race — stop owning it (whether still in hand or already thrown)
        flying.delete(m.id);                  // a rejected throw stops gliding; the real holder's state wins
        const o = objects.get(m.id);
        // held=false so the server's corrective object_state (held:true, from the real
        // holder) re-lifts it; leaving it true would suppress that re-lift.
        if (o) { if (S.heldId === m.id && S.preGrab) { o.x = S.preGrab.x; o.y = S.preGrab.y; o._tx = S.preGrab.x; o._ty = S.preGrab.y; } o.held = false; }
        setLift(m.id, 0, SETTLE_MS, EASE_SETTLE);
        if (S.heldId === m.id) _onClearHold();
      }
      break;
    }
    case OUT.PRESENCE: {
      if (m.pid === S.myPid) break;
      const now = performance.now();
      const p = presences.get(m.pid);
      if (!p) presences.set(m.pid, { x: m.x, y: m.y, born: now, last: now, gone: 0 });
      else { p.x = m.x; p.y = m.y; p.last = now; } // never un-set `gone`: presence_gone must finish its fade
      break;
    }
    case OUT.PRESENCE_GONE: {
      const p = presences.get(m.pid); if (p) p.gone = performance.now();
      break;
    }
    case OUT.TEND: case OUT.GRAZE: case OUT.BLOOM: { // a wordless "something happened HERE" cue → a light bloom at (x,y)
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) worldEvts.push({ x: m.x, y: m.y, start: performance.now(), kind: m.t });
      break;
    }
  }
}

dothit.addEventListener('pointerenter', () => { dot.classList.add('show'); clearTimeout(dotTimer); });
dothit.addEventListener('pointerleave', () => { dotTimer = setTimeout(() => dot.classList.remove('show'), 2000); });

// presence: broadcast where we are inhabiting (camera centre), every 500ms.
setInterval(() => {
  if (!wsReady) return;
  const c = screenToWorld(vw / 2, vh / 2);
  const h = viewHalf();
  send({ t: IN.PRESENCE_MOVE, x: c.x, y: c.y, hw: h.hw, hh: h.hh, ts: Date.now() });
  saveHome(performance.now()); // remember where we've been inhabiting (return thread, §6.3)
}, PRESENCE_SEND_MS);

export { send, connect };
