// Communion (the "bring a friend" reward): two presences lingering in the same patch
// for a few ticks make the world BLOSSOM there — flowering plants (+ sometimes an
// anomaly). Presence-driven, in-memory; a cooldown stops a patch farming it.
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const key = { 'x-admin-key': 'local-dev-key' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: key }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const near = (w, x, y, r) => w.objects.filter((o) => Math.abs(o.x - x) < r && Math.abs(o.y - y) < r);

// a lone presence lingering — should NOT bloom anything (it takes two)
const LX = -6000, LY = -6000;
const solo = await open(); await solo.world;
for (let i = 0; i < 4; i++) { solo.send(JSON.stringify({ t: 'presence_move', x: LX, y: LY, hw: 800, hh: 600, ts: Date.now() })); await wait(80); await tickG(1); }
check(near(await snap(), LX, LY, 220).length === 0, 'a lone visitor lingering blooms nothing (it takes two)');
solo.close();

// two presences lingering in the same patch -> a communion bloom of flowering plants
const SX = 6000, SY = 6000;
const before = near(await snap(), SX, SY, 220).length;
const A = await open(); await A.world;
const B = await open(); await B.world;
for (let i = 0; i < 4; i++) {
  A.send(JSON.stringify({ t: 'presence_move', x: SX, y: SY, hw: 800, hh: 600, ts: Date.now() }));
  B.send(JSON.stringify({ t: 'presence_move', x: SX + 60, y: SY + 40, hw: 800, hh: 600, ts: Date.now() }));
  await wait(90); await tickG(1);
}
const after = near(await snap(), SX, SY, 240);
check(after.length > before, `tending a patch together blooms new life (${before} -> ${after.length})`);
check(after.some((o) => o.family === 'seed' && o.maturity >= 0.8), 'the bloom includes mature flowering plants');
A.close(); B.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
