// =============================================================================
// DRIFT — background / atmosphere painters
// -----------------------------------------------------------------------------
// These reproduce the world's atmosphere exactly as committed in the Visual
// Bible (ground radial, ambient amber glows, value-noise overlay, presence
// bloom). They are built on the deterministic primitives in drift-procgen.js
// (makeNoise, fbm, PALETTE, SEASONS, paintGrade, colour helpers) — which are
// lifted verbatim and never modified. Object drawing itself (drawStone /
// drawSeed) is called directly from client.js.
//
// Everything here paints in CSS pixels; the caller sets the screen-space
// transform (dpr only) before calling.
// =============================================================================
import * as PG from './drift-procgen.js';

const PALETTE = PG.PALETTE;
const SEASONS = PG.SEASONS;

// Value-noise texture rendered once to a small offscreen buffer, upscaled with
// low opacity — never per-pixel per-frame (Visual Bible §07 / procgen §8.2).
const _noiseCache = {};
function noiseCanvas(w, h, seed) {
  const key = w + 'x' + h + ':' + seed;
  if (_noiseCache[key]) return _noiseCache[key];
  const s = 0.28, cw = Math.max(2, Math.round(w * s)), ch = Math.max(2, Math.round(h * s));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const cx = cv.getContext('2d'); const img = cx.createImageData(cw, ch);
  const noise = PG.makeNoise(seed);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = PG.fbm(noise, x * 0.07, y * 0.07, 4) * 0.5 + 0.5;
    const i = (y * cw + x) * 4, l = 80 + v * 140;
    img.data[i] = l; img.data[i + 1] = l * 0.92; img.data[i + 2] = l * 0.78; img.data[i + 3] = 26;
  }
  cx.putImageData(img, 0, 0); _noiseCache[key] = cv; return cv;
}

export function paintGround(ctx, w, h, sk) {
  const s = SEASONS[sk] || SEASONS.growing;
  const core = PG.mix(s.ground, '#1b1510', 0.62), edge = s.ground;
  const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
  g.addColorStop(0, core); g.addColorStop(1, edge);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

export function paintGlows(ctx, w, h, seed) {
  const r = PG.rng(seed), n = 2 + (r() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const x = w * (0.32 + r() * 0.36), y = h * (0.28 + r() * 0.44), rad = Math.min(w, h) * (0.42 + r() * 0.3);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, PG.rgba(PALETTE.glowCore, PALETTE.glowAlpha));
    g.addColorStop(1, PG.rgba(PALETTE.glowCore, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}

export function paintNoise(ctx, w, h, seed) {
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.7;
  ctx.drawImage(noiseCanvas(w, h, seed), 0, 0, w, h); ctx.restore();
}

// Presence warmth — committed spec (PRD §4.4 / Visual Bible §04):
// #e8c87a, 6% core opacity, radius ~0.5-0.6x viewport width, blend 'lighter'.
// `intensity` is the 0..1 fade envelope; we build to the spec value (no 2.5x
// screen exaggeration the Bible used to make it legible in print).
export function paintPresence(ctx, w, h, x, y, rad, intensity) {
  if (intensity <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, PG.rgba(PALETTE.presenceCore, PALETTE.presenceAlpha * intensity));
  g.addColorStop(1, PG.rgba(PALETTE.presenceCore, 0));
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.restore();
}

export const paintGrade = PG.paintGrade;

// ---- water -----------------------------------------------------------------
// A world-anchored pool of wet sheen (drawn in the world transform, beneath
// objects). Pale cool grey-blue (#a8b8c4), with a slow breathing shimmer.
export function paintWaterWorld(ctx, pool, t) {
  if (!pool) return;
  const { x, y, r } = pool;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, PG.rgba(PALETTE.waterCore, 0.16));
  g.addColorStop(0.7, PG.rgba(PALETTE.waterCore, 0.06));
  g.addColorStop(1, PG.rgba(PALETTE.waterCore, 0));
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
  const b = 0.5 + 0.5 * Math.sin(t * 0.4); // slow shimmer
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = PG.rgba('#cfe0ea', 0.04 + 0.05 * b);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(x, y, r * (0.5 + 0.28 * b), r * 0.7 * (0.5 + 0.28 * b), 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ---- seasons ----------------------------------------------------------------
// The whole-frame colour grade for a monotonic season phase (floor % 4 is the
// current season; it crossfades to the next over the season's last ~30%).
export const SEASON_KEYS = ['growing', 'turning', 'resting', 'rising'];
function gradeOne(ctx, w, h, key, weight) {
  if (weight <= 0) return;
  const s = SEASONS[key] || SEASONS.growing;
  ctx.save();
  ctx.globalAlpha = Math.min(1, weight);
  ctx.globalCompositeOperation = s.blend;
  ctx.fillStyle = s.overlay;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
export function paintSeasonGrade(ctx, w, h, phase) {
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3; f = f * f * (3 - 2 * f); // smoothstep
  gradeOne(ctx, w, h, SEASON_KEYS[i], 1 - f);
  gradeOne(ctx, w, h, SEASON_KEYS[(i + 1) % 4], f);
}
// The current season's ground base colour key (differences are subtle).
export function seasonGround(phase) { return SEASON_KEYS[Math.floor(phase) % 4]; }
// The world-layer saturation for this season phase (applied as a CSS filter on
// the canvas — the Visual Bible's "canvas/CSS saturation multiplier"). Resting
// drops toward silver (0.68); Growing is full (1.0).
export function seasonSat(phase) {
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3; f = f * f * (3 - 2 * f);
  const a = SEASONS[SEASON_KEYS[i]] || SEASONS.growing;
  const b = SEASONS[SEASON_KEYS[(i + 1) % 4]] || SEASONS.growing;
  return a.sat + (b.sat - a.sat) * f;
}
