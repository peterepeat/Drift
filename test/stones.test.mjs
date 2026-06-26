// Stones (Family 1): stacking, toppling, and erosion-to-grit.
//   - drop a stone within another's footprint -> it balances on top
//   - a stack grown past STACK_MAX topples on the next tick (scatters)
//   - tapping a tall stack (a `scatter` message) topples it on demand
//   - a stone handled GRIT_HANDLING times wears to grit and dissolves
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const TOK = 'stone-tok';
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
check(pool.length >= 16, `world has ample stones to stack (${pool.length})`);

// 1. drop one stone onto another -> it balances on top (level 1)
const A = pool[0], B = pool[1];
const FAR = 6000;
await move(A, FAR, FAR);          // isolate the base
await move(B, FAR, FAR);          // drop B onto A
let b = byId(await snap(), B);
check(b.stack === 1 && b.stackBase === A, `a stone dropped onto another stacks (level ${b.stack}, base ${b.stackBase === A})`);
check(Math.abs(b.x - FAR) < 12 && b.y < FAR, 'the stacked stone snaps over its base and rises');

// 2. a stack grown past the max topples on the next tick (scatters)
for (let i = 2; i <= 6; i++) await move(pool[i], FAR, FAR); // base + 6 = height 7 (> STACK_MAX)
let tall = stones(await snap()).filter((o) => pool.slice(0, 7).includes(o.id));
check(Math.max(...tall.map((o) => o.stack)) >= 6, `the stack grows tall (top level ${Math.max(...tall.map((o) => o.stack))})`);
await tickG(1);
let after = stones(await snap()).filter((o) => pool.slice(0, 7).includes(o.id));
check(after.every((o) => o.stack === 0), 'a too-tall stack topples on the next tick (all stones scatter free)');

// 3. tapping a tall stack topples it on demand (the `scatter` gesture)
const G = 9000;
for (let i = 7; i <= 10; i++) await move(pool[i], G, G); // base + 4 = height 5 (>= STACK_TALL)
let s3 = stones(await snap()).filter((o) => pool.slice(7, 11).includes(o.id));
check(Math.max(...s3.map((o) => o.stack)) >= 3, 'a stack of stones builds at the second site');
const top = s3.reduce((a, o) => (o.stack > a.stack ? o : a));
ctl.send(JSON.stringify({ t: 'scatter', id: top.id, token: TOK, ts: Date.now() }));
await wait(120);
let s3b = stones(await snap()).filter((o) => pool.slice(7, 11).includes(o.id));
check(s3b.every((o) => o.stack === 0), 'tapping a tall stack scatters it');

// 4. a much-handled stone wears to grit and dissolves
const X = pool[12], H = -7000;
for (let i = 0; i < 26; i++) await move(X, H, H); // GRIT_HANDLING = 26 places
check(!byId(await snap(), X), 'a stone handled to the bone wears to grit and is gone');

ctl.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
