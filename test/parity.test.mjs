// Cross-runtime PARITY (unit; no worker boot).
// The shared-core modules under public/shared/ are the SINGLE source of the
// constants/formulae that used to be duplicated — with "MUST match the other"
// comments — across the server, the client, and the tests. This suite imports the
// shared modules and asserts the contracts hold, converting those comments into
// enforced invariants: a one-sided change now fails CI instead of silently
// desyncing what the world treats as water from what the client paints.
import { POND_ASPECT, inPond, poolContaining, bankPoint, POND_BANK_PAD } from '../public/shared/geometry.js';
import { POND_ASPECT as RENDER_POND_ASPECT } from '../public/render.js';
import { stoneRadius, anomalyRadius, crystalRadius, seedScale, plantRadius } from '../public/shared/sizing.js';
import { rng } from '../public/drift-procgen.js';
import { FORM, formOf, SPROUT_C, BIG_TREE_MAT, GIANT_R, stoneSize, anomalyR, crystalR, shownMat } from '../public/forms.js';
import { creatureR, fishR } from '../public/creatures.js';
import { MSG, IN, OUT, WIRE_OBJECT_FIELDS, FORBIDDEN_WIRE_FIELDS, isWireField, wireLeak, forbiddenLeak, scrubForbidden } from '../public/shared/protocol.js';
import { FAMILIES, FAMILY_NAMES, familyOf } from '../public/shared/families.js';

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

// ---- form-from-seed sizing is one source (server + client + generator + tests) ----
for (const s of [0, 1, 7, 12345, 0xdeadbeef, 4294967295]) {
  check(stoneRadius(s) === 12 + rng(s >>> 0)() * 34, `stoneRadius(${s}) matches the canonical 12 + rng*34 footprint`);
}
check(stoneRadius(123) >= 12 && stoneRadius(123) <= 46, 'stoneRadius is bounded to [12, 46]');
check(anomalyRadius(99, 1) >= 18 && anomalyRadius(99, 1) <= 32, 'anomalyRadius (single kind) reads ~18-32 wu');
check(anomalyRadius(99, 3) > anomalyRadius(99, 1), 'a fused anomaly (more kinds) is larger than a plain one');
check(crystalRadius(99) >= 6 && crystalRadius(99) <= 13, 'crystalRadius reads ~6-13 wu');
check(seedScale(42) >= 0.9 && seedScale(42) <= 1.8, 'seedScale is in [0.9, 1.8]');
check(stoneRadius(42) === stoneRadius(42) && seedScale(42) === seedScale(42), 'sizers are deterministic for a given seed');

// ---- wire protocol is one source, shared by server + client + tests ----
// PIN the actual wire strings to their literal values. The client (public/client.js)
// still hard-codes these literals on both send + handle, so a one-sided rename of a
// MSG value must FAIL here — an identity assert like MSG[k]===IN[k] would not (MSG is
// {...IN,...OUT}, so the two move together) and would silently pass a desync.
check(MSG.PICKUP === 'pickup' && MSG.CARRY === 'carry' && MSG.PLACE === 'place' && MSG.BREAK === 'break'
  && MSG.DISSOLVE === 'dissolve' && MSG.MARK === 'mark' && MSG.GIANT_SKIP === 'giant_skip'
  && MSG.BEFRIEND === 'befriend' && MSG.PRESENCE_MOVE === 'presence_move',
  'every inbound wire string is pinned to its literal value (the client sends these verbatim)');
check(MSG.WORLD_STATE === 'world_state' && MSG.WORLD_PATCH === 'world_patch' && MSG.OBJECT_NEW === 'object_new'
  && MSG.OBJECT_STATE === 'object_state' && MSG.OBJECT_GONE === 'object_gone' && MSG.PICKUP_ACK === 'pickup_ack'
  && MSG.SEASON === 'season' && MSG.PRESENCE === 'presence' && MSG.PRESENCE_GONE === 'presence_gone',
  'every outbound wire string is pinned to its literal value (the client handles these verbatim)');
