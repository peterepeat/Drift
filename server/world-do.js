// =============================================================================
// DRIFT — WorldRoom: the single authoritative world (one global Durable Object).
//
// Holds every object in memory (backed by DO storage so it survives restart),
// fans out pickup/place/carry/presence over WebSockets, reclaims holds on
// disconnect, and runs a self-rescheduling 60s tick that grows the world even
// with zero connected clients — the world breathes, indifferent.
//
// GROWTH (Phase 2): seed-family objects carry a continuous lifecycle —
// maturity 0->1 (seed -> sprout -> plant -> mature) then aged 0->1 (mature ->
// aged -> dissolve). Growth is slow by default and ACCELERATED BY WARMTH: the
// presence of people nearby heats objects, and heat speeds growth. Mature
// plants shed seeds nearby; fully-aged plants release final seeds and dissolve.
// The visual FORM is always regenerated from seed+maturity+aged (drawPlant) —
// no visual data is stored. Stones do not grow; they only erode by handling.
//
// No identity ever leaves the server: a client's session token is used only
// for hold ownership; broadcasts carry an ephemeral per-connection `pid` and a
// boolean `held` — never the token.
// =============================================================================
import { generateWorld, makeSeedRecord } from './seed.js';

const TICK_MS = 60000;
const HOLD_TIMEOUT_MS = 45000;            // reclaim a hold if its connection vanished
const COG_ALPHA = 0.2;                    // centre-of-gravity EMA weight

// ---- growth tuning (per 60s tick) ------------------------------------------
const SPROUT = 0.14;                      // maturity below this is still a seed
const GROW_BASE = 0.0016;                 // maturity/tick unattended (~10h seed->full)
const GROW_WARM = 0.055;                  // extra maturity/tick at heat=1 (~18min warm)
const AGE_RATE = 0.0045;                  // aged/tick once mature (~hours of maturity)
const HEAT_DECAY = 0.80;                  // heat retained per tick when no warmth
const HEAT_GAIN = 0.36;                   // heat added per nearby presence per tick
const HEAT_RADIUS = 240;                  // world units a presence warms
const PRESENCE_STALE_MS = 12000;          // presence older than this stops warming
const SHED_TICKS = 6;                     // a mature plant sheds ~every 6 ticks
const SHED_MAX_AGED = 0.6;                // stop shedding once this aged
const FINAL_SHED = 2;                     // seeds released when a plant dissolves
const MAX_OBJECTS = 800;                  // population cap (stop shedding above it)
const MAT_BCAST_DELTA = 0.025;            // broadcast growth when maturity moves this much

