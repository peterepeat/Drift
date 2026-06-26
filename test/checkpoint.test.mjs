// Checkpoint write-economy (the rows_written quota — PRD §7.3 scaling).
// The ~30-min checkpoint must flush ONLY objects whose in-memory state diverged
// from disk since their last write (the dirty set), never the whole population —
// so the always-ticking world's write rate scales with CHANGE, not population.
// /admin/checkpoint forces a flush and reports how many objects it wrote (gated;
// inert in prod). A clean world writes nothing; after growth it writes the
// changed objects but not the static stones; a second flush writes nothing.
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = { 'x-admin-key': 'local-dev-key' };
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: KEY }).then((r) => r.json());
const tick = (n, s) => post(`/admin/tick?n=${n}&season=${s}`);
const checkpoint = () => post('/admin/checkpoint');
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }

const w0 = await snap();
const stoneCount = w0.objects.filter((o) => o.family === 'stone').length;
check(stoneCount > 0, `world has static stones to exclude from the checkpoint (${stoneCount})`);

// 1. a freshly-loaded world is byte-current on disk — a checkpoint writes nothing
const c0 = await checkpoint();
check(c0.wrote === 0, `a clean world's checkpoint writes nothing (wrote ${c0.wrote})`);

// 2. after growth, the checkpoint flushes the changed objects — but NOT the whole
//    population (the static stones stay clean and are skipped)
await tick(8, 0.0); // Growing — seeds grow every tick (sub-threshold ⇒ dirty, no discrete write)
const c1 = await checkpoint();
check(c1.wrote > 0, `growth dirties objects that the checkpoint flushes (wrote ${c1.wrote})`);
check(c1.wrote === c1.dirtyBefore, `the checkpoint flushes EXACTLY the dirty set (wrote ${c1.wrote} === dirty ${c1.dirtyBefore})`);
check(c1.wrote < c1.total, `the checkpoint writes a SUBSET, not the whole world (${c1.wrote} < ${c1.total})`);
check(c1.wrote <= c1.total - stoneCount, `static stones are excluded from the flush (${c1.wrote} <= ${c1.total - stoneCount})`);

// 3. the flush cleared the dirty set — an immediate second checkpoint writes nothing
const c2 = await checkpoint();
check(c2.wrote === 0, `a second back-to-back checkpoint writes nothing (dirty set cleared; wrote ${c2.wrote})`);

// 4. even after another tick, the checkpoint stays a strict subset of the world
//    (write rate tracks change, never the whole population)
await tick(2, 0.0);
const c3 = await checkpoint();
check(c3.wrote < c3.total, `the checkpoint never rewrites the whole world (${c3.wrote} < ${c3.total})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
