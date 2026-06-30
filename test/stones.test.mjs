// Stones (Family 1): fusing, breaking, settle-clear, and erosion-to-grit.
//   - drop a stone onto another -> they FUSE into one larger stone
//   - double-click (`break`) a fused stone -> it splits into smaller stones
//   - a stone dropped overlapping (off-centre) settles clear, never through
//   - a stone handled GRIT_HANDLING times wears to grit and dissolves
import { stoneRadius } from '../public/shared/sizing.js';
import { inPond } from '../public/shared/geometry.js';
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const TOK = 'stone-tok';
const stoneR = stoneRadius; // shared stone footprint (server + client + this test)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickG = (n) => fetch(`${base}/admin/tick?n=${n}&season=0.0`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const stones = (w) => w.objects.filter((o) => o.family === 'stone');

const ctl = await open(); await ctl.world;
async function move(id, x, y) { // pick up then drop at (x, y) — the unit of interaction
  ctl.send(JSON.stringify({ t: 'pickup', id, token: TOK, ts: Date.now() }));
  await wait(60);
  ctl.send(JSON.stringify({ t: 'place', id, token: TOK, x, y, ts: Date.now() }));
  await wait(60);
}
const byId = (w, id) => stones(w).find((o) => o.id === id);

// a pool of distinct free stones to work with
const pool = stones(await snap()).filter((o) => !o.held).map((o) => o.id);
check(pool.length >= 16, `world has ample stones to work with (${pool.length})`);
const radOf = (o) => (o && o.r != null ? o.r : stoneR(o.seed)); // effective radius (stored `r` once fused/split)

// 1. drop one stone onto another -> they FUSE into one larger stone
const A = pool[0], B = pool[1];
const FAR = 6000;
const rA0 = radOf(byId(await snap(), A));
await move(A, FAR, FAR);          // isolate the target
await move(B, FAR, FAR);          // drop B onto A → fuse
const wf = await snap();
const a = byId(wf, A), bGone = !byId(wf, B);
check(bGone, 'the dropped stone is consumed by the fuse (one stone, not a pile)');
check(a && a.r != null && a.r > rA0, `the target grew into a larger stone (r ${a && a.r ? a.r.toFixed(0) : '?'} > base ${rA0.toFixed(0)})`);

// 1b. a stone dropped OVERLAPPING another (but off-centre, so it won't fuse) settles
// CLEAR — adjacent and touching — instead of passing straight through it.
const P = pool[13], Q = pool[14], SITE = 3000;
const w1b = await snap();
const rP = stoneR(byId(w1b, P).seed), rQ = stoneR(byId(w1b, Q).seed);
await move(P, SITE, SITE);                               // isolate the base stone
await move(Q, SITE + (rP + rQ - 10), SITE);             // drop Q overlapping P by ~10 (centre outside P's footprint)
const w1c = await snap();
const pp = byId(w1c, P), qq = byId(w1c, Q);
const gap = Math.hypot(qq.x - pp.x, qq.y - pp.y);
check(!!qq, 'an off-centre overlapping drop does not fuse (it just settles clear)');
check(gap >= rP + rQ - 1.5, `it settles clear of the other stone, not through it (gap ${gap.toFixed(1)} >= ${(rP + rQ).toFixed(1)})`);

// 2. BREAK: fuse a few stones into a big one, then break it -> smaller stones appear
const G = 9000;
const base2 = byId(await snap(), pool[2]);
await move(pool[2], G, G);
await move(pool[3], G, G); // fuse 3 into 2
await move(pool[4], G, G); // fuse 4 in too -> pool[2] is now sizeable
const bigBefore = byId(await snap(), pool[2]);
check(bigBefore && bigBefore.r != null && bigBefore.r > radOf(base2), `fusing three stones makes a sizeable one (r ${bigBefore && bigBefore.r ? bigBefore.r.toFixed(0) : '?'})`);
ctl.send(JSON.stringify({ t: 'break', id: pool[2], token: TOK, ts: Date.now() }));
await wait(150);
const w3 = await snap();
const broken = !byId(w3, pool[2]);
const pieces = stones(w3).filter((o) => Math.abs(o.x - G) < 120 && Math.abs(o.y - G) < 120);
check(broken, 'the broken stone is gone');
check(pieces.length >= 2, `it split into >= 2 smaller stones (${pieces.length})`);
check(pieces.every((o) => radOf(o) < bigBefore.r), 'the pieces are each smaller than the original');

