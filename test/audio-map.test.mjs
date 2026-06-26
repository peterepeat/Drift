// Ambient sound parameter mapping (pure — no AudioContext, no worker).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { worldToAudioParams, pingParams, SEASON_SEMITONES, TONIC_BASE_HZ, DENSITY_FULL } from '../public/audio.js';
import { rng } from '../public/drift-procgen.js';
let pass = 0, fail = 0;
const check = (c, label) => { console.log((c ? '  PASS ' : '  FAIL ') + label); c ? pass++ : fail++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const tonicAt = (semi) => TONIC_BASE_HZ * Math.pow(2, semi / 12);

// 1. tonal centre tracks the season (held value at each season's plateau)
check(near(worldToAudioParams({ seasonPhase: 0 }).tonicHz, tonicAt(SEASON_SEMITONES[0])), 'Growing sits on the base tonic');
check(near(worldToAudioParams({ seasonPhase: 2 }).tonicHz, tonicAt(SEASON_SEMITONES[2])), 'Resting drops to its darker tonic');
check(near(worldToAudioParams({ seasonPhase: 3 }).tonicHz, tonicAt(SEASON_SEMITONES[3])), 'Rising lifts to its tonic');
check(near(worldToAudioParams({ seasonPhase: 4 }).tonicHz, worldToAudioParams({ seasonPhase: 0 }).tonicHz), 'the season clock wraps (phase 4 == phase 0)');
check(near(worldToAudioParams({ seasonPhase: 0.5 }).tonicHz, tonicAt(SEASON_SEMITONES[0])), 'mid-season plateau holds the tonic (no early drift)');
const mid01 = worldToAudioParams({ seasonPhase: 0.85 }).tonicHz; // crossfade growing->turning
check(mid01 < tonicAt(SEASON_SEMITONES[0]) && mid01 > tonicAt(SEASON_SEMITONES[1]), 'the tonic crossfades between adjacent seasons');
check(Number.isFinite(worldToAudioParams({ seasonPhase: NaN, density: NaN, warmth: Infinity }).tonicHz), 'non-finite world state never yields a NaN frequency');

// 2. richness rises with density, monotonic and clamped
const lo = worldToAudioParams({ density: 0 }), mid = worldToAudioParams({ density: 20 }), hi = worldToAudioParams({ density: DENSITY_FULL });
const over = worldToAudioParams({ density: DENSITY_FULL * 4 });
check(mid.padLevel > lo.padLevel && hi.padLevel >= mid.padLevel, 'pad richness rises with object density');
check(mid.droneLevel > lo.droneLevel && hi.droneLevel >= mid.droneLevel, 'drone richness rises with density');
check(near(hi.padLevel, over.padLevel) && over.padLevel <= 1, 'density saturates (clamped, never over 1)');

// 3. warmth swells the bed, bounded
check(worldToAudioParams({ warmth: 1 }).swell > worldToAudioParams({ warmth: 0 }).swell, 'nearby warmth swells the sound');
check(worldToAudioParams({ warmth: 5 }).swell <= 0.06 + 1e-9, 'the swell stays gentle (<= SWELL_DEPTH)');

// 4. every output stays in range; defaults are safe; deterministic
const p = worldToAudioParams({ seasonPhase: 1.5, density: 12, warmth: 0.4, water: 0.7 });
check(p.brightness >= 0 && p.brightness <= 1 && p.padLevel >= 0 && p.padLevel <= 1 && p.droneLevel >= 0 && p.droneLevel <= 1, 'all levels stay within [0,1]');
check(p.tonicHz > 0 && Number.isFinite(p.tonicHz), 'tonic is a finite positive frequency');
check(JSON.stringify(worldToAudioParams({})) === JSON.stringify(worldToAudioParams({ seasonPhase: 0, density: 0, warmth: 0, water: 0 })), 'empty input == explicit zero input (safe defaults)');
check(JSON.stringify(p) === JSON.stringify(worldToAudioParams({ seasonPhase: 1.5, density: 12, warmth: 0.4, water: 0.7 })), 'mapping is deterministic');

// 4b. interaction pings: consonant on the tonic, gesture-shaped, and unique per touch
const TON = 110;
const pk = pingParams(7, 'seed', 'pickup', TON, rng(7));
check(pk.freq > 0 && Number.isFinite(pk.freq) && pk.dur > 0 && pk.peak > 0, 'a ping has a finite positive freq/dur/peak');
check(near(pingParams(7, 'seed', 'place', TON, rng(99)).freq, pingParams(7, 'seed', 'pickup', TON, rng(99)).freq * 0.5), 'a place settles an octave below its pickup');
check(pingParams(7, 'crystal', 'pickup', TON, rng(5)).freq > pingParams(7, 'stone', 'pickup', TON, rng(5)).freq, 'a crystal pings higher than a stone (family octave)');
check(pk.slide > 1 && pingParams(7, 'seed', 'place', TON, rng(7)).slide < 1, 'pickup lifts in pitch, place settles down');
const PENT_REF = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 8 / 3];
const fr = pingParams(123, 'seed', 'pickup', TON, rng(123)).freq / TON; // seed octave = 1
const nearest = PENT_REF.reduce((b, x) => Math.abs(x - fr) < Math.abs(b - fr) ? x : b, PENT_REF[0]);
check(Math.abs(fr - nearest) / nearest < 0.01, 'a ping lands on a pentatonic ratio above the tonic (always consonant)');
const pitches = new Set();
for (let i = 0; i < 24; i++) pitches.add(Math.round(pingParams(i, 'seed', 'pickup', TON, rng(1000 + i)).freq * 100));
check(pitches.size >= 4, `pings vary across touches — ${pitches.size} distinct pitches in 24 (never the same twice)`);
check(Number.isFinite(pingParams(0, 'no-such-family', 'pickup', TON, rng(1)).freq), 'an unknown family falls back safely (finite freq)');

// 5. purity guard: the audio module never touches identity or the network
const src = readFileSync(fileURLToPath(new URL('../public/audio.js', import.meta.url)), 'utf8');
check(!/\btoken\b/.test(src) && !/ws\.send|\.send\(|fetch\(/.test(src), 'audio.js reads no session token and sends nothing');
check(!/localStorage/.test(src), 'audio.js holds no persistence (the on/off choice lives in client.js)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
