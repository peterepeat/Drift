// =============================================================================
// DRIFT — generative ambient sound (opt-in, client-only; PRD §8.4).
// No samples: a low drone (a few detuned oscillators on a season-derived tonal
// centre) beneath a band-passed noise pad, breathed by a sub-0.1 Hz LFO. OFF by
// default; a single tap on the corner glyph enables it (and unlocks the
// AudioContext, per the autoplay policy). The only deterministic, unit-tested
// piece is worldToAudioParams — a pure map from world state the client already
// holds to audio parameters; the audible graph follows it and GLIDES slowly so
// the bed feels alive and indifferent, never reactive. Reads nothing
// identifying; sends nothing. Never edits drift-procgen.js — only calls rng.
// =============================================================================
import * as PG from './drift-procgen.js';

export const TONIC_BASE_HZ = 110;                 // A2 — low and warm
export const SEASON_SEMITONES = [0, -3, -5, 2];   // growing / turning / resting / rising offsets
export const DENSITY_FULL = 40;                   // object count that saturates richness
const FIFTH_DETUNE_CENTS = 6;                     // slight beating on the fifth
const MASTER_GAIN = 0.18, FADE_S = 4;             // quiet bed; tide-like enable/disable
const LFO_RATE_HZ = 0.05;                         // glacial breathing
const SWELL_DEPTH = 0.06;                         // max fractional master-gain swell from warmth
const BRIGHT_HZ = [220, 2000];                    // bandpass sweep range
const UPDATE_MS = 300, GLIDE_TC_S = 5;            // param refresh + multi-second glide

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Season tonal-centre crossfade — the same smoothstep the visual season grade uses.
function seasonSemitone(phase) {
  const i = ((Math.floor(phase) % 4) + 4) % 4, frac = phase - Math.floor(phase);
  let f = frac < 0.7 ? 0 : (frac - 0.7) / 0.3; f = f * f * (3 - 2 * f);
  return SEASON_SEMITONES[i] + (SEASON_SEMITONES[(i + 1) % 4] - SEASON_SEMITONES[i]) * f;
}

// PURE: world state -> audio parameters. The only unit-tested piece. Non-finite
// inputs are coerced to 0 so a malformed season can never set a node to NaN.
const fin = (v) => (Number.isFinite(v) ? v : 0);
export function worldToAudioParams({ seasonPhase = 0, density = 0, warmth = 0, water = 0 } = {}) {
  const tonicHz = TONIC_BASE_HZ * Math.pow(2, seasonSemitone(fin(seasonPhase)) / 12);
  const d = clamp(fin(density) / DENSITY_FULL, 0, 1), w = clamp(fin(water), 0, 1);
  return {
    tonicHz,
    fifthDetuneCents: FIFTH_DETUNE_CENTS,
    brightness: clamp(0.25 + 0.6 * d + 0.15 * w, 0, 1),
    padLevel: clamp(0.18 + 0.8 * d, 0, 1),
    droneLevel: clamp(0.45 + 0.4 * d, 0, 1),
    swell: clamp(fin(warmth), 0, 1) * SWELL_DEPTH,
  };
}

// ---- interaction pings (generative, unique per touch; PRD §8.4 extended) -----
// A short, consonant tone on each pickup/place/land — synthesised (no samples) and
// never the same twice: scale degree, octave, detune, pan and length all derive
// from the object's seed + a per-event nonce. Pitched on a just-pentatonic above
// the SAME season tonic the ambient bed uses, so events always sit in the drone.
// Gated by the one sound opt-in (the corner glyph), like the bed.
const PING_LEVEL = 0.16;                          // peak gain of a ping (quiet, sits under the bed's presence)
const PENT = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 8 / 3]; // just-intonation pentatonic-ish ratios
// family flavour: octave multiplier, oscillator timbre, base length (s)
const PING_FAMILY = {
  stone:   { oct: 0.5, type: 'triangle', dur: 0.55 },
  seed:    { oct: 1.0, type: 'sine',     dur: 0.32 },
  crystal: { oct: 2.0, type: 'sine',     dur: 0.6  },
  anomaly: { oct: 1.0, type: 'triangle', dur: 0.95 },
  creature:{ oct: 1.5, type: 'sine',     dur: 0.28 },
};

