// =============================================================================
// DRIFT — Reference procedural generation & rendering
// -----------------------------------------------------------------------------
// Pure, framework-free ES module. The Visual Bible draws every live specimen
// with these exact functions, so this file doubles as reference code: lift it
// straight into the Canvas-2D client renderer described in the PRD (§7.2, §8.2).
//
// Core promise of the world: NO TWO OBJECTS ARE IDENTICAL. Every form derives
// deterministically from a 32-bit integer seed, so a given seed always rebuilds
// the same object (needed for sync + persistence) while the population as a
// whole reads as endlessly varied.
//
// Coordinates are CSS pixels. All draw* functions paint at (cx, cy) and assume
// the caller has already handled devicePixelRatio scaling on the context.
// =============================================================================

// ---- Deterministic PRNG (mulberry32) ---------------------------------------
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a — turn any string (e.g. an object UUID) into a stable seed.
export function seedFrom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- Value noise (smooth) — ground texture (§8.2) --------------------------
// Lightweight value noise. For the production ground, render once to a small
// offscreen buffer and upscale with low opacity over the base — never per-pixel
// per-frame. Returns a sampler f(x, y) -> [-1, 1].
export function makeNoise(seed) {
  const r = rng(seed);
  const N = 256;
  const G = new Float32Array(N * N);
  for (let i = 0; i < G.length; i++) G[i] = r();
  const at = (x, y) => G[(x & 255) + (y & 255) * N];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  return function (x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x - x0), fy = fade(y - y0);
    const a = lerp(at(x0, y0), at(x0 + 1, y0), fx);
    const b = lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx);
    return lerp(a, b, fy) * 2 - 1;
  };
}

// Fractal sum of noise — richer, more organic texture.
export function fbm(noise, x, y, oct = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * noise(x * freq, y * freq); norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}

// =============================================================================
// PALETTE — baseline values are GROWING season (PRD §8.1). Object colours are
// never recoloured per season; seasonal mood is a single composite overlay
// applied to the whole frame (see SEASONS + paintGrade).
// =============================================================================
export const PALETTE = {
  ground:       '#0d0b08', // warm, very dark, almost-black
  deepGround:   '#161210', // depth-gradient core
  glowCore:     '#c8922a', // the world's own light — warm amber
  glowAlpha:    0.08,       // ambient glow opacity
  stone:        ['#8a7e72', '#a89c90', '#c2b8ad', '#d4cfc9'], // fresh-dark -> worn-light
  growthYoung:  '#bcc77e', // sapling — soft yellow-green (fresh, just sprouted)
  growthLight:  '#8dab6f', // mid-growth / branch tips
  growthDeep:   '#3f5733', // mature core — deep forest green
  waterCore:    '#a8b8c4', // pale cool grey-blue
  waterAlpha:   0.40,
  presenceCore: '#e8c87a', // presence warmth bloom
  presenceAlpha:0.06,
};

// Each season is a felt quality, never a label in-world (PRD §2.2).
// `growing` carries the PRD's stated baseline; the other three are committed
// here, extending the PRD in its spirit. `overlay`+`blend` grade the frame;
// `sat` is the canvas/CSS saturation multiplier for the world layer.
export const SEASONS = {
  growing: { label: 'Growing', feel: 'Warm · green-gold · still, full, heavy',
    source: 'PRD', ground: '#0d0b08', overlay: 'rgba(200,146,42,0.05)', blend: 'overlay',     sat: 1.00, accent: '#c8922a' },
  turning: { label: 'Turning', feel: 'Cool · amber-red · restless, windy',
    source: 'DESIGN', ground: '#100a07', overlay: 'rgba(176,74,40,0.11)',  blend: 'overlay',    sat: 0.94, accent: '#b8593a' },
  resting: { label: 'Resting', feel: 'Cold · pale silver · silent, slow, dark',
    source: 'DESIGN', ground: '#0a0b0d', overlay: 'rgba(150,168,190,0.12)', blend: 'soft-light', sat: 0.68, accent: '#9fb0c4' },
  rising:  { label: 'Rising',  feel: 'Mild · grey-green · expectant, damp',
    source: 'DESIGN', ground: '#0a0c0a', overlay: 'rgba(120,150,120,0.09)', blend: 'soft-light', sat: 0.86, accent: '#88a888' },
};

