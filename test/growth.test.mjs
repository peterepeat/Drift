const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tick = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json()); // pin Growing; seasons tested separately
const lifecycle = (id, maturity, aged) => fetch(`${base}/admin/lifecycle?id=${id}&maturity=${maturity}&aged=${aged}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());

function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snapshot() { const ws = await open(); const w = await ws.world; ws.close(); return w; }

// --- 1. lifecycle present in world_state ---
const w0 = await snapshot();
const seeds0 = w0.objects.filter((o) => o.family === 'seed');
check(w0.objects.every((o) => typeof o.maturity === 'number' && typeof o.aged === 'number'), 'world_state carries maturity + aged');
const dormant0 = seeds0.filter((o) => o.maturity < 0.14).length;
const plant0 = seeds0.filter((o) => o.maturity >= 0.14).length;
check(dormant0 > 0 && plant0 > 0, `arrival world is established: ${dormant0} seeds + ${plant0} plants (of ${seeds0.length})`);

// --- 2. presence WARMTH accelerates growth ---
const cand = seeds0.filter((o) => o.maturity < 0.12).sort((a, b) => a.maturity - b.maturity);
const A = cand[0];
const B = cand.find((o) => Math.hypot(o.x - A.x, o.y - A.y) > 500); // outside warmth radius (240)
const a0 = A.maturity, b0 = B.maturity;
const warm = await open();           // a connection that "lingers" at A
for (let i = 0; i < 8; i++) {
  warm.send(JSON.stringify({ t: 'presence_move', x: A.x, y: A.y, ts: Date.now() }));
  await wait(40);
  await tick(1);
}
const w1 = await snapshot();
const A1 = w1.objects.find((o) => o.id === A.id);
const B1 = w1.objects.find((o) => o.id === B.id);
const dA = A1.maturity - a0, dB = B1.maturity - b0;
check(dA > 0.08, `warmed seed grew strongly: +${dA.toFixed(3)} maturity over 8 ticks`);
check(dB >= 0 && dB < 0.03, `cold control barely grew: +${dB.toFixed(3)}`);
check(dA > dB * 4, `warmth accelerates growth (warm +${dA.toFixed(3)} vs cold +${dB.toFixed(3)})`);
warm.close();
await wait(200); // let presence_gone / dropConn settle so warmth stops

// --- disturbance resets a pre-sprout seed (run early, while seeds are dormant) ---
const fresh = await snapshot();
const dseed = fresh.objects.find((o) => o.family === 'seed' && o.maturity > 0.01 && o.maturity < 0.14);
const ctl = await open(); await ctl.world;
const tok = 'dist-tok';
ctl.send(JSON.stringify({ t: 'pickup', id: dseed.id, token: tok, ts: Date.now() }));
await wait(120);
ctl.send(JSON.stringify({ t: 'place', id: dseed.id, token: tok, x: dseed.x, y: dseed.y, ts: Date.now() }));
await wait(150);
const dAfter = (await snapshot()).objects.find((o) => o.id === dseed.id);
check(dAfter && dAfter.maturity === 0, `disturbing a pre-sprout seed reset its growth (${dseed.maturity.toFixed(3)} -> ${dAfter?.maturity})`);
ctl.close();

// --- unattended cycle: shedding + population bounded ---
const before = (await snapshot()).objects.length;
let totalSpawned = 0;
for (let i = 0; i < 6; i++) { const r = await tick(40); totalSpawned += r.spawned; } // ~240 ticks
const w2 = await snapshot();
check(totalSpawned > 0, `mature plants shed new seeds (${totalSpawned} spawned over ~240 ticks)`);
check(w2.objects.length <= 10000, `population stays under the cap (${w2.objects.length} <= 10000)`);
const grown = w2.objects.filter((o) => o.family === 'seed' && o.maturity >= 0.14).length;
check(grown > plant0, `the world filled with plants over time (${plant0} -> ${grown})`);

// --- a fully-aged plant dissolves: set one to the brink, a few ticks finish it
//     (deterministic — natural aging timing is marginal and ballooning to age it
//     the slow way would pack the world to the cap) ---
const ripe = w2.objects.find((o) => o.family === 'seed' && o.maturity >= 0.86);
await lifecycle(ripe.id, 1, 0.96);
let dissolved = 0;
for (let i = 0; i < 5 && !dissolved; i++) dissolved += (await tick(20)).gone; // ~20-100 ticks
check(dissolved > 0 && !(await snapshot()).objects.find((o) => o.id === ripe.id), `a fully-aged plant dissolves (${dissolved} gone)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
