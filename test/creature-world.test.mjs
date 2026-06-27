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
const MIN = 24, MAX = 48;

// 1. fresh world is uninhabited; one tick ramps to the baseline
const w0 = await snap();
check(creatures(w0).length === 0, 'a fresh world has no creatures');
check(w0.now && typeof w0.now === 'number', 'world_state carries a server clock (now) for the shared wander');
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

// 5. a creature does not drift on the water (home is fixed until placed)
const dr = await spawn(null, 0, 0); // pool centre, where free objects would drift most
await tickG(40);
const d = creatures(await snap()).find((o) => o.id === dr.creature.id);
check(d && d.x === 0 && d.y === 0, 'a creature does not drift (it moves itself, client-side)');

// 6. a creature never fades, even long-untouched (a stone would crumble by ~1440 ticks)
const pc = await spawn(null, 800, 800);
await isolate(pc.creature.id, 3000);
await tickG(5);
check(!!creatures(await snap()).find((o) => o.id === pc.creature.id), 'a creature never fades, however long it is left');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
