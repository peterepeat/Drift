// =============================================================================
// DRIFT — the FAMILIES registry (runtime-agnostic DATA)
// -----------------------------------------------------------------------------
// One entry per OBJECT family, holding the per-family behaviour flags the world
// branches on. This is the single source the server reads instead of scattering
// `o.family === '...'` ladders across the tick passes; the client will extend each
// entry with render descriptors in public/forms.js (a later increment). Pure data
// + a lookup helper, no deps — Node-importable (the flow.js / sizing.js pattern):
// the DO imports up into it, the browser loads it statically, tests assert on it.
//
// EACH FLAG IS AN INDEPENDENT PREDICATE. The family OVERLAPS between columns are
// coincidental, not one concept — collapsing any two would be a silent regression:
//   - stone FADES and is TRIMMABLE but does NOT drift (it's a wall);
//   - the four "alive" families (anomaly/creature/fish/mark) are isolation-exempt
//     (`tended`) AND ceiling-protected (`!trimmable`), but those are DISTINCT passes;
//   - the ceiling actively trims seed/crystal, which fade no-ops on.
// Keep the columns separate.
//
//   drifts            — eligible to creep along the water flow (#driftEligible)
//   driftsAfterSprout — ...but only once mature enough to have rooted; the SERVER
//                       applies its SPROUT threshold (kept there, not duplicated here)
//   fades             — crumbles to grit when free + cold + long-forgotten (isolation)
//   tended            — "alive": skipped by the whole isolation pass (never fades,
//                       never dirtied by a warmth-refresh)
//   trimmable         — eligible for the ceiling / over-cap trim (the inverse of
//                       "protected")
//   deflectsFlow      — a wall the water flow steers around (#flowAt)
//   grows             — runs the per-tick heat/grow/age/shed/dissolve lifecycle (seed)
//   decays            — slowly dissolves each tick, then is removed (crystal)
//   heals             — a ground stain that self-removes after its TTL (mark)
// `grows`/`decays`/`heals` only GATE which lifecycle block runs in the tick loop;
// the bodies stay in world-do.js (they close over the tick ctx / season / neighbours).
// At most one is true per family, and a family with none has no time-based change.
// =============================================================================
export const FAMILIES = Object.freeze({
  stone:    Object.freeze({ drifts: false, driftsAfterSprout: false, fades: true,  tended: false, trimmable: true,  deflectsFlow: true,  grows: false, decays: false, heals: false }),
  seed:     Object.freeze({ drifts: true,  driftsAfterSprout: true,  fades: false, tended: false, trimmable: true,  deflectsFlow: false, grows: true,  decays: false, heals: false }),
  anomaly:  Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false, grows: false, decays: false, heals: false }),
  crystal:  Object.freeze({ drifts: true,  driftsAfterSprout: false, fades: false, tended: false, trimmable: true,  deflectsFlow: false, grows: false, decays: true,  heals: false }),
  creature: Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false, grows: false, decays: false, heals: false }),
  fish:     Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false, grows: false, decays: false, heals: false }),
  mark:     Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false, grows: false, decays: false, heals: true  }),
});

// Every persisted object family. (giant is deliberately ABSENT — it's an in-memory
// NPC in this.giants[], never in this.objects, so the tick's family passes never
// reach it; it earns a first-class entry only on the render side, in forms.js.)
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));

// Conservative all-false default — keeps a hypothetical unknown family inert (it
// can't arise: the record factories produce only the names above). A missing flag
// must never crash the always-on tick nor silently drift/fade/trim something.
const NONE = Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: false, trimmable: false, deflectsFlow: false, grows: false, decays: false, heals: false });
export const familyOf = (family) => FAMILIES[family] || NONE;