// 4. a much-handled stone wears to grit and dissolves
const X = pool[12], H = -7000;
for (let i = 0; i < 26; i++) await move(X, H, H); // GRIT_HANDLING = 26 places
check(!byId(await snap(), X), 'a stone handled to the bone wears to grit and is gone');

// 5. SOLIDITY (Unit ⑥): a plant set down ON a rock settles BESIDE it, never through it
// — so a dropped thing reads as resting against a solid, not stacked like a flat card.
const PLANT_BASE_R = 9;                                  // mirrors the server const
const Rk = pool[8], SX = -12000, SY = 12000;            // a clear region, far from everything
await move(Rk, SX, SY);                                  // isolate a rock there
const rRk = radOf(byId(await snap(), Rk));
const seedId = (await snap()).objects.find((o) => o.family === 'seed' && !o.held)?.id;
check(!!seedId, 'a free plant exists to test plant-on-rock settling');
await move(seedId, SX, SY);                              // drop the plant dead-centre on the rock
const wS = await snap();
const sd = wS.objects.find((o) => o.id === seedId), rk2 = byId(wS, Rk);
const gapSR = Math.hypot(sd.x - rk2.x, sd.y - rk2.y);
check(gapSR >= rRk + PLANT_BASE_R - 1.5, `a plant dropped on a rock settles beside it, not through it (gap ${gapSR.toFixed(1)} >= ${(rRk + PLANT_BASE_R).toFixed(1)})`);

// 6. EQUILIBRIUM: hand-fusing builds a CHUNKY rock but CAPS — it never grows into an
// UNBOUNDED monolith. The cap is now generous (a deliberate big rock is allowed, ≈5 steps
// above the old 62); the giant breaks down only stones LARGER than the cap (see giant.test.mjs).
const STONE_CAP_R = 350;                                           // mirrors the server const
const key2 = { 'x-admin-key': 'local-dev-key' };
const BIG = pool[20], SPOT = { x: 14000, y: -14000 };
await move(BIG, SPOT.x, SPOT.y);
for (let i = 21; i <= 34; i++) await move(pool[i], SPOT.x, SPOT.y); // pile 14 more onto it
const bigR = radOf(byId(await snap(), BIG));
check(bigR > 62, `hand-fusing grows a rock well past the OLD 62 ceiling (r ${bigR.toFixed(0)})`);
// Force it just under the new cap and fuse a full-size stone on → it holds AT the cap, not past:
await fetch(`${base}/admin/place?id=${BIG}&x=${SPOT.x}&y=${SPOT.y}&r=349`, { method: 'POST', headers: key2 });
await fetch(`${base}/admin/place?id=${pool[35]}&x=${SPOT.x + 4000}&y=${SPOT.y}&r=46`, { method: 'POST', headers: key2 });
await move(pool[35], SPOT.x, SPOT.y);                              // pile the full-size stone onto the near-cap rock
const wEdge = await snap();
const capped = radOf(byId(wEdge, BIG));
check(!byId(wEdge, pool[35]) && capped <= STONE_CAP_R + 0.5 && capped >= 349, `the rock holds AT the cap, never past it (r ${capped.toFixed(0)} ≈ ${STONE_CAP_R})`);

// 6b. BOUNCE: a stone dropped onto an ALREADY-CAPPED rock is NOT consumed into it (which
// would just delete it for nothing) — it bounces off and settles clear, still a whole stone.
const CAPPED = pool[15], BSPOT = { x: -22000, y: 22000 };
await fetch(`${base}/admin/place?id=${CAPPED}&x=${BSPOT.x}&y=${BSPOT.y}&r=350`, { method: 'POST', headers: key2 }); // a rock AT the cap
const dropper = pool[16];
await move(dropper, BSPOT.x, BSPOT.y);                              // drop it dead-centre on the capped rock
const w6b = await snap();
const dr2 = byId(w6b, dropper), cap2 = byId(w6b, CAPPED);
const bsep = dr2 ? Math.hypot(dr2.x - BSPOT.x, dr2.y - BSPOT.y) : 0;
check(!!dr2 && !!cap2 && (cap2.r || 0) <= 350.5, `dropping on a capped rock neither grows nor vanishes it (dropper kept=${!!dr2}, cap r ${cap2 ? (cap2.r || 0).toFixed(0) : '?'})`);
check(!!dr2 && bsep >= 350, `the dropped stone bounces off + settles clear of the capped rock (gap ${bsep.toFixed(0)} >= 350)`);

