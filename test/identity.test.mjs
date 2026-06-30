// Wire-identity contract (invariant #3). The server must NEVER leak a raw record
// field onto the wire: #pub (world_state / world_patch) and #stateMsg (object_state)
// expose seed + lifecycle SCALARS + a boolean `held` + the EPHEMERAL `heldBy` pid —
// never the session token, the raw `heldConn`, or internal bookkeeping (heat /
// last_touched / held_at / shedAccum / decay). This suite spawns one of EVERY family
// (admin) so the projection is checked across all of them, and over the three wire
// shapes that carry objects: world_state, object_new, and object_state.
import { FORBIDDEN_WIRE_FIELDS, WIRE_OBJECT_FIELDS, isWireField } from '../public/shared/protocol.js';
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = 'local-dev-key';
const admin = (path) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-admin-key': KEY } }).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };

// Raw record fields that must never appear in any object projection on the wire —
// sourced from the shared protocol contract (not re-typed here), so this guard and
// the server's scrubForbidden() can never disagree on what "leak" means.
const FORBIDDEN = FORBIDDEN_WIRE_FIELDS;
const leak = (objs) => {
  for (const o of objs || []) for (const k of FORBIDDEN) if (o && k in o) return `${(o.family || o.act || '?')}.${k}`;
  return null;
};
// A projection may carry ONLY whitelisted keys (no identity AND no schema drift).
const offWhitelist = (objs) => {
  for (const o of objs || []) for (const k in o) if (!isWireField(k)) return `${(o.family || o.act || '?')}.${k}`;
  return null;
};

// Seed the world with one of every non-seeded family so the scan covers them all.
await admin('/admin/creature?x=320&y=40');
await admin('/admin/anomaly?x=-320&y=-40');
await admin('/admin/crystal');
await admin('/admin/fish');

function open() {
  const ws = new WebSocket(WS); ws.msgs = []; ws.pid = null;
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.t === 'world_state') ws.pid = m.pid; ws.msgs.push(m); });
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
const lastOf = (ws, t, id) => [...ws.msgs].reverse().find((m) => m.t === t && (id ? m.id === id : true));

const A = await open();
const B = await open();
await wait(300);
A.send(JSON.stringify({ t: 'mark', x: 820, y: 820, ts: Date.now() })); // a mark family via the wire
await admin('/admin/creature?x=1200&y=1200'); // a RICH family spawned AFTER both clients connect → arrives as a genuine object_new (exercises the creature projection's kind/act branches through the object_new path, not just the bare mark)
await wait(200);

const ws0 = lastOf(A, 'world_state');
const families = new Set(ws0.objects.map((o) => o.family));
check(ws0.objects.length > 0, `world_state carries objects (${ws0.objects.length})`);
check(['stone', 'seed', 'creature', 'anomaly', 'crystal', 'fish'].every((f) => families.has(f)),
  `world_state covers every family (${[...families].sort().join(',')})`);
check(leak(ws0.objects) === null, `world_state #pub leaks NO raw record field (${leak(ws0.objects) || 'clean'})`);
check(offWhitelist(ws0.objects) === null, `every world_state object carries ONLY whitelisted keys (${offWhitelist(ws0.objects) || 'clean'})`);
check(ws0.objects.every((o) => typeof o.held === 'boolean'), 'every object exposes a boolean held (never the raw token string)');
check(ws0.objects.every((o) => o.heldBy === undefined || o.held === true), 'heldBy only present while held');
check(leak(ws0.giants) === null && (ws0.giants || []).length > 0, `the giants projection leaks no raw field (${leak(ws0.giants) || 'clean'})`);

// object_new: the mark sown via the wire + the creature spawned AFTER connect — a genuine
// object_new carrying the RICH creature projection (kind + the live `act` focus), not just
// the simplest mark. (A pre-connect admin spawn reaches a late joiner via the world_state
// snapshot, NEVER object_new — so a rich object_new must be triggered post-connect.)
const news = A.msgs.filter((m) => m.t === 'object_new').map((m) => m.o);
check(news.length > 0 && leak(news) === null, `object_new #pub leaks no raw field (${news.length} seen; ${leak(news) || 'clean'})`);
check(offWhitelist(news) === null, `every object_new projection carries ONLY whitelisted keys (${offWhitelist(news) || 'clean'})`);
check(news.some((o) => o.family === 'mark'), 'the sown mark reached the world (via object_new)');
check(news.some((o) => o.family === 'creature' && o.kind && o.act), 'a creature spawned after connect arrives as a genuine object_new with its rich projection (kind + live act)');

// object_state: a pickup broadcast to the OTHER client carries no identity
const target = ws0.objects.find((o) => o.family === 'creature') || ws0.objects[0];
A.send(JSON.stringify({ t: 'pickup', id: target.id, token: 'idy-secret-token', ts: Date.now() }));
await wait(180);
const st = lastOf(B, 'object_state', target.id);
check(st && leak([st]) === null, `object_state #stateMsg leaks no raw record field (${st ? leak([st]) || 'clean' : 'no broadcast'})`);
check(st && offWhitelist([st]) === null, `the object_state delta carries ONLY whitelisted keys (${st ? offWhitelist([st]) || 'clean' : 'no broadcast'})`);
check(st && st.held === true && st.token === undefined && st.heldConn === undefined, 'a pickup broadcast carries boolean held + NO token/heldConn');
check(st && st.heldBy === A.pid, "the carried object is tagged with the carrier's EPHEMERAL pid (heldBy), not the token");

A.close(); B.close();
await wait(100);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
