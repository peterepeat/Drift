const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
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
const d = Math.hypot(c.x - w0.pool.x, c.y - w0.pool.y) / w0.pool.r;
check(c && c.family === 'crystal', 'spawned object is a crystal');
check(d > 0.8 && d < 1.2, `crystal forms at the pool edge (${d.toFixed(2)}x pool radius)`);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
