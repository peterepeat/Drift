// Stones (Family 1): fusing, breaking, settle-clear, and erosion-to-grit.
//   - drop a stone onto another -> they FUSE into one larger stone
//   - double-click (`break`) a fused stone -> it splits into smaller stones
//   - a stone dropped overlapping (off-centre) settles clear, never through
//   - a stone handled GRIT_HANDLING times wears to grit and dissolves
import { rng } from '../public/drift-procgen.js';
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const TOK = 'stone-tok';
const stoneR = (seed) => 12 + rng(seed >>> 0)() * 34; // MUST mirror the server's stoneRadius
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
// unbounded monolith. (The giant breaks down anything bigger; see giant.test.mjs.)
const STONE_CAP_R = 62;                                            // mirrors the server const
const BIG = pool[20], SPOT = { x: 14000, y: -14000 };
await move(BIG, SPOT.x, SPOT.y);
for (let i = 21; i <= 34; i++) await move(pool[i], SPOT.x, SPOT.y); // pile 14 more onto it
const bigR = radOf(byId(await snap(), BIG));
check(bigR > 46 && bigR <= STONE_CAP_R + 0.5, `a much-merged rock grows chunky but holds at the cap (r ${bigR.toFixed(0)} ≈ ${STONE_CAP_R})`);
await move(pool[35], SPOT.x, SPOT.y);                              // pile one more onto the capped rock
const wEdge = await snap();
check(!byId(wEdge, pool[35]) && radOf(byId(wEdge, BIG)) <= STONE_CAP_R + 0.5, `more stones still merge in, but the rock won't grow past the cap (r ${radOf(byId(wEdge, BIG)).toFixed(0)})`);

// 7. NO ROCKS IN WATER: a stone dropped in a pool rolls out — the world keeps no free
// stone sitting in any pool (place-time roll + the per-tick relocation pass).
const waterPool = (await snap()).pool;                             // central pool {x,y,r}
const ROCK = pool[6];
await move(ROCK, waterPool.x, waterPool.y);                        // drop it dead in the water
await tickG(1);                                                    // settle it on the bank
const w7 = await snap();
const poolsArr = w7.pools || [w7.pool];
const inWater = (o) => poolsArr.some((p) => Math.hypot(o.x - p.x, o.y - p.y) <= p.r);
const drowned = stones(w7).filter((o) => !o.held && inWater(o));
check(drowned.length === 0, `no rocks sit in any pool after a drop + tick (${drowned.length} in water)`);
const r6 = byId(w7, ROCK);
check(!r6 || !inWater(r6), 'the rock dropped in the pool rolled out to the bank');

ctl.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
