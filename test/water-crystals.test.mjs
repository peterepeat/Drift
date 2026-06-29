const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
// Crystal spawn/decay are season-independent, so we tick in RESTING (growth paused)
// to keep the seed population from ballooning to the cap over these long bursts
// (a packed world's per-tick ceiling-trim is what made this suite crawl). The
// season CLOCK advances during a burst, so re-pin Resting in small chunks — one
// big call would drift into the growing seasons and balloon anyway.
const tickN = (n, s) => fetch(`${base}/admin/tick?n=${n}&season=${s}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const tickG = async (n) => { let r; for (let d = 0; d < n; d += 50) r = await tickN(Math.min(50, n - d), 2.0); return r; };
const spawn = (x, y) => fetch(`${base}/admin/crystal${x != null ? `?x=${x}&y=${y}` : ''}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const crystals = (w) => w.objects.filter((o) => o.family === 'crystal');

// 1. world carries a pool
const w0 = await snap();
check(w0.pool && typeof w0.pool.r === 'number', `world_state carries a water pool (r=${w0.pool?.r})`);
check(crystals(w0).length === 0, 'fresh world has no crystals');

// 2. a crystal forms at the pool edge
const sp = await spawn();
const w1 = await snap();
const c = crystals(w1).find((o) => o.id === sp.crystal.id);
const ASPECT = 0.7; // ponds are ellipses (POND_ASPECT) — measure the crystal on the elliptical rim
const eEdge = Math.hypot((c.x - w0.pool.x) / w0.pool.r, (c.y - w0.pool.y) / (w0.pool.r * ASPECT));
check(c && c.family === 'crystal', 'spawned object is a crystal');
check(eEdge > 0.7 && eEdge < 1.25, `crystal forms at the elliptical pool edge (e=${eEdge.toFixed(2)})`);

// 3. auto-spawn + cap
await tickG(200);
const cc = crystals(await snap()).length;
check(cc >= 1 && cc <= 10, `crystals form over time but stay under the cap (${cc} in [1,10])`);

// 4. held crystals do not dissolve (decay paused)
const wh = await snap();
const held = crystals(wh)[0];
const ctl = await open(); await ctl.world;
ctl.send(JSON.stringify({ t: 'pickup', id: held.id, token: 'crys-tok', ts: Date.now() }));
await wait(150);
await tickG(400); // long enough to dissolve a free crystal
check(!!crystals(await snap()).find((o) => o.id === held.id), 'a held crystal does not dissolve (decay paused)');
ctl.send(JSON.stringify({ t: 'place', id: held.id, token: 'crys-tok', x: held.x, y: held.y, ts: Date.now() }));
await wait(120);
ctl.close();

// 5. a free crystal dissolves after enough time (brief flash -> gone)
const fresh = await spawn();
await tickG(330); // > 300 ticks at CRYSTAL_DECAY=1/300
check(!crystals(await snap()).find((o) => o.id === fresh.crystal.id), 'a free crystal dissolves after ~its lifespan');

// 6. the world carries multiple ponds; pools[0] is the central pool (== w.pool)
check(Array.isArray(w0.pools) && w0.pools.length >= 2, `world_state carries multiple ponds (${w0.pools?.length})`);
check(!!(w0.pools && w0.pools[0] && w0.pools[0].x === w0.pool.x && w0.pools[0].y === w0.pool.y && w0.pools[0].r === w0.pool.r), 'pools[0] is the central pool');

// 7. no trees in water: a seed dropped into a pond is nudged to its bank next tick
const place = (id, x, y) => fetch(`${base}/admin/place?id=${id}&x=${x}&y=${y}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const pond = (w0.pools && w0.pools[1]) || w0.pool; // a quiet outer pond
const seedObj = (await snap()).objects.find((o) => o.family === 'seed' && !o.held);
if (seedObj) {
  await place(seedObj.id, pond.x, pond.y); // drop it dead-centre of the pond
  await tickN(1, 2.0);                      // one tick relocates it to the bank
  const after = (await snap()).objects.find((o) => o.id === seedObj.id);
  const ASPECT = 0.7; // mirrors POND_ASPECT (ponds are ellipses)
  const nx = after ? (after.x - pond.x) / pond.r : 0, ny = after ? (after.y - pond.y) / (pond.r * ASPECT) : 0;
  check(after && (nx * nx + ny * ny) > 1, `a seed in a pond is nudged out onto the elliptical bank (e=${(nx * nx + ny * ny).toFixed(2)} > 1)`);
} else {
  check(false, 'a seed exists to test pond relocation');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
