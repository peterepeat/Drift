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
import { FLOW_SEED, FLOW_SCALE, FLOW_REACH } from './flow.js'; // shared with the server flow field
import { POND_ASPECT } from './shared/geometry.js'; // shared pond ellipse aspect (server + client)

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

// The ambient amber glows. (ox, oy) parallax-shift them a little with the camera
// (Wave H) so they drift slowly behind the 1:1-panning world — distant light, more
// pronounced depth — instead of being pinned dead to the screen.
export function paintGlows(ctx, w, h, seed, ox = 0, oy = 0) {
  const r = PG.rng(seed), n = 2 + (r() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const x = w * (0.32 + r() * 0.36) + ox, y = h * (0.28 + r() * 0.44) + oy, rad = Math.min(w, h) * (0.42 + r() * 0.3);
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

// ---- ground terrain variation (world-anchored; Wave O, reworked) -----------
// The land isn't a uniform brown: a slow low-frequency noise field tints it warmer
// (sandy) or cooler (mossy) in LARGE, SOFT, CONTINUOUS regions. Rendered ONCE to a
// small offscreen buffer (organic boundaries come free from upscaling the noise — no
// discs, no grid) and blitted each frame with ONE drawImage in the world transform.
// So it's world-anchored AND costs nothing per-frame regardless of zoom (the old
// per-cell radial-gradient loop was the pan/zoom perf regression). Deliberately
// SUBTLE — a breath of place, never pattern.
const GP_WORLD_HALF = 8000;    // the buffer covers ±this around origin (world units)
const GP_RES = 256;            // buffer is GP_RES² px, upscaled smooth over the world span
const GP_SAND = [181, 154, 99]; // warm sandy tint (rgb)
const GP_MOSS = [96, 128, 66];  // cool mossy tint (rgb)
const GP_THRESH = 0.20;        // only stronger noise tints — leaves big neutral areas (fewer, larger regions)
const GP_ALPHA = 0.13;         // peak tint opacity — subtle
let _gpCanvas = null;
function gpCanvas() {
  if (_gpCanvas) return _gpCanvas;
  const cv = document.createElement('canvas'); cv.width = GP_RES; cv.height = GP_RES;
  const cx = cv.getContext('2d'); const img = cx.createImageData(GP_RES, GP_RES);
  const noise = PG.makeNoise(0x5a17d);
  const span = GP_WORLD_HALF * 2;
  for (let py = 0; py < GP_RES; py++) for (let px = 0; px < GP_RES; px++) {
    const wx = -GP_WORLD_HALF + (px / GP_RES) * span, wy = -GP_WORLD_HALF + (py / GP_RES) * span;
    const v = PG.fbm(noise, wx * 0.00052, wy * 0.00052, 4); // low frequency → large regions
    const mag = Math.abs(v);
    const i = (py * GP_RES + px) * 4;
    const rgb = v > 0 ? GP_SAND : GP_MOSS;
    const a = mag > GP_THRESH ? Math.min(1, (mag - GP_THRESH) / 0.45) * GP_ALPHA : 0; // smooth ramp from neutral
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = a * 255;
  }
  cx.putImageData(img, 0, 0);
  _gpCanvas = cv; return cv;
}
export function paintGroundPatches(ctx) {
  ctx.save();
  ctx.imageSmoothingEnabled = true; // bilinear upscale → soft organic boundaries (no discs)
  ctx.drawImage(gpCanvas(), -GP_WORLD_HALF, -GP_WORLD_HALF, GP_WORLD_HALF * 2, GP_WORLD_HALF * 2);
  ctx.restore();
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

// A faint warm tether from a person (their presence bloom centre) to the object they
// are carrying — so a carried thing reads as held by SOMEONE, not floating on its own.
// Brightest at the person, fading to the object, with a soft halo where it's carried.
// Same warm presence colour; drawn 'lighter' so it only ever adds glow (Wave E).
export function paintCarryTether(ctx, px, py, ox, oy, intensity) {
  if (intensity <= 0) return;
  const a = 0.16 * intensity;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(px, py, ox, oy);
  g.addColorStop(0, PG.rgba(PALETTE.presenceCore, a));
  g.addColorStop(1, PG.rgba(PALETTE.presenceCore, a * 0.12));
  ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ox, oy); ctx.stroke();
  const halo = ctx.createRadialGradient(ox, oy, 0, ox, oy, 28);
  halo.addColorStop(0, PG.rgba(PALETTE.presenceCore, a * 1.7));
  halo.addColorStop(1, PG.rgba(PALETTE.presenceCore, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(ox, oy, 28, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Atmospheric horizon (Wave H): a faint band of season-tinted "sky" at the TOP of the
// screen — a breath of up-there — which also hazes the up-screen (further-back) world
// into it, so the flat plane reads as gently receding. The tint is the season's own
// accent lifted off the ground colour, crossfaded exactly like the grade. Drawn over
// the world but beneath held objects + the grade, so what's in your hands stays crisp.
export function paintSky(ctx, w, h, phase) {
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3; f = f * f * (3 - 2 * f); // smoothstep crossfade
  const a = SEASONS[SEASON_KEYS[i]] || SEASONS.growing, b = SEASONS[SEASON_KEYS[(i + 1) % 4]] || SEASONS.growing;
  const col = PG.mix(PG.mix(PALETTE.ground, a.accent, 0.32), PG.mix(PALETTE.ground, b.accent, 0.32), f);
  const skyH = h * 0.42;
  const g = ctx.createLinearGradient(0, 0, 0, skyH);
  g.addColorStop(0, PG.rgba(PG.lighten(col, 0.07), 0.9));    // a brighter horizon rim at the very top
  g.addColorStop(0.45, PG.rgba(col, 0.40));
  g.addColorStop(1, PG.rgba(col, 0));
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, w, skyH); ctx.restore();
}

export const paintGrade = PG.paintGrade;

// ---- water -----------------------------------------------------------------
// A world-anchored pond of water (drawn in the world transform, beneath objects).
// A real, calm BLUE (Wave P — ponds read as water, not a faint grey sheen), with a
// slow breathing shimmer. Used for every pond the world carries.
const WATER_BLUE = '#2f78c0';  // pond body — saturated enough to read blue over the warm glow
const WATER_DEEP = '#1f4f88';  // a deeper centre so the pond has body, not just a flat tint
// Ponds are ELLIPSES (squashed vertically — a top-down look): ry = r·POND_ASPECT.
// POND_ASPECT is imported from the shared geometry module (the single source the
// server also reads) and re-exported here for existing importers.
export { POND_ASPECT };
export function paintWaterWorld(ctx, pool, t) {
  if (!pool) return;
  const { x, y, r } = pool;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, PG.rgba(WATER_DEEP, 0.55));
  g.addColorStop(0.55, PG.rgba(WATER_BLUE, 0.34));
  g.addColorStop(1, PG.rgba(WATER_BLUE, 0));
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(x, y, r, r * POND_ASPECT, 0, 0, Math.PI * 2); ctx.fill();
  const b = 0.5 + 0.5 * Math.sin(t * 0.4); // slow shimmer
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = PG.rgba('#bfe2f2', 0.05 + 0.06 * b);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(x, y, r * (0.5 + 0.28 * b), r * POND_ASPECT * (0.5 + 0.28 * b), 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ---- water flow traces ------------------------------------------------------
// Faint streaks that reveal the flow PATH the server drifts objects along. The
// FLOW_SEED + FLOW_SCALE + FLOW_REACH come from the shared flow.js the server
// also reads, so the visible sheen and the actual drift agree and cover the same
// band. Geometry is fixed; brightness crests travel downstream so it reads as
// slow-moving water without particles.
let _flowNoise = null, _flowPts = null;
export function paintFlow(ctx, pool, t) {
  if (!pool) return;
  if (!_flowNoise) _flowNoise = PG.makeNoise(FLOW_SEED);
  if (!_flowPts) { // a deterministic scatter of sample points across the whole drift band
    const r = PG.rng(FLOW_SEED); _flowPts = [];
    for (let i = 0; i < 80; i++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * pool.r * FLOW_REACH;
      _flowPts.push({ x: pool.x + Math.cos(a) * rr, y: pool.y + Math.sin(a) * rr * POND_ASPECT, ph: r() * Math.PI * 2 });
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of _flowPts) {
    const ang = _flowNoise(p.x * FLOW_SCALE, p.y * FLOW_SCALE) * Math.PI;
    const along = p.x * Math.cos(ang) + p.y * Math.sin(ang); // project onto flow -> crests travel downstream
    const b = 0.5 + 0.5 * Math.sin(t * 0.5 - along * 0.02 + p.ph);
    const len = 16;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ang);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0, PG.rgba(PALETTE.waterCore, 0));
    g.addColorStop(0.5, PG.rgba(PALETTE.waterCore, 0.06 * b));
    g.addColorStop(1, PG.rgba(PALETTE.waterCore, 0));
    ctx.fillStyle = g; ctx.fillRect(-len, -0.7, len * 2, 1.4); ctx.restore();
  }
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
