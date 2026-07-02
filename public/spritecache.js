// public/spritecache.js — Stage B: cache the STATIC plant-canopy render.
// -----------------------------------------------------------------------------
// drawPlant re-runs a ~590-stroke recursive fractal every frame per visible tree, though the
// form is TIME-INVARIANT given (seed, maturity, aged). Bake it ONCE to an offscreen canvas keyed
// by (seed + quantized maturity/aged buckets + dpr) and blit thereafter — a mature grove goes from
// thousands of strokes/frame to N drawImages (the pan-jank fix). The per-frame transforms
// (position, sway `bend`, depth scale, zoom) are applied at BLIT time by the caller (draw.js),
// never baked in — so the key stays tiny and the steady-state hit-rate is ~100% (growth is a 60s
// cadence with a ~1s settle → a tree re-bakes a few times ever, then never).
//
// SCOPE (phase 1): only the numerous mid-maturity plants (SPROUT_C ≤ mat < BIG_TREE_MAT). The
// caller keeps pre-sprout seeds, rooted big trees (their roots must stay unbent), and the animated
// families (creature/fish/anomaly/crystal/giant) on the live-vector path — and hands back to
// live-vector when zoomed IN past the handoff (few objects visible there, crispness matters more).
//
// BUCKETING: `floor(mat*20)` — the branch-count regime (maxDepth = round(2+mat*5)) steps at
// mat = 0.1/0.3/0.5/0.7/0.9, all multiples of 0.05, so floor-to-20 buckets never straddle a regime
// edge → no branch-count POP across a bucket boundary. What the bucket does NOT fix, the caller
// does: it size-corrects the blit by the true/baked baseLen ratio, so SIZE tracks maturity
// continuously (no size-snap during growth); the residual quantization is only the canopy COLOUR
// (measured mean Δ<1.5/255 across the range → imperceptible) and, for the aged>0.167 minority, a
// ~1-generation branch-count difference (aged=0 bakes exact; aging is slow → accepted for phase 1).
// aged is quantized to 8 buckets, baked at each bucket's LOWER edge so the common aged=0 is exact.
// BOUNDS: an LRU byte cap + a per-frame bake budget (panning into fresh grove can't stall) + a
// max-sprite-size fallback (return null → the caller draws that one plant live).
import * as PG from './drift-procgen.js';

const MAT_BUCKETS = 20, AGED_BUCKETS = 8; // floor-quantization steps (mat aligned to maxDepth regimes)
const SPRITE_BAKE_Z = 1.4;   // bake-resolution CAP (px/world-unit = dpr*this); also the sprite↔live handoff
const MAX_SPRITE_PX = 1200;  // a sprite larger than this on a side → return null (caller draws live). Sized so the
                             // biggest fully-mature tree at the z=1.4 handoff (dpr2 → ~1027px) still caches, not just below.
const BAKES_PER_FRAME = 10;  // cap fresh bakes/frame so panning/zoom into new grove can't hitch (the blob-fallback covers the rest until baked)

// Resolution-MATCH the bake to the on-screen zoom: bake ~display-resolution, NOT world-resolution,
// so a zoomed-OUT grove (trees shown at ~20px) bakes tiny sprites instead of world-res ones that peg
// the cache and thrash (the zoom-out regression). Quantize z to √2 multiplicative buckets in
// [0.25, SPRITE_BAKE_Z] → a sprite is always within ~19% of the display resolution (crisp) while the
// zoom dimension adds only ~5 buckets to the key. Capped at SPRITE_BAKE_Z (zoom-IN past the caller's
// SPRITE_Z_MAX draws live-vector); floored so tiny sprites keep some resolution.
function bakeZoom(z) {
  const zc = z > SPRITE_BAKE_Z ? SPRITE_BAKE_Z : z < 0.25 ? 0.25 : z;
  return Math.pow(2, Math.round(Math.log2(zc) * 2) / 2); // √2 steps
}
// Plant bbox from the base point as multiples of baseLen. Seed sweeps (80-160/bucket) found worst
// extents of up ~4.07× and half ~2.56× baseLen across the FULL cached range now (mat up to ~1.0,
// since big trees are cached too); these factors add ~10-15% headroom so no branch tip clips even
// for the widest/tallest mature outliers. Nothing renders below the base (canopy grows up), so DOWN
// is a small fixed pad for the base stroke width.
const UP_F = 4.5, HALF_F = 3.0, DOWN_WU = 8;

let _cap = 96 * 1024 * 1024;             // total sprite-bytes cap (tier-tunable via setSpriteCap)
let _bytes = 0;
const _cache = new Map();                // key -> { canvas, half, up, K, bytes, used }
let _tick = 0, _frameT = -1, _bakesThisFrame = 0;

export function setSpriteCap(bytes) { _cap = bytes; while (_bytes > _cap && _cache.size) evictLRU(); }
export function spriteStats() { return { count: _cache.size, mb: +(_bytes / 1048576).toFixed(1), cap: Math.round(_cap / 1048576) }; }

function evictLRU() {
  let oldK = null, oldU = Infinity;
  for (const [k, v] of _cache) if (v.used < oldU) { oldU = v.used; oldK = k; }
  if (oldK == null) return;
  _bytes -= _cache.get(oldK).bytes; _cache.delete(oldK);
}

// Return the cached canopy sprite {canvas, half, up, K, bakeMat} for a plant, or null if it should be
// drawn live THIS frame (bake budget exhausted, or the sprite would be too large). `dpr` and the
// zoom `z` set the bake resolution K (display-matched); `nowStamp` is any per-frame-unique value
// (resets the bake budget on a new frame).
export function getPlantSprite(seed, mat, aged, dpr, z, nowStamp) {
  if (nowStamp !== _frameT) { _frameT = nowStamp; _bakesThisFrame = 0; } // new frame → reset the bake budget
  const mb = Math.floor(mat * MAT_BUCKETS), ab = Math.floor(aged * AGED_BUCKETS);
  const K = dpr * bakeZoom(z); // resolution matched to the display zoom (a zoomed-out grove bakes small, not world-res)
  const key = seed + '|' + mb + '|' + ab + '|' + K;
  let e = _cache.get(key);
  if (e) { e.used = ++_tick; return e; }
  if (_bakesThisFrame >= BAKES_PER_FRAME) return null; // defer: draw live this frame, bake later
  // size from the bucket's UPPER maturity edge + max per-seed size jitter (never clips in-bucket)
  const baseLen = (9 + ((mb + 1) / MAT_BUCKETS) * 46) * 1.1;
  const half = baseLen * HALF_F, up = baseLen * UP_F, down = DOWN_WU;
  const W = Math.ceil(2 * half * K), H = Math.ceil((up + down) * K);
  if (W > MAX_SPRITE_PX || H > MAX_SPRITE_PX || W < 1 || H < 1) return null; // too big → live-vector
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.setTransform(K, 0, 0, K, half * K, up * K); // origin at the base anchor; K px per world unit
  const bakeMat = (mb + 0.5) / MAT_BUCKETS;     // bucket-centre maturity (the caller size-corrects the blit off this)
  PG.drawPlant(g, seed, 0, 0, bakeMat, ab / AGED_BUCKETS); // aged at the bucket's LOWER edge → aged=0 (the common case) bakes exact
  _bakesThisFrame++;
  const bytes = W * H * 4;
  e = { canvas: cv, half, up, K, bakeMat, bytes, used: ++_tick };
  _cache.set(key, e); _bytes += bytes;
  while (_bytes > _cap && _cache.size > 1) evictLRU();
  return e;
}
