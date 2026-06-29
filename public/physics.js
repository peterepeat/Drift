// =============================================================================
// DRIFT — pure motion helpers (framework-free, shared with a unit test).
// -----------------------------------------------------------------------------
// Small, deterministic physics the client uses for throw-momentum (a released
// drag glides on instead of freezing) and for nudging light objects out of the
// pointer's way. Pure functions only — no DOM, no time source — so they can be
// reasoned about and unit-tested (test/physics.test.mjs) the same way cull.js and
// audio.js's worldToAudioParams are. The client supplies dt from its frame clock.
// =============================================================================

// Exponential friction: the fraction `retain` of a velocity survives each second,
// so over `dt` seconds the multiplier is retain^dt (frame-rate independent).
export function friction(retain, dt) { return Math.pow(retain, Math.max(0, dt)); }

// Advance one fling step. `pos`/`vel` are {x,y} (world units, units/s); returns the
// new position and decayed velocity, plus `stopped` once it has slowed below `stop`
// (so the caller can settle it into a place). dt is clamped by the caller.
export function flingStep(pos, vel, dt, retain, stop) {
  const k = friction(retain, dt);
  const vx = vel.x * k, vy = vel.y * k;
  return { x: pos.x + vx * dt, y: pos.y + vy * dt, vx, vy, stopped: Math.hypot(vx, vy) < stop };
}

// Exponential moving average toward a new sample (used to smooth sampled pointer
// velocity so one jittery frame can't define a throw). a = weight of the sample.
export function ema(prev, sample, a) { return prev * (1 - a) + sample * a; }

// One damped-spring step pulling a scalar toward rest (0): `k` is stiffness, `retain`
// the fraction of velocity kept per second. Returns the new position and velocity.
// Drives the cursor-displacement spring-back (a nudged leaf settles home).
export function spring(pos, vel, dt, k, retain) {
  const v = (vel - k * pos * dt) * friction(retain, dt);
  return { pos: pos + v * dt, vel: v };
}

// Push a point OUT of any overlapping circle footprints so it rests just clear of
// them, never inside. Each circle is {x, y, r}; `pad` is extra clearance (e.g. the
// moving body's radius). Each pass resolves the single deepest overlap, so a point
// wedged between several circles walks out to the gap over a few passes. The push is
// continuous (it fades to zero exactly at the rim, so there's no pop as a wanderer
// approaches). Fully deterministic — every client computes the same rest point.
// Used to fence ground creatures around rock footprints (solids read as solid).
export function deflectCircles(x, y, pad, circles, passes = 3) {
  for (let i = 0; i < passes; i++) {
    let worst = 0, ux = 0, uy = 1;
    for (const c of circles) {
      const min = c.r + pad;
      const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy);
      const over = min - d;
      if (over > worst) { worst = over; ux = d > 0.001 ? dx / d : 0; uy = d > 0.001 ? dy / d : 1; }
    }
    if (worst <= 0) break;           // clear of every circle
    x += ux * worst; y += uy * worst;
  }
  return { x, y };
}

// A soft radial push: an object within `radius` of a moving point is nudged away
// along the point→object direction, strongest at the centre and zero at the rim,
// scaled by the point's speed. Returns the velocity to ADD {vx,vy} (world units/s).
// `lightness` (0..1) lets tiny things fly and heavy things barely stir. Pure: the
// caller decides eligibility and integrates the result.
export function nudge(px, py, ox, oy, radius, speed, strength, lightness = 1) {
  const dx = ox - px, dy = oy - py;
  const d = Math.hypot(dx, dy);
  if (d > radius || speed <= 0) return { vx: 0, vy: 0 };
  const fall = 1 - d / radius;                 // 1 at centre → 0 at the rim
  // A tiny separation keeps a dead-centre hit from dividing by zero; it picks a
  // gentle outward direction from the raw offset (or a default) so motion stays sane.
  const ux = d > 0.001 ? dx / d : 0, uy = d > 0.001 ? dy / d : 1;
  const mag = speed * strength * fall * fall * lightness;
  return { vx: ux * mag, vy: uy * mag };
}
