// Ground marks (Family 7, Wave S): double-click bare ground leaves a rock-shaped
// tinted stain, visible to everyone, that heals (is removed) after ~10 min.
//   - a 'mark' message creates a mark at the point; it's LAND-only (rejected in water)
//   - a mark heals away after its lifespan (aged via /admin/isolate, then one tick)
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickN = (n, s) => fetch(`${base}/admin/tick?n=${n}&season=${s}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const isolate = (id, n) => fetch(`${base}/admin/isolate?id=${id}&n=${n}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const marks = (w) => w.objects.filter((o) => o.family === 'mark');

// 1. fresh world has no marks
const w0 = await snap();
check(marks(w0).length === 0, 'fresh world has no marks');

// 2. a 'mark' on bare ground leaves a mark there (a quiet spot far from the pools)
const SITE = { x: 4000, y: 4000 };
const ws = await open(); await ws.world;
ws.send(JSON.stringify({ t: 'mark', x: SITE.x, y: SITE.y, ts: Date.now() }));
await wait(220);
const w1 = await snap();
const mk = marks(w1).find((o) => Math.hypot(o.x - SITE.x, o.y - SITE.y) < 1);
check(!!mk, `a double-click on bare ground leaves a mark (${marks(w1).length} mark(s))`);
check(!!(mk && mk.family === 'mark' && typeof mk.created_at === 'number'), 'the mark exposes family=mark + created_at (drives the heal fade)');

// 3. marks are LAND-only — one dropped in the central pool is rejected
ws.send(JSON.stringify({ t: 'mark', x: w0.pool.x, y: w0.pool.y, ts: Date.now() }));
await wait(220);
const inPool = marks(await snap()).find((o) => Math.hypot(o.x - w0.pool.x, o.y - w0.pool.y) < w0.pool.r);
check(!inPool, 'a mark dropped in the water is rejected (land only)');
ws.close();

// 4. a mark heals away after its lifespan: age it past ~10 min, then one tick removes it
await isolate(mk.id, 11); // backdate created_at 11 min (> the 10-min life)
await tickN(1, 2.0);       // tick in resting (no growth) — the expiry pass removes it
check(!marks(await snap()).find((o) => o.id === mk.id), 'a mark heals away (is removed) after ~10 min');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
