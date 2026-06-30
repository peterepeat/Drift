// ---- thermal field & stone formation (PRD §4.1) ----------------------------
// Every area carries a slow, invisible heat value (0..1) that rises where people
// linger and decays over time (season-modulated: Growing lets heat linger,
// Resting bleeds it away). Sustained-warm cells slowly grow STONES (PRD §3/§4.1:
// "form slowly in warm areas" — the maker is long gone before it finishes), and
// the heat GRADIENT bends the water flow toward cooler areas. This field is
// SEPARATE from the per-object `heat` that drives growth (that lives on the
// object record), and is never transmitted — heat is invisible (PRD §4.1).
//
// HeatField owns the coarse cell grid + the persistence-activity flags. The DO
// holds one instance; storage I/O and the spawn ledger stay in the DO (update()
// RETURNS the stones it forms rather than spawning them — the tick's TickContext
// remains the single home of write-economy accounting, invariant #1).
import { makeRecord } from '../seed.js';

const HEAT_CELL = 200;                     // world units per heat cell
const FIELD_HALF = 2000;                   // field covers ±this around the origin (20×20 = 400 cells)
const HEAT_MAX = 1.0;                      // per-cell heat ceiling
const HEAT_GAIN_FIELD = 0.5;               // heat a present person adds to their cell per tick
const HEAT_SEASON_DECAY = { growing: 0.99, turning: 0.98, resting: 0.95, rising: 0.985 }; // heat retained/tick
const STONE_HEAT = 0.35;                   // a cell this warm makes progress toward forming a stone
const STONE_FORM_TICKS = 90;               // sustained warm ticks to form one stone (~forms while you're gone)

const lerp = (a, b, t) => a + (b - a) * t;

export class HeatField {
  constructor() {
    this.field = null;       // { w, data[], form[] } — lazy; persisted under 'field:heat'
    this.active = false;     // any heat or formation this tick (skip persisting an inert field)
    this.wasActive = false;  // active last tick (so the field's final settle-to-zero persists once)
  }

  load(stored) { this.field = stored || null; }                                 // rehydrate from storage (rebuilt lazily if absent)
  get needsPersist() { return !!this.field && (this.active || this.wasActive); } // live, or just-settled to zero
  endTick() { this.wasActive = this.active; }                                    // carry this tick's activity into the next persist decision

  #ensure() {
    if (!this.field) {
      const w = Math.round((FIELD_HALF * 2) / HEAT_CELL);
      this.field = { w, data: new Array(w * w).fill(0), form: new Array(w * w).fill(0) };
    }
    return this.field;
  }
  #cellIndex(x, y) {
    const h = this.#ensure();
    const cx = Math.max(0, Math.min(h.w - 1, Math.floor((x + FIELD_HALF) / HEAT_CELL)));
    const cy = Math.max(0, Math.min(h.w - 1, Math.floor((y + FIELD_HALF) / HEAT_CELL)));
    return cy * h.w + cx;
  }
  at(x, y) { return this.#ensure().data[this.#cellIndex(x, y)]; }
  // Heat gradient as a raw cell-to-cell difference (range ~[-1,1]); flow bends along -grad.
  grad(x, y) {
    return { gx: this.at(x + HEAT_CELL, y) - this.at(x - HEAT_CELL, y),
             gy: this.at(x, y + HEAT_CELL) - this.at(x, y - HEAT_CELL) };
  }
  // Ops/testing: directly set a cell's heat (clamped to [0, HEAT_MAX]).
  setCell(x, y, v) { this.#ensure().data[this.#cellIndex(x, y)] = Math.max(0, Math.min(HEAT_MAX, v)); }

  // One thermal tick: decay every cell (season-modulated), add warmth from the
  // live presences, and let sustained-warm, UNATTENDED cells make progress toward
  // forming a stone. `presences` = the live { x, y } this tick; `hasRoom(n)` = can
  // the world hold n more objects. Returns any stones formed (the maker is long
  // gone — PRD §4.1); the caller spawns them so the write ledger stays single-source.
  update(now, sb, presences, hasRoom) {
    const h = this.#ensure();
    const decay = lerp(HEAT_SEASON_DECAY[sb.cur], HEAT_SEASON_DECAY[sb.next], sb.fade);
    for (let i = 0; i < h.data.length; i++) h.data[i] *= decay;
    const occupied = new Set();
    for (const p of presences) {
      const i = this.#cellIndex(p.x, p.y);
      h.data[i] = Math.min(HEAT_MAX, h.data[i] + HEAT_GAIN_FIELD);
      occupied.add(i);
    }
    const formed = [];
    let active = false;
    for (let i = 0; i < h.data.length; i++) {
      // A cell makes progress toward a stone only while warm AND UNATTENDED — the
      // stone finishes after people leave (PRD §4.1: the maker is long gone). The
      // counter is capped at the threshold so warm-while-capped time isn't lost.
      if (h.data[i] >= STONE_HEAT && !occupied.has(i)) {
        h.form[i] = Math.min(STONE_FORM_TICKS, h.form[i] + 1);
        if (h.form[i] >= STONE_FORM_TICKS && hasRoom(formed.length)) {
          h.form[i] = 0;
          formed.push(this.#formStone(i, now));
        }
      } else if (h.data[i] < STONE_HEAT && h.form[i] > 0) {
        h.form[i] -= 1; // cooling unwinds the progress
      }
      if (h.data[i] > 0 || h.form[i] > 0) active = true;
    }
    this.active = active; // lets the tick skip persisting a fully-inert field
    return formed;
  }
  #formStone(idx, now) {
    const h = this.field, cx = idx % h.w, cy = Math.floor(idx / h.w);
    const wx = (cx + 0.5) * HEAT_CELL - FIELD_HALF + (Math.random() * 2 - 1) * HEAT_CELL * 0.4;
    const wy = (cy + 0.5) * HEAT_CELL - FIELD_HALF + (Math.random() * 2 - 1) * HEAT_CELL * 0.4;
    const seed = (Math.random() * 4294967296) >>> 0;
    return makeRecord(crypto.randomUUID(), 'stone', seed, wx, wy, now);
  }
}
