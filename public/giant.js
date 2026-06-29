// =============================================================================
// THE GIANT — a solo journeyer. Drawn UPRIGHT / side-on (it stands on the ground
// plane like the trees, not splayed top-down like the bugs), so it reads as a being
// apart. It is NEVER perfectly idle: its legs walk whenever it's moving, its neck
// dips its mouth down to the work while it tends, and it breathes the rest of the time.
// Pure draw (no time source beyond the t the caller passes) — framework-free.
// =============================================================================
import { rgba } from './drift-procgen.js';

const BODY = '#e7e0cf';     // pale moonlit cream
const BODY_DK = '#bcae93';  // its underside / shading
const SADDLE = '#9bbf9a';   // a soft moss-green marking — a bit of colour
const GLOW = '#f6efda';     // the faint warmth it carries
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

// cx,cy = ground contact. R = height. t = seconds. ang = heading (faces its travel).
// opts: { gait 0..1 (leg stride, driven by actual speed), tend 0..1 (mouth-to-work dip),
//         lookX, lookY (a WORLD point its eye follows — e.g. the other giant) }.
export function drawGiant(ctx, cx, cy, R, t, ang = 0, opts = {}) {
  const gait = clamp01(opts.gait != null ? opts.gait : 1);
  const tend = clamp01(opts.tend || 0);
  const face = Math.cos(ang) >= 0 ? 1 : -1;                 // face the way it travels (flip horizontally)
  const breath = Math.sin(t * 1.3);                         // a slow always-on breath
  const bob = breath * R * 0.012 + Math.sin(t * 2.4) * R * 0.02 * gait; // gentle bob, livelier afoot

  // soft contact shadow at the feet (on the ground, doesn't bob)
  ctx.save();
  ctx.fillStyle = rgba('#000000', 0.16);
  ctx.beginPath(); ctx.ellipse(cx, cy, R * 0.32, R * 0.07, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.scale(face, 1);

  const halo = ctx.createRadialGradient(0, -R * 0.45, 0, 0, -R * 0.45, R * 0.95); // presence glow
  halo.addColorStop(0, rgba(GLOW, 0.12)); halo.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, -R * 0.45, R * 0.95, 0, Math.PI * 2); ctx.fill();

  const bodyY = -R * 0.52;
  // ---- four legs: an always-on idle weight-shift, a real stride when moving ----
  // The foot swings AGAINST the body's travel (it plants as the body advances over it),
  // so a walking giant reads as walking, not sliding. Amplitude/speed scale with gait.
  const swingAmp = R * (0.02 + 0.11 * gait);               // a little even at rest, full afoot
  const legSpeed = 2.0 + 1.6 * gait;
  const legX = [-R * 0.17, -R * 0.1, R * 0.1, R * 0.17];   // hind pair, fore pair
  for (let i = 0; i < 4; i++) {
    const ph = t * legSpeed + (i % 2 ? Math.PI : 0);
    const swing = -Math.sin(ph) * swingAmp;                // plant-and-push
    const lift = Math.max(0, Math.cos(ph)) * R * (0.015 + 0.06 * gait);
    const hipX = legX[i], hipY = bodyY + R * 0.08;
    const footX = hipX + swing + (i < 2 ? -R * 0.02 : R * 0.02), footY = -lift;
    const kneeX = (hipX + footX) / 2 + R * 0.04, kneeY = (hipY + footY) / 2;
    const far = i === 0 || i === 3;
    ctx.fillStyle = far ? BODY_DK : BODY;
    const w0 = R * 0.035, w1 = R * 0.013;
    ctx.beginPath();
    ctx.moveTo(hipX - w0, hipY);
    ctx.quadraticCurveTo(kneeX - w1, kneeY, footX - w1, footY);
    ctx.lineTo(footX + w1, footY);
    ctx.quadraticCurveTo(kneeX + w1, kneeY, hipX + w0, hipY);
    ctx.closePath(); ctx.fill();
  }

  // ---- body (breathing) ----
  const bg = ctx.createLinearGradient(0, bodyY - R * 0.22, 0, bodyY + R * 0.16);
  bg.addColorStop(0, BODY); bg.addColorStop(1, BODY_DK);
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.ellipse(-R * 0.02, bodyY, R * 0.3, R * 0.21 * (1 + breath * 0.025), -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgba(SADDLE, 0.55);
  ctx.beginPath(); ctx.ellipse(-R * 0.05, bodyY - R * 0.08, R * 0.18, R * 0.09, -0.08, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgba(BODY_DK, 0.6); // a small tail tuft
  ctx.beginPath(); ctx.ellipse(-R * 0.3, bodyY - R * 0.02 + breath * R * 0.01, R * 0.05, R * 0.03, 0.4, 0, Math.PI * 2); ctx.fill();

  // ---- neck + head: lerp from an UP carriage to a DOWN-to-the-work reach by `tend`,
  //      with an active working dip; mouth ends up at the ground where it's tending ----
  const upX = R * 0.34, upY = bodyY - R * 0.34;
  const downX = R * 0.3, downY = -R * 0.06;                 // reaching the ground just in front (the work)
  const workDip = Math.sin(t * 4.2) * R * 0.05 * tend;     // it dips as it works — never frozen
  const headX = upX + (downX - upX) * tend;
  const headY = upY + (downY - upY) * tend + workDip + breath * R * 0.012;
  ctx.strokeStyle = BODY; ctx.lineWidth = R * 0.11; ctx.lineCap = 'round';
  const nbX = R * 0.16, nbY = bodyY - R * 0.05;
  ctx.beginPath(); ctx.moveTo(nbX, nbY);
  ctx.quadraticCurveTo(nbX + (headX - nbX) * 0.4 + R * 0.06, (nbY + headY) / 2 - R * 0.05 * (1 - tend), headX, headY);
  ctx.stroke();
  ctx.fillStyle = BODY; ctx.beginPath(); ctx.ellipse(headX + R * 0.02, headY, R * 0.1, R * 0.075, 0, 0, Math.PI * 2); ctx.fill();

  // ---- eye: follows a world target if given (the other giant), else looks ahead / at the work
  let edx = 1, edy = tend * 1.6;
  if (opts.lookX != null) {
    const lx = (opts.lookX - cx) * face, ly = opts.lookY - (cy + bob); // the target in this local, face-flipped frame
    edx = lx - headX; edy = ly - headY;
  }
  const el = Math.hypot(edx, edy) || 1; edx /= el; edy /= el;
  ctx.fillStyle = rgba('#554e42', 0.9);
  ctx.beginPath(); ctx.arc(headX + R * 0.045 + edx * R * 0.018, headY - R * 0.005 + edy * R * 0.018, R * 0.015, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}
