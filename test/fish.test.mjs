// Fish (Family 6, Wave Q): a few swim in each pond, bounded to the water; and a
// ground bug dropped into a pond becomes fish food (consumed, with a splash).
//   - the tick ramps fish into every pond; each fish's home sits inside a pond
//   - a fish exposes family=fish + a wander anchor (the client computes its swim)
//   - picking up a crawler and dropping it in a pond consumes it (fish food)
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const tickN = (n, s) => fetch(`${base}/admin/tick?n=${n}&season=${s}`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
const spawnCrawler = (x, y) => fetch(`${base}/admin/creature?x=${x}&y=${y}&kind=crawler`, { method: 'POST', headers: { 'x-admin-key': 'local-dev-key' } }).then((r) => r.json());
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) {
    const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); }
  }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }
const fish = (w) => w.objects.filter((o) => o.family === 'fish');
const inAnyPond = (o, pools) => pools.some((p) => Math.hypot(o.x - p.x, o.y - p.y) <= p.r);

// 1. the world ramps fish into its ponds, each bounded to the water
const w0 = await snap();
check(Array.isArray(w0.pools) && w0.pools.length >= 1, `world carries ponds (${w0.pools?.length})`);
await tickN(8, 0); // a few growing ticks ramp fish in
const fs = fish(await snap());
check(fs.length > 0, `fish ramp into the ponds (${fs.length} fish)`);
check(fs.length > 0 && fs.every((o) => inAnyPond(o, w0.pools)), 'every fish home sits inside a pond');
check(fs.length > 0 && fs.every((o) => o.family === 'fish' && typeof o.wanderT0 === 'number'), 'a fish exposes family=fish and a wander anchor');

// 2. a crawler dropped into a pond becomes fish food (consumed; the pond is sustained/grows)
const pond = w0.pools[w0.pools.length - 1];                 // an outer pond
const cr = await spawnCrawler(Math.round(pond.x + pond.r + 40), Math.round(pond.y)); // on the bank, outside
const bugId = cr.creature.id;
const fishBefore = fish(await snap()).length;
const ws = await open(); await ws.world; const token = 'bug-tok';
ws.send(JSON.stringify({ t: 'pickup', id: bugId, token, ts: Date.now() }));
await wait(150);
ws.send(JSON.stringify({ t: 'place', id: bugId, token, x: pond.x, y: pond.y, ts: Date.now() })); // drop it dead-centre
await wait(220);
ws.close();
const wEnd = await snap();
check(!wEnd.objects.find((o) => o.id === bugId), 'a crawler dropped into a pond is consumed (fish food)');
check(fish(wEnd).length >= fishBefore, `the pond's fish are sustained or grow (${fishBefore} -> ${fish(wEnd).length})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
