// =============================================================================
// DRIFT — creatures (Family 5): the world is inhabited.
// -----------------------------------------------------------------------------
// A few gentle insects wander the world on their own. They are DETERMINISTIC
// AGENTS: a creature's live position is home + wanderAt(seed, kind, t), a pure
// function of its seed and a SHARED clock — so every client computes the same
// wander with ZERO per-frame sync, exactly like the water flow field. The server
// stores only existence (seed, kind, home = x/y); the clock is the server's
// `now` (world_state), which clients lock onto, so two people see a creature in
// the same place. Pick one up like anything else (pickup/place/carry) — while
// held it's server-authoritative; placed, its home moves there and it wanders on.
//
// Pure helpers (wanderAt, creatureR) are framework-free and unit-tested in Node,
// the same way drift-procgen and flow are. drawCreature is the only browser part
// (it takes a ctx). NEVER edits drift-procgen.js — it only calls its primitives.
// =============================================================================
import { rng, mix, rgba, lighten, darken } from './drift-procgen.js';

const TAU = Math.PI * 2;
export const CREATURE_KINDS = ['crawler', 'flier'];
// kind → wander reach (world units from home) and pace (time multiplier).
// `pace` scales the wander's temporal frequency = traversal SPEED; reach is
// renormalised independently, so a higher pace covers the same path 50% faster
// (Wave O: +50% — the world feels livelier) without wandering any further.
// `fish` (Wave Q) has a SHORT reach so it stays inside its pond and a slow, gliding
// pace — it reads as swimming, not skittering. Its home is placed well inside the
// pond (≤ half-radius from centre), so home ± reach never crosses the rim.
const KIND = {
  crawler: { reach: 34, pace: 1.875, bob: 0 },
  flier:   { reach: 74, pace: 2.55, bob: 6 },
  fish:    { reach: 70, pace: 1.05, bob: 0 },
};

// PURE & DETERMINISTIC: the wander offset from home at shared time t (seconds).
// A small sum of seed-derived sinusoids — smooth, organic, and BOUNDED to ~reach
// so a creature stays near its home. Same (seed, kind, t) → same point everywhere.
export function wanderAt(seed, kind, t) {
  const k = KIND[kind] || KIND.crawler;
  const r = rng(seed >>> 0);
  let x = 0, y = 0, amp = 1, ampSum = 0;
  for (let i = 0; i < 3; i++) {
    const fx = (0.05 + r() * 0.10) * k.pace, fy = (0.05 + r() * 0.10) * k.pace;
    const px = r() * TAU, py = r() * TAU;
    x += amp * Math.sin(t * fx + px);
    y += amp * Math.cos(t * fy + py);
    ampSum += amp; amp *= 0.5;
  }
  const norm = k.reach / (ampSum || 1);              // keep the path within ~reach of home
  return { x: x * norm, y: y * norm + k.bob * Math.sin(t * 1.7 + (seed & 7)) };
}

// Hit / cull radius (world units) — small, seed-varied; the grab padding in the
// client makes the effective tap target comfortable.
export function creatureR(seed, kind) {
  const r = rng((seed ^ 0x9e37) >>> 0);
  return (kind === 'flier' ? 20 : 26) + r() * 10; // ~2× (more visible / easier to grab); grab padding adds the rest
}

// Fish cull / sort radius (world units) — seed-varied; fish are not pickable, so this
// is only for culling and depth-sorting them within the pond.
export function fishR(seed) {
  const r = rng((seed ^ 0x515f) >>> 0);
  return 22 + r() * 12;
}

// ---- drawing (browser only; caller is in the world transform) ---------------
// A small living thing in the world's muted palette. Heading `ang` orients a
// crawler along its motion; `t` (seconds, local is fine) animates legs/wings so it
// reads as alive even while its slow drift is barely moving. Form is from `seed`.
export function drawCreature(ctx, seed, kind, cx, cy, t, ang = 0) {
  const r = rng(seed >>> 0);
  const size = (kind === 'flier' ? 0.85 : 1) * (9.2 + r() * 5.2); // body half-length, world units — ~2× so creatures read clearly
  const bodyHue = mix('#2b2620', r() < 0.5 ? '#3a2f24' : '#26303a', r()); // warm charcoal ↔ cool
  const sheen = lighten(bodyHue, 0.16);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang + Math.PI / 2); // body long-axis points along heading
  if (kind === 'flier') drawFlier(ctx, r, size, t, bodyHue, sheen);
  else drawCrawler(ctx, r, size, t, bodyHue, sheen);
  ctx.restore();
}

