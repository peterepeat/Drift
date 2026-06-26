// Interest management: the initial world_state is filtered to the connecting
// client's viewport (centred on the cog), and panning pages the rest in via
// `world_patch`. Bare connects (no viewport) still get the whole world.
// PURELY in-memory on the server — this suite also documents that the feature
// adds no persistence (no new storage writes).
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const place = (id, x, y) => post(`/admin/place?id=${id}&x=${x}&y=${y}`);

const MARGIN = 1.6; // must match INTEREST_MARGIN in world-do.js

function open(query = '') {
  const ws = new WebSocket(WS + query);
  ws.msgs = []; ws.pid = null;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'world_state') ws.pid = m.pid;
    ws.msgs.push(m);
  });
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
const lastOf = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
const patchIds = (ws) => new Set(ws.msgs.filter((m) => m.t === 'world_patch').flatMap((m) => m.objects.map((o) => o.id)));
let pass = 0, fail = 0;
const check = (cond, label) => { console.log((cond ? '  PASS ' : '  FAIL ') + label); cond ? pass++ : fail++; };

// ---- back-compat: a viewport-less connect still gets the whole world ----
const full = await open();
await wait(300);
const wsFull = lastOf(full, 'world_state');
check(wsFull && wsFull.objects.length === 200, `bare connect gets the full world (${wsFull?.objects.length})`);
const cog = wsFull.cog; // fresh world ⇒ ~origin; the interest box is centred here

// ---- interest-filtered initial payload ----
const hw = 60, hh = 60;
const small = await open(`?hw=${hw}&hh=${hh}`);
await wait(300);
const wsSmall = lastOf(small, 'world_state');
check(wsSmall && wsSmall.objects.length < 200, `small viewport gets a subset, not the world (${wsSmall?.objects.length}/200)`);
check(wsSmall && wsSmall.objects.length > 0, `small viewport still sees what's nearby (${wsSmall?.objects.length})`);
const within = wsSmall.objects.every((o) =>
  Math.abs(o.x - cog.x) <= hw * MARGIN + 1e-6 && Math.abs(o.y - cog.y) <= hh * MARGIN + 1e-6);
check(within, 'every object in the filtered payload is inside the interest box');

// ---- panning pages distant objects in via world_patch ----
// Relocate a known object far outside any reasonable initial viewport.
const far = wsFull.objects[0];
await place(far.id, 6000, 6000);
await wait(120);
// A client that connects AFTER the move, with a viewport at the origin, must not
// see it in world_state (it's far away and the move predates this connection).
const pager = await open(`?hw=${hw}&hh=${hh}`);
await wait(300);
const wsPager = lastOf(pager, 'world_state');
check(!wsPager.objects.some((o) => o.id === far.id), 'a distant object is absent from the origin-viewport payload');
// Pan there: presence_move carries the viewport, server streams the object in.
pager.send(JSON.stringify({ t: 'presence_move', x: 6000, y: 6000, hw: 200, hh: 200, ts: Date.now() }));
await wait(250);
check(patchIds(pager).has(far.id), 'panning to the object pages it in via world_patch');

// ---- a second viewport report doesn't re-send what's already known ----
pager.msgs.length = 0;
pager.send(JSON.stringify({ t: 'presence_move', x: 6000, y: 6000, hw: 200, hh: 200, ts: Date.now() }));
await wait(250);
check(!patchIds(pager).has(far.id), 'a repeat viewport report does not re-page a known object');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
