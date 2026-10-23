---
name: dev-flow
description: >
  The repo's enforced feature workflow: plan → implement → pre-release →
  release → done, one feature at a time, driven through the flow tool. Read before
  starting ANY feature work in a repo whose .dev-flow/project.md playbook exists — the
  stage guards block out-of-stage edits and main-branch git ops, so working
  outside this flow fails at the guard.
---

<!-- dev-flow:core:start -->

# dev-flow: the stage-by-stage playbook

Only the **flow tool** advances stages, and each gate refuses until its exit
criteria hold. Drive it with args arrays — `["start", "dark-mode", "--ui"]`,
`["test"]`, `["status"]`.

Ground rules:

- **The flow tool is the only invocation.** `flow` is **not a shell command**: a
  bash call named `flow` has no binary behind it (the guard refuses it and names
  the tool call) — never reach for bash, `npx`, or a path to run a gate.
- **You run the gates; the operator says words.** Ask the checkpoint word in
  chat, then run the gate yourself. **Checkpoints are one verb: Approve? /
  Verified? / Release? / Finish?** — ask exactly that word as a **plain chat
  message**, mention that **yolo** is an available answer, and stop. The same
  verb (or an explicit equivalent) in chat is the answer; then run that gate
  with `--confirmed` — zero dialogs, **exactly one checkpoint per stage**. A
  structured question tool is not chat and never
  licenses `--confirmed`; never infer the answer. Never ask the operator to type
  a `/flow ...` command: `/flow` is their **manual override** — surface it only
  when the session is demonstrably wrong, stuck, or claiming a gate result it
  never ran (and `/reload` when `flow version` says this session runs an older
  build).
  - **yolo** at any checkpoint → run that gate `--yolo --confirmed`; every later
    checkpoint is pre-confirmed — run the remaining gates back to back without
    asking, honoring guidance attached to the word ("yolo, create a patch
    version release" → bump patch; "yolo, no tag" → `--no-version`). Checks and
    guardrails stay fully enforced — a flow-guard `confirm` rule still asks the
    operator.
  - At Release?, choosing **no version/tag for this flow** →
    `flow release --no-version --confirmed` — the merge still owes a changelog
    entry under `Unreleased`, which the next versioned release folds under its
    version heading (default is versioned: bump + tag).
- **One session = exactly one feature** (flow + branch + worktree); parallel
  sessions, one feature each, are the model. A session binds **explicitly and
  only**: `flow start <slug>` binds its own feature (main checkout must be on
  the default branch); `flow use <slug>` takes one over. Nothing auto-binds.
  Unbound: gates demand an explicit slug and main-checkout writes stay
  blocked — there is no bypass, an unbound session cannot edit source.
- **Project `flow-guard` rules** (`deny`/`confirm`/`protect`/`forbid` in
  project.md `## global`) apply at **every** stage and are judged ahead of
  dev-flow's verdicts — operator safety rules, not flow discipline. When one
  fires, its reason is the answer: stop, show it, let the operator decide;
  never route around it.
- **`.dev-flow/<slug>/state.json` is flow-owned** — never read or write it;
  `flow status` is your view. **project.md is the operator-owned playbook**:
  read freely, **never edit** — it changes through `flow init --write` on the
  operator's word (`flow doctor` reviews what it lacks).
- **Every bash/shell call states its own `timeout`** or the guard refuses it.
- **A guard blocking you means you are skipping a stage or writing outside your
  feature** — run the gate instead of working around it. The guard reads
  **commands**: quoted text is an argument's prose (a PR body discussing a
  commit is not a commit), and a wrapper that execs its argument
  (`sh -c "git push origin main"`) is judged on its payload.
- Abandon a feature with `flow abort <slug>` — never unbind by hand. A gate
  refusal lists exactly what is missing: fix that, rerun the gate.
- Also obey the repo's own AGENTS.md and project skills: dev-flow sequences
  stages, the project defines its conventions.

<!-- dev-flow:core:end -->

## Which stage you are in

Everything the stage demands lives beside this file, one file per stage: the
session's stage injection names the file to read now, and this is the map.

| Read | For |
| --- | --- |
| `references/start.md` | `flow init` (no `.dev-flow/` yet), mode grants (`--patch`, `--docs`), playbook ownership |
| `references/plan.md` | plan stage — research, clarify, plan file, mockups, Approve? |
| `references/implement.md` | implement stage — worktree, commits, checks, tier-2 list, Verified? |
| `references/pre-release.md` | pre-release — `/flow-review`, docs, changelog + bump, Release? |
| `references/release.md` | release — PR and merge style, tag, forge release, release-done; hands over to finish |
| `references/finish.md` | the close-out after `release-done` — reflect first, Finish?, worktree and branch cleanup |
| `references/reflect.md` | reflections (the suggestion queue) and the roadmap backlog |
