> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Before a flow exists (pre-plan)

A feature request arriving in an **unbound** session gets analysis, not
scaffolding — this is the only phase with **no writes at all** (guards refuse
checkout writes unbound anyway): read the code the request touches (reads are
always free), then bring back to chat: findings, the real unknowns, your
**open questions** and a proposed **direction**, with a proposed slug and mode
and its one-line why. **Ask the operator to start the flow** — only on their
word do you `flow start <slug>` (they grant any `--patch`/`--docs` mode at the
start gate). The direction lives in chat until the plan stage writes and owns
`plan.md`.

## Start

**No `.dev-flow/`?** `flow init` analyzes the repo and prints a **setup
brief**: what was detected plus one question per knob detection cannot decide
(forge github/gitlab/self, version manifest and tag convention, automatic
forge releases, registry artifacts like Docker Hub, the real
test/build/lint/health commands, tier-2 items, prose). Relay the questions
(one per knob, detected default shown, explain in a line when not obvious),
fill `flow init --draft` with the answers, present it, then apply
`flow init --write "<content>"` **only after the operator confirms** — never
hand-edit, never write project.md before the confirmation. The playbook
belongs in git; the chore is legal unbound:
`git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"`
(force — a tracked file outranks a `.gitignore` of `.dev-flow/`; the env
prefix lets the installed hook accept a main commit that only touches the
playbook). **With existing config** `flow init` is a **doctor**: discuss
findings, fix via the same write path, never overwrite hand edits without
confirming; ghost feature dirs (a `plan/` whose `state.json` is gone) come
with a delete offer — surface the dialog, never delete on your own.
`flow doctor` runs the same probes **read-only** (prefer it when you only want
findings); `--force` re-detects from scratch, `--draft` prints without
writing.

`flow start <slug> [--ui]` — `--ui` whenever anything user-visible is touched;
slug lowercase words-dashed; check `flow status` for an active feature first.

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
  committed to git like any file. A leftover `project.json` is never read; the
  doctor flags it.