check(Object.keys(MSG).length === Object.keys(IN).length + Object.keys(OUT).length && Object.keys(MSG).length === 18,
  `MSG is the union of IN(${Object.keys(IN).length}) + OUT(${Object.keys(OUT).length}) = 18 message types`);
check(new Set(Object.values(MSG)).size === Object.keys(MSG).length, 'no two message types share a wire value (no collision an integration suite could mask)');
check(Object.values(MSG).every((v) => typeof v === 'string'), 'every MSG value is a string the wire carries verbatim');
check(Object.isFrozen(MSG) && Object.isFrozen(WIRE_OBJECT_FIELDS) && Object.isFrozen(FORBIDDEN_WIRE_FIELDS), 'the protocol tables are frozen (single source, no mutation)');

// The whitelist and the forbidden list are DISJOINT — so scrubForbidden (a blocklist
// strip) can never remove a legitimate wire field. This is what makes the runtime
// scrub a guaranteed no-op on a correctly built projection.
check(FORBIDDEN_WIRE_FIELDS.every((k) => !isWireField(k)), 'no forbidden field is also whitelisted (blocklist ∩ whitelist = ∅)');
check(FORBIDDEN_WIRE_FIELDS.includes('token') && FORBIDDEN_WIRE_FIELDS.includes('heldConn'), 'the session token + raw holder connection are forbidden on the wire');
check(FORBIDDEN_WIRE_FIELDS.includes('last_eval') && FORBIDDEN_WIRE_FIELDS.includes('last_touched'), 'the per-object bookkeeping clocks (last_eval/last_touched) are forbidden on the wire');

// wireLeak / forbiddenLeak / scrubForbidden behaviour
const clean = { id: 1, family: 'stone', x: 0, y: 0, seed: 7, held: false, heldBy: '' };
check(wireLeak(clean) === null && forbiddenLeak(clean) === null, 'a clean projection passes both leak checks');
check(forbiddenLeak({ ...clean, token: 'secret' }) === 'token', 'forbiddenLeak catches a raw token');
check(forbiddenLeak({ ...clean, heat: 9 }) === 'heat', 'forbiddenLeak catches the thermal accumulator');
check(wireLeak({ ...clean, bogus: 1 }) === 'bogus', 'wireLeak catches a non-whitelisted (schema-drift) field');
check(forbiddenLeak({ ...clean, bogus: 1 }) === null, 'forbiddenLeak ignores a non-sensitive non-whitelisted field (that is schema, not identity)');
const dirty = { ...clean, token: 'secret', heldConn: 'c9', heat: 5, last_eval: 123, last_touched: 4 };
const scrubbed = scrubForbidden(dirty);
check(scrubbed === dirty && forbiddenLeak(scrubbed) === null, 'scrubForbidden strips every forbidden field in place');
check(scrubbed.id === 1 && scrubbed.seed === 7 && scrubbed.heldBy === '', 'scrubForbidden leaves the whitelisted fields untouched');
// The session token rides under `held` on a RAW record — a stray spread must NOT leak it.
// scrubForbidden coerces a string `held` to its boolean wire form (the real token defense,
// since `held` is whitelisted and the blocklist `token` entry never matches a record).
const heldSpread = scrubForbidden({ ...clean, held: 'idy-secret-token', heldConn: 'c1' });
check(heldSpread.held === true, 'scrubForbidden coerces a string `held` (where the raw token rides) to a boolean — the token never reaches the wire');
check(scrubForbidden({ ...clean, held: '' }).held === false, 'an empty `held` coerces to false (nobody is carrying it)');
check(wireLeak({ ...clean, last_eval: 1 }) === 'last_eval' && forbiddenLeak({ ...clean, last_eval: 1 }) === 'last_eval', 'last_eval is now caught by BOTH the whitelist and the blocklist paths');

