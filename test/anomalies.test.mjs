const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const KINDS = ['rotor', 'point', 'prism', 'breath'];
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const spawn = (x, y) => fetch(`${base}/admin/anomaly${x != null ? `?x=${x}&y=${y}` : ''}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const anomalies = (w) => w.objects.filter((o) => o.family === 'anomaly');

// 1. fresh world has none
check(anomalies(await snap()).length === 0, 'fresh world has no anomalies');

// 2. proximity boost — run on the FRESH world where dormant seeds are plentiful
const w0 = await snap();
const A = w0.objects.filter((o) => o.family === 'seed' && o.maturity < 0.10).sort((a, b) => a.maturity - b.maturity)[0];
const B = w0.objects.filter((o) => o.family === 'seed' && o.maturity < 0.10 && Math.hypot(o.x - A.x, o.y - A.y) > 600)[0];
await spawn(A.x, A.y); // anomaly right at A
const a0 = A.maturity, b0 = B.maturity;
await tickG(6);
const w0b = await snap();
const dA = w0b.objects.find((o) => o.id === A.id).maturity - a0;
const dB = w0b.objects.find((o) => o.id === B.id).maturity - b0;
check(dA > dB + 0.08, `seed beside an anomaly grew faster (near +${dA.toFixed(3)} vs far +${dB.toFixed(3)})`);

// 3. auto-spawn stays under the cap, valid kinds
await tickG(300);
const aw = await snap();
const ac = anomalies(aw).length;
check(ac >= 1 && ac <= 4, `auto-spawn produced anomalies but stayed under the cap (${ac} in [1,4])`);
check(anomalies(aw).every((a) => KINDS.includes(a.kind)), `all anomalies have a valid kind (${[...new Set(anomalies(aw).map((a) => a.kind))].join(',')})`);

// 4. no lifecycle: an anomaly persists across many ticks
const a1 = anomalies(aw)[0];
await tickG(80);
check(!!anomalies(await snap()).find((a) => a.id === a1.id), 'anomaly persists across 80 ticks (no decay)');

// 5. dissolution: only the holder can dissolve
const sp = await spawn();
const ctl = await open(); await ctl.world;
ctl.send(JSON.stringify({ t: 'dissolve', id: sp.anomaly.id, token: 'not-the-holder', ts: Date.now() }));
await wait(150);
check(!!anomalies(await snap()).find((a) => a.id === sp.anomaly.id), 'dissolve is rejected when you are not holding it');
ctl.send(JSON.stringify({ t: 'pickup', id: sp.anomaly.id, token: 'holder-tok', ts: Date.now() }));
await wait(150);
ctl.send(JSON.stringify({ t: 'dissolve', id: sp.anomaly.id, token: 'holder-tok', ts: Date.now() }));
await wait(200);
check(!anomalies(await snap()).find((a) => a.id === sp.anomaly.id), 'holding + dissolve removes the anomaly');
ctl.close();

// 6. world_state carries anomaly kind
check(anomalies(await snap()).every((a) => 'kind' in a), 'world_state exposes anomaly kind for rendering');

// ---- anomaly POWERS (Wave R) ----------------------------------------------
const life = (id, m, a) => fetch(`${base}/admin/lifecycle?id=${id}&maturity=${m}&aged=${a}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const spawnK = (x, y, kind) => fetch(`${base}/admin/anomaly?x=${x}&y=${y}&kind=${kind}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
async function drop(id, x, y) { // pick an object up and set it down at (x,y)
  const ws = await open(); await ws.world; const tok = 'pw-' + id.slice(0, 6);
  ws.send(JSON.stringify({ t: 'pickup', id, token: tok, ts: Date.now() })); await wait(150);
  ws.send(JSON.stringify({ t: 'place', id, token: tok, x, y, ts: Date.now() })); await wait(240);
  ws.close();
}

// 7. RIPEN: a 'point' anomaly dropped on a young seed matures it into a tree
const seedR = (await snap()).objects.find((o) => o.family === 'seed' && !o.held);
await life(seedR.id, 0.1, 0);                                   // make it young & fresh
const anR = await spawnK(Math.round(seedR.x) + 3000, Math.round(seedR.y), 'point'); // spawn far, then carry it over
await drop(anR.anomaly.id, seedR.x, seedR.y);
const afterR = (await snap()).objects.find((o) => o.id === seedR.id);
check(afterR && afterR.maturity >= 0.99, `a 'point' anomaly ripens a young seed into a mature tree (maturity ${afterR?.maturity?.toFixed(2)})`);

// 8. BURST: a 'prism' anomaly dropped on a mature tree shatters it into saplings
const seedB = (await snap()).objects.find((o) => o.family === 'seed' && !o.held && o.id !== seedR.id);
await life(seedB.id, 1, 0);                                     // make it a mature tree
const seedsBefore = (await snap()).objects.filter((o) => o.family === 'seed').length;
const anB = await spawnK(Math.round(seedB.x) + 3000, Math.round(seedB.y), 'prism');
await drop(anB.anomaly.id, seedB.x, seedB.y);
const wEnd = await snap();
const seedsAfter = wEnd.objects.filter((o) => o.family === 'seed').length;
check(!wEnd.objects.find((o) => o.id === seedB.id), 'a \'prism\' anomaly bursts a mature tree (the tree is gone)');
check(seedsAfter > seedsBefore, `the burst scattered saplings (seeds ${seedsBefore} -> ${seedsAfter})`);

// 9. the anomaly is NOT consumed by using its power (reusable wonder)
check(!!anomalies(await snap()).find((a) => a.id === anR.anomaly.id), 'an anomaly persists after working its power (reusable)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
