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