// ---- FAMILIES registry: the per-family behaviour-flag contract ----
// Pin EVERY flag for EVERY family — this is the single source the server's tick
// passes branch on, so a wrong/flipped flag is a silent world-behaviour regression
// (the wrong objects drift / fade / get trimmed). The columns are INDEPENDENT; the
// reference table below is the behaviour contract, verified against the live code.
const FAM_EXPECTED = {
  //          drifts  driftsAfterSprout  fades  tended  trimmable  deflectsFlow  grows  decays  heals
  stone:    [ false,  false,             true,  false,  true,      true,         false, false,  false ],
  seed:     [ true,   true,              false, false,  true,      false,        true,  false,  false ],
  anomaly:  [ false,  false,             false, true,   false,     false,        false, false,  false ],
  crystal:  [ true,   false,             false, false,  true,      false,        false, true,   false ],
  creature: [ false,  false,             false, true,   false,     false,        false, false,  false ],
  fish:     [ false,  false,             false, true,   false,     false,        false, false,  false ],
  mark:     [ false,  false,             false, true,   false,     false,        false, false,  true  ],
};
const FAM_KEYS = ['drifts', 'driftsAfterSprout', 'fades', 'tended', 'trimmable', 'deflectsFlow', 'grows', 'decays', 'heals'];
check(FAMILY_NAMES.length === 7 && Object.keys(FAM_EXPECTED).every((f) => FAMILY_NAMES.includes(f)),
  `FAMILIES covers exactly the 7 object families (${FAMILY_NAMES.join(',')}) — giant is absent (it's not in this.objects)`);
let famOk = true, famWhy = '';
for (const [fam, row] of Object.entries(FAM_EXPECTED)) {
  FAM_KEYS.forEach((k, i) => { if (FAMILIES[fam][k] !== row[i]) { famOk = false; famWhy = `${fam}.${k}=${FAMILIES[fam][k]} (want ${row[i]})`; } });
}
check(famOk, `every family's behaviour flags match the contract (${famWhy || 'all match'})`);
// The overlaps are coincidental, not one predicate — guard the tempting collapses:
check(FAMILIES.stone.fades && FAMILIES.stone.trimmable && !FAMILIES.stone.drifts, 'stone fades AND is trimmable but does NOT drift (a wall) — fades/trimmable/drifts are not one flag');
check(['anomaly', 'creature', 'fish', 'mark'].every((f) => FAMILIES[f].tended && !FAMILIES[f].trimmable), 'the four "alive" families are isolation-exempt AND ceiling-protected');
check(['seed', 'crystal'].every((f) => FAMILIES[f].trimmable && !FAMILIES[f].tended), 'seed/crystal are trimmable AND participate in isolation (tended=false) — tended ≠ protected');
check(FAMILIES.seed.driftsAfterSprout && !FAMILIES.crystal.driftsAfterSprout, 'only seed gates drift behind the sprout threshold');
check(FAMILIES.seed.grows && FAMILIES.crystal.decays && FAMILIES.mark.heals, 'the lifecycle flags route to seed (grow) / crystal (decay) / mark (heal)');
check(FAMILY_NAMES.every((f) => [FAMILIES[f].grows, FAMILIES[f].decays, FAMILIES[f].heals].filter(Boolean).length <= 1), 'at most ONE lifecycle block runs per family (grows/decays/heals are mutually exclusive)');
check(['stone', 'anomaly', 'fish'].every((f) => !FAMILIES[f].grows && !FAMILIES[f].decays && !FAMILIES[f].heals), 'stone/anomaly/fish have no time-based lifecycle change');
check(Object.isFrozen(FAMILIES) && Object.values(FAMILIES).every((e) => Object.isFrozen(e)), 'the family table + every entry are frozen');
check(familyOf('stone') === FAMILIES.stone && familyOf('giant').drifts === false && familyOf('nonsense').tended === false,
  'familyOf returns the entry, and an unknown family gets the inert all-false default (never undefined → no tick crash)');

