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

# dev-flow: ground rules

Only the **flow tool** advances stages; each gate refuses until its exit
criteria hold. Call it with an args array — `["start", "dark-mode"]`,
`["check"]`, `["status"]`.

- **The flow tool is the only invocation.** There is no `flow` shell command —
  never bash, `npx` or a path.
- **You run the gates; the operator says words.** Never ask the operator to
  type a `flow` or `/flow` command. A checkpoint is one word asked in plain
  chat — **Approve? / Verified? / Release? / Finish?** — mentioning that
  *yolo* is an answer, then stop. Their word (or a clear equivalent) in chat →
  run that gate with `--confirmed`. A structured question tool is not chat;
  never infer the answer — the flow tool refuses a `--confirmed` with no
  operator message since the gate asked. A gate returning `NEEDS-OPERATOR <Question?>` means:
  ask exactly that, in chat. `/flow` is the operator's own override; mention it
  only when the session is demonstrably stuck or wrong (and `/reload` when
  `flow version` says this session runs an older build).
- **Stage reports** — open every report with the **stage line the gate
  returned** (`stage line for your report`), pasted as is — the gate builds it
  from state. A checkpoint message then has an event title and, on their own
  lines, **`Done:`** (outcomes; a path or SHA only when useful) and
  **`Next steps:`** — the operator's options as italic verbs, the recommended one ***bold italic***
  first, *yolo* last with what it pre-confirms, then the line
  "or say what to do differently". Plain markdown, never fenced, never a gate
  command.
- **Talk outcomes, not internals.** Chat is for the operator: what changed or
  is wrong, why it matters, in plain words and a few lines. Name a file or
  function only when they must act on it — no code-path walkthroughs or
  internal identifiers. Depth lives in plan.md, commits and the diff; give it
  in full when asked.
- **yolo** at a checkpoint → that gate with `--yolo --confirmed`; run the
  remaining gates back to back without asking, honoring guidance attached to
  the word ("yolo, patch bump", "yolo, no tag" → `--no-version`). Checks,
  guard rules and any `NEEDS-OPERATOR` still apply.
- **One session = one feature** (flow + branch + worktree). `flow start <slug>`
  binds a new one, `flow use <slug>` takes one over; nothing auto-binds, and an
  unbound session cannot edit source.
- **Project `flow-guard` rules** apply at every stage, ahead of dev-flow's own.
  When one fires, show its reason and let the operator decide.
- **Hands off**: never read or write `.dev-flow/<slug>/state.json` (`flow
  status` is your view); never edit `project.md` (it changes through `flow
  init` on the operator's word, or inside a docs/patch flow).
- **A guard blocking you means you skipped a stage or wrote outside your
  feature** — run the gate instead of working around it. A refusal lists what
  is missing: fix that, rerun.
- **Every bash call has a timeout** (class default when unstated); pass
  `timeout` (seconds) for longer runs.
- Abandon a feature with `flow abort <slug>`. The repo's own AGENTS.md and
  project skills still apply.

<!-- dev-flow:core:end -->

## Which stage you are in

The stage injection names the file to read now; this is the map.

| Read | For |
| --- | --- |
| `references/start.md` | `flow init`, starting a feature, modes (`--patch`, `--docs`, `--ui`), merge policy |
| `references/plan.md` | plan — research, clarify, plan file, mockups, Approve? |
| `references/implement.md` | implement — worktree, commits, checks, workers, Verified? |
| `references/pre-release.md` | pre-release — review, docs, changelog + bump, Release? |
| `references/release.md` | release — PR, CI, merge, tag; hands over to finish |
| `references/finish.md` | finish — closing reflection, fold/drop, cleanup |
| `references/reflect.md` | reflections and the roadmap backlog |

Why each gate checks what it checks: [docs/gates.md](../../docs/gates.md).
