// public/state.js — the client's shared mutable state (the browser-side analogue of
// the server's "world facade"). As client.js decomposes into subsystem modules
// (net / view / localfx / draw / input, increment 4.14), each imports these shared
// references and mutates them IN PLACE. They are all objects / Maps / arrays that are
// NEVER re-assigned, so ES-module live bindings let every consumer keep writing
// `objects.set(…)` / `camera.x = …` unchanged (a re-assigned `let` can't be shared
// across modules — those SCALARS move onto a holder object as each subsystem lands).
//
// 4.14a moves the pure containers here (zero usage-site rename); later sub-increments
// add the scalars their subsystem needs.

// the render substrate — read by nearly everything (draw / cull / hit-test / transforms).
// `canvas`/`ctx` are const; `camera` is const + mutated in place (camera.x = …), never
// re-assigned, so consumers keep `camera.x/.y/.z` unchanged. z starts at Z0 (=1.0, the
// CSS-px-per-world-unit base — Z0 itself stays in client.js for the zoom clamps/gestures).
export const canvas = document.getElementById('c');
export const ctx = canvas.getContext('2d');
export const camera = { x: 0, y: 0, z: 1.0 };

export const objects = new Map();     // id -> { id, family, x, y, seed, handling, held(bool), _sg, … } — THE model
export const presences = new Map();   // pid -> { x, y, born, last, gone }
export const lifts = new Map();       // id -> lift animation state

// local, cosmetic FX buffers (drained by the render loop; pushed by net + localfx)
export const flashes = [];            // brief crystal-dissolution flashes { x, y, start }
export const ripples = [];            // brief water ripples — a bug dropped in a pond becomes fish food
export const feedRushes = [];         // a pond's fish swim over to eat a dropped bug { x, y, start, pond, eatT }
export const grits = [];              // brief stone-to-grit scatters { x, y, seed, r, start }
export const creatureEvts = [];       // brief birth-shimmer / death-puff cues { x, y, start, birth }
export const giantFootprints = [];    // fading prints the journeyer leaves as it walks { x, y, start }

// shared cross-module refs (input WRITES, localfx READS — by-reference so no circular
// import). flying: thrown objects gliding free of the pointer (input arms, localfx eases +
// client.js drains). swaying: rooted trees leaning under a drag (input adds, localfx springs
// back). mouseVelW: the cursor's smoothed world velocity (input samples, localfx nudges by it).
export const flying = new Map();      // id -> { vx, vy, x0, y0 } — a thrown object gliding on
export const swaying = new Set();     // ids of rooted trees currently leaning (updateSway settles them)
export const mouseVelW = { x: 0, y: 0 }; // cursor world-velocity (mutated in place by input)

// Re-assigned SCALARS live on this holder object: an imported `let` is read-only at the
// import site and re-assigning one across modules is a SyntaxError, so shared values that
// get RE-ASSIGNED (not just mutated) become S.<name> and every consumer reads/writes the
// property. (Container state above is exported by reference; only re-assigned scalars need S.)
// 4.14 adds scalars here as each subsystem is extracted; this batch = the world MODEL
// (server-authoritative; the net handlers write them, render/draw/view read them).
export const S = {
  seasonPhase: 0,     // monotonic season clock from the server (feels, never labelled)
  clockSkew: 0,       // (server now − local now), from world_state — aligns the wander clock across clients
  animT: 0,           // seconds, drives the only animated objects (anomalies)
  myPid: null,        // our ephemeral per-connection presence id
  worldBounds: null,  // {x,y} half-extents of the object field (from the server) — the camera clamps to it
  pool: null,         // the central water pool { x, y, r } (flow + audio anchor)
  pools: [],          // every pond the world carries (Wave P) — all rendered as water
  giants: [],         // the TWO gardener NPCs — server-authoritative; walked continuously client-side

  // local HOLD state — input + net WRITE it, draw (isLifted/drawHeldScreen) + localfx READ it
  heldId: null,       // id of the object this client is currently holding (or null)
  carry: null,        // the held object's live carried position { x, y } (null when not holding)
  heldSince: 0,       // performance.now() when the local hold began (drives anomaly dissolution)

  // per-frame RENDER scratch — the frame() cull pass WRITES these, draw.js READS them
  // (same frame, write-before-read). On S so client.js and draw.js share them by reference
  // (an imported `let` is read-only at the import site — the arrive-class hazard).
  frameStones: [],    // this frame's visible rock footprints {x,y,r} — creaturePos fences ground creatures around them (Unit ⑥)
  frameLodCut: 0,     // on-screen radius below which to LOD this frame (0 = LOD nothing); set by the detail budget

  // cursor + sway scalars that input RE-ASSIGNS and localfx READS (reassigned → on S, not by-ref)
  mouseWorld: { x: 0, y: 0 }, // the cursor's world position (input sets S.mouseWorld = worldPoint each hover)
  lastHoverT: 0,      // performance.now() of the last hover sample (gates the nudge/leaf cursor force)
  swayId: null,       // the rooted tree currently held under a drag-pan (input sets, updateSway reads)
};

