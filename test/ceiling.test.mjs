// Object ceiling + isolation decay (PRD §4.3 + §7.3).
//   - a stone left untouched & unwarmed long enough crumbles to grit
//   - touching or warming a stone resets its isolation, so it survives
//   - anomalies never fade
//   - a full world trims its most-isolated objects back under the ceiling
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
const MAX = 10000, FADE = 1440; // MAX_OBJECTS; FADE = ticks-untouched that crumble a stone (STONE_FADE_MS / TICK_MS)
let pass = 0, fail = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
const isolate = (id, n) => post(`/admin/isolate?id=${id}&n=${n}`);
const place = (id, x, y) => post(`/admin/place?id=${id}&x=${x}&y=${y}`);
const setHeat = (x, y, v) => post(`/admin/heat?x=${x}&y=${y}&set=${v}`);
const fill = (n) => post(`/admin/fill?n=${n}`);
const anomaly = (x, y) => post(`/admin/anomaly?x=${x}&y=${y}`);
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const has = (w, id) => w.objects.some((o) => o.id === id);
const stones = (w) => w.objects.filter((o) => o.family === 'stone' && !o.held);

// pick three free stones far from the pool/each other so warmth doesn't bleed across
const st = stones(await snap());
const [A, B, C] = st;

// 1. a forgotten stone crumbles to grit
await isolate(A.id, FADE);
await tick(1, 0.0);
check(!has(await snap(), A.id), 'a stone left untouched & unwarmed long enough crumbles to grit');

// 2. touching a stone resets its isolation — it survives
await isolate(B.id, FADE);
await place(B.id, B.x, B.y);  // a touch
await tick(1, 0.0);
check(has(await snap(), B.id), 'touching a stone resets its isolation (it survives)');

// 3. warmth tends a stone — it survives even when otherwise forgotten
await isolate(C.id, FADE);
await setHeat(C.x, C.y, 1.0);
await tick(1, 0.0);
check(has(await snap(), C.id), 'nearby warmth tends a stone (resets isolation, survives)');

// 3.5 a long-stacked stone is tended — it must not crumble the instant it scatters
const free = stones(await snap()).filter((o) => ![A.id, B.id, C.id].includes(o.id));
const [D, E] = free;
const ctl = await open(); await ctl.world;
const move = async (id, x, y) => {
  ctl.send(JSON.stringify({ t: 'pickup', id, token: 'ceil-tok', ts: Date.now() })); await wait(60);
  ctl.send(JSON.stringify({ t: 'place', id, token: 'ceil-tok', x, y, ts: Date.now() })); await wait(60);
};
await move(D.id, 5000, 5000);   // a base in open, unwarmed space
await move(E.id, 5000, 5000);   // stack E on top
await isolate(E.id, FADE);      // pretend it has been stacked a very long time
await tick(1, 0.0);
check(has(await snap(), E.id), 'a stacked stone is tended (does not fade however isolated)');
ctl.send(JSON.stringify({ t: 'scatter', id: E.id, token: 'ceil-tok', ts: Date.now() })); await wait(100);
await tick(1, 0.0);
check(has(await snap(), E.id), 'a just-scattered stone does not instantly crumble to grit');
ctl.close();

// 4. anomalies never fade, even when maximally isolated
const an = (await anomaly(120, 120)).anomaly.id;
await isolate(an, FADE * 10);
await tick(2, 0.0);
check(has(await snap(), an), 'an anomaly never fades, however isolated');

// 5. a full world trims its most-isolated objects back under the ceiling
const start = (await snap()).objects.length;
await fill(MAX + 120 - start);         // push just over the cap
check((await snap()).objects.length > MAX, `world filled over the ceiling (> ${MAX})`);
const over = (await snap()).objects.length;
await tick(6, 0.0);                      // isolation builds; the ceiling trims the most-isolated
const after = (await snap()).objects.length;
// It comes back DOWN from the over-fill and stays bounded by the cap. (In Growing it
// then churns AT the cap — trim removes the most-forgotten as fresh seeds shed — so
// the invariant is "<= cap", not "strictly under": a packed world breathes, not grows.)
check(after <= MAX && after < over, `a full world trims back to the ceiling (${over} -> ${after} <= ${MAX})`);
check(has(await snap(), an), 'the ceiling spares anomalies while trimming');

// 6. write economy: the full-world snapshot must NOT run every tick (the DO
// rows_written quota killer) — only on the occasional time-gated checkpoint.
const burst = await tick(400, 0.0);
check(burst.checkpoints <= 1, `a 400-tick burst writes at most one full checkpoint (was ${burst.checkpoints}, not 400)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
