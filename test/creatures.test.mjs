// Creature wander (pure, deterministic — no worker, no DOM). The key property:
// every client computes the SAME position from (seed, kind, sharedClock), so a
// creature is in the same place for everyone without any per-frame sync.
import { wanderAt, creatureR, CREATURE_KINDS } from '../public/creatures.js';
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const REACH = { crawler: 26, flier: 58 }, BOB = { crawler: 0, flier: 4 };

// 1. deterministic: same inputs → identical point (this is what keeps clients agreeing)
for (const kind of CREATURE_KINDS) {
  const a = wanderAt(12345, kind, 7.5), b = wanderAt(12345, kind, 7.5);
  check(a.x === b.x && a.y === b.y, `${kind}: same (seed,t) gives an identical position`);
}

// 2. bounded near home across a long time span (never wanders off)
let okBound = true;
for (const kind of CREATURE_KINDS) {
  for (let t = 0; t < 600; t += 0.37) {
    const w = wanderAt(999, kind, t);
    if (Math.abs(w.x) > REACH[kind] + 1e-6 || Math.abs(w.y) > REACH[kind] + BOB[kind] + 1e-6) okBound = false;
  }
}
check(okBound, 'wander stays within ~reach of home for all time (bounded)');

// 3. smooth/continuous: a small time step makes a small move (no teleporting)
let okSmooth = true;
for (const kind of CREATURE_KINDS) {
  for (let t = 0; t < 60; t += 0.5) {
    const a = wanderAt(7, kind, t), b = wanderAt(7, kind, t + 0.02);
    if (Math.hypot(b.x - a.x, b.y - a.y) > 6) okSmooth = false;
  }
}
check(okSmooth, 'wander is continuous (a 20ms step moves only a little)');

// 4. it actually MOVES over time (not a static point)
const m0 = wanderAt(55, 'crawler', 0), m1 = wanderAt(55, 'crawler', 20);
check(Math.hypot(m1.x - m0.x, m1.y - m0.y) > 1, 'a creature actually wanders over time');

// 5. different seeds trace different paths (variety)
const distinct = new Set();
for (let s = 0; s < 16; s++) { const w = wanderAt(s * 2654435761 >>> 0, 'flier', 9.3); distinct.add(Math.round(w.x) + ':' + Math.round(w.y)); }
check(distinct.size >= 8, `distinct seeds wander differently (${distinct.size}/16 distinct)`);

// 6. radius is a sane, finite, seed-varied tap target
check(CREATURE_KINDS.every((k) => { const r = creatureR(42, k); return Number.isFinite(r) && r > 2 && r < 20; }), 'creatureR is finite and small');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
