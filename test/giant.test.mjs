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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
