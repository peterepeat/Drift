# Drift — evolution roadmap

Post-launch feedback from user testing (2026-06-26), assessed for feasibility and
sequenced into shippable increments. This is a living document; each item is marked
as it ships. The guiding constraint is unchanged: **the world stays wordless, slow,
anonymous, and indifferent** — every feature below has to earn its place inside that.

## Architectural invariants (nothing below may break these)

1. **No identity in the protocol.** Broadcasts carry an ephemeral per-connection
   `pid` and a boolean `held` — never the session token. New features add no
   per-person state to the wire.
2. **Form is always regenerated from `seed`.** No visual data is ever stored or
   transmitted; a 32-bit seed (+ lifecycle scalars) rebuilds every object. New
   object kinds follow this — store a seed, draw from it.
3. **`drift-procgen.js` is lifted verbatim and never modified.** New rendering goes
   in `render.js` or a new module that *calls* procgen primitives (`rng`, `makeNoise`,
   `mix`, `rgba`, …).
4. **Server is authoritative; the client is optimistic.** The single global Durable
   Object owns truth and ticks even with nobody connected.
5. **Writes track change, not population or broadcast rate.** Anything new that
   mutates per tick must ride the dirty-set / checkpoint, not write per tick — the
   `rows_written` budget is the binding constraint behind the 10k cap.
6. **Determinism is shared.** Server and client import the *same* primitives/constants
   (`seed.js` re-exports procgen; `flow.js` is shared) so what the server simulates
   and the client paints can never silently diverge. New shared simulation (e.g.
   creature motion) lives in a shared module the same way.

## Verification

- Server: `npm test` (boots `wrangler dev` per suite; ~140 checks, ~65s). Stays green.
- Client: browser preview tools — load, console-error check, synthetic pointer/touch
  events for gestures, screenshot for proof.
- Periodic adversarial review (≤ hourly) across shipped increments.

---

## Backlog (prioritized & sequenced)

Ordering principle for an autonomous run: **client-only, reversible changes first**
(they can't corrupt the live world), server/storage changes later with tests, the one
destructive action (re-seed) last.

### Wave 1 — fix what testing surfaced (client-only, low risk)

- [ ] **Tab title** `~ d r i f t ~` (was a bare `·`).
- [ ] **Bigger hit targets.** Tiny things (leaves, seeds, crystals) are hard to grab.
  Raise the minimum tap radius and give small families extra hit padding so the
  *grabbable* area is larger than the drawn form.
- [ ] **Pinch-zoom.** Touch pinch is wired but desktop trackpad pinch is dead on
  Safari (it fires non-standard `gesture*` events we only `preventDefault`) and coarse
  on Chrome (`wheel`+ctrlKey). Handle both properly.

### Wave 2 — the interaction model (the central complaint)

- [ ] **Direct-drag manipulation.** Today: tap to pick up, tap to put down — and while
  "held", moving the mouse doesn't carry, so an object teleports A→B with no travel
  (the "not animated between pick up and put down"). Change to direct manipulation:
  **press an object and drag → it moves with you; release → it settles. Press the
  background and drag → pan.** Preserve: a click that doesn't move (sticky pickup as a
  fallback / tall-stack scatter), desktop hover-attend, mobile long-press-attend.
- [ ] **Throw & momentum.** Carrying has velocity; releasing a moving object lets it
  glide and settle with friction rather than freezing. Built on a small client physics
  layer reused by the next item. Others see the glide (carry stream) then the rest.

### Wave 3 — life & feel

- [ ] **Generative interaction sound.** The ambient bed exists; add *unique-per-touch*
  generative notes on pickup/place/land (pitch & timbre from the object's seed + family
  + a nonce, so it never repeats and never tires). Behind the existing opt-in glyph.
  (Extends the PRD's ambient-only stance at the owner's explicit request.)
- [ ] **The mouse displaces small things.** Moving the pointer through light objects
  (seeds, leaves, grit-scale plants) nudges them; a fast pass scatters them; they
  drift back to rest. Lifelike, emergent — not a canned animation. Reuses the physics
  layer; throttled position stream for others; final rest persisted.
- [ ] **A little perspective.** A breath of pseudo-depth — faint ground recession and a
  gentle size-by-depth + grounded contact shadows — so it reads less like a flat plane.
  Kept subtle by design; reconciled with hit-testing and culling.

### Wave 4 — the world is inhabited (most ambitious; the "what's the point" answer)

- [ ] **Creatures.** A new `creature` family: a few gentle insects (crawlers, drifting
  fliers) that wander on their own. Modelled as **deterministic agents** — position is
  `f(seed, worldClock)` from a shared noise field, so every client animates the same
  wander with **zero per-frame sync**, exactly like the water flow. The server stores
  only existence (seed, home, kind); clients compute motion. You can pick one up like
  anything else (server-authoritative while held; it resumes wandering from where you
  set it down). This is the seed of an ecosystem — later: feeding on/near elements,
  resting on stones, sheltering. Starts minimal and alive.
- [ ] **Serendipity & shared presence (exploration).** Lean into what already exists —
  carried objects already stream, presence warmth already blooms. Make *acting near
  each other* feel mutual (a shared warmth that intensifies when two people work the
  same patch), and make traces discoverable (the world keeps what you rearranged for
  whoever comes next). No accounts, no chat — presence felt, not addressed.

### Wave 5 — spaciousness (one destructive step, done last)

- [ ] **Re-seed wider & fuller.** Objects cluster at the centre (generator σ≈400) in a
  now-much-larger world. Widen the distribution and raise the count to use the 10k
  headroom, so arrival feels spacious and inhabited rather than a clump in a void.
  This wipes the current accreted world (procedural, fully regenerable) — done last,
  after the generator change is verified, per the owner's "perhaps via a world reset".

---

## Deferred / considered-and-parked

- **Hard collision physics across clients.** True multiplayer rigid-body collision
  needs server authority at interactive rates — at odds with invariant 5 and the slow
  world. A *local, cosmetic* soft-separation while dragging (things ease aside, no
  authoritative collision) is the feasible slice and folds into the physics layer; full
  collision is parked.
- **Literal 3D.** Out of scope and off-aesthetic; "a little perspective" (Wave 3)
  delivers the felt benefit without leaving Canvas-2D top-down.
