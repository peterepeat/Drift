// =============================================================================
// DRIFT — viewport culling predicate (pure, shared with a unit test).
// The render loop touches every object each frame to build/sort/draw the world.
// As the population grows toward the ceiling that O(N) overdraw is the dominant
// client cost, so we skip objects whose screen position is outside the viewport
// by more than CULL_MARGIN (which leaves room for an object's body and shadow to
// stay visible when its centre is just off-screen).
// =============================================================================
export const CULL_MARGIN = 160; // CSS px of slack beyond the viewport edges
export function inViewport(sx, sy, vw, vh, m = CULL_MARGIN) {
  return sx >= -m && sx <= vw + m && sy >= -m && sy <= vh + m;
}