// 6c. ROCK WINS POSITION WARS: a non-stone object overlapping a stone is eased OUT each tick
// (the stone never moves). Drop a plant dead-centre on a rock, tick, and it's shouldered clear.
const PW = { x: 22000, y: 22000 }, rockW = pool[5];
await fetch(`${base}/admin/place?id=${rockW}&x=${PW.x}&y=${PW.y}&r=100`, { method: 'POST', headers: key2 }); // a r=100 rock
const seedW = (await snap()).objects.find((o) => o.family === 'seed' && !o.held);
await fetch(`${base}/admin/place?id=${seedW.id}&x=${PW.x}&y=${PW.y}`, { method: 'POST', headers: key2 }); // a plant dead-centre on it
await tickG(1);
const w6c = await snap();
const rk6c = byId(w6c, rockW), pl6c = w6c.objects.find((o) => o.id === seedW.id);
const sep6c = pl6c ? Math.hypot(pl6c.x - PW.x, pl6c.y - PW.y) : 0;
check(!!rk6c && rk6c.x === PW.x && rk6c.y === PW.y, `the rock holds its ground — it never yields position`);
check(!!pl6c && sep6c >= 100, `a plant overlapping a rock is shouldered clear each tick (gap ${sep6c.toFixed(0)} >= 100)`);

// 7. NO ROCKS IN WATER: a stone dropped in a pool rolls out — the world keeps no free
// stone sitting in any pool (place-time roll + the per-tick relocation pass).
const waterPool = (await snap()).pool;                             // central pool {x,y,r}
const ROCK = pool[6];
await move(ROCK, waterPool.x, waterPool.y);                        // drop it dead in the water
await tickG(1);                                                    // settle it on the bank
const w7 = await snap();
const poolsArr = w7.pools || [w7.pool];
const inWater = (o) => poolsArr.some((p) => inPond(p, o.x, o.y)); // shared elliptical-pond test (POND_ASPECT)
const drowned = stones(w7).filter((o) => !o.held && inWater(o));
check(drowned.length === 0, `no rocks sit in any pool after a drop + tick (${drowned.length} in water)`);
const r6 = byId(w7, ROCK);
check(!r6 || !inWater(r6), 'the rock dropped in the pool rolled out to the bank');

// 8. BREAK never deletes a rock: at the FLOOR size a double-click is a NO-OP — the stone
// stays (it used to crumble to nothing). The floor is now smaller (MIN_STONE_R 8), so a
// rock that used to BE the floor (r 16) now splits — proving the floor dropped.
// (a) a floor-size rock (r 8) is unbreakable — the double-click leaves it whole:
await fetch(`${base}/admin/place?id=${pool[7]}&x=-16000&y=16000&r=8`, { method: 'POST', headers: key2 });
const r8 = radOf(byId(await snap(), pool[7]));
ctl.send(JSON.stringify({ t: 'break', id: pool[7], token: TOK, ts: Date.now() })); await wait(150);
const after8 = byId(await snap(), pool[7]);
check(!!after8 && radOf(after8) === r8, `a floor-size rock (r 8) is no longer breakable — a double-click leaves it whole (r ${r8.toFixed(0)})`);
// (b) a rock at the OLD floor (r 16) now DOES break — the floor dropped from 16 to 8:
await fetch(`${base}/admin/place?id=${pool[10]}&x=19000&y=-19000&r=16`, { method: 'POST', headers: key2 });
const r16 = radOf(byId(await snap(), pool[10]));
ctl.send(JSON.stringify({ t: 'break', id: pool[10], token: TOK, ts: Date.now() })); await wait(150);
const after16 = byId(await snap(), pool[10]);
check(!after16 && r16 === 16, `a rock at the old floor (r 16) now splits into pieces — the floor dropped to 8 (was r ${r16.toFixed(0)})`);

ctl.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
