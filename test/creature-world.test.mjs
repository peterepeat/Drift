// Creatures on the server: they spawn and ramp to a baseline, stay under a cap,
// are pickable/placeable (home moves), and are spared from drift and fade.
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const key = { 'x-admin-key': 'local-dev-key' };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: key }).then((r) => r.json());
const spawn = (kind, x, y) => {
  const q = [];
  if (kind) q.push('kind=' + kind);
  if (x != null) q.push('x=' + x, 'y=' + y);
  return fetch(`${base}/admin/creature${q.length ? '?' + q.join('&') : ''}`, { method: 'POST', headers: key }).then((r) => r.json());
};
const isolate = (id, n) => fetch(`${base}/admin/isolate?id=${id}&n=${n}`, { method: 'POST', headers: key }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const creatures = (w) => w.objects.filter((o) => o.family === 'creature');
const MIN = 50, MAX = 120;

// 1. fresh world is uninhabited; one tick ramps to the baseline
const w0 = await snap();
check(creatures(w0).length === 0, 'a fresh world has no creatures');
check(w0.now && typeof w0.now === 'number', 'world_state carries a server clock (now) for the shared wander');
check(w0.bounds && Number.isFinite(w0.bounds.x) && Number.isFinite(w0.bounds.y) && w0.bounds.x >= 900, `world_state carries camera bounds (${w0.bounds ? w0.bounds.x.toFixed(0) : 'none'}u)`);
await tickG(1);
const n1 = creatures(await snap()).length;
check(n1 >= MIN, `one tick ramps creatures to the baseline (${n1} >= ${MIN})`);

// 2. they top up but stay under the cap
await tickG(250);
const n2 = creatures(await snap()).length;
check(n2 >= MIN && n2 <= MAX, `creatures stay between baseline and cap (${n2} in [${MIN},${MAX}])`);

// 3. a spawned creature carries family + kind + a home, and exposes its kind for rendering
const sp = await spawn('crawler', 120, -40);
const c = creatures(await snap()).find((o) => o.id === sp.creature.id);
check(c && c.family === 'creature' && c.kind === 'crawler', 'a creature exposes family=creature and its kind');
check(c.x === 120 && c.y === -40, 'a creature spawns with a home at the given point');
check(typeof c.wanderT0 === 'number' && c.wanderT0 > 0, 'a creature carries a wander anchor (wanderT0) for smooth placement');

// 4. pickable + placeable: its home moves to where it is set down, and the wander
// RE-ANCHORS (wanderT0 advances) so it continues from the drop point, not a snap.
const t0Before = c.wanderT0;
const ctl = await open(); await ctl.world;
ctl.send(JSON.stringify({ t: 'pickup', id: c.id, token: 'cre-tok', ts: Date.now() }));
await wait(150);
ctl.send(JSON.stringify({ t: 'carry', id: c.id, token: 'cre-tok', x: 300, y: 220, ts: Date.now() }));
await wait(80);
ctl.send(JSON.stringify({ t: 'place', id: c.id, token: 'cre-tok', x: 305, y: 225, ts: Date.now() }));
await wait(150);
const placed = creatures(await snap()).find((o) => o.id === c.id);
check(placed && placed.x === 305 && placed.y === 225, "a placed creature's home moves to where it was set down");
check(placed && placed.wanderT0 > t0Before, 'placing a creature re-anchors its wander (wanderT0 advances)');
ctl.close();

// 5. a creature does not WATER-drift, and with nothing in reach it stays put (its
// only motion is the client-side wander + server goal-seeking, never the flow).
const dr = await spawn(null, 8000, 8000); // far outside the seeded world (no plant/stone/pool in reach)
await tickG(40);
const d = creatures(await snap()).find((o) => o.id === dr.creature.id);
check(d && d.x === 8000 && d.y === 8000, 'a creature with nothing in reach stays put (no water-drift; it moves itself)');

// 6. a creature never fades, even long-untouched (a stone would crumble by ~1440 ticks)
const pc = await spawn(null, 800, 800);
await isolate(pc.creature.id, 3000);
await tickG(5);
check(!!creatures(await snap()).find((o) => o.id === pc.creature.id), 'a creature never fades, however long it is left');

// 7. goal-seeking drift (Wave G1): a creature isolated far out, with a single mature
// plant ~300u away, drifts its home TOWARD the plant over a drive cycle (the 'feed'
// ticks pull it in; nothing else is in range). The seeded world is within ±2600, so
// out here only the placed plant is an attractor.
const lifecycle = (id, mat) => fetch(`${base}/admin/lifecycle?id=${id}&maturity=${mat}`, { method: 'POST', headers: key }).then((r) => r.json());
const place = (id, x, y) => fetch(`${base}/admin/place?id=${id}&x=${x}&y=${y}`, { method: 'POST', headers: key }).then((r) => r.json());
const FARP = 5000;
const gc = await spawn('crawler', FARP, FARP);
const plant = (await snap()).objects.find((o) => o.family === 'seed');
await lifecycle(plant.id, 0.6);            // make it a mature plant (a feed target)
await place(plant.id, FARP + 300, FARP);   // 300u east of the creature
const g0 = creatures(await snap()).find((o) => o.id === gc.creature.id);
const dBefore = Math.hypot(FARP + 300 - g0.x, FARP - g0.y);
await tickG(26);                           // > one full drive cycle (4 drives × 5 ticks) so 'feed' ticks occur
const g1 = creatures(await snap()).find((o) => o.id === gc.creature.id);
const dAfter = Math.hypot(FARP + 300 - g1.x, FARP - g1.y);
check(dAfter < dBefore - 100, `a creature drifts toward a nearby plant to feed (${dBefore.toFixed(0)}u -> ${dAfter.toFixed(0)}u)`);

// 8. drink → the NEAREST pond, not the hardcoded central one (the "all bugs walk to the
// same place" bug). A creature far beyond the central pool's reach but beside an OUTER
// pond now has a drink target THERE; the old code only ever considered the central pool,
// so out here it gave no target and the creature sat still.
const POND3 = { x: 520, y: 1180, r: 230 };               // an outer pond (POOLS[3]); ~2076u from centre
const rimDist = (c) => Math.hypot(c.x - POND3.x, c.y - POND3.y) - POND3.r;
const dc = await spawn('crawler', POND3.x, POND3.y + POND3.r + 600); // 600u outside its rim, out of the old central-pool reach
const dk0 = creatures(await snap()).find((o) => o.id === dc.creature.id);
const drinkBefore = rimDist(dk0);
await tickG(26);                                          // a full drive cycle → its 'drink' ticks fire
const dk1 = creatures(await snap()).find((o) => o.id === dc.creature.id);
const drinkAfter = rimDist(dk1);
check(drinkAfter < drinkBefore - 100, `a creature drinks at its NEAREST pond, not the distant central one (${drinkBefore.toFixed(0)}u -> ${drinkAfter.toFixed(0)}u from the outer pond)`);

// 9. ANTI-CROWD: a tight pile of creatures spreads into a scatter (no dense blob). Far
// out (-9000) so the only creatures here are ours; same-species so no clashes scatter them.
const PILE = { x: -9000, y: -9000 }, NPILE = 16, pileIds = [];
for (let i = 0; i < NPILE; i++) { const r = await spawn('crawler', PILE.x + (i % 4) * 6, PILE.y + Math.floor(i / 4) * 6); pileIds.push(r.creature.id); }
const minSpacing = (w) => {
  const cs = creatures(w).filter((o) => pileIds.includes(o.id));
  let m = Infinity;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const dd = Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y); if (dd < m) m = dd; }
  return { m, n: cs.length };
};
const pre = minSpacing(await snap());
await tickG(30);
const post = minSpacing(await snap());
check(post.n >= 2 && post.m > pre.m && post.m > 25, `a pile of ${NPILE} creatures spreads out (closest pair ${pre.m.toFixed(0)}u -> ${post.m.toFixed(0)}u)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
