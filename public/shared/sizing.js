// =============================================================================
// DRIFT — shared form-from-seed SIZING (runtime-agnostic)
// -----------------------------------------------------------------------------
// Every object's footprint is regenerated from its integer seed (invariant #3:
// form is never stored or transmitted). These pure functions are the ONE home of
// those formulas, shared by the Durable Object, the canvas client, the generator,
// and the tests — so a "MUST match" stone radius can't silently diverge between
// what the server treats as a footprint and what the client draws.
//
// Lives under public/ (like flow.js / geometry.js) so the browser loads it as a
// static module and the server imports UP into it — zero build step. Lifting the
// client's sizers here also makes them Node-importable, and therefore testable.
// =============================================================================
import { rng } from '../drift-procgen.js';

// Stone base footprint from seed (world units). THE cross-runtime formula: the
// server, the client, the generator's spacing, and the stone tests all read this.
// (A fused/split stone's stored `r` overrides it — the caller's concern.)
export function stoneRadius(seed) { return 12 + rng(seed >>> 0)() * 34; }

// Anomaly luminous radius (~18-32 wu); a fused hybrid grows with each kind it carries.
export function anomalyRadius(seed, nKinds = 1) {
  const base = 18 + rng(seed >>> 0)() * 14;
  return base * Math.min(1.7, 1 + 0.17 * (nKinds - 1));
}

// Crystal radius (small, ~6-13 wu).
export function crystalRadius(seed) { return 6 + rng(seed >>> 0)() * 7; }

// Per-seed scale jitter for a seed/sprout sprite (0.9..1.8) — a SEPARATE seed
// stream (seed ^ golden ratio) so it doesn't disturb the form's structure.
export function seedScale(seed) { return 0.9 + rng((seed ^ 0x9e3779b9) >>> 0)() * 0.9; }

// A plant's visual / tap radius from its maturity: a small seed sprite below the
// sprout threshold, growing with maturity once sprouted.
export function plantRadius(maturity, seed, sprout) {
  return maturity < sprout ? 10 * seedScale(seed) : 10 + maturity * 26;
}
