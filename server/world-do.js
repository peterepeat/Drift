// =============================================================================
// DRIFT — WorldRoom: the single authoritative world (one global Durable Object).
//
// Holds every object in memory (backed by DO storage so it survives restart),
// fans out pickup/place/carry/presence over WebSockets, reclaims holds on
// disconnect, and runs a self-rescheduling 60s tick that advances decay even
// with zero connected clients — the world continues, indifferent.
//
// No identity ever leaves the server: a client's session token is used only
// for hold ownership; broadcasts carry an ephemeral per-connection `pid` and a
// boolean `held` — never the token.
// =============================================================================
import { generateWorld } from './seed.js';

const TICK_MS = 60000;
const HOLD_TIMEOUT_MS = 45000;            // reclaim a hold if its connection vanished
const COG_ALPHA = 0.2;                    // centre-of-gravity EMA weight
// Seconds to fully decay (generous — impermanence is felt between visits, not
// during a session). Tunable; stage is a pure function of the accumulator.
const TAU = { stone: 60 * 60 * 24 * 30, seed: 60 * 60 * 24 * 3 };

export class WorldRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.objects = new Map();   // id -> record
    this.cog = { x: 0, y: 0, n: 0 };
    this.lastSeen = new Map();  // pid -> ts (presence liveness)
    this.state.blockConcurrencyWhile(async () => { await this.#load(); });
  }

  async #load() {
    const list = await this.state.storage.list({ prefix: 'obj:' });
    for (const [, rec] of list) this.objects.set(rec.id, rec);
    this.cog = (await this.state.storage.get('cog')) || { x: 0, y: 0, n: 0 };
    if (this.objects.size === 0) await this.#seed(false);
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
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

  // ---- HTTP (routed here by the Worker for /ws and /admin/seed) -------------
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
      if (force) {
        const key = request.headers.get('x-admin-key');
        if (!this.env.ADMIN_KEY || key !== this.env.ADMIN_KEY) {
          return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
        }
      }
      const before = this.objects.size;
      let n = before;
      if (force) n = await this.#seed(true);
      else if (before === 0) n = await this.#seed(false);
      if (force) {
        for (const ws of this.state.getWebSockets()) {
          this.#send(ws, this.#worldState(ws.deserializeAttachment()?.pid));
        }
      }
      return Response.json({ ok: true, seeded: n, was: before, forced: force });
    }

    return new Response('not found', { status: 404 });
  }

  #worldState(pid) {
    const objects = [];
    for (const o of this.objects.values()) {
      objects.push({
        id: o.id, family: o.family, x: o.x, y: o.y, seed: o.seed,
        handling: o.handling, held: o.held !== '', created_at: o.created_at,
      });
    }
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
        this.#bcast({ t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: true, ts: now }, ws);
        this.#updateCog(o.x, o.y);
      } else {
        this.#send(ws, { t: 'pickup_ack', id: o.id, ok: false });
        this.#send(ws, { t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: true, ts: now });
      }

    } else if (m.t === 'carry') {
      const o = this.objects.get(m.id);
      if (!o || o.held !== m.token) return;
      o.x = m.x; o.y = m.y;                    // in-memory only; persisted on place / reclaim
      this.#bcast({ t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: true, ts: now }, ws);

    } else if (m.t === 'place') {
      const o = this.objects.get(m.id);
      if (!o) return;
      if (o.held !== m.token) { // not the holder — correct their view
        this.#send(ws, { t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: o.held !== '', ts: now });
        return;
      }
      o.x = m.x; o.y = m.y; o.held = ''; o.heldConn = ''; o.held_at = 0;
      o.handling += 1; o.last_eval = now;      // resume decay clock from now
      await this.#persist(o);
      this.#bcast({ t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: false, ts: now }, null);
      this.#updateCog(o.x, o.y);

    } else if (m.t === 'presence_move') {
      this.lastSeen.set(pid, now);
      this.#bcast({ t: 'presence', pid, x: m.x, y: m.y, ts: now }, ws);
    }
  }

  async webSocketClose(ws) { await this.#dropConn(ws); }
  async webSocketError(ws) { await this.#dropConn(ws); }

  // Holder vanished -> drop their objects at last known position (MVP criterion).
  async #dropConn(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    this.lastSeen.delete(pid);
    const now = Date.now();
    for (const o of this.objects.values()) {
      if (o.heldConn === pid) {
        o.held = ''; o.heldConn = ''; o.held_at = 0; o.last_eval = now;
        await this.#persist(o);
        this.#bcast({ t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: false, ts: now }, null);
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

  // ---- 60s tick: decay + stale-hold reclaim, runs with zero clients ---------
  async alarm() {
    const now = Date.now();
    const changed = [], gone = [];
    for (const o of this.objects.values()) {
      if (o.held !== '' && now - o.held_at > HOLD_TIMEOUT_MS) { // missed-close safety net
        o.held = ''; o.heldConn = ''; o.held_at = 0; o.last_eval = now; changed.push(o);
      }
      if (o.held !== '') continue;                  // decay paused while held
      const tau = TAU[o.family] || TAU.seed;
      const dt = Math.max(0, (now - o.last_eval) / 1000);
      if (dt > 0) { o.decay = Math.min(1, o.decay + dt / tau); o.last_eval = now; }
      if (o.decay >= 1) gone.push(o);
    }
    for (const o of changed) {
      await this.#persist(o); // durable before broadcast (mirrors pickup/place/dropConn)
      this.#bcast({ t: 'object_state', id: o.id, x: o.x, y: o.y, handling: o.handling, held: false, ts: now }, null);
    }
    for (const o of gone) {
      this.objects.delete(o.id);
      await this.state.storage.delete('obj:' + o.id);
      this.#bcast({ t: 'object_gone', id: o.id }, null);
    }
    // Snapshot survivors so decay survives a restart.
    const puts = {};
    for (const o of this.objects.values()) puts['obj:' + o.id] = o;
    if (Object.keys(puts).length) await this.#putAll(puts);
    await this.state.storage.setAlarm(now + TICK_MS);
  }
}