export class WorldRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.objects = new Map();      // id -> record
    this.cog = { x: 0, y: 0, n: 0 };
    this.lastSeen = new Map();     // pid -> ts (presence liveness)
    this.presencePos = new Map();  // pid -> { x, y, ts } (drives warmth)
    this.bcastMark = new Map();    // id -> { maturity, aged } last broadcast (chatter control)
    this.state.blockConcurrencyWhile(async () => { await this.#load(); });
  }

  async #load() {
    const list = await this.state.storage.list({ prefix: 'obj:' });
    for (const [, rec] of list) { this.#migrate(rec); this.objects.set(rec.id, rec); }
    this.cog = (await this.state.storage.get('cog')) || { x: 0, y: 0, n: 0 };
    if (this.objects.size === 0) await this.#seed(false);
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // Backfill lifecycle fields on records written by an earlier version.
  #migrate(o) {
    if (typeof o.maturity !== 'number') o.maturity = 0;
    if (typeof o.aged !== 'number') o.aged = 0;
    if (typeof o.heat !== 'number') o.heat = 0;
    if (typeof o.shedAccum !== 'number') o.shedAccum = 0;
  }

  async #seed(force) {
    if (force) {
      const old = await this.state.storage.list({ prefix: 'obj:' });
      if (old.size) await this.state.storage.delete([...old.keys()]);
      this.objects.clear();
    }
    const recs = generateWorld();
    const puts = {};
    for (const r of recs) { this.objects.set(r.id, r); puts['obj:' + r.id] = r; }
    await this.#putAll(puts);
    this.cog = { x: 0, y: 0, n: 0 };
    await this.state.storage.put('cog', this.cog);
    await this.state.storage.put('meta:seeded', { at: Date.now(), n: recs.length });
    return recs.length;
  }

  // storage.put accepts at most 128 entries per call.
  async #putAll(map) {
    const entries = Object.entries(map);
    for (let i = 0; i < entries.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
  }

  // ---- HTTP (routed here by the Worker) -------------------------------------
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const pid = crypto.randomUUID();          // ephemeral; not tied to the token
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ pid });
      this.#send(server, this.#worldState(pid));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/admin/seed') {
      const force = url.searchParams.get('force') === '1';
      if (force && !this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const before = this.objects.size;
      let n = before;
      if (force) n = await this.#seed(true);
      else if (before === 0) n = await this.#seed(false);
      if (force) for (const ws of this.state.getWebSockets()) this.#send(ws, this.#worldState(ws.deserializeAttachment()?.pid));
      return Response.json({ ok: true, seeded: n, was: before, forced: force });
    }

    // Ops/testing only: advance the world by N ticks immediately. Gated by ADMIN_KEY.
    if (url.pathname === '/admin/tick') {
      if (!this.#adminOk(request)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      const n = Math.max(1, Math.min(500, parseInt(url.searchParams.get('n') || '1', 10)));
      const before = this.objects.size;
      let spawned = 0, gone = 0;
      for (let i = 0; i < n; i++) { const r = await this.#tick(Date.now()); spawned += r.spawned; gone += r.gone; }
      return Response.json({ ok: true, ticks: n, before, after: this.objects.size, spawned, gone });
    }

    return new Response('not found', { status: 404 });
  }

  #adminOk(request) {
    return this.env.ADMIN_KEY && request.headers.get('x-admin-key') === this.env.ADMIN_KEY;
  }

  // Public projection of an object (FORM derived from seed; no visual data).
  #pub(o) {
    return {
      id: o.id, family: o.family, x: o.x, y: o.y, seed: o.seed,
      handling: o.handling, held: o.held !== '',
      maturity: o.maturity, aged: o.aged, created_at: o.created_at,
    };
  }
  #stateMsg(o, now) {
    return {
      t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling,
      held: o.held !== '', maturity: o.maturity, aged: o.aged, ts: now,
    };
  }
  #worldState(pid) {
    const objects = [];
    for (const o of this.objects.values()) objects.push(this.#pub(o));
    return { t: 'world_state', now: Date.now(), pid, cog: { x: this.cog.x, y: this.cog.y }, objects };
  }

  #send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  #bcast(obj, exceptWs) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(s); } catch {}
    }
  }
  async #persist(o) { await this.state.storage.put('obj:' + o.id, o); }

  // ---- WebSocket message handling -------------------------------------------
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const pid = ws.deserializeAttachment()?.pid;
    const now = Date.now();

    if (m.t === 'pickup') {
      const o = this.objects.get(m.id);
      if (!o) return;
      if (o.held === '') {
        // Single-threaded DO -> this read-then-write IS the atomic compare-and-set.
        o.held = m.token; o.heldConn = pid; o.held_at = now;
        await this.#persist(o);
        this.#send(ws, { t: 'pickup_ack', id: o.id, ok: true });
        this.#bcast(this.#stateMsg(o, now), ws);
        this.#updateCog(o.x, o.y);
      } else {
        this.#send(ws, { t: 'pickup_ack', id: o.id, ok: false });
        this.#send(ws, this.#stateMsg(o, now));
      }

    } else if (m.t === 'carry') {
      const o = this.objects.get(m.id);
      if (!o || o.held !== m.token) return;
      o.x = m.x; o.y = m.y;                    // in-memory only; persisted on place / reclaim
      this.#bcast(this.#stateMsg(o, now), ws);

    } else if (m.t === 'place') {
      const o = this.objects.get(m.id);
      if (!o) return;
      if (o.held !== m.token) { this.#send(ws, this.#stateMsg(o, now)); return; } // not the holder
      o.x = m.x; o.y = m.y; o.held = ''; o.heldConn = ''; o.held_at = 0;
      o.handling += 1;
      // Disturbing a pre-sprout seed resets its growth — it must be left be to take.
      if (o.family === 'seed' && o.maturity < SPROUT) { o.maturity = 0; o.heat = 0; }
      await this.#persist(o);
      this.#bcast(this.#stateMsg(o, now), null);
      this.#updateCog(o.x, o.y);

    } else if (m.t === 'presence_move') {
      this.lastSeen.set(pid, now);
      this.presencePos.set(pid, { x: m.x, y: m.y, ts: now });
      this.#bcast({ t: 'presence', pid, x: m.x, y: m.y, ts: now }, ws);
    }
  }

  async webSocketClose(ws) { await this.#dropConn(ws); }
  async webSocketError(ws) { await this.#dropConn(ws); }

  async #dropConn(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    this.lastSeen.delete(pid);
    this.presencePos.delete(pid);
    const now = Date.now();
    for (const o of this.objects.values()) {
      if (o.heldConn === pid) {
        o.held = ''; o.heldConn = ''; o.held_at = 0;
        await this.#persist(o);
        this.#bcast(this.#stateMsg(o, now), null);
      }
    }
    this.#bcast({ t: 'presence_gone', pid }, null);
  }

  #updateCog(x, y) {
    this.cog.x = this.cog.x * (1 - COG_ALPHA) + x * COG_ALPHA;
    this.cog.y = this.cog.y * (1 - COG_ALPHA) + y * COG_ALPHA;
    this.cog.n += 1;
    this.state.storage.put('cog', this.cog); // fire-and-forget
  }

  #warmth(o, now) {
    let warm = 0;
    for (const p of this.presencePos.values()) {
      if (now - p.ts > PRESENCE_STALE_MS) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < HEAT_RADIUS) warm += HEAT_GAIN * (1 - d / HEAT_RADIUS);
    }
    return warm;
  }

  // ---- the breath: one growth/decay tick ------------------------------------
  async #tick(now) {
    const changed = [], spawned = [], gone = [];
    for (const o of this.objects.values()) {
      if (o.held !== '' && now - o.held_at > HOLD_TIMEOUT_MS) { // missed-close safety net
        o.held = ''; o.heldConn = ''; o.held_at = 0; changed.push(o);
      }
      if (o.held !== '') continue;          // growth paused while held
      if (o.family !== 'seed') continue;    // stones don't grow (they erode by handling)

      o.heat = Math.min(1, o.heat * HEAT_DECAY + this.#warmth(o, now));
      const beforeMat = o.maturity, beforeAged = o.aged;

      if (o.maturity < 1) {
        o.maturity = Math.min(1, o.maturity + GROW_BASE + GROW_WARM * o.heat);
      } else {
        o.aged = Math.min(1, o.aged + AGE_RATE);
        if (o.aged < SHED_MAX_AGED) {
          o.shedAccum += 1;
          if (o.shedAccum >= SHED_TICKS && this.objects.size + spawned.length < MAX_OBJECTS) {
            o.shedAccum = 0;
            spawned.push(this.#shed(o, now));
          }
        }
        if (o.aged >= 1) {                  // dissolve: release final seeds, then gone
          for (let k = 0; k < FINAL_SHED && this.objects.size + spawned.length < MAX_OBJECTS; k++) {
            spawned.push(this.#shed(o, now));
          }
          gone.push(o);
        }
      }

      // broadcast only on a meaningful lifecycle move (keeps a quiet world quiet)
      const mark = this.bcastMark.get(o.id) || { maturity: beforeMat, aged: beforeAged };
      const crossedSprout = (beforeMat < SPROUT) !== (o.maturity < SPROUT);
      if (Math.abs(o.maturity - mark.maturity) >= MAT_BCAST_DELTA ||
          Math.abs(o.aged - mark.aged) >= MAT_BCAST_DELTA ||
          crossedSprout) {
        this.bcastMark.set(o.id, { maturity: o.maturity, aged: o.aged });
        // !changed.includes guards against a double-push when a hold also timed out this tick
        if (!gone.includes(o) && !changed.includes(o)) changed.push(o);
      }
    }

    // Prune stale presence so the warmth map can't grow unbounded from
    // connections that never closed cleanly.
    for (const [pid, p] of this.presencePos) {
      if (now - p.ts > PRESENCE_STALE_MS + 5000) this.presencePos.delete(pid);
    }

    for (const o of changed) { await this.#persist(o); this.#bcast(this.#stateMsg(o, now), null); }
    for (const o of spawned) { this.objects.set(o.id, o); await this.#persist(o); this.#bcast({ t: 'object_new', o: this.#pub(o) }, null); }
    for (const o of gone) {
      this.objects.delete(o.id); this.bcastMark.delete(o.id);
      await this.state.storage.delete('obj:' + o.id);
      this.#bcast({ t: 'object_gone', id: o.id }, null);
    }
    // Snapshot survivors so growth survives a restart.
    const puts = {};
    for (const o of this.objects.values()) puts['obj:' + o.id] = o;
    if (Object.keys(puts).length) await this.#putAll(puts);

    return { spawned: spawned.length, gone: gone.length };
  }

  #shed(parent, now) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 22 + Math.random() * 70;
    const x = parent.x + Math.cos(ang) * dist;
    const y = parent.y + Math.sin(ang) * dist;
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeSeedRecord(crypto.randomUUID(), seed, x, y, now);
  }

  async alarm() {
    await this.#tick(Date.now());
    await this.state.storage.setAlarm(Date.now() + TICK_MS);
  }
}