// Apply a season grade to the whole frame. Call AFTER everything else is drawn.
export function paintGrade(ctx, w, h, seasonKey) {
  const s = SEASONS[seasonKey] || SEASONS.growing;
  ctx.save();
  ctx.globalCompositeOperation = s.blend;
  ctx.fillStyle = s.overlay;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---- Colour helpers (all hex -> hex, so results are re-parseable) ----------
function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function toHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  return toHex(A.r + (B.r - A.r) * t, A.g + (B.g - A.g) * t, A.b + (B.b - A.b) * t);
}
export function lighten(hex, amt) { const c = parseHex(hex); return toHex(c.r + 255 * amt, c.g + 255 * amt, c.b + 255 * amt); }
export function darken(hex, amt)  { const c = parseHex(hex); return toHex(c.r - 255 * amt, c.g - 255 * amt, c.b - 255 * amt); }
export function applySat(hex, sat) {
  const c = parseHex(hex); const grey = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return toHex(grey + (c.r - grey) * sat, grey + (c.g - grey) * sat, grey + (c.b - grey) * sat);
}
export function rgba(hex, a) { const c = parseHex(hex); return `rgba(${c.r},${c.g},${c.b},${a})`; }

// =============================================================================
// FAMILY 1 — STONES (PRD §3.1, §3.2)
// Irregular rounded polygons, 8–14 vertices. They do not grow or decay; they
// ERODE — each handling makes them smaller, smoother, lighter. erosion 0..1.
// Much-handled stones (erosion > ~0.6) gain a faint luminescence: the object's
// only visible history.
// =============================================================================
export function makeStone(seed, sizePx, erosion = 0) {
  const r = rng(seed);
  const verts = 8 + Math.floor(r() * 7);            // 8..14
  const radius = sizePx * (1 - 0.42 * erosion);     // erosion shrinks the stone
  const rough = (1 - erosion) * 0.34;               // angular when fresh, smooth when worn
  const pts = [];
  for (let i = 0; i < verts; i++) {
    const a = (i / verts) * Math.PI * 2 + (r() - 0.5) * 0.18;
    const rad = radius * (1 + (r() * 2 - 1) * rough);
    pts.push({ a, rad });
  }
  const idx = Math.min(3, Math.floor(erosion * 3 + r() * 0.6));
  const base = mix(PALETTE.stone[idx], PALETTE.stone[Math.min(3, idx + 1)], r());
  // a subtle, unique warm/cool cast per stone (so the greys aren't all identical) — kept faint
  const fill = mix(base, r() < 0.5 ? '#9a8a76' : '#787f8a', 0.05 + r() * 0.16);
  const luminescence = Math.max(0, erosion - 0.6) / 0.4; // 0 until very old, ->1 near dissolution
  return { pts, radius, fill, luminescence };
}

export function drawStone(ctx, stone, cx, cy) {
  const { pts, radius, fill, luminescence } = stone;
  if (luminescence > 0) { // faint warm halo — barely perceptible, visible if you look
    const g = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius * 2.0);
    g.addColorStop(0, rgba('#ecd9a8', 0.10 * luminescence));
    g.addColorStop(1, rgba('#ecd9a8', 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, radius * 2.0, 0, Math.PI * 2); ctx.fill();
  }
  const P = pts.map((p) => ({ x: cx + Math.cos(p.a) * p.rad, y: cy + Math.sin(p.a) * p.rad }));
  ctx.beginPath();
  for (let i = 0; i <= P.length; i++) {            // rounded: quad-smooth through edge midpoints
    const a = P[i % P.length], b = P[(i + 1) % P.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (i === 0) ctx.moveTo(mx, my); else ctx.quadraticCurveTo(a.x, a.y, mx, my);
  }
  ctx.closePath();
  const sg = ctx.createLinearGradient(cx, cy - radius, cx, cy + radius); // soft top-light
  sg.addColorStop(0, lighten(fill, 0.06));
  sg.addColorStop(1, darken(fill, 0.13));
  ctx.fillStyle = sg; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(darken(fill, 0.22), 0.5); ctx.stroke(); // soft, not pixel-perfect edge
}

// A scatter of grit — the brief 500ms remains of a fully-eroded stone (§4.3).
export function drawGrit(ctx, seed, cx, cy, spread, alpha) {
  const r = rng(seed);
  for (let i = 0; i < 22; i++) {
    const a = r() * Math.PI * 2, d = r() * spread;
    ctx.fillStyle = rgba(PALETTE.stone[1 + (i % 3)], alpha * (0.4 + r() * 0.6));
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.7 + r() * 1.5, 0, Math.PI * 2); ctx.fill();
  }
}

