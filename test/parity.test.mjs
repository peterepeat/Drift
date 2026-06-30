// Cross-runtime PARITY (unit; no worker boot).
// The shared-core modules under public/shared/ are the SINGLE source of the
// constants/formulae that used to be duplicated — with "MUST match the other"
// comments — across the server, the client, and the tests. This suite imports the
// shared modules and asserts the contracts hold, converting those comments into
// enforced invariants: a one-sided change now fails CI instead of silently
// desyncing what the world treats as water from what the client paints.
import { POND_ASPECT, inPond, poolContaining, bankPoint, POND_BANK_PAD } from '../public/shared/geometry.js';
import { POND_ASPECT as RENDER_POND_ASPECT } from '../public/render.js';

let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };

// ---- pond geometry is one source, shared by server + client + tests ----
check(POND_ASPECT === 0.7, 'POND_ASPECT is 0.7 (the value the world + tests rely on)');
check(RENDER_POND_ASPECT === POND_ASPECT, 'render.js re-exports the shared POND_ASPECT (no client↔server divergence possible)');

const pool = { x: 0, y: 0, r: 100 };
check(inPond(pool, 0, 0), 'centre is in the pond');
check(inPond(pool, 99, 0), 'a point just inside the horizontal rim is in the pond');
check(!inPond(pool, 0, 80), 'a point at 0.8r vertically is OUTSIDE — the ellipse is squashed to 0.7r, not a phantom circle');
check(inPond(pool, 0, 69), 'a point at 0.69r vertically IS in the squashed ellipse');
check(poolContaining([{ x: 500, y: 0, r: 50 }, pool], 0, 0) === pool, 'poolContaining finds the containing pond among several');
check(poolContaining([pool], 1000, 1000) === null, 'poolContaining returns null outside every pond');

// bankPoint eases a body just past the elliptical rim along the ray centre→point
const be = bankPoint(pool, 200, 0);   // due east: rim at x=100, pushed past by POND_BANK_PAD(16)
check(Math.abs(be.x - (100 + POND_BANK_PAD)) < 1e-6 && Math.abs(be.y) < 1e-6, `bankPoint eases past the horizontal rim (${be.x.toFixed(1)}, ${be.y.toFixed(1)})`);
const bs = bankPoint(pool, 0, 200);   // due south: vertical rim at y=70 (0.7r), pushed past by 16
check(Math.abs(bs.x) < 1e-6 && Math.abs(bs.y - (70 + POND_BANK_PAD)) < 1e-6, `bankPoint respects the squashed vertical rim (${bs.x.toFixed(1)}, ${bs.y.toFixed(1)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