// ---- the audio graph (browser only) ----------------------------------------
const DRONE = [[0.5, 'sine', 0.5], [1.0, 'sine', 0.6], [1.5, 'triangle', 0.4]]; // [tonic mult, type, gain]
let ctx = null, master = null, breath = null, drones = [], droneGains = [], bandpass = null, padGain = null, swellDepth = null, fx = null;
let enabled = false, timer = null;
let lastState = { seasonPhase: 0, density: 0, warmth: 0, water: 0 };

function brownNoiseBuffer() {
  const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
  const r = PG.rng(0x50414421); let last = 0; // deterministic "brown-ish" noise (no samples loaded)
  for (let i = 0; i < len; i++) { const wn = r() * 2 - 1; last = (last + 0.02 * wn) / 1.02; data[i] = last * 3.2; }
  return buf;
}

function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  // A "breath" gain sits UPSTREAM of the master fade: the LFO swells it around a
  // base of 1, while master.gain alone governs enable/disable. So fading the
  // master to 0 is truly silent (no residual LFO offset) and never overshoots.
  breath = ctx.createGain(); breath.gain.value = 1; breath.connect(master);
  const p = worldToAudioParams(lastState);
  for (const [mult, type, g] of DRONE) {
    const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = p.tonicHz * mult;
    if (mult === 1.5) osc.detune.value = p.fifthDetuneCents;
    const gain = ctx.createGain(); gain.gain.value = g * p.droneLevel;
    osc.connect(gain); gain.connect(breath); osc.start();
    drones.push(osc); droneGains.push(gain);
  }
  const noise = ctx.createBufferSource(); noise.buffer = brownNoiseBuffer(); noise.loop = true;
  bandpass = ctx.createBiquadFilter(); bandpass.type = 'bandpass'; bandpass.Q.value = 0.7;
  bandpass.frequency.value = BRIGHT_HZ[0] + (BRIGHT_HZ[1] - BRIGHT_HZ[0]) * p.brightness;
  padGain = ctx.createGain(); padGain.gain.value = 0.25 * p.padLevel;
  noise.connect(bandpass); bandpass.connect(padGain); padGain.connect(breath); noise.start();
  const lfo = ctx.createOscillator(); lfo.frequency.value = LFO_RATE_HZ;
  swellDepth = ctx.createGain(); swellDepth.gain.value = 0; // breathing depth (fraction of 1), set per update
  lfo.connect(swellDepth); swellDepth.connect(breath.gain); lfo.start();
  // Interaction pings bypass the bed's breath/master so they read as crisp events,
  // not part of the drone. Their own gate is `enabled` (checked when a ping fires).
  fx = ctx.createGain(); fx.gain.value = 1; fx.connect(ctx.destination);
}

// PURE: derive a ping's tonal parameters from the object + the season tonic + a
// random source `r` (an rng()). Pentatonic-on-the-tonic keeps every event consonant
// with the drone; the per-call rng makes no two identical (PRD: "must be unique").
// kind: 'pickup' (a small rise) | 'place' (an octave-lower settle) | 'land' (a rest).
export function pingParams(seed, family, kind, tonicHz, r) {
  const fam = PING_FAMILY[family] || PING_FAMILY.seed;
  const deg = PENT[Math.floor(r() * PENT.length)];
  const freq = tonicHz * fam.oct * deg * (kind === 'place' ? 0.5 : 1) * (1 + (r() - 0.5) * 0.012);
  const dur = fam.dur * (0.8 + r() * 0.5) * (kind === 'land' ? 0.7 : 1);
  const peak = PING_LEVEL * (kind === 'pickup' ? 1 : kind === 'place' ? 0.85 : 0.7);
  const slide = kind === 'pickup' ? 1.05 : 0.95;  // gesture contour: pickup lifts, place/land settle
  return { freq, dur, peak, type: fam.type, slide };
}

