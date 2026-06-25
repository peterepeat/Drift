const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickSeason = (n, s) => fetch(`${base}/admin/tick?n=${n}&season=${s}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }

const w0 = await snap();
check(typeof w0.season === 'number', `world_state carries a season clock (${w0.season})`);

const r = await tickSeason(5, 0.0);
check(Math.abs(r.season - 5 * 4 / 480) < 1e-6, `tick advances the season clock (${r.season.toFixed(4)} after 5 ticks from 0)`);

// growth is gated by season
const wA = await snap();
const A = wA.objects.filter((o) => o.family === 'seed' && o.maturity < 0.10).sort((a, b) => a.maturity - b.maturity)[0];
const a0 = A.maturity;
await tickSeason(5, 2.2); // Resting
const A1 = (await snap()).objects.find((o) => o.id === A.id);
check(Math.abs(A1.maturity - a0) < 1e-6, `RESTING pauses growth (Δ${(A1.maturity - a0).toFixed(4)})`);

const wB = await snap();
const B = wB.objects.filter((o) => o.family === 'seed' && o.maturity < 0.10).sort((a, b) => a.maturity - b.maturity)[0];
const b0 = B.maturity;
await tickSeason(5, 0.2); // Growing
const B1 = (await snap()).objects.find((o) => o.id === B.id);
check((B1.maturity - b0) > 0.005, `GROWING grows seeds (Δ${(B1.maturity - b0).toFixed(4)})`);

// aging is modulated by season — mature the world first (Growing)
await tickSeason(80, 0.2);
const wm = await snap();
// pick mature plants AWAY from anomalies — an anomaly nearby slows aging
// (ANOMALY_AGE_SLOW), which would otherwise confound this season comparison.
const anoms = wm.objects.filter((o) => o.family === 'anomaly');
const clear = (o) => anoms.every((a) => Math.hypot(o.x - a.x, o.y - a.y) > 220);
const matures = wm.objects.filter((o) => o.family === 'seed' && o.maturity >= 0.999 && o.aged < 0.4 && clear(o));
const P = matures[0], Q = matures[1];
await tickSeason(5, 1.2); // Turning ages P
const wt = await snap();
const Pt = wt.objects.find((o) => o.id === P.id), Qt = wt.objects.find((o) => o.id === Q.id);
const turnDelta = Pt.aged - P.aged;
await tickSeason(5, 2.2); // Resting ages Q
const Qr = (await snap()).objects.find((o) => o.id === Q.id);
const restDelta = Qr.aged - Qt.aged;
check(turnDelta > restDelta * 2, `TURNING ages faster than RESTING (turn Δ${turnDelta.toFixed(4)} vs rest Δ${restDelta.toFixed(4)})`);

// season cycles back to growing once the clock crosses 4.0
const cyc = await tickSeason(2, 3.99); // 3.99 + 2 ticks crosses 4.0 -> wraps to Growing
check(cyc.season >= 4 && Math.floor(cyc.season) % 4 === 0, `season clock wraps Rising -> Growing (phase ${cyc.season.toFixed(3)}, season ${Math.floor(cyc.season) % 4})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
