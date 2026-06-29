// =============================================================================
// THE GIANT — a solo journeyer. Drawn UPRIGHT / side-on (it stands on the ground
// plane like the trees, not splayed top-down like the bugs), so it reads as a being
// apart from everything else in the world: tall, pale, long-legged, gentle. Light
// palette with a touch of colour, a soft walking gait, a faint presence glow.
// Pure draw (no DOM/time source beyond the t the caller passes) — framework-free.
// =============================================================================
import { rgba } from './drift-procgen.js';

const BODY = '#e7e0cf';     // pale moonlit cream
const BODY_DK = '#bcae93';  // its underside / shading
const SADDLE = '#9bbf9a';   // a soft moss-green marking — a bit of colour
const GLOW = '#f6efda';     // the faint warmth it carries

// cx,cy = ground contact point. R = overall height (world units). t = seconds (gait +
// breath). ang = heading (faces the way it walks). walk 0..1 = how much it's striding.
export function drawGiant(ctx, cx, cy, R, t, ang = 0, walk = 1) {
  const face = Math.cos(ang) >= 0 ? 1 : -1;                 // face the heading (flip horizontally)
  const bob = Math.sin(t * 1.7) * R * 0.02 * (0.5 + walk);  // gentle bob, livelier afoot
  // a soft contact shadow at the feet (stays on the ground, doesn't bob)
  ctx.save();
  ctx.fillStyle = rgba('#000000', 0.16);
  ctx.beginPath(); ctx.ellipse(cx, cy, R * 0.32, R * 0.07, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.scale(face, 1);

  // a faint presence glow (it carries a little warmth wherever it goes)
  const halo = ctx.createRadialGradient(0, -R * 0.45, 0, 0, -R * 0.45, R * 0.95);
  halo.addColorStop(0, rgba(GLOW, 0.12)); halo.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, -R * 0.45, R * 0.95, 0, Math.PI * 2); ctx.fill();

  const bodyY = -R * 0.52;                                  // the body rides high on long legs
  // ---- four legs in two pairs, tapered + gently bent at the knee (a calm walk) ----
  const legX = [-R * 0.17, -R * 0.1, R * 0.1, R * 0.17];    // hind pair, fore pair
  for (let i = 0; i < 4; i++) {
    const ph = t * 2.2 + (i % 2 ? Math.PI : 0);             // diagonal pairs swing opposite
    const swing = Math.sin(ph) * R * 0.1 * walk;            // foot swings fore/aft
    const lift = Math.max(0, Math.cos(ph)) * R * 0.06 * walk; // lifts on the forward swing
    const hipX = legX[i], hipY = bodyY + R * 0.08;
    const footX = hipX + swing + (i < 2 ? -R * 0.02 : R * 0.02), footY = -lift; // a touch of splay
    const kneeX = (hipX + footX) / 2 + R * 0.04, kneeY = (hipY + footY) / 2;    // a forward knee
    const far = i === 0 || i === 3;                         // outer leg of each pair = the far one (shaded)
    ctx.fillStyle = far ? BODY_DK : BODY;
    const w0 = R * 0.035, w1 = R * 0.013;                   // wide at the hip → narrow at the hoof
    ctx.beginPath();
    ctx.moveTo(hipX - w0, hipY);
    ctx.quadraticCurveTo(kneeX - w1, kneeY, footX - w1, footY);
    ctx.lineTo(footX + w1, footY);
    ctx.quadraticCurveTo(kneeX + w1, kneeY, hipX + w0, hipY);
    ctx.closePath(); ctx.fill();
  }

  // ---- body (a fuller, rounded form with a gentle back) ----
  const bg = ctx.createLinearGradient(0, bodyY - R * 0.22, 0, bodyY + R * 0.16);
  bg.addColorStop(0, BODY); bg.addColorStop(1, BODY_DK);
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.ellipse(-R * 0.02, bodyY, R * 0.3, R * 0.21, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgba(SADDLE, 0.55);                       // a soft moss saddle (its bit of colour)
  ctx.beginPath(); ctx.ellipse(-R * 0.05, bodyY - R * 0.08, R * 0.18, R * 0.09, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgba(BODY_DK, 0.6);                       // a small tail tuft at the back
  ctx.beginPath(); ctx.ellipse(-R * 0.3, bodyY - R * 0.02, R * 0.05, R * 0.03, 0.4, 0, Math.PI * 2); ctx.fill();

  // ---- neck + head (rising gently from the front) ----
  const headX = R * 0.34, headY = bodyY - R * 0.34 + Math.sin(t * 1.4) * R * 0.015;
  ctx.strokeStyle = BODY; ctx.lineWidth = R * 0.11; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(R * 0.16, bodyY - R * 0.05); ctx.quadraticCurveTo(R * 0.3, bodyY - R * 0.26, headX, headY); ctx.stroke();
  ctx.fillStyle = BODY; ctx.beginPath(); ctx.ellipse(headX + R * 0.02, headY, R * 0.1, R * 0.075, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgba('#554e42', 0.85);                   // a small, calm eye
  ctx.beginPath(); ctx.arc(headX + R * 0.05, headY - R * 0.01, R * 0.013, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}
