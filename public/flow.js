// =============================================================================
// DRIFT — shared water-flow constants.
// Imported by BOTH the server (world-do.js, reaching into public/ the same way
// it imports drift-procgen.js via seed.js) and the client (render.js), so the
// flow field the server drifts objects along and the streaks the client paints
// can never silently diverge. The flow DIRECTION at a point is
// makeNoise(FLOW_SEED) sampled at FLOW_SCALE; FLOW_REACH bounds the drifting /
// trace region to the pool neighbourhood.
// =============================================================================
export const FLOW_SEED = 0x77617472;  // 'watr' — the flow field's fixed seed
export const FLOW_SCALE = 0.012;      // noise sampling scale (matches drawWaterPatch idiom)
export const FLOW_REACH = 1.35;       // × POOL.r: the band that drifts and shows traces
