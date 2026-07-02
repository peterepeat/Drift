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
import { FLOW_SEED, FLOW_SCALE, FLOW_REACH, deflectFlow } from './flow.js'; // shared with the server flow field (incl. the stone-channelling formula)
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

// The ground radial is opaque, full-screen, and CONSTANT between resizes / season-ground
// changes — yet it was re-evaluated (a radial-gradient allocation + a per-fragment fill) every
// frame. Bake it once into a device-resolution offscreen buffer and blit it 1:1 thereafter: a
// straight opaque texture copy instead of a gradient evaluation, and no per-frame allocation
// (which also eases the GC pressure Stage C targets). Rebuilt only when the backing-store size
// or the season ground key changes. Pixel-identical to painting paintGround directly.
let _bd = null, _bdKey = '';
function backdropBuffer(vw, vh, dpr, groundKey) {
  const W = Math.max(1, Math.round(vw * dpr)), H = Math.max(1, Math.round(vh * dpr));
  const key = W + 'x' + H + ':' + groundKey;
  if (_bd && _bdKey === key) return _bd;
  const cv = _bd || document.createElement('canvas');
  cv.width = W; cv.height = H;                 // (re)assigning width resets + clears the buffer
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);        // same transform the frame used → identical pixels
  paintGround(g, vw, vh, groundKey);
  _bd = cv; _bdKey = key; return cv;
}
// Blit the baked ground (device px, identity transform); the opaque buffer covers the whole
// canvas 1:1, so no clear is needed. Self-contained transform (save/restore) — the caller's
// current transform is preserved for the atmosphere passes that follow.
export function paintBackdrop(ctx, vw, vh, dpr, groundKey) {
  const buf = backdropBuffer(vw, vh, dpr, groundKey);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
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

// Pre-rendered glows. The glow field is seed-fixed and only PARALLAX-drifts a hair with the
// camera (GLOW_PARALLAX = 0.04) — so re-filling 2-3 full-screen radial gradients every frame is
// pure waste. Bake it ONCE into a buffer that overscans the viewport by GLOW_MARGIN on each side,
// then blit it at the parallax offset. The buffer is rendered at GLOW_RES (glows are smooth +
// low-frequency, so a downscaled buffer upscales back cleanly — a few MB, not tens) and in CSS
// space — dpr-INDEPENDENT: the buffer is identical at any dpr; the device scale is folded in only
// at blit time, so it's correctly reused across dpr/tier changes (that's why dpr isn't in its key).
// source-over is associative, so the baked stack composited onto the ground == the old per-glow
// fills onto the ground. The parallax offset is BOUNDED to ±GLOW_MARGIN: within the bound (all
// normal panning, and any pan until the lag reaches the screen margin) it matches the old per-frame
// offset EXACTLY; the bound engages only once a ~450px-radius glow is already at/off the screen
// edge, where holding vs. drifting further is imperceptible — and it keeps the always-on glow
// softly present rather than blanking a far-panned corner (A4's always-painted-backdrop principle).
const GLOW_MARGIN = 600;   // parallax-lag bound (CSS px); also the viewport overscan so the shift never exposes an edge
const GLOW_RES = 0.4;      // buffer resolution factor (smooth gradients survive the down/up-scale)
let _glowBuf = null, _glowKey = '';
function glowBuffer(vw, vh, seed) {
  const key = vw + 'x' + vh + ':' + seed;   // dpr intentionally omitted — the buffer is CSS-space; dpr is applied at blit
  if (_glowBuf && _glowKey === key) return _glowBuf;
  const M = GLOW_MARGIN, W2 = vw + 2 * M, H2 = vh + 2 * M, s = GLOW_RES;
  const cv = _glowBuf || document.createElement('canvas');
  cv.width = Math.max(1, Math.round(W2 * s)); cv.height = Math.max(1, Math.round(H2 * s));
  const g = cv.getContext('2d');
  g.setTransform(s, 0, 0, s, 0, 0);   // draw in CSS px; the buffer is downscaled by s
  g.translate(M, M);                  // buffer (M+x, M+y) ≙ the zero-parallax screen glow at (x, y)
  const r = PG.rng(seed), n = 2 + (r() < 0.5 ? 1 : 0);   // SAME rng consumption as paintGlows → same centres/radii
  for (let i = 0; i < n; i++) {
    const x = vw * (0.32 + r() * 0.36), y = vh * (0.28 + r() * 0.44), rad = Math.min(vw, vh) * (0.42 + r() * 0.3);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, PG.rgba(PALETTE.glowCore, PALETTE.glowAlpha));
    grd.addColorStop(1, PG.rgba(PALETTE.glowCore, 0));
    g.fillStyle = grd; g.fillRect(-M, -M, W2, H2);   // fill the WHOLE buffer (margin included)
  }
  _glowBuf = cv; _glowKey = key; return cv;
}
// Blit the pre-rendered glows at the camera's parallax offset (device px, identity transform,
// self-contained). (ox, oy) match paintGlows' offset args; clamped to ±GLOW_MARGIN.
export function paintGlowsBuffered(ctx, vw, vh, dpr, seed, ox = 0, oy = 0) {
  const buf = glowBuffer(vw, vh, seed), M = GLOW_MARGIN;
  const cx = ox < -M ? -M : ox > M ? M : ox, cy = oy < -M ? -M : oy > M ? M : oy;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, buf.width, buf.height, (-M + cx) * dpr, (-M + cy) * dpr, (vw + 2 * M) * dpr, (vh + 2 * M) * dpr);
  ctx.restore();
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
let _skyGrad = null, _skyKey = '';
export function paintSky(ctx, w, h, phase) {
  const d = seasonDerived(phase), skyH = h * 0.42, key = phase + '|' + w + '|' + h;
  if (key !== _skyKey) { // rebuild the gradient only on a phase/size change — the colour math is memoized in seasonDerived
    _skyGrad = ctx.createLinearGradient(0, 0, 0, skyH);
    _skyGrad.addColorStop(0, d.skyTop);      // a brighter horizon rim at the very top
    _skyGrad.addColorStop(0.45, d.skyMid);
    _skyGrad.addColorStop(1, d.skyBot);
    _skyKey = key;
  }
  ctx.save(); ctx.fillStyle = _skyGrad; ctx.fillRect(0, 0, w, skyH); ctx.restore();
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
export function paintFlow(ctx, pool, t, stones) {
  if (!pool) return;
  const rocks = stones || [];
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
    const a0 = _flowNoise(p.x * FLOW_SCALE, p.y * FLOW_SCALE) * Math.PI;
    const df = deflectFlow(p.x, p.y, Math.cos(a0), Math.sin(a0), rocks); // bend the streak around nearby rocks — the channelling made visible (same formula the server drifts objects with)
    const ang = Math.atan2(df.vy, df.vx);
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

// Season MEMO. S.seasonPhase changes only when net.js reassigns it from a server message
// (~60s tick cadence); the derived colours/weights/gradients below were nonetheless recomputed
// 60×/s. Cache the phase-derived bundle and recompute only when the phase actually changes — the
// `phase === _seasonPhase` guard auto-invalidates on the next reassignment. The per-frame full-
// screen fillRects stay; only the colour-math + allocation is lifted out of the hot loop.
let _seasonPhase = NaN, _seasonD = null;
function seasonDerived(phase) {
  if (phase === _seasonPhase && _seasonD) return _seasonD;
  const i = Math.floor(phase) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3; f = f * f * (3 - 2 * f); // smoothstep crossfade
  const a = SEASONS[SEASON_KEYS[i]] || SEASONS.growing, b = SEASONS[SEASON_KEYS[(i + 1) % 4]] || SEASONS.growing;
  const skyCol = PG.mix(PG.mix(PALETTE.ground, a.accent, 0.32), PG.mix(PALETTE.ground, b.accent, 0.32), f);
  _seasonD = {
    groundKey: SEASON_KEYS[i],
    sat: a.sat + (b.sat - a.sat) * f,
    // the two crossfaded grade layers (a weight ≤ 0 is skipped by the painter, exactly as before)
    grade: [{ blend: a.blend, overlay: a.overlay, weight: 1 - f },
            { blend: b.blend, overlay: b.overlay, weight: f }],
    skyTop: PG.rgba(PG.lighten(skyCol, 0.07), 0.9),  // sky gradient stop colours (paintSky builds the gradient)
    skyMid: PG.rgba(skyCol, 0.40),
    skyBot: PG.rgba(skyCol, 0),
  };
  _seasonPhase = phase;
  return _seasonD;
}

// The whole-frame colour grade for a monotonic season phase (floor % 4 is the current
// season; it crossfades to the next over the season's last ~30%).
function gradeLayer(ctx, w, h, L) {
  if (L.weight <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, L.weight);
  ctx.globalCompositeOperation = L.blend;
  ctx.fillStyle = L.overlay;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
export function paintSeasonGrade(ctx, w, h, phase) {
  const g = seasonDerived(phase).grade;
  gradeLayer(ctx, w, h, g[0]);
  gradeLayer(ctx, w, h, g[1]);
}
// The current season's ground base colour key (differences are subtle).
export function seasonGround(phase) { return seasonDerived(phase).groundKey; }
// The world-layer saturation for this season phase (applied as a CSS filter on the canvas —
// the Visual Bible's "canvas/CSS saturation multiplier"). Resting drops toward silver (0.68).
export function seasonSat(phase) { return seasonDerived(phase).sat; }
