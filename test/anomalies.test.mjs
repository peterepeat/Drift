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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
