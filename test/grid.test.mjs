// Spatial grid (PRD §7.3): an in-memory spatial hash makes the per-tick / per-
// message neighbour queries (flow deflection, interest box scans, stack-on-place)
// O(neighbours). It's purely an indexing layer, so it must (a) stay perfectly
// consistent with the object map across EVERY mutation, and (b) be behaviour-
// identical. /admin/grid exposes a self-consistency check (gated; inert in prod).
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
const TOK = 'grid-tok';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const grid = () => post('/admin/grid');
const place = (id, x, y) => post(`/admin/place?id=${id}&x=${x}&y=${y}`);
const fill = (n) => post(`/admin/fill?n=${n}`);
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
const crystalAt = (x, y) => post(`/admin/crystal?x=${x}&y=${y}`);
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };

function open(query = '') {
  const ws = new WebSocket(WS + query);
  ws.msgs = []; ws.pid = null;
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.t === 'world_state') ws.pid = m.pid; ws.msgs.push(m); });
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
const lastOf = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
async function snap() { const ws = await open(); await wait(200); const w = lastOf(ws, 'world_state'); ws.close(); return w; }
const patchIds = (ws) => new Set(ws.msgs.filter((m) => m.t === 'world_patch').flatMap((m) => m.objects.map((o) => o.id)));

// 0. fresh world: the grid indexes exactly the loaded population, consistently
const w0 = await snap();
let g = await grid();
check(g.consistent, 'fresh world: grid is self-consistent');
check(g.indexed === w0.objects.length, `grid indexes every object (${g.indexed}/${w0.objects.length})`);

// 1. a bulk /admin/fill rebuilds the grid — every filled object indexed
const before = g.objects;
await fill(500);
g = await grid();
check(g.consistent && g.objects === before + 500, `bulk fill stays consistent (${g.objects} objects across ${g.cells} cells)`);

// 2. a mutation-heavy sequence keeps the grid consistent
await tick(5, 0.0);                                   // growth / shed / spawn / gone / drift all run
const stones = w0.objects.filter((o) => o.family === 'stone');
await place(stones[0].id, 4000, -4000);               // far moves crossing many cells
await place(stones[1].id, -3000, 2500);
const c = (await crystalAt(1234, -987)).crystal.id;   // spawn via admin
await place(c, 1234, -987);
const ctl = await open(); await wait(150);
const mover = w0.objects.find((o) => o.family === 'seed' && !o.held);
ctl.send(JSON.stringify({ t: 'pickup', id: mover.id, token: TOK, ts: Date.now() }));   await wait(80);
ctl.send(JSON.stringify({ t: 'carry', id: mover.id, token: TOK, x: 5000, y: 5000, ts: Date.now() })); await wait(80);
ctl.send(JSON.stringify({ t: 'place', id: mover.id, token: TOK, x: 5000, y: 5000, ts: Date.now() })); await wait(120);
g = await grid();
check(g.consistent, 'grid consistent after tick + far places + spawn + pickup/carry/place');

// 3. a carried-away object pages into a viewport panned over its destination
//    (proves the grid box query returns objects the move re-indexed)
const pager = await open('?hw=80&hh=80');             // viewport at the origin
await wait(250);
const seen0 = lastOf(pager, 'world_state').objects.some((o) => o.id === mover.id);
check(!seen0, 'the carried-away object is absent from an origin viewport');
pager.send(JSON.stringify({ t: 'presence_move', x: 5000, y: 5000, hw: 200, hh: 200, ts: Date.now() }));
await wait(250);
check(patchIds(pager).has(mover.id), 'panning to the destination pages the carried object in (grid box query)');

// 4. stacking via the WS path uses the grid-backed #tryStack and stays consistent
async function wsMove(id, x, y) {
  ctl.send(JSON.stringify({ t: 'pickup', id, token: TOK, ts: Date.now() })); await wait(60);
  ctl.send(JSON.stringify({ t: 'place', id, token: TOK, x, y, ts: Date.now() })); await wait(60);
}
const freeStones = (await snap()).objects.filter((o) => o.family === 'stone' && !o.held).map((o) => o.id);
await wsMove(freeStones[0], 7000, 7000);
await wsMove(freeStones[1], 7000, 7000);              // drop onto the first -> grid #tryStack finds it
const st = (await snap()).objects.find((o) => o.id === freeStones[1]);
check(st && st.stack === 1 && st.stackBase === freeStones[0], `a stone stacks via the grid-backed #tryStack (level ${st?.stack})`);
g = await grid();
check(g.consistent, 'grid consistent after WS stacking');

ctl.close(); pager.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
