> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Start

### No playbook yet: `flow init`

1. `flow init` prints a setup brief: what was detected, then numbered
   questions, each with `detected:`, `accept:` and `why:`.
2. Relay it: group the questions that have an `accept` line as one "keep
   these?", explain the rest in a line each.
3. Apply every answer in one call: `flow init --answers key=value …`. It
   previews the summary and diff and writes nothing — show that.
4. After the operator confirms, re-run the same call with `--confirmed
   --track`.

- Free text (checklist items, prose, `flow-guard` rules): `flow init
  --write-file <path>` with the full file (`flow init --draft` prints it).
- Never hand-edit `project.md`, and never write it before the confirmation.
- CLAUDE.md / AGENTS.md / CONTRIBUTING.md found → propose their stage rules
  as prose; never copy them unasked.
- With a playbook already there, `flow init` is a **doctor**: discuss its
  findings and fix through the same write path. Ghost feature dirs come with
  a delete offer — only on the operator's word. `flow doctor` is the
  read-only version.

### Starting a feature: `flow start <slug>`

Report opening: **💬 pre-flow · new work** — mode proposal + why · detected
knobs · merge-policy state.

- Check `flow status` for an active feature first. Slug: lowercase words,
  dashes.
- **`--ui` is your call, not a grant**: pass it whenever the feature changes
  screens (or the project's skills require mockups for the change). It only
  adds the mockup gate, so don't ask. Turning it **off** is the operator's:
  `flow start <slug> --no-ui --confirmed` at plan, after they say so, and
  aborting a ui feature at plan asks the same.
- **Never ask before `flow start`**: starting only creates the plan stage;
  the operator's first word is Approve?.
- **A mode is a proposal, not a grant**: pass `--patch` or `--docs` on the
  start call when the work fits (no `--confirmed`, no question). The
  operator grants it with their **Approve?** answer — say the mode and why
  when you ask it. They say no → `flow abort`, start again as a normal
  feature.
- **The merge policy is the one grant start asks for**, and only when the
  playbook has none: `flow start <slug> [--ui] [--patch|--docs]
  --merge=<style> --confirmed` on their answer. After a refusal, only a
  message sent later counts, so a `--confirmed` re-run right away is refused
  too. Ask once.
- No merge policy → the gate refuses with `NEEDS-OPERATOR Merge policy?` and a
  suggestion read off the repo's history. Ask: squash, merge, rebase or any.
  The answer is written into `## release` once.
- `--ui` after a plain start, still at plan: `flow start <slug> --ui` from
  the feature's own session — no abort, no question.
- Start warns when this session runs an older dev-flow build than the
  checkout (`/reload` before trusting gate output) and lists playbook gaps.

### Modes

- `normal` — a written plan (`plan/plan.md`) is required before Approve?.
- `--patch` — a small change to release now (one-file fix, version chore):
  no plan file, one chat line is the plan, every other gate identical.
  Approve? reads "approve this as a patch: <one line>".
- `--docs` — docs only: no plan file and no tier-1 checks; worktree and the
  full release stay.
- A change that grows past one line or touches behavior is a normal feature.
