// Water (Family 3, Phase 3): flow field, drift, and stone-channelling.
//   - flow vector is a season-scaled ~unit vector from the shared noise field
//   - Resting nearly freezes the flow; Rising runs it full
//   - eligible free objects near the pool drift along the flow; far ones don't
//   - a stone deflects the local flow (channelling)
//   - a held object does not drift
//   - the server's flow direction == the client's procgen noise field (determinism)
import { makeNoise } from '../public/drift-procgen.js';
import { FLOW_SEED, FLOW_SCALE } from '../public/flow.js';
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const flow = (x, y) => post(`/admin/flow?x=${x}&y=${y}`);
const place = (id, x, y) => post(`/admin/place?id=${id}&x=${x}&y=${y}`);
const crystal = (x, y) => post(`/admin/crystal?x=${x}&y=${y}`);
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const find = (w, id) => w.objects.find((o) => o.id === id);
const FAR = { x: 8000, y: 3000 }; // far from every seeded stone (gaussian σ=400): pure base flow

// 1. flow is a season-scaled ~unit vector, full-strength in Rising
await tick(1, 3.0); // Rising
const fr = await flow(FAR.x, FAR.y);
const magR = Math.hypot(fr.vx, fr.vy);
check(magR > 0.9 && magR < 1.1, `Rising flow runs at full strength (|v|=${magR.toFixed(3)})`);

// 2. Resting nearly freezes the flow
await tick(1, 2.0); // Resting
const fs = await flow(FAR.x, FAR.y);
const magS = Math.hypot(fs.vx, fs.vy);
check(magS < 0.15 && magS < magR, `Resting nearly freezes the flow (|v|=${magS.toFixed(3)} << ${magR.toFixed(3)})`);

// 3. server flow DIRECTION == the client's procgen noise field (determinism / M3)
await tick(1, 0.0); // Growing — nonzero magnitude so direction is well-defined
const fg = await flow(FAR.x, FAR.y);
const n = makeNoise(FLOW_SEED); // shared with the server via public/flow.js
const ang = n(FAR.x * FLOW_SCALE, FAR.y * FLOW_SCALE) * Math.PI;
const m = Math.hypot(fg.vx, fg.vy);
const dot = (fg.vx / m) * Math.cos(ang) + (fg.vy / m) * Math.sin(ang);
check(dot > 0.999, `server flow direction matches the shared client noise field (cosθ=${dot.toFixed(4)})`);

// 4. an eligible object near the pool drifts along the flow; a far one does not
const near = (await crystal(40, 40)).crystal.id;
await place(near, 40, 40);
const far = (await crystal(6000, 6000)).crystal.id;
await place(far, 6000, 6000);
const f0 = await flow(40, 40);
await tick(30, 3.0); // Rising, 30 ticks
const w1 = await snap();
const no = find(w1, near), fo = find(w1, far);
const moved = no ? Math.hypot(no.x - 40, no.y - 40) : 0;
const downstream = no ? (no.x - 40) * f0.vx + (no.y - 40) * f0.vy : -1;
check(no && moved > 8, `an object in the pool drifts along the flow (crept ${moved.toFixed(1)} units)`);
check(downstream > 0, 'it drifts roughly downstream (positive along the flow vector)');
check(fo && Math.hypot(fo.x - 6000, fo.y - 6000) < 0.001, 'an object far outside the pool does not drift');

// 5. a stone deflects the local flow — channelling (isolate one stone's effect).
// Probe a CLEAR region far beyond every grove, so ONLY the placed stone is nearby
// (the dense heart grove at the origin would otherwise contaminate a near-origin probe).
await tick(1, 3.0);                          // Rising → full flow magnitude at the probe
const PX = 8130, PY = 3000, SX = 8100, SY = 3000; // stone 30u from the probe (< FLOW_STONE_R)
const stone = (await snap()).objects.find((o) => o.family === 'stone');
await place(stone.id, 12000, 12000);        // stone far away: baseline flow at the probe
const base0 = await flow(PX, PY);
await place(stone.id, SX, SY);              // stone beside the probe: should steer flow around it
const base1 = await flow(PX, PY);
check(base1.vx !== base0.vx || base1.vy !== base0.vy, 'a stone deflects the local flow (channelling)');
check(Math.abs(base1.vy - base0.vy) > 1e-3, `the deflection curves the flow tangentially (Δvy=${(base1.vy - base0.vy).toFixed(3)})`);

// 6. a held object does not drift
const heldC = (await crystal(30, 30)).crystal.id;
await place(heldC, 30, 30);
const ctl = await open(); await ctl.world;
ctl.send(JSON.stringify({ t: 'pickup', id: heldC, token: 'water-tok', ts: Date.now() }));
await wait(120);
await tick(20, 3.0);
const hc = find(await snap(), heldC);
check(hc && Math.hypot(hc.x - 30, hc.y - 30) < 0.001, 'a held object does not drift (held flow-immune)');
ctl.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