// =============================================================================
// FAMILY 2 — GROWTH (PRD §3.2)
// Seeds (teardrops, the most common object) -> sprout -> plant. Plants are
// abstract branching structures ("slow lightning / a river delta from above"),
// never a literal tree. maturity 0..1 drives size, branch depth, saturation.
// aged 0..1 desaturates and prunes branches back toward simplicity.
// =============================================================================
export function drawSeed(ctx, seed, cx, cy, scale = 1, color) {
  const r = rng(seed);
  const len = 9 * scale * (0.85 + r() * 0.3), w = 4.0 * scale * (0.85 + r() * 0.3);
  const col = color || mix(PALETTE.growthDeep, PALETTE.growthLight, 0.4 + r() * 0.3);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(r() * Math.PI * 2);
  ctx.beginPath(); ctx.moveTo(0, -len);
  ctx.bezierCurveTo(w, -len * 0.2, w, len * 0.6, 0, len);
  ctx.bezierCurveTo(-w, len * 0.6, -w, -len * 0.2, 0, -len);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -len, 0, len);
  g.addColorStop(0, lighten(col, 0.12)); g.addColorStop(1, darken(col, 0.10));
  ctx.fillStyle = g; ctx.fill(); ctx.restore();
}

export function drawPlant(ctx, seed, cx, cy, maturity, aged = 0) {
  const maxDepth = Math.round(2 + maturity * 5);          // 2..7 generations
  // Per-plant uniqueness: a SEPARATE seed stream (so it never disturbs the branch RNG below)
  // gives each plant its own subtle foliage TINT (a slightly different green), a branch SPREAD
  // character (narrow ↔ wide), a gentle whole-plant LEAN, and a touch of size variation — so
  // no two plants are quite alike, all still within the green palette.
  const tr = rng((seed ^ 0x5e3d9b) >>> 0);
  const tintTo = tr() < 0.5 ? '#cfc878' : '#6f9c88';      // a warmer yellow-green ↔ a cooler blue-green
  const tintAmt = 0.10 + tr() * 0.20;                     // 0.10..0.30 — subtle
  const spread = 0.34 + tr() * 0.26;                      // branch fan: narrow ↔ wide
  const lean = (tr() * 2 - 1) * 0.18;                     // a gentle lean off vertical
  const baseLen = (9 + maturity * 46) * (0.9 + tr() * 0.2); // grows with maturity, ±10% per plant
  const sat = (0.35 + maturity * 0.65) * (1 - aged * 0.7); // young = pale, mature = rich, aged = fades
  // Maturity reads as COLOUR (Wave O): sapling soft yellow-green → mature deep forest green.
  let core = maturity < 0.5
    ? mix(PALETTE.growthYoung, PALETTE.growthLight, maturity / 0.5)
    : mix(PALETTE.growthLight, PALETTE.growthDeep, (maturity - 0.5) / 0.5);
  core = mix(core, tintTo, tintAmt);                      // ← each plant a unique tint of that green
  ctx.save(); ctx.translate(cx, cy); ctx.lineCap = 'round';
  (function branch(g, x, y, ang, len, depth, thick) {
    if (depth > maxDepth || len < 1.5) return;
    if (aged > 0 && depth > maxDepth - Math.round(aged * 3) && g() < aged) return; // aged plants drop late branches
    const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
    const mx = (x + ex) / 2 + (g() * 2 - 1) * len * 0.14;  // wandering midpoint = river-delta feel
    const my = (y + ey) / 2 + (g() * 2 - 1) * len * 0.14;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.lineWidth = Math.max(0.6, thick);
    ctx.strokeStyle = applySat(mix(core, PALETTE.growthLight, (depth / maxDepth) * 0.6), sat);
    ctx.stroke();
    const n = 2 + (g() < 0.3 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const da = (i - (n - 1) / 2) * (spread + g() * 0.3) + (g() * 2 - 1) * 0.16;
      branch(g, ex, ey, ang + da, len * (0.68 + g() * 0.14), depth + 1, thick * 0.7);
    }
    if (depth === maxDepth && maturity > 0.6 && aged < 0.5 && g() < 0.5) { // mature tips bear nodes
      ctx.beginPath(); ctx.arc(ex, ey, 1.5, 0, Math.PI * 2); ctx.fillStyle = applySat(lighten(PALETTE.growthLight, 0.08), sat); ctx.fill();
    }
  })(rng(seed), 0, 0, -Math.PI / 2 + lean, baseLen, 0, 1.6 + maturity * 2.4);
  ctx.restore();
}

