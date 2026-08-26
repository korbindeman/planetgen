# Stage docs

One file per stage under `docs/stages/`. The skeleton, status words, and
promote-to-folder rule live in [docs/README.md](../../../docs/README.md).
Do not invent a new layout. Do not put a tagline under the title.

`bun run check:docs` holds links, the seven headings in order, `**Wishes**`
in § Reads, and contract fields against the code.

## Seven sections

Write them as description except **Must not regress** (invariants as
imperative "Do not") and **How to judge it** (commands).

1. **What it does** — the job, the grain, where the code lives. No status
   motto. If two tiers exist, say which one ships and which one is untried.
2. **Reads** — inputs, and **Wishes**. A wish is something this stage
   would use if upstream emitted it. That list is the upstream backlog.
   If a wish is granted, move it to a row in upstream § Hands on. Do not
   leave it in both places.
3. **Hands on** — the contract. A new field is a new row. Downstream
   links here. Do not restate it elsewhere.
4. **Must not regress** — invariants, and things that were tried and
   reverted. Quantify the revert (seed, N, what the picture did). Do not
   delete a line without a picture that shows why.
5. **How it works today** — the mechanism that ships. Not the plan.
6. **Open** — unknown, measured dead ends, yet to try. Name the trial.
   Say what a pass or fail would mean.
7. **How to judge it** — the capture command, what to look at, what not
   to judge from (biome map vs moisture, stats vs picture).

You should not have to read another stage file to know what you can do
in this one.

## Index table vs the file

`docs/README.md` carries **State** for every stage (Live, not started,
schema decided). Repeat that fact in § Open or § What it does as a
plain sentence if it helps. Do not open the file with it as a slogan.

## Other docs

| File | This skill |
| --- | --- |
| `docs/studio.md` | Same prose rules. It wins on harness questions. |
| `docs/ref/` | Lookup. Change when the external tool changes. |
| `docs/history/` | Do not update. |
| `CONTEXT.md` | Vocabulary only. If you add a term, add `_Avoid_`. |
| `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/` | Pointers and one invariant. Do not restate a stage doc. |