function drawCrawler(ctx, r, s, t, body, sheen) {
  const legs = 3, gait = Math.sin(t * 6);                 // a walking oscillation
  ctx.lineCap = 'round';
  // legs (3 per side), splayed from the thorax and articulating in anti-phase
  ctx.strokeStyle = rgba(darken(body, 0.05), 0.8); ctx.lineWidth = Math.max(0.5, s * 0.16);
  for (let i = 0; i < legs; i++) {
    const ly = (i - 1) * s * 0.7, swing = gait * (i % 2 ? -1 : 1) * s * 0.5;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(side * s * 0.5, ly);
      ctx.quadraticCurveTo(side * s * 1.5, ly + swing * 0.4, side * s * 2.1, ly + swing);
      ctx.stroke();
    }
  }
  // antennae
  ctx.strokeStyle = rgba(darken(body, 0.05), 0.6); ctx.lineWidth = Math.max(0.4, s * 0.12);
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(side * s * 0.3, -s * 1.1);
    ctx.quadraticCurveTo(side * s * 0.9, -s * 2.0, side * s * 1.1 + gait * s * 0.3, -s * 2.4);
    ctx.stroke();
  }
  // body: abdomen + thorax + head along the axis
  const seg = [[0.55, s * 1.2], [-0.15, s * 0.9], [-0.95, s * 0.7]]; // [yMul, radius]
  for (const [ym, rad] of seg) {
    const g = ctx.createLinearGradient(0, ym * s - rad, 0, ym * s + rad);
    g.addColorStop(0, sheen); g.addColorStop(1, darken(body, 0.08));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, ym * s, rad * 0.8, rad, 0, 0, TAU); ctx.fill();
  }
}

function drawFlier(ctx, r, s, t, body, sheen) {
  const flap = 0.45 + 0.55 * Math.abs(Math.sin(t * 16)); // fast wingbeat
  // wings (a pair, translucent, flapping by vertical squash)
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(side * s * 0.4, -s * 0.1); ctx.scale(1, flap);
    const g = ctx.createRadialGradient(side * s * 0.9, 0, 0, side * s * 0.9, 0, s * 1.8);
    g.addColorStop(0, rgba('#dfe8f0', 0.18)); g.addColorStop(1, rgba('#dfe8f0', 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(side * s * 1.0, 0, s * 1.3, s * 0.7, side * 0.3, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // slim body
  const g = ctx.createLinearGradient(0, -s * 1.2, 0, s * 1.2);
  g.addColorStop(0, sheen); g.addColorStop(1, darken(body, 0.06));
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, s * 0.5, s * 1.3, 0, 0, TAU); ctx.fill();
}

// A small fish seen from above, swimming (Wave Q). `ang` orients it along its heading;
// `t` (seconds) swishes the tail so it reads as alive even when barely drifting. Cool,
// muted, seed-varied — calm, never cartoonish. Caller is in the world transform.
export function drawFish(ctx, seed, cx, cy, t, ang = 0) {
  const r = rng(seed >>> 0);
  const s = 8 + r() * 5.5;                                 // body half-length, world units
  const body = mix('#90a8b8', r() < 0.5 ? '#9aa890' : '#86a2b8', r()); // pale cool grey-blue ↔ muted (reads against dark water)
  const belly = lighten(body, 0.22);
  const swish = Math.sin(t * 3 + (seed & 7)) * 0.6;        // slow tail beat
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang + Math.PI / 2);                            // nose (-y) points along heading
  ctx.save(); ctx.translate(0, s * 0.9); ctx.rotate(swish * 0.6); // tail fin behind the body, swishing
  ctx.fillStyle = rgba(darken(body, 0.05), 0.85);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s * 0.7, s * 0.9); ctx.lineTo(s * 0.7, s * 0.9); ctx.closePath(); ctx.fill();
  ctx.restore();
  const g = ctx.createLinearGradient(0, -s, 0, s);          // body — a smooth lens, nose forward
  g.addColorStop(0, belly); g.addColorStop(1, darken(body, 0.06));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.15);
  ctx.quadraticCurveTo(s * 0.62, -s * 0.1, 0, s * 0.95);
  ctx.quadraticCurveTo(-s * 0.62, -s * 0.1, 0, -s * 1.15);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = rgba('#eef6fb', 0.32);                    // dorsal highlight — a glint along the spine
  ctx.beginPath(); ctx.ellipse(0, -s * 0.15, s * 0.18, s * 0.55, 0, 0, TAU); ctx.fill();
  ctx.restore();
}
