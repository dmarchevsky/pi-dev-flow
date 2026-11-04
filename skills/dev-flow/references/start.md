> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Start

**No `.dev-flow/`?** `flow init` analyzes the repo and prints a **setup
brief**: what was detected plus one numbered question per knob, each with
`detected:` (what was found), `accept:` (the answer that keeps it) and `why:`.
Relay them: group the ones with an `accept` line as one "keep these?", and
explain the rest in a line each. Apply **every** answer in one call:
`flow init --answers key=value …` (targeted edits onto the draft; unknown
keys are refused). It **previews** the summary and diff and writes nothing.
Present that, and only after the operator confirms, re-run the same call with
`--confirmed --track` (validated write + the playbook commit). Free-text
additions (checklist items, prose, `flow-guard` rules) go through
`flow init --write-file <path>` with the full file (`flow init --draft` prints
it). Never hand-edit, and never write project.md before the confirmation.
Detection names CLAUDE.md / AGENTS.md / CONTRIBUTING.md when present: propose
their stage rules as prose, never copy them unasked. **With existing config** `flow init` is a **doctor**: discuss
findings, fix via the same write path, never overwrite hand edits without
confirming; ghost feature dirs (a `plan/` whose `state.json` is gone) come
with a delete offer — surface the dialog, never delete on your own.
`flow doctor` runs the same probes **read-only** (prefer it when you only want
findings); `--force` re-detects from scratch, `--draft` prints without
writing.

`flow start <slug> [--ui --confirmed]` — `--ui` adds a rendered-mockup gate to plan, so it is
operator-granted like `--patch`/`--docs`: propose it when screens change, start with it only on their word;
slug lowercase words-dashed; check `flow status` for an active feature first. Screens turned out to
change after a plain start (the operator asks for mockups)? While the feature is still at plan,
`flow start <slug> --ui --confirmed` from its session switches the mockup gate on; past plan it refuses.

`flow start` **preflights** before it creates anything: it warns when this session runs an older dev-flow
build than the checkout (`/reload` before trusting gate output), prints the playbook gaps `flow doctor`
would report, and **refuses while the playbook has no merge policy**. That refusal is a question: ask the
operator how a merged PR should land on the default branch — `squash`, `merge` (a merge commit), `rebase`,
or `any` (no policy) — with the suggestion the refusal read off their own history, then re-run
`flow start <slug> --merge=<style> --confirmed`. The gate writes the answer into `## release` (single-line
insert, validated, `.bak` kept) and never asks again. Never pick the style yourself and never write
`project.md` by hand to get rid of the question. Pre-flow reports open with **💬 pre-flow · new work** —
mode proposal + why · detected knobs · merge-policy state (💬 = "operator, your turn": a grant or
answer is pending).


---

### Moved here from the ground rules

Modes are carried by `flow start` and belong to it:

- **Modes are proposed, never taken**: every `flow start` carries the mode and
  a one-line why; the operator grants it in chat and the gate refuses
  `--patch`/`--docs` until the grant is anchored with `--confirmed` — never
  self-grant. `normal` (default): a written plan is enforced (`plan/plan.md`
  before Approve?). `--patch`: a small change you intend to release
  (one-file fix, version chore) — no plan file, one chat line is the plan,
  everything else identical. `--docs`: docs-only — no plan file **and no
  tier-1 checks** (build/lint/test); worktree discipline and the full release
  stay. A change that grows past one line or touches behavior is a normal
  feature, not patch/docs.


Playbook ownership, in full:

- `.dev-flow/<slug>/state.json` is flow-owned — never read or write it;
  `flow status` is your view. **project.md is the operator-owned playbook**
  (test/build/run commands, default branch, forge, worktree path, safety
  rules): read freely, **never edit** — changes go through `flow init --write`
  on the operator's word. In-life playbook updates run as a docs flow:
  project.md is editable only inside a docs/patch flow's worktree and is
  committed to git like any file.
