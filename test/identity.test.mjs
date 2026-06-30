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

// object_state OPTIONAL-FIELD deltas (roll/bounce/glowUntil+glowHue/tameUntil/kinds): drive each
// real interaction over the wire so offWhitelist() runs against a delta that ACTUALLY carries the
// optional field — otherwise a future un-whitelisted key stamped on one of these paths ships green.
// A is the dropper; capture on B. Giants OFF so they can't fuse/move our stones mid-test. Each
// interaction sits on its own far-apart, DRY coord (all outside every pond) so they can't cross-trigger.
await admin('/admin/giant?off=1');
const pond0 = ws0.pools[0]; // the central pond {0,0,r:350} — a stone dropped here rolls to the bank
// the latest post-connect object_new of a family (+ optional kind) near a coord (spawned objects
// arrive as object_new on A); kind disambiguates two objects too close for the coord tolerance.
const newOf = (ws, fam, near, tol = 40, kind = null) =>
  [...ws.msgs].reverse().find((m) => m.t === 'object_new' && m.o && m.o.family === fam
    && (!kind || m.o.kind === kind)
    && (!near || (Math.abs(m.o.x - near.x) <= tol && Math.abs(m.o.y - near.y) <= tol)))?.o;

// (1) roll=1 — a free seed stone dropped into open water rolls to the bank (#onPlace → #rollStoneFromWater).
//     The drop must land in OPEN water clear of any free stone, else the stone FUSES instead of rolling
//     (the central pond's heart clusters seed stones, so the bare centre isn't reliably clear) — find a
//     clear in-pond point from ws0 (deterministic, robust to seed/sizing changes).
const stones = ws0.objects.filter((o) => o.family === 'stone' && o.held === false);
const ry0 = pond0.r * 0.7; // the pond is a squashed ellipse (POND_ASPECT)
let rollDrop = null;
for (const [dx, dy] of [[0, 0], [0, 130], [0, -130], [150, 0], [-150, 0], [90, 90], [-90, -90], [90, -90], [180, 0]]) {
  const x = pond0.x + dx, y = pond0.y + dy;
  if ((dx * dx) / (pond0.r * pond0.r) + (dy * dy) / (ry0 * ry0) <= 0.85 && !stones.some((s) => Math.hypot(s.x - x, s.y - y) < 60)) { rollDrop = { x, y }; break; }
}
check(stones.length >= 3, `the seed gives >=3 free stones to drive roll/bounce (${stones.length})`);
check(!!rollDrop, 'found an open-water point in the central pond for the roll drop (clear of seed stones)');
if (stones.length >= 3 && rollDrop) {
  const sRoll = stones[0].id, sBounce = stones[1].id, sBouncer = stones[2].id;
  await admin(`/admin/place?id=${sRoll}&x=-2000&y=-2000`); // park on dry ground first
  await wait(80);
  A.send(JSON.stringify({ t: 'pickup', id: sRoll, token: 'idy-roll', ts: Date.now() }));
  await wait(120);
  A.send(JSON.stringify({ t: 'place', id: sRoll, token: 'idy-roll', x: rollDrop.x, y: rollDrop.y, ts: Date.now() }));
  await wait(180);
  const stR = lastOf(B, 'object_state', sRoll);
  check(stR && stR.roll === 1, `a stone dropped in the central pond broadcasts roll=1 (${stR ? stR.roll : 'no delta'})`);
  check(stR && offWhitelist([stR]) === null, `the roll delta carries ONLY whitelisted keys (${stR ? offWhitelist([stR]) || 'clean' : 'no delta'})`);
  check(stR && leak([stR]) === null, `the roll delta leaks no raw field (${stR ? leak([stR]) || 'clean' : 'no delta'})`);

  // (2) bounce=1 — a stone dropped onto an AT-CAP stone bounces off (kept), not consumed
  await admin(`/admin/place?id=${sBounce}&x=-2000&y=2000&r=350`); // r=350 >= STONE_CAP_R-0.5 → at cap
  await admin(`/admin/place?id=${sBouncer}&x=-2000&y=2000`);
  await wait(80);
  A.send(JSON.stringify({ t: 'pickup', id: sBouncer, token: 'idy-bnc', ts: Date.now() }));
  await wait(120);
  A.send(JSON.stringify({ t: 'place', id: sBouncer, token: 'idy-bnc', x: -2000, y: 2000, ts: Date.now() }));
  await wait(180);
  const stB = lastOf(B, 'object_state', sBouncer);
  check(stB && stB.bounce === 1, `a stone dropped on an at-cap stone broadcasts bounce=1 (${stB ? stB.bounce : 'no delta'})`);
  check(stB && offWhitelist([stB]) === null, `the bounce delta carries ONLY whitelisted keys (${stB ? offWhitelist([stB]) || 'clean' : 'no delta'})`);
  check(stB && leak([stB]) === null, `the bounce delta leaks no raw field (${stB ? leak([stB]) || 'clean' : 'no delta'})`);
}

