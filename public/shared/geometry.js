// =============================================================================
// DRIFT — shared pond geometry (runtime-agnostic)
// -----------------------------------------------------------------------------
// Ponds are ELLIPSES — squashed vertically (a top-down look): rx = p.r,
// ry = p.r * POND_ASPECT. This module is the ONE source of that geometry, shared
// by the Durable Object (membership + banking), the canvas client (paint), and
// the tests — so "what counts as water / where the bank is" can never drift into
// two "MUST match" copies again.
//
// It lives under public/ (like flow.js) so the browser loads it as a static ES
// module and the server imports UP into it — the project's zero-build, single-
// deploy cross-runtime sharing pattern. The only dependency is the deterministic
// rng primitive (drift-procgen.js), which both runtimes already share.
// =============================================================================
import { rng } from '../drift-procgen.js';

export const POND_ASPECT = 0.7;   // ry / rx — the sole definition (was duplicated server↔client)
export const POND_BANK_PAD = 16;  // a body settles this far past a pond's elliptical rim

// Is world point (x,y) inside pond p's ellipse, within its rim × (1 + margin)?
export function inPond(p, x, y, margin = 0) {
  const rx = p.r * (1 + margin), ry = p.r * POND_ASPECT * (1 + margin);
  const nx = (x - p.x) / rx, ny = (y - p.y) / ry;
  return nx * nx + ny * ny <= 1;
}

// The pond in `pools` whose ellipse contains (x,y) (within margin), else null.
export function poolContaining(pools, x, y, margin = 0) {
  for (const p of pools) if (inPond(p, x, y, margin)) return p;
  return null;
}

// The point just OUTSIDE pond p's elliptical rim, along the ray from its centre
// through (x,y) — where an in-water seed/stone settles. `padExtra` clears a
// body's own radius too. Dead-centre falls back to a seed-deterministic direction.
export function bankPoint(p, x, y, seed = 0, padExtra = 0) {
  let dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
  if (d < 1) { const a = rng(seed >>> 0)() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); d = 1; } // dead-centre → deterministic direction
  const ry = p.r * POND_ASPECT;
  const t = 1 / Math.hypot(dx / p.r, dy / ry);        // scale to land exactly on the ellipse rim along this ray
  const pad = POND_BANK_PAD + padExtra;
  return { x: p.x + dx * t + (dx / d) * pad, y: p.y + dy * t + (dy / d) * pad }; // rim, then pushed just past it
}
