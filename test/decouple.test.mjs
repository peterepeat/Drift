// Broadcast/persist decouple (the rows_written quota — PRD §7.3 scaling).
// A growing world BROADCASTS every lifecycle threshold-crossing for smooth visuals,
// but those crossings must NOT each write to storage — they're recorded in the dirty
// set and flushed together by the periodic checkpoint. So the discrete per-object
// writes during a tick batch are EXACTLY the structural changes (spawns + deaths +
// any hold-reclaim), never the (far larger) number of objects that broadcast. We
// warm a cluster (presence at the origin) so central seeds cross the broadcast delta
// EVERY tick — under the old per-crossing-persist code objWrites would be ≈ spawns +
// deaths + crossings; decoupled it is exactly spawns + deaths, and far below the
// number of broadcasts the client actually receives. /admin/tick reports objWrites.
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
let pass = 0, fail = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
const checkpoint = () => post('/admin/checkpoint');

// A client that counts the object_state broadcasts it receives (proves the decoupled
// broadcast path actually fired — so the write-count assertion isn't vacuous).
function open() {
  const ws = new WebSocket(WS);
  ws.states = 0;
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data);
    if (m.t === 'object_state') ws.states++;
    if (m.t === 'world_state') res(m);
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}

const ws = await open();
const w0 = await ws.world;
check(w0.objects.length > 0, `world loaded (${w0.objects.length} objects)`);

// Turn the gardener OFF: its tending (ripen/thin/sow/fill/fuse) is a legitimate structural
// write, but this test isolates the GROWTH/DRIFT decouple — so keep the giant out of it.
await post('/admin/giant?off=1');

// Warm the centre: presence at the origin heats nearby seeds so they grow fast enough
// to cross the broadcast delta on essentially every tick.
ws.send(JSON.stringify({ t: 'presence_move', x: 0, y: 0, ts: Date.now() }));
await wait(120);

// A growing window. Each warmed seed broadcasts an object_state most ticks; none of
// those broadcasts may cost a discrete write.
const r = await tick(40, 0.0); // Growing
await wait(500); // let the client drain the broadcasts triggered during the ticks

check(ws.states > 0, `growth actually broadcast object_state to the client (${ws.states} msgs)`);
// THE decouple invariant: discrete per-object writes == structural changes only.
check(r.objWrites === r.spawned + r.gone,
  `per-object writes are EXACTLY spawns+deaths, not per-crossing (objWrites ${r.objWrites} === spawned ${r.spawned} + gone ${r.gone})`);
// And those structural writes are far fewer than the broadcasts — the whole point:
// broadcast cadence is decoupled from (and dwarfs) write cadence.
check(ws.states > r.objWrites,
  `broadcasts dwarf discrete writes (${ws.states} object_state >> ${r.objWrites} writes)`);

// Nothing was lost: the deferred growth is still on the books — the next checkpoint
// flushes the dirty set (the in-memory drift the broadcasts didn't persist).
const c = await checkpoint();
check(c.wrote > 0, `the deferred growth is durably captured by the checkpoint dirty-flush (wrote ${c.wrote})`);
// A clean world (snapshot just taken) then writes nothing — the flush cleared dirty.
const c2 = await checkpoint();
check(c2.wrote === 0, `a back-to-back checkpoint writes nothing (dirty cleared; wrote ${c2.wrote})`);

ws.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
