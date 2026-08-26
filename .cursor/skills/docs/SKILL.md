---
name: docs
description: Write and rewrite planetgen documentation in clear Simple English, keeping research hedges and quantified evidence. Use when writing or editing docs/, stage files, docs/README.md, docs/studio.md, or AGENTS.md pointers; when the user mentions simple-english, hedges, open questions, a stage contract, or a stage doc.
---

# Docs

Planetgen docs are **active research**, not a finished-pipeline manual.
Apply the **simple-english** skill in pragmatic mode, with the exceptions
below. Words come from `CONTEXT.md`. UI copy is `studio-style`, not this
skill.

Do not update `docs/history/`. Those files are dated on purpose.

## Three claims, keep them distinct

Every assertion is one of these. Do not blur them.

| Claim | Write | Do not write |
| --- | --- | --- |
| **Known** | The measurement, the seed, the picture, the count | A vibe ("looks wrong", "the live question") |
| **Unknown** | The gap, by name | A slogan that hides the gap |
| **Yet to try** | The trial, what it would settle, cost if known | "Do it first" as a command with no reason |

Status words in [docs/README.md](../../../docs/README.md) map onto this:
**decided** = known (reopen only with a picture). **recommended** = yet
to try (one trial). **open** = unknown (no chosen answer).

## Hedges carry status. Keep them.

Simple-english bans `should` / `would` / `could` / `may` / `might`.
**This skill allows them** when they mark research status. Flattening
them invents a finished pipeline.

| Hedge | Use for | Do not use for |
| --- | --- | --- |
| **must** | An invariant | A target or a guess |
| **should** | A target or a recommendation | An invariant (`must`) |
| **would** | Unbuilt or counterfactual | Something that already runs |
| **could** / **may** / **might** | Possibility | A measured result |
| **ideally** | A preferred method, not required yet | Filler |
| **likely** | A first guess before a trial | A decided mechanism |

**Before:** A GCM supplies all four channels from physics.
**After:** A GCM would supply all four channels from physics. That trial
is not run.

`has been` / `have been` are legal when they mark an untried state
("Nothing has been built or tried").

## Strip attitude, not uncertainty

Remove taglines under the title. Status belongs in the index table, in
§ Open, or in a status word — not in a motto.

Remove clauses that add no fact: "the whole point", "the one thing",
"this is the live question", "worth noting". Keep "worth doing first"
only when it ranks a named trial against other work.

Keep every measurement, dead end, field name, and reverted attempt.

## Structure

Short sentences. One fact per sentence. Complete grammar. No
contractions. No semicolons. Active voice. `CONTEXT.md` terms only.

Stage files: [stage-docs.md](stage-docs.md). After a stage edit, run
`bun run check:docs`.

## Self-check

- Each claim is known, unknown, or yet to try — and reads as that.
- A hedge that marked status is still there.
- A number, seed, or picture sits next to each "known".
- No tagline. No synonym for a `CONTEXT.md` word.
