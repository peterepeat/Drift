// =============================================================================
// DRIFT — shared wire protocol (runtime-agnostic)
// -----------------------------------------------------------------------------
// The ONE source of truth for the realtime message surface between the Durable
// Object and the browser client: the message-type names, and the field whitelist
// that an object projection is allowed to carry onto the wire. Pure data + pure
// helpers, no deps — Node-importable, so the server imports UP into it, the
// client loads it as a static ES module, and the tests assert against it (the
// flow.js / geometry.js zero-build cross-runtime pattern).
//
// It exists to make invariant #3 — FORM-FROM-SEED / NO IDENTITY — a single named
// contract instead of a build-by-listing convention re-derived in two #pub-style
// methods and a hand-copied FORBIDDEN array in the guard test. Form is always
// regenerated on the client from the integer `seed`; the wire never carries the
// rendered shape, the session token, or any server-internal bookkeeping.
// =============================================================================

// ---- message types -----------------------------------------------------------
// IN  = client → server (an INTENT; the server stays authoritative).
// OUT = server → client (authoritative state deltas + ephemeral presence).
export const IN = Object.freeze({
  PICKUP: 'pickup', CARRY: 'carry', PLACE: 'place',
  BREAK: 'break', DISSOLVE: 'dissolve', MARK: 'mark',
  GIANT_SKIP: 'giant_skip', BEFRIEND: 'befriend', PRESENCE_MOVE: 'presence_move',
});
export const OUT = Object.freeze({
  WORLD_STATE: 'world_state', WORLD_PATCH: 'world_patch',
  OBJECT_NEW: 'object_new', OBJECT_STATE: 'object_state', OBJECT_GONE: 'object_gone',
  PICKUP_ACK: 'pickup_ack', SEASON: 'season',
  PRESENCE: 'presence', PRESENCE_GONE: 'presence_gone',
});
export const MSG = Object.freeze({ ...IN, ...OUT });

// ---- object-projection whitelist (invariant #3) ------------------------------
// The ONLY keys an object projection may carry — #pub (world_state.objects /
// world_patch.objects / object_new.o) and #stateMsg (object_state). It is the
// UNION over both shapes and every family: a field is listed once and may be
// absent (most are per-family / per-state optional). Anything outside this set
// reaching the wire is a schema leak; `wireLeak()` flags it and the guard tests
// assert every projected object's keys are a subset of it.
export const WIRE_OBJECT_FIELDS = Object.freeze([
  // identity-free record + lifecycle scalars (form is regenerated from `seed`)
  'id', 'family', 'x', 'y', 'seed', 'handling', 'held', 'maturity', 'aged', 'created_at',
  // optional form / behaviour hints, present per family or per state
  'kind', 'kinds', 'wanderT0', 'glowUntil', 'glowHue', 'tameUntil', 'act', 'r',
  'heldBy',          // the carrier's EPHEMERAL per-connection pid (NEVER the token)
  // object_state envelope + transient one-shot cues the server stamps on a delta
  't', 'ts', 'roll', 'bounce',
]);
const WIRE_SET = new Set(WIRE_OBJECT_FIELDS);
export const isWireField = (k) => WIRE_SET.has(k);

// ---- forbidden raw record fields (must NEVER reach the wire) ------------------
// Server-internal bookkeeping that rides the in-memory / stored record: the
// session token, the raw holder connection, and the thermal/aging/decay
// accumulators. A projection carrying any of these is an invariant-#3 leak.
// `scrubForbidden()` deletes them defensively at the projection site (a no-op
// while #pub/#stateMsg build by listing — insurance against a future spread /
// Object.assign that would otherwise copy the whole record onto the wire).
export const FORBIDDEN_WIRE_FIELDS = Object.freeze([
  'token', 'heldConn', 'heat', 'last_touched', 'held_at', 'shedAccum', 'decay',
]);

// The first forbidden key on a projection, or null if clean (the contract the
// guard tests enforce, and the basis of scrubForbidden).
export const forbiddenLeak = (o) => {
  if (o) for (const k of FORBIDDEN_WIRE_FIELDS) if (k in o) return k;
  return null;
};
// First forbidden OR non-whitelisted key, or null — the full object-projection
// contract (no identity AND no schema drift). Giant projections use forbiddenLeak
// only (their own schema is broader than an object's).
export const wireLeak = (o) => {
  const f = forbiddenLeak(o);
  if (f) return f;
  if (o) for (const k in o) if (!WIRE_SET.has(k)) return k;
  return null;
};
// Defensively strip any forbidden field, in place; returns the same object so it
// can wrap a projection's return. Pure no-op on a correctly built projection.
export const scrubForbidden = (o) => {
  for (const k of FORBIDDEN_WIRE_FIELDS) if (k in o) delete o[k];
  return o;
};