// =============================================================================
// FAMILY 3 — WATER TRACES (PRD §3.2)
// Marks, not objects: sheen / residue left by the slow water system. Pools
// gather in low areas; crystalline formations glint at pool edges and dry
// channels. drawWaterPatch composes a representative trace into (w × h).
// =============================================================================
export function drawCrystal(ctx, seed, cx, cy, size, t = 0) {
  const r = rng(seed);
  const facets = 3 + Math.floor(r() * 3);                 // 3..5 — small, geometric
  const rot = r() * Math.PI * 2;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < facets; i++) {
    const a = (i / facets) * Math.PI * 2;
    const rad = size * (0.6 + r() * 0.5);
    const fn = i === 0 ? 'moveTo' : 'lineTo';
    ctx[fn](Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(-size, -size, size, size);
  g.addColorStop(0, rgba('#dfeaf2', 0.85)); g.addColorStop(1, rgba(PALETTE.waterCore, 0.55));
  ctx.fillStyle = g; ctx.fill();
  const glint = 0.5 + 0.5 * Math.sin(t * 2 + seed); // slow glint
  ctx.fillStyle = rgba('#ffffff', 0.5 * glint);
  ctx.beginPath(); ctx.arc(-size * 0.2, -size * 0.25, size * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export function drawWaterPatch(ctx, seed, w, h, t = 0) {
  const r = rng(seed);
  const noise = makeNoise(seed);
  // Slow flow sheen — faint elongated streaks following the flow field.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const x = r() * w, y = r() * h;
    const ang = noise(x * 0.012, y * 0.012) * Math.PI;     // local flow direction
    const len = 14 + r() * 26;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0, rgba(PALETTE.waterCore, 0)); g.addColorStop(0.5, rgba(PALETTE.waterCore, 0.05)); g.addColorStop(1, rgba(PALETTE.waterCore, 0));
    ctx.fillStyle = g; ctx.fillRect(-len, -0.8, len * 2, 1.6); ctx.restore();
  }
  ctx.restore();
  // A pool gathered in a low area — wet sheen.
  const px = w * 0.42, py = h * 0.6, pr = Math.min(w, h) * 0.34;
  const pool = ctx.createRadialGradient(px, py, 0, px, py, pr);
  pool.addColorStop(0, rgba(PALETTE.waterCore, 0.22)); pool.addColorStop(0.7, rgba(PALETTE.waterCore, 0.09)); pool.addColorStop(1, rgba(PALETTE.waterCore, 0));
  ctx.fillStyle = pool; ctx.beginPath(); ctx.ellipse(px, py, pr, pr * 0.62, 0, 0, Math.PI * 2); ctx.fill();
  // Crystalline formations glinting at the pool edge.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r();
    const cx = px + Math.cos(a) * pr * (0.78 + r() * 0.2);
    const cy = py + Math.sin(a) * pr * 0.62 * (0.8 + r() * 0.2);
    drawCrystal(ctx, seed + i * 97, cx, cy, 3 + r() * 4, t);
  }
}

