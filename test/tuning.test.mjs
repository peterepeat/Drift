// Operator tuning panel: the /admin/tuning catalogue + live, persisted overrides.
//   - GET is keyless and lists EVERY knob (live + catalogued-read-only)
//   - a live knob can be set (gated), is reflected, and resets to its default
//   - a non-live / unknown knob is rejected
//   - a live override actually reaches the running simulation (BEFRIEND_MS)
const PORT = process.env.PORT || 8787;
const base = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const key = { 'x-admin-key': 'local-dev-key' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const getTune = () => fetch(`${base}/admin/tuning`).then((r) => r.json());
const knob = (t, k) => t.knobs.find((o) => o.key === k);
const setTune = (k, v, hdr = key) => fetch(`${base}/admin/tuning?key=${k}&value=${v}`, { method: 'POST', headers: hdr });
const resetTune = (k) => fetch(`${base}/admin/tuning/reset${k ? '?key=' + k : ''}`, { method: 'POST', headers: key });
function open() {
  const ws = new WebSocket(WS);
  ws.world = new Promise((res) => ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.t === 'world_state') { ws.removeEventListener('message', h); res(m); } }));
  return new Promise((res) => ws.addEventListener('open', () => res(ws)));
}
async function snap() { const ws = await open(); const w = await ws.world; ws.close(); return w; }

// 1. GET is keyless; the catalogue lists every knob, with live + read-only ones distinguished
const t0 = await getTune();
check(Array.isArray(t0.knobs) && t0.knobs.length > 100, `tuning catalogue lists every knob (${t0.knobs ? t0.knobs.length : 0})`);
const cap = knob(t0, 'STONE_CAP_R');
check(cap && cap.live === true && cap.value === '350', `a live knob reports its running value (STONE_CAP_R=${cap && cap.value}, live=${cap && cap.live})`);
const internal = knob(t0, 'GRID_CELL');
check(internal && internal.live === false, `a deep internal is catalogued read-only (GRID_CELL live=${internal && internal.live})`);

// 2. setting requires the admin key
const noKey = await setTune('STONE_CAP_R', 200, {});
check(noKey.status === 403, `setting a knob without the key is forbidden (${noKey.status})`);

// 3. set → reflected → reset to default
const r2 = await (await setTune('STONE_CAP_R', 200)).json();
check(r2.ok && r2.value === '200', `set STONE_CAP_R → 200 (${r2.value})`);
check(knob(await getTune(), 'STONE_CAP_R').value === '200', 'the change shows in the catalogue (overridden)');
const r3 = await (await resetTune('STONE_CAP_R')).json();
check(r3.ok && r3.value === '350', `reset STONE_CAP_R → default 350 (${r3.value})`);

// 4. a catalogued-but-not-live knob (and an unknown one) is rejected
const bad = await (await setTune('GRID_CELL', 100)).json();
check(bad.ok === false, `a non-live knob can't be set live (${bad.error})`);

// 5. a live override actually reaches behaviour: shorten the befriend bond from ~6min, then befriend
await setTune('BEFRIEND_MS', 90000);
const sp = await fetch(`${base}/admin/creature?x=40000&y=40000`, { method: 'POST', headers: key }).then((r) => r.json());
const ws = await open(); await ws.world;
ws.send(JSON.stringify({ t: 'befriend', id: sp.creature.id, token: 'tune-tok', ts: Date.now() }));
await wait(150);
const c = (await snap()).objects.find((o) => o.id === sp.creature.id);
const bondMs = c ? c.tameUntil - Date.now() : 0;
check(c && bondMs > 60000 && bondMs < 130000, `the BEFRIEND_MS override reaches the simulation (bond ~${Math.round(bondMs / 1000)}s, not 360s)`);
ws.close();

// 6. reset ALL clears every override
await setTune('GROW_BASE', 0.01);
const ra = await (await resetTune()).json();
check(ra.ok && ra.key === 'all', 'reset-all succeeds');
check(knob(await getTune(), 'GROW_BASE').overridden === false, 'after reset-all, no knob is overridden');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
