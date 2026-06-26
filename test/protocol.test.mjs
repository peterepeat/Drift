// End-to-end check of the Drift realtime protocol against the live dev worker.
const PORT = process.env.PORT || 8787;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(name) {
  const ws = new WebSocket(URL);
  ws.name = name; ws.msgs = []; ws.pid = null;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'world_state') ws.pid = m.pid;
    ws.msgs.push(m);
  });
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
const lastOf = (ws, t, id) => [...ws.msgs].reverse().find((m) => m.t === t && (id ? m.id === id : true));
const since = (ws, t, id) => ws.msgs.filter((m) => m.t === t && (id ? m.id === id : true));
let pass = 0, fail = 0;
const check = (cond, label) => { console.log((cond ? '  PASS ' : '  FAIL ') + label); cond ? pass++ : fail++; };

const A = await open('A');
const B = await open('B');
await wait(300);

const wsA = lastOf(A, 'world_state');
const wsB = lastOf(B, 'world_state');
check(wsA && wsA.objects.length > 50, `A world_state has the full seeded world (${wsA?.objects.length})`);
check(wsB && wsB.objects.length === wsA?.objects.length, `B sees the same full world as A (${wsB?.objects.length})`);
check(A.pid && B.pid && A.pid !== B.pid, 'A and B have distinct ephemeral pids');
check(wsA.objects.every((o) => typeof o.held === 'boolean' && o.token === undefined), 'world_state objects expose boolean held, never a token');

// ---- pickup propagates to the other client ----
const target = wsA.objects[0];
const tokenA = 'tokA-' + Math.random().toString(36).slice(2);
const t0 = Date.now();
A.send(JSON.stringify({ t: 'pickup', id: target.id, token: tokenA, ts: Date.now() }));
await wait(150);
const ackA = lastOf(A, 'pickup_ack', target.id);
const heldOnB = lastOf(B, 'object_state', target.id);
check(ackA && ackA.ok === true, 'A receives pickup_ack ok:true');
check(heldOnB && heldOnB.held === true, `B sees object lifted (held:true) — ${Date.now() - t0}ms`);
check(heldOnB && heldOnB.token === undefined && heldOnB.heldConn === undefined, 'broadcast carries no identity (no token/heldConn)');

// ---- carry streams position ----
A.send(JSON.stringify({ t: 'carry', id: target.id, token: tokenA, x: 123.5, y: -77.25, ts: Date.now() }));
await wait(120);
const carriedB = lastOf(B, 'object_state', target.id);
check(carriedB && carriedB.x === 123.5 && carriedB.y === -77.25 && carriedB.held === true, 'B sees carried object glide to new position, still held');

// ---- conflict: B tries to grab the same held object ----
B.send(JSON.stringify({ t: 'pickup', id: target.id, token: 'tokB', ts: Date.now() }));
await wait(120);
const ackB = lastOf(B, 'pickup_ack', target.id);
check(ackB && ackB.ok === false, 'B loses the race for an already-held object (ack ok:false)');

// ---- place ----
A.send(JSON.stringify({ t: 'place', id: target.id, token: tokenA, x: 200, y: 200, ts: Date.now() }));
await wait(150);
const placedB = lastOf(B, 'object_state', target.id);
check(placedB && placedB.held === false && placedB.x === 200 && placedB.y === 200, 'B sees object placed (held:false) at new position');
check(placedB && placedB.handling === (target.handling + 1), `handling incremented on place (${placedB?.handling})`);

// ---- presence (ephemeral pid, no identity) ----
A.send(JSON.stringify({ t: 'presence_move', x: 10, y: 20, ts: Date.now() }));
await wait(120);
const presB = lastOf(B, 'presence');
check(presB && presB.x === 10 && presB.y === 20, 'B receives presence warmth position');
check(presB && presB.pid === A.pid && presB.token === undefined, 'presence carries the ephemeral pid, never the token');
check(since(A, 'presence').length === 0, 'sender does NOT receive its own presence');

// ---- disconnect-reclaim: held object drops when holder vanishes ----
const target2 = wsA.objects[5];
A.send(JSON.stringify({ t: 'pickup', id: target2.id, token: tokenA, ts: Date.now() }));
await wait(120);
check(lastOf(B, 'object_state', target2.id)?.held === true, 'B sees second object picked up by A');
A.close();
await wait(300);
const reclaimed = lastOf(B, 'object_state', target2.id);
check(reclaimed && reclaimed.held === false, 'on A disconnect, B sees the held object DROP (held:false)');
const goneA = lastOf(B, 'presence_gone');
check(goneA && goneA.pid === A.pid, 'B receives presence_gone for the departed pid');

B.close();
await wait(100);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
