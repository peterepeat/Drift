// Pure motion helpers (no worker needed) — throw momentum + pointer nudge.
import { friction, flingStep, ema, nudge } from '../public/physics.js';
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ---- friction: retain^dt, frame-rate independent ----
check(near(friction(0.5, 1), 0.5), 'friction retains the per-second fraction over 1s');
check(near(friction(0.5, 0), 1), 'friction over zero time changes nothing');
check(near(friction(0.25, 0.5), 0.5), 'friction composes over time (0.25^0.5 = 0.5)');

// ---- flingStep: decays velocity and glides in its direction ----
const s = flingStep({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 0.5, 10);
check(near(s.vx, 50) && near(s.vy, 0), 'flingStep halves a 100u/s velocity over 1s at retain 0.5');
check(near(s.x, 50) && near(s.y, 0), 'flingStep advances position along the velocity');
check(s.stopped === false, 'a still-fast fling is not stopped');
check(flingStep({ x: 0, y: 0 }, { x: 5, y: 0 }, 1, 0.5, 10).stopped === true, 'a fling below the stop speed reports stopped');

// velocity composition is exact regardless of step size (frame-rate independence)
let v = { x: 80, y: 0 }, p = { x: 0, y: 0 };
for (let i = 0; i < 4; i++) { const r = flingStep(p, v, 0.25, 0.5, 0.001); p = { x: r.x, y: r.y }; v = { x: r.vx, y: r.vy }; }
const one = flingStep({ x: 0, y: 0 }, { x: 80, y: 0 }, 1, 0.5, 0.001);
check(near(v.x, one.vx, 1e-9), 'four 0.25s steps decay velocity the same as one 1s step');

// ---- ema ----
check(near(ema(0, 100, 0.5), 50), 'ema blends halfway with a=0.5');
check(near(ema(100, 0, 1), 0), 'ema with a=1 takes the sample');
check(near(ema(10, 20, 0), 10), 'ema with a=0 keeps the previous value');

// ---- nudge: a soft radial push from a moving point ----
check(nudge(0, 0, 100, 0, 50, 10, 1).vx === 0, 'an object beyond the radius is not nudged');
const n = nudge(0, 0, 10, 0, 50, 10, 1, 1);
check(n.vx > 0 && near(n.vy, 0), 'an object inside the radius is pushed away along the offset');
check(nudge(0, 0, 10, 0, 50, 0, 1).vx === 0, 'a stationary point nudges nothing (speed 0)');
const c0 = nudge(0, 0, 0, 0, 50, 10, 1);
check(Number.isFinite(c0.vx) && Number.isFinite(c0.vy) && (c0.vx !== 0 || c0.vy !== 0), 'a dead-centre hit stays finite and still moves');
check(nudge(0, 0, 10, 0, 50, 10, 1, 0).vx === 0, 'lightness 0 (a heavy thing) does not stir');
check(nudge(0, 0, 10, 0, 50, 10, 1, 1).vx > nudge(0, 0, 10, 0, 50, 10, 1, 0.3).vx, 'lighter things are nudged more than heavier ones');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
