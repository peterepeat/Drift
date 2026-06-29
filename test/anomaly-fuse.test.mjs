// Anomaly fusing & breaking (Unit ⑤): anomalies merge into hybrids and split back.
//   - drop an anomaly onto another of a DIFFERENT kind -> they FUSE into one hybrid
//     (carries both kinds; the dropped one is consumed)
//   - dropping onto the SAME kind does nothing (a wonder is never destroyed for nothing)
//   - a hybrid's powers COMBINE: a ripen+burst hybrid on a young seed ripens THEN bursts
//   - double-click (`break`) a hybrid -> it splits back into one anomaly per kind
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const hdr = { 'x-admin-key': 'local-dev-key' };
const spawnK = (x, y, kind) => fetch(`${base}/admin/anomaly?x=${x}&y=${y}&kind=${kind}`, { method: 'POST', headers: hdr }).then((r) => r.json());
const life = (id, m, a) => fetch(`${base}/admin/lifecycle?id=${id}&maturity=${m}&aged=${a}`, { method: 'POST', headers: hdr }).then((r) => r.json());
const place = (id, x, y) => fetch(`${base}/admin/place?id=${id}&x=${x}&y=${y}`, { method: 'POST', headers: hdr }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const anomalies = (w) => w.objects.filter((o) => o.family === 'anomaly');
const byId = (w, id) => w.objects.find((o) => o.id === id);
async function drop(id, x, y) { // carry an object and set it down at (x,y) — the unit of interaction
  const ws = await open(); await ws.world; const tok = 'fz-' + id.slice(0, 6);
  ws.send(JSON.stringify({ t: 'pickup', id, token: tok, ts: Date.now() })); await wait(150);
  ws.send(JSON.stringify({ t: 'place', id, token: tok, x, y, ts: Date.now() })); await wait(240);
  ws.close();
}

const ctl = await open(); await ctl.world;

// 1. FUSE: drop a 'point' onto a 'prism' (different kinds) -> one hybrid carrying both.
const R1X = 9000, R1Y = 9000;
const A = (await spawnK(R1X, R1Y, 'point')).anomaly;            // the target
const B = (await spawnK(R1X + 8, R1Y, 'prism')).anomaly;        // dropped onto A
await drop(B.id, R1X, R1Y);
let w = await snap();
const surv = byId(w, A.id) || byId(w, B.id);
const gone = !byId(w, A.id) || !byId(w, B.id);
check(gone, 'fusing consumes the dropped anomaly (one hybrid, not two)');
check(!!(surv && Array.isArray(surv.kinds) && surv.kinds.length === 2), `the survivor is a hybrid carrying two kinds (${surv?.kinds?.join('+') || '?'})`);
check(!!(surv && surv.kinds && surv.kinds.includes('point') && surv.kinds.includes('prism')), 'the hybrid carries BOTH constituent kinds (point + prism)');

// 2. SAME-KIND drop does nothing — a rare wonder is never destroyed for no gain.
const R2X = 9000, R2Y = -9000;
const C = (await spawnK(R2X, R2Y, 'rotor')).anomaly;
const D = (await spawnK(R2X + 8, R2Y, 'rotor')).anomaly;
await drop(D.id, R2X, R2Y);
w = await snap();
check(!!byId(w, C.id) && !!byId(w, D.id), 'dropping an anomaly onto the SAME kind leaves both standing (no destruction)');

// 3. COMBINED POWERS: a ripen+burst hybrid dropped on a YOUNG seed ripens it to a tree
//    THEN bursts that tree into saplings — an effect neither kind does alone.
const R3X = -9000, R3Y = 9000;
const seed = (await snap()).objects.find((o) => o.family === 'seed' && !o.held);
await life(seed.id, 0.1, 0);                                     // young & fresh (a lone 'point' would only ripen it)
await place(seed.id, R3X, R3Y);                                  // move it to the clear test region
const E = (await spawnK(R3X + 3000, R3Y, 'point')).anomaly;     // ripen
const F = (await spawnK(R3X + 3008, R3Y, 'prism')).anomaly;     // burst
await drop(F.id, R3X + 3000, R3Y);                              // fuse E+F at the staging spot
const hybrid = (await snap());
const hy = byId(hybrid, E.id) || byId(hybrid, F.id);
check(!!(hy && hy.kinds && hy.kinds.length === 2), 'staged a ripen+burst hybrid for the combined-power test');
const seedsBefore = hybrid.objects.filter((o) => o.family === 'seed').length;
await drop(hy.id, R3X, R3Y);                                     // drop the hybrid onto the young seed
w = await snap();
const seedGone = !byId(w, seed.id);
const saplings = w.objects.filter((o) => o.family === 'seed' && Math.abs(o.x - R3X) < 140 && Math.abs(o.y - R3Y) < 140 && o.id !== seed.id);
check(seedGone, 'the combined hybrid consumed the young seed (ripened, then burst)');
check(saplings.length >= 2, `the burst scattered fresh saplings where the seed was (${saplings.length})`);

// 4. BREAK: double-click the region-1 hybrid -> it splits back into its two kinds.
const before4 = anomalies(await snap()).length;
ctl.send(JSON.stringify({ t: 'break', id: surv.id, token: 'breaker', ts: Date.now() }));
await wait(200);
w = await snap();
const brokenGone = !byId(w, surv.id);
const shards = anomalies(w).filter((o) => Math.abs(o.x - R1X) < 120 && Math.abs(o.y - R1Y) < 120);
check(brokenGone, 'the broken hybrid is gone');
check(shards.length === 2, `it split into 2 single-kind anomalies (${shards.length})`);
check(shards.every((o) => !o.kinds) && shards.some((o) => o.kind === 'point') && shards.some((o) => o.kind === 'prism'),
  `the shards are the original kinds, un-fused (${shards.map((o) => o.kind).join(',')})`);
check(anomalies(w).length === before4 + 1, 'breaking one hybrid yields exactly two anomalies (net +1)');

ctl.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
