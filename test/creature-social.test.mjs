// Creature social life (Wave G2): same-species creatures left together breed; a
// crawler and flier together clash (the loser routs or dies); and the population
// self-balances — a kind never goes extinct (the per-species floor refills it).
// Runs against a FRESH world so the population has headroom under MAX_CREATURES.
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const key = { 'x-admin-key': 'local-dev-key' };
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: key }).then((r) => r.json());
const spawn = (kind, x, y) => fetch(`${base}/admin/creature?kind=${kind}&x=${x}&y=${y}`, { method: 'POST', headers: key }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const creatures = (w) => w.objects.filter((o) => o.family === 'creature');
const near = (w, x, y, r) => creatures(w).filter((o) => Math.abs(o.x - x) < r && Math.abs(o.y - y) < r);

await tickG(1); // ramp to the baseline so there's headroom to MAX for breeding

// 1. MATING — three crawlers clustered far from anything breed offspring nearby
// (isolated, so the only creatures out here are theirs; offspring inherit the kind).
const MX = 6000, MY = 6000;
await spawn('crawler', MX, MY);
await spawn('crawler', MX + 40, MY);
await spawn('crawler', MX + 20, MY + 34);
const before = near(await snap(), MX, MY, 250).length;
await tickG(34);
const grown = near(await snap(), MX, MY, 320);
check(grown.length > before, `same-species creatures together breed offspring (${before} -> ${grown.length})`);
check(grown.every((o) => o.kind === 'crawler'), 'offspring inherit their parents\' species (all crawlers)');

// 2. CONFLICT — a crawler and a flier left together clash: the loser routs far away
// (home jumps) or dies, so they do not stay overlapping.
const FX = -7000, FY = -7000;
const cr = await spawn('crawler', FX, FY);
const fl = await spawn('flier', FX + 40, FY);
await tickG(34);
const w2 = await snap();
const crA = creatures(w2).find((o) => o.id === cr.creature.id);
const flA = creatures(w2).find((o) => o.id === fl.creature.id);
const oneGone = !crA || !flA;
const sep = crA && flA ? Math.hypot(crA.x - flA.x, crA.y - flA.y) : Infinity;
check(oneGone || sep > 100, `a cross-species clash routs or kills the loser (gone=${oneGone}, sep=${sep === Infinity ? 'n/a' : sep.toFixed(0)})`);

// 3. NO EXTINCTION — after all that churn both species persist at/above their floor.
const w3 = await snap();
const byKind = {};
for (const o of creatures(w3)) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
const cw = byKind.crawler || 0, fl3 = byKind.flier || 0;
// both above the floor (no extinction) AND below the ceiling (no single kind hogging
// the cap) — even after a breeding cluster that, unchecked, ran one kind to 70.
check(cw >= 6 && fl3 >= 6 && cw <= 76 && fl3 <= 76, `both species persist, neither dominates (crawler=${cw}, flier=${fl3})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
