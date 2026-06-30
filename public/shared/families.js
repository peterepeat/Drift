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
// =============================================================================
export const FAMILIES = Object.freeze({
  stone:    Object.freeze({ drifts: false, driftsAfterSprout: false, fades: true,  tended: false, trimmable: true,  deflectsFlow: true  }),
  seed:     Object.freeze({ drifts: true,  driftsAfterSprout: true,  fades: false, tended: false, trimmable: true,  deflectsFlow: false }),
  anomaly:  Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false }),
  crystal:  Object.freeze({ drifts: true,  driftsAfterSprout: false, fades: false, tended: false, trimmable: true,  deflectsFlow: false }),
  creature: Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false }),
  fish:     Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false }),
  mark:     Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: true,  trimmable: false, deflectsFlow: false }),
});

// Every persisted object family. (giant is deliberately ABSENT — it's an in-memory
// NPC in this.giants[], never in this.objects, so the tick's family passes never
// reach it; it earns a first-class entry only on the render side, in forms.js.)
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));

// Conservative all-false default — keeps a hypothetical unknown family inert (it
// can't arise: the record factories produce only the names above). A missing flag
// must never crash the always-on tick nor silently drift/fade/trim something.
const NONE = Object.freeze({ drifts: false, driftsAfterSprout: false, fades: false, tended: false, trimmable: false, deflectsFlow: false });
export const familyOf = (family) => FAMILIES[family] || NONE;
