// Thermal (PRD §4.1): an invisible spatial heat field that decays over time,
// bends the water flow toward cooler areas, and slowly forms stones where heat
// is sustained. Heat is never transmitted (it is invisible).
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const heat = (x, y) => post(`/admin/heat?x=${x}&y=${y}`);
const setHeat = (x, y, v) => post(`/admin/heat?x=${x}&y=${y}&set=${v}`);
const flow = (x, y) => post(`/admin/flow?x=${x}&y=${y}`);
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const stones = (w) => w.objects.filter((o) => o.family === 'stone');

// 1. heat is invisible — never in world_state — and a fresh field reads ~0
const w0 = await snap();
check(w0.heat === undefined, 'heat is never transmitted (invisible — not in world_state)');
check((await heat(0, 0)).heat === 0, 'a fresh area has no heat');

// 2. heat is local: warming one spot leaves distant areas cold
await setHeat(500, 500, 1.0);
check((await heat(500, 500)).heat > 0.9, 'warming a spot raises its heat');
check((await heat(-500, -500)).heat === 0, 'heat stays local (a distant spot is unaffected)');

// 3. heat decays over time with nobody present (season-modulated)
await setHeat(500, 500, 1.0);
const before = (await heat(500, 500)).heat;
await tick(12, 0.0); // Growing — heat lingers but still bleeds away with no presence
const after = (await heat(500, 500)).heat;
check(after < before && after > 0, `heat decays when left alone (${before.toFixed(2)} -> ${after.toFixed(2)})`);

// 4. the heat gradient bends the water flow toward cooler areas (PRD §4.2)
await tick(1, 0.0); // Growing -> nonzero flow magnitude
const cold = await flow(100, 0);                 // baseline: no nearby heat
await setHeat(300, 0, 1.0);                       // a hot blob to the +x side of the probe
const warm = await flow(100, 0);
check(warm.vx < cold.vx - 1e-6, `flow bends away from heat / toward cooler (Δvx=${(warm.vx - cold.vx).toFixed(3)})`);

// 5. sustained warmth slowly forms a stone (the maker is long gone — §4.1)
const HX = 700, HY = -700;
const before5 = new Set(stones(await snap()).map((s) => s.id));
await setHeat(HX, HY, 1.0);
await tick(100, 0.0); // > STONE_FORM_TICKS(90); heat stays above the threshold ~104 ticks (decay 0.99)
const w5 = await snap();
const fresh = stones(w5).filter((s) => !before5.has(s.id));
const nearHot = fresh.find((s) => Math.hypot(s.x - HX, s.y - HY) < 200);
check(stones(w5).length > before5.size, `a new stone formed in the warm area (${before5.size} -> ${stones(w5).length})`);
check(!!nearHot, 'the formed stone materialised where the heat was sustained');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