// Build and fire one generative interaction tone. Pure synthesis; auto-cleans up.
function ping({ seed = 0, family = 'seed', kind = 'pickup', x = 0 } = {}) {
  if (!enabled || !ctx || ctx.state !== 'running' || !fx) return;
  const t = ctx.currentTime;
  const tonic = worldToAudioParams(lastState).tonicHz;             // harmonise with the season bed
  const r = PG.rng(((seed >>> 0) ^ ((Math.random() * 4294967296) >>> 0)) >>> 0); // unique every time
  const p = pingParams(seed, family, kind, tonic, r);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(p.peak, t + 0.008);        // quick attack
  env.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);        // exponential decay
  const osc = ctx.createOscillator(); osc.type = p.type; osc.frequency.setValueAtTime(p.freq, t);
  osc.frequency.exponentialRampToValueAtTime(p.freq * p.slide, t + Math.min(p.dur, 0.12));
  const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.setValueAtTime(p.freq * 2, t);
  const g2 = ctx.createGain(); g2.gain.value = 0.28;               // a soft octave partial for body
  osc.connect(env); osc2.connect(g2); g2.connect(env);
  let out = env;
  if (ctx.createStereoPanner) { const pan = ctx.createStereoPanner(); pan.pan.value = Math.max(-0.6, Math.min(0.6, x / 1400)); env.connect(pan); out = pan; }
  out.connect(fx);
  osc.start(t); osc2.start(t);
  osc.stop(t + p.dur + 0.05); osc2.stop(t + p.dur + 0.05);
  osc.onended = () => { try { env.disconnect(); g2.disconnect(); } catch (e) {} };
}

function apply(glide) {
  if (!ctx) return;
  const t = ctx.currentTime, tc = glide ? GLIDE_TC_S : 0.02, p = worldToAudioParams(lastState);
  drones.forEach((osc, i) => {
    osc.frequency.setTargetAtTime(p.tonicHz * DRONE[i][0], t, tc);
    droneGains[i].gain.setTargetAtTime(DRONE[i][2] * p.droneLevel, t, tc);
  });
  bandpass.frequency.setTargetAtTime(BRIGHT_HZ[0] + (BRIGHT_HZ[1] - BRIGHT_HZ[0]) * p.brightness, t, tc);
  padGain.gain.setTargetAtTime(0.25 * p.padLevel, t, tc);
  swellDepth.gain.setTargetAtTime(p.swell, t, tc); // breathes the upstream node ±swell around 1
}
function startTimer() { if (!timer) timer = setInterval(() => { if (enabled && ctx && ctx.state === 'running') apply(true); }, UPDATE_MS); }
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

export const Audio = {
  isEnabled: () => enabled,
  setState(s) { lastState = s; },
  event(kind, info) { try { ping({ kind, ...(info || {}) }); } catch (e) {} }, // a generative interaction tone (no-op when silent)
  enable(s) {
    if (s) lastState = s;
    try { if (!ctx) build(); else if (ctx.state === 'suspended') ctx.resume(); } catch { return false; }
    enabled = true;
    apply(false);
    master.gain.setTargetAtTime(MASTER_GAIN, ctx.currentTime, FADE_S / 3);
    startTimer();
    return true;
  },
  disable() {
    enabled = false; stopTimer();
    if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, FADE_S / 4);
    if (ctx) setTimeout(() => { if (!enabled && ctx) ctx.suspend().catch(() => {}); }, FADE_S * 1000);
  },
  toggle(s) { enabled ? this.disable() : this.enable(s); return enabled; },
  onHidden() { stopTimer(); if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
  onVisible() { if (enabled && ctx) { ctx.resume().catch(() => {}); startTimer(); } },
};