// =============================================================================
// FAMILY 4 — ANOMALIES (PRD §3.2)
// Rare, beautiful, unlike the other families. No lifecycle — they persist
// until deliberately dissolved. Four committed directions. t is seconds.
// =============================================================================
// The wonder's FIELD made visible: a large, soft, slow-breathing halo out to ~the influence radius
// (~200wu) so an anomaly reads as a PLACE of quiet power where life gathers — not just a small bright
// icon. Drawn once per anomaly (see forms.drawAnomalyForm), additive + very low alpha so it stays calm.
export function drawAnomalyHalo(ctx, t, cx, cy, R) {
  const hb = 0.6 + 0.4 * Math.sin(t * 0.7), hr = R * 6.5;   // ~195wu at a base R≈30; a fused (bigger R) wonder glows wider
  const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, hr);
  g.addColorStop(0, rgba('#ffe9b8', 0.10 * hb)); g.addColorStop(0.5, rgba('#ffe9b8', 0.045 * hb)); g.addColorStop(1, rgba('#ffe9b8', 0));
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
export function drawAnomaly(ctx, kind, t, cx, cy, R) {
  ctx.save(); ctx.translate(cx, cy);
  if (kind === 'rotor') {                                  // a slowly rotating geometric form
    for (let ring = 0; ring < 3; ring++) {
      const rr = R * (0.4 + ring * 0.28);
      const seg = 5 + ring;
      const rot = t * (0.12 + ring * 0.05) * (ring % 2 ? -1 : 1);
      ctx.strokeStyle = rgba(mix('#7ad0c8', '#b89ae0', ring / 2), 0.75 - ring * 0.12);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i <= seg; i++) { const a = rot + (i / seg) * Math.PI * 2; const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.stroke();
    }
  } else if (kind === 'point') {                           // a breathing point of light
    const b = 0.5 + 0.5 * Math.sin(t * 1.1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * (0.7 + 0.3 * b));
    g.addColorStop(0, rgba('#fff4d8', 0.9)); g.addColorStop(0.3, rgba('#ffd98f', 0.5 + 0.3 * b)); g.addColorStop(1, rgba('#ffd98f', 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgba('#fffbf0', 0.95); ctx.beginPath(); ctx.arc(0, 0, 2 + b, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'prism') {                           // a perfect geometric shape, refracting
    const rot = t * 0.18; const sides = 6;
    for (let layer = 0; layer < 3; layer++) {
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.rotate(rot + layer * 0.09);
      ctx.fillStyle = rgba(['#86e0d0', '#9bb8f0', '#e0a6d8'][layer], 0.34);
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) { const a = (i / sides) * Math.PI * 2; const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(a) * R, Math.sin(a) * R); }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.strokeStyle = rgba('#eaf6ff', 0.8); ctx.lineWidth = 1.2; ctx.save(); ctx.rotate(rot); ctx.beginPath();
    for (let i = 0; i <= sides; i++) { const a = (i / sides) * Math.PI * 2; const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(a) * R, Math.sin(a) * R); } ctx.closePath(); ctx.stroke(); ctx.restore();
  } else if (kind === 'breath') {                          // an organic form that seems to breathe
    const pulse = 0.82 + 0.18 * Math.sin(t * 0.9);
    const lobes = 7;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const rad = R * pulse * (0.78 + 0.22 * Math.sin(a * lobes + t * 0.6));
      const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, rgba('#c8f0e0', 0.5)); g.addColorStop(1, rgba('#7fd0b8', 0.05));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgba('#e0fff4', 0.55); ctx.lineWidth = 1; ctx.stroke();
  } else if (kind === 'heart') {                           // a soft, beating love-heart — it TAMES (Wave U)
    const beat = 0.84 + 0.16 * Math.abs(Math.sin(t * 2.4));
    const h = R * 1.5 * beat;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.7); // warm glow behind it
    halo.addColorStop(0, rgba('#ff7a98', 0.4)); halo.addColorStop(1, rgba('#ff7a98', 0));
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.2);
    ctx.bezierCurveTo(0, -h * 0.5, -h * 0.5, -h * 0.5, -h * 0.5, -h * 0.12);
    ctx.bezierCurveTo(-h * 0.5, h * 0.18, 0, h * 0.36, 0, h * 0.5);
    ctx.bezierCurveTo(0, h * 0.36, h * 0.5, h * 0.18, h * 0.5, -h * 0.12);
    ctx.bezierCurveTo(h * 0.5, -h * 0.5, 0, -h * 0.5, 0, -h * 0.2);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -h * 0.5, 0, h * 0.5);
    g.addColorStop(0, rgba('#ffd0dc', 0.95)); g.addColorStop(1, rgba('#e85a7a', 0.9));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgba('#fff0f4', 0.6); ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.restore();
}
