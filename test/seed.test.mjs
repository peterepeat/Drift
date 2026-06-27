// World generator + reseed-migration decision (pure — no worker, no DOM).
import { generateWorld, SEED_COUNT, SEED_VERSION, reseedAction } from '../server/seed.js';
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };

// ---- reseedAction: the version-gated one-time reseed decision (loop-risk lives here) ----
check(reseedAction(0, undefined) === 'seed-fresh', 'an empty world seeds fresh');
check(reseedAction(0, SEED_VERSION) === 'seed-fresh', 'an empty world seeds fresh even if a version lingers');
check(reseedAction(500, undefined) === 'reseed', 'a populated pre-version world reseeds once (the live-world migration)');
check(reseedAction(500, 1) === 'reseed', 'a populated old-version world reseeds once');
check(reseedAction(500, SEED_VERSION) === 'none', 'a current-version world does NOT reseed (never loops)');

// ---- generateWorld: deterministic, full, and spread into groves ----
const a = generateWorld(1_000_000), b = generateWorld(1_000_000);
check(a.length === SEED_COUNT, `generates SEED_COUNT objects (${a.length}/${SEED_COUNT})`);
check(JSON.stringify(a) === JSON.stringify(b), 'is deterministic (same seed → identical world)');
check(a.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y)), 'every object has finite coordinates');
const fam = {}; a.forEach((r) => { fam[r.family] = (fam[r.family] || 0) + 1; });
check(fam.seed > 0 && fam.stone > 0, `mixes seeds and stones (${fam.seed} seed / ${fam.stone} stone)`);

// spread: many occupied coarse cells (groves + clearings), not one central clump
const CELL = 300, occ = new Set();
a.forEach((r) => occ.add(Math.round(r.x / CELL) + ',' + Math.round(r.y / CELL)));
check(occ.size > 90, `objects spread across the world, not clustered (${occ.size} occupied 300u cells)`);
const maxR = Math.max(...a.map((r) => Math.hypot(r.x, r.y)));
check(maxR > 1500 && maxR < 6000, `spread is wide but bounded (furthest ${maxR.toFixed(0)} wu)`);
// relaxation: no two objects pile up on top of each other (kills the dense clump)
const CS = 80, grid = new Map();
a.forEach((r, i) => { const k = Math.round(r.x / CS) + ',' + Math.round(r.y / CS); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
let minD = Infinity;
for (let i = 0; i < a.length; i++) { const cx = Math.round(a[i].x / CS), cy = Math.round(a[i].y / CS);
  for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) { const arr = grid.get(gx + ',' + gy); if (!arr) continue;
    for (const j of arr) { if (j <= i) continue; const d = Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y); if (d < minD) minD = d; } } }
check(minD > 40, `no two objects pile up — min spacing ${minD.toFixed(1)}u (relaxation worked)`);

// the cog/origin still has life (a "heart" grove) so arrivals don't land in a void,
// and the interest box there is a strict subset — both relied on by interest.test
const central = a.filter((r) => Math.abs(r.x) <= 96 && Math.abs(r.y) <= 96).length;
check(central > 0 && central < SEED_COUNT, `the origin has a heart grove (${central} objects in the central box)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