// (3) glowUntil+glowHue — a rotor (non-heart) anomaly dropped onto a free creature glows IT (the creature)
await admin('/admin/creature?x=1500&y=1500&kind=flier');
await admin('/admin/anomaly?x=1500&y=1500&kind=rotor');
await wait(200);
const glowCreature = newOf(A, 'creature', { x: 1500, y: 1500 }), glowAnom = newOf(A, 'anomaly', { x: 1500, y: 1500 });
check(!!(glowCreature && glowAnom), 'spawned a creature + rotor anomaly for the glow path');
if (glowCreature && glowAnom) {
  A.send(JSON.stringify({ t: 'pickup', id: glowAnom.id, token: 'idy-glow', ts: Date.now() }));
  await wait(120);
  A.send(JSON.stringify({ t: 'place', id: glowAnom.id, token: 'idy-glow', x: 1500, y: 1500, ts: Date.now() }));
  await wait(180);
  const gst = lastOf(B, 'object_state', glowCreature.id); // the buff lands on the CREATURE, not the anomaly
  check(gst && typeof gst.glowUntil === 'number' && gst.glowUntil > Date.now() && typeof gst.glowHue === 'number',
    `a glowed creature broadcasts glowUntil+glowHue (${gst ? `${gst.glowUntil},${gst.glowHue}` : 'no delta'})`);
  check(gst && offWhitelist([gst]) === null, `the glow delta carries ONLY whitelisted keys (${gst ? offWhitelist([gst]) || 'clean' : 'no delta'})`);
  check(gst && leak([gst]) === null, `the glow delta leaks no raw field (${gst ? leak([gst]) || 'clean' : 'no delta'})`);
}

// (4) tameUntil — a heart anomaly dropped onto a free creature tames it
await admin('/admin/creature?x=-1500&y=1500&kind=flier');
await admin('/admin/anomaly?x=-1500&y=1500&kind=heart');
await wait(200);
const tameCreature = newOf(A, 'creature', { x: -1500, y: 1500 }), tameAnom = newOf(A, 'anomaly', { x: -1500, y: 1500 });
check(!!(tameCreature && tameAnom), 'spawned a creature + heart anomaly for the tame path');
if (tameCreature && tameAnom) {
  A.send(JSON.stringify({ t: 'pickup', id: tameAnom.id, token: 'idy-tame', ts: Date.now() }));
  await wait(120);
  A.send(JSON.stringify({ t: 'place', id: tameAnom.id, token: 'idy-tame', x: -1500, y: 1500, ts: Date.now() }));
  await wait(180);
  const tst = lastOf(B, 'object_state', tameCreature.id);
  check(tst && typeof tst.tameUntil === 'number' && tst.tameUntil > Date.now(), `a tamed creature broadcasts tameUntil (${tst ? tst.tameUntil : 'no delta'})`);
  check(tst && offWhitelist([tst]) === null, `the tame delta carries ONLY whitelisted keys (${tst ? offWhitelist([tst]) || 'clean' : 'no delta'})`);
  check(tst && leak([tst]) === null, `the tame delta leaks no raw field (${tst ? leak([tst]) || 'clean' : 'no delta'})`);
}

// (5) kinds — fuse two DISTINCT-kind anomalies; the survivor broadcasts a hybrid kinds[] (len>1)
await admin('/admin/anomaly?x=-1000&y=-1000&kind=point'); // survivor/target
await admin('/admin/anomaly?x=-1010&y=-1000&kind=heart'); // dropped (distinct kind; dx=10 < ANOM_TOUCH_R=76)
await wait(200);
const fuseTarget = newOf(A, 'anomaly', { x: -1000, y: -1000 }, 40, 'point'), fuseDrop = newOf(A, 'anomaly', { x: -1010, y: -1000 }, 40, 'heart');
check(!!(fuseTarget && fuseDrop && fuseTarget.id !== fuseDrop.id), 'spawned a point + heart anomaly for the kinds-fuse path');
if (fuseTarget && fuseDrop && fuseTarget.id !== fuseDrop.id) {
  A.send(JSON.stringify({ t: 'pickup', id: fuseDrop.id, token: 'idy-fuse', ts: Date.now() }));
  await wait(120);
  A.send(JSON.stringify({ t: 'place', id: fuseDrop.id, token: 'idy-fuse', x: -1000, y: -1000, ts: Date.now() }));
  await wait(180);
  const fst = lastOf(B, 'object_state', fuseTarget.id); // kinds rides the SURVIVOR (the dropped one is consumed)
  check(fst && Array.isArray(fst.kinds) && fst.kinds.length > 1, `a fused anomaly broadcasts a hybrid kinds[] (${fst ? JSON.stringify(fst.kinds) : 'no delta'})`);
  check(fst && offWhitelist([fst]) === null, `the fused delta carries ONLY whitelisted keys (${fst ? offWhitelist([fst]) || 'clean' : 'no delta'})`);
  check(fst && leak([fst]) === null, `the fused delta leaks no raw field (${fst ? leak([fst]) || 'clean' : 'no delta'})`);
  check(!!lastOf(B, 'object_gone', fuseDrop.id), 'the dropped anomaly is consumed (object_gone), not a kinds delta');
}

A.close(); B.close();
await wait(100);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
