// The giant (Stage 1): a shared gardener NPC that strolls and tends the world.
//   - world_state carries the giant's position
//   - it RIPENS a young plant it reaches
//   - it STROLLS when there's nothing nearby to tend
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const key = { 'x-admin-key': 'local-dev-key' };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: key }).then((r) => r.json());
const lifecycle = (id, m, a) => fetch(`${base}/admin/lifecycle?id=${id}&maturity=${m}&aged=${a}`, { method: 'POST', headers: key }).then((r) => r.json());
const place = (id, x, y) => fetch(`${base}/admin/place?id=${id}&x=${x}&y=${y}`, { method: 'POST', headers: key }).then((r) => r.json());
const setGiant = (x, y) => fetch(`${base}/admin/giant?x=${x}&y=${y}`, { method: 'POST', headers: key }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }

// 1. world_state carries the gardener's position
const w0 = await snap();
check(w0.giant && Number.isFinite(w0.giant.x) && Number.isFinite(w0.giant.y), `world_state carries the gardener (${w0.giant ? `${w0.giant.x.toFixed(0)},${w0.giant.y.toFixed(0)}` : 'missing'})`);

// 2. it RIPENS a young plant it reaches — out in the empty far field so it has only this to tend
const seed = w0.objects.find((o) => o.family === 'seed' && !o.held);
await lifecycle(seed.id, 0.3, 0);                 // a young plant
await place(seed.id, 6000, 6000);
await setGiant(6000, 6000);                        // put the gardener right on it (clears its goal)
await tickG(1);                                    // one step: it picks the plant, is already in reach, tends it
const after = (await snap()).objects.find((o) => o.id === seed.id);
check(after && after.maturity >= 0.99, `the gardener ripens a young plant it reaches (0.30 -> ${after?.maturity?.toFixed(2)})`);

// 3. it STROLLS when nothing nearby needs tending (far from any plant/stone)
await setGiant(20000, 20000);
const g0 = (await snap()).giant;
await tickG(3);
const g1 = (await snap()).giant;
const moved = Math.hypot(g1.x - g0.x, g1.y - g0.y);
check(moved > 50, `the gardener strolls when there's nothing to tend (moved ${moved.toFixed(0)}u over 3 ticks)`);
check(Number.isFinite(g1.hx) && Number.isFinite(g1.hy) && Math.hypot(g1.hx, g1.hy) > 0.5, 'it carries a heading (which way it faces) as it moves');

// 4. EQUILIBRIUM — it THINS an over-crowded patch (a patient force against thickets)
const THIN = { x: -8000, y: 8000 };
const cluster = (await snap()).objects.filter((o) => o.family === 'seed' && o.maturity < 0.86).slice(0, 18).map((o) => o.id);
for (const id of cluster) { await place(id, THIN.x + (Math.random() * 80 - 40), THIN.y + (Math.random() * 80 - 40)); await lifecycle(id, 1, 0); } // 18 mature plants packed tight
await setGiant(THIN.x, THIN.y);
const cBefore = (await snap()).objects.filter((o) => o.family === 'seed' && Math.hypot(o.x - THIN.x, o.y - THIN.y) < 200).length;
await tickG(6);
const cAfter = (await snap()).objects.filter((o) => o.family === 'seed' && Math.hypot(o.x - THIN.x, o.y - THIN.y) < 200).length;
check(cAfter < cBefore, `the giant thins an over-crowded patch toward balance (${cBefore} -> ${cAfter})`);

// 5. EQUILIBRIUM — it FILLS a dug hole it reaches (no heal-timer needed)
const HOLE = { x: 9000, y: -9000 };
const hws = await open(); await hws.world;
hws.send(JSON.stringify({ t: 'mark', x: HOLE.x, y: HOLE.y, ts: Date.now() })); await new Promise((r) => setTimeout(r, 200)); hws.close();
const hBefore = (await snap()).objects.filter((o) => o.family === 'mark' && Math.hypot(o.x - HOLE.x, o.y - HOLE.y) < 50).length;
await setGiant(HOLE.x, HOLE.y);
await tickG(5);
const hAfter = (await snap()).objects.filter((o) => o.family === 'mark' && Math.hypot(o.x - HOLE.x, o.y - HOLE.y) < 50).length;
check(hBefore === 1 && hAfter === 0, `the giant fills a dug hole it reaches (${hBefore} -> ${hAfter})`);

// 6. EQUILIBRIUM — it SOWS life in a barren patch (the breed-scarce half of balance)
const SOW = { x: 11000, y: 11000 };           // empty far field — nothing else to tend out here
await setGiant(SOW.x, SOW.y);
const near = (o, c, r) => o.family === 'seed' && Math.hypot(o.x - c.x, o.y - c.y) < r;
const sBefore = (await snap()).objects.filter((o) => near(o, SOW, 1600)).length;
await tickG(10);                               // it cycles its finders → with only barren ground around, it sows
const sAfter = (await snap()).objects.filter((o) => near(o, SOW, 1600)).length;
check(sAfter > sBefore, `the giant sows life where it's scarce (${sBefore} -> ${sAfter})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
