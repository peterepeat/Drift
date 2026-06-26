// Viewport culling predicate (pure — no worker needed).
import { inViewport, CULL_MARGIN } from '../public/cull.js';
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const VW = 800, VH = 600;

check(inViewport(400, 300, VW, VH), 'a point at screen centre is in view');
check(inViewport(0, 0, VW, VH), 'a point at the top-left corner is in view');
check(inViewport(VW, VH, VW, VH), 'a point at the bottom-right corner is in view');
check(inViewport(-CULL_MARGIN + 1, 300, VW, VH), 'a point just inside the left margin is kept');
check(inViewport(VW + CULL_MARGIN - 1, 300, VW, VH), 'a point just inside the right margin is kept');
check(!inViewport(-CULL_MARGIN - 1, 300, VW, VH), 'a point past the left margin is culled');
check(!inViewport(VW + CULL_MARGIN + 1, 300, VW, VH), 'a point past the right margin is culled');
check(!inViewport(400, VH + CULL_MARGIN + 1, VW, VH), 'a point below the bottom margin is culled');
check(!inViewport(400, -CULL_MARGIN - 1, VW, VH), 'a point above the top margin is culled');
check(inViewport(400, 300, VW, VH, 0) && !inViewport(-1, 300, VW, VH, 0), 'a custom zero margin culls just outside the edge');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
