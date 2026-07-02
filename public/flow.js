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

// Stone CHANNELLING — a stone bends the local flow tangentially around itself (curves past, never
// into it), with a small radial-away term. Shared so the SERVER's object drift and the CLIENT's
// visible flow streaks use ONE formula — the channelling can't silently diverge between the two.
export const FLOW_STONE_R = 70;       // a stone deflects flow within this radius of its centre
export const FLOW_STONE_PUSH = 1.0;   // tangential deflection strength (the channelling)
export const FLOW_STONE_RADIAL = 0.35;// small radial-away term so flow never runs straight into a stone
// Bend a base flow vector (vx,vy) at (x,y) around each nearby flow-deflecting stone. Pure — the caller
// supplies the stone list (the server from its grid; the client from the visible footprints).
export function deflectFlow(x, y, vx, vy, stones) {
  for (const s of stones) {
    const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
    if (d > 0.001 && d < FLOW_STONE_R) {
      const f = 1 - d / FLOW_STONE_R, rx = dx / d, ry = dy / d;
      let tx = -ry, ty = rx;                                    // tangent ⟂ the radial, oriented to agree with the base flow
      if (tx * vx + ty * vy < 0) { tx = -tx; ty = -ty; }
      vx += (tx * FLOW_STONE_PUSH + rx * FLOW_STONE_RADIAL) * f;
      vy += (ty * FLOW_STONE_PUSH + ry * FLOW_STONE_RADIAL) * f;
    }
  }
  return { vx, vy };
}