// ---- forms.js: the CLIENT render registry (render half of the keystone) ----
// First automated coverage of the client form layer (it was un-importable before).
// Pins the per-family render flags + the footprint dispatch against the old client
// branches, so a render-contract drift fails CI instead of only showing in-browser.
check(SPROUT_C === 0.14 && GIANT_R === 150 && BIG_TREE_MAT === 0.8, 'client form consts hold (SPROUT_C=0.14 mirrors the server SPROUT; GIANT_R=150; BIG_TREE_MAT=0.8)');
const FORM_EXPECTED = {
  //          castsShadow  alwaysFull  pickable
  stone:    [ true,        false,      true  ],
  seed:     [ true,        false,      true  ],
  anomaly:  [ false,       true,       true  ],
  crystal:  [ true,        false,      true  ],
  creature: [ true,        false,      true  ],
  fish:     [ false,       true,       false ],
  mark:     [ false,       false,      false ],
  giant:    [ false,       true,       false ],
};
let formOk = true, formWhy = '';
for (const [fam, [cs, af, pk]] of Object.entries(FORM_EXPECTED)) {
  const f = formOf(fam);
  if (f.castsShadow !== cs) { formOk = false; formWhy = `${fam}.castsShadow`; }
  if (f.alwaysFull !== af) { formOk = false; formWhy = `${fam}.alwaysFull`; }
  if (f.pickable !== pk) { formOk = false; formWhy = `${fam}.pickable`; }
}
check(formOk, `every drawable family's render flags match the old client branches (${formWhy || 'all match'})`);
check(['anomaly', 'fish', 'giant'].every((f) => formOf(f).alwaysFull) && ['stone', 'seed', 'crystal', 'creature', 'mark'].every((f) => !formOf(f).alwaysFull), 'only anomaly/fish/giant skip LOD + the detail budget (always full)');
check(!formOf('fish').pickable && !formOf('mark').pickable && ['stone', 'seed', 'anomaly', 'crystal', 'creature'].every((f) => formOf(f).pickable), 'fish + marks are not hit-tested; the object families are');
// sizeFn — form-from-seed footprints, identical to the old objRadius dispatch
check(formOf('stone').sizeFn({ seed: 1234 }) === stoneRadius(1234) && formOf('stone').sizeFn({ seed: 1, r: 42 }) === 42, 'stone footprint = stoneRadius(seed), or the stored r once fused/split');
check(formOf('crystal').sizeFn({ seed: 7 }) === crystalRadius(7), 'crystal footprint = crystalRadius(seed)');
check(formOf('anomaly').sizeFn({ seed: 7, kinds: ['a', 'b'] }) === anomalyRadius(7, 2) && formOf('anomaly').sizeFn({ seed: 7 }) === anomalyRadius(7, 1), 'anomaly footprint grows with the fused kind count');
check(formOf('giant').sizeFn({}) === GIANT_R * 0.5, 'giant footprint = GIANT_R / 2');
check(formOf('creature').sizeFn({ seed: 9, kind: 'flier' }) === creatureR(9, 'flier'), 'creature footprint = creatureR(seed, kind)');
check(formOf('fish').sizeFn({ seed: 9 }) === fishR(9), 'fish footprint = fishR(seed)');
check(formOf('seed').sizeFn({ seed: 5, maturity: 0.5 }) === plantRadius(0.5, 5, SPROUT_C), 'seed/plant footprint = plantRadius(shownMat, seed, SPROUT_C)');
check(formOf('seed').sizeFn({ seed: 5, _matShown: 0.9, maturity: 0.2 }) === plantRadius(0.9, 5, SPROUT_C), 'the footprint reads the TWEENED maturity (_matShown), not the raw value');
// movable — a rooted big tree can't be lifted
check(formOf('seed').movable({ maturity: 0.5 }) === true && formOf('seed').movable({ maturity: 0.85 }) === false, 'a seed is movable until it roots (maturity >= BIG_TREE_MAT)');
check(formOf('stone').movable({}) === true && formOf('giant').movable({}) === true, 'non-plant families are always movable');
check(shownMat({ maturity: 0.3 }) === 0.3 && shownMat({ _matShown: 0.7, maturity: 0.3 }) === 0.7, 'shownMat prefers the tweened value, falls back to the raw maturity');
check(Object.values(FORM).every((e) => Object.isFrozen(e)), 'every FORM entry is frozen (an immutable render contract)');
check(formOf('nonsense').castsShadow === true && formOf('nonsense').pickable === true && formOf('nonsense').alwaysFull === false, 'an unknown family gets the plant-like default (no crash, matches the old fall-through)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
