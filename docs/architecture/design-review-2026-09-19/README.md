# Architecture design review — 2026-09-19

A multi-agent, read-only review run before Sprint 2: four engineers mapped the
Sprint 1 codebase, six architects each designed one hard part of the target
system, one skeptic attacked each design, and an integrator reconciled them.

| File | What it is |
|---|---|
| `00-codebase-map.md` | What Sprint 1 actually contains, and every gap against the target (auth, schema, POS frontend, API structure) |
| `01`–`06` `<topic>.md` | The full design write-up for that topic |
| `01`–`06` `<topic>--decisions-risks-critique.md` | Its key decisions, risks, changes needed to Sprint 1, disagreements with the brief, and the skeptic's findings |
| `07-integration-…md` | Contradictions between the designs with resolutions, topics nobody covered, the foundation-first list, ranked risks, questions for the owner |

Topics: 01 suite + launcher + permissions · 02 central database + data merge ·
03 box agent + sync · 04 offline trust + money path · 05 iPad ↔ box networking ·
06 operations, scale and delivery.

## Read this first — what the owner has since overruled

See `docs/briefs/OWNER_DIRECTION.md`. In particular, **ignore** recommendations
in these files that exist only because a box might be stolen or tampered with:
per-box/asymmetric band keys, moving certificate issuance off the box, a
separate domain for box names, minimising member data cached on boxes, PIN-only
verifiers, disk encryption. The brief's decisions stand for all of those. The
week-1 hardware spike and the "gated milestones instead of one run" advice are
also overruled.

Still valid regardless: the Sprint 1 foundation gaps (no transactions, no
client-supplied IDs, no box-verifiable token, permission defects), moving sale
and tax logic into shared integer-satang code, the sync design that cannot
lose or duplicate an event, child-safety data rules during the merge, the
1D-barcode wristband constraint, and power/clock on the Pi.

File paths inside these documents use the pre-restructure layout
(`oto-platform/...` and the prototype at the repo root). Today the platform is
the repo root and the prototype lives in `imports/oto-pos/`.
