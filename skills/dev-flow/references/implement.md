> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: implement

Work only in the feature's worktree (path in `flow status` and the stage
note). Other sessions' worktrees are theirs.

### Building it

1. Follow the approved plan, the project's conventions and the stage guidance
   injected at stage start.
2. **Commit as you go** — small reviewable commits. `flow verify` refuses a
   branch with no commit (except a release-only flow: a versioned project
   whose code is already on main, unreleased since the last tag).
3. **Write tests as you go.** Scratch files go in `$TMPDIR` / `mktemp` (it is
   `.dev-flow/<slug>/tmp/`, removed at finish) — never a hard-coded `/tmp/...`.
4. `flow check` runs every tier-1 check (test, health with seeded data, named
   `flow-check` blocks) and records them against the worktree; any later edit
   makes them stale, and verify reruns stale ones itself.
5. UI feature → a real browser visual pass, not just a typecheck.
6. Walk the **tier-2 checklist** (`- [ ]` items) with the operator honestly —
   it cannot be scripted.

### Verified? — two calls

1. `flow verify` prepares the review: rebases onto the default branch when
   behind (a conflict aborts and hands it to you), runs build, the `dev`
   deploy and the health probe against what it deployed, and returns
   `NEEDS-OPERATOR Verified?`. It never opens a dialog.
   - Another flow holds the dev port → `NEEDS-OPERATOR Dev port?` with free
     RAM/disk: ask, stop, then re-run with `--port=<n>` or `--replace` on
     their answer. "wait" means wait; a later "proceed" about the feature is
     not a yes to replacing another flow's stack.
   - The health probe retries every 2s up to `healthWait` (default 30s); a
     service that needs a moment is not a broken deploy.
2. Look at the change yourself, **keep the app running**, ask **Verified?**
   — say what changed for the user and how to see it, not which modules
   changed.
   Report opening: **🔨 implement · `<slug>`** (the gate's stage line).
   - Versioned project, playbook `version = ask` (the default): the gate's
     question also asks the **release call** — a patch, minor or major
     release (propose one by the playbook's versioning rule) or merge
     unreleased. Record the kind, not a number, unless the operator names one:
     the gate counts it from the newest tag, so a parallel release moves it.
3. Answer → `flow verify --confirmed` (yolo → `--yolo --confirmed`), plus
   `--version=patch|minor|major` (or `--version=<exact>`) or `--no-version`. If the
   default branch moved since the review deploy it refuses: run `flow verify`
   again first. Fixes → iterate and re-verify; that loop is free.

Verify lands the feature in **pre-release**. A `--docs` feature runs no
project command and asks only the question.

### The feature grew, or a new problem appeared

- **Same feature, more scope** → stay here, append an `**Added mid-stage:**`
  line to `plan.md`, implement, `flow check` again.
- **Different problem** → once the operator agrees to split it, park it:
  `flow roadmap add "<title>" --slug=<new-slug> --brief=<notes>`; finish this
  feature, then `flow start <new-slug>` seeds its plan from the brief. Never
  create `.dev-flow/<new-slug>/` by hand.
- **Plan heavily amended** → show it and get Approve? again in chat; verify
  stays the checkpoint.

### Optional: a fresh-session worker (`flow_stage`)

Delegate a slice when it is in the plan, provable by `flow check`, needs no
operator input, and is big (≈4+ files or heavy reading) — especially past
~40–50% of this session's context. Stay inline for small fixes, mid-debug
work, undecided approaches, anything the operator judges, and the final
wiring before Verified?.

- `flow_stage({ op: "implement", note, label })` — a fresh pi session in the
  worktree edits and commits one slice. It gets the plan, commits and checks
  itself; your `note` is the slice plus any operator answers. On return it
  reruns `flow check` and lists new commits.
- `flow_stage({ op: "review", note })` — a read-only reviewer: findings plus
  `verdict: PASS|FAIL`. Advisory. Run one before Verified? on a non-trivial
  feature, and always when workers wrote most of the code.
- `flow_stage({ op: "reflect", note })` — a read-only review of this session's
  transcripts; finish runs it for you.
- One worker at a time; read each diff before briefing the next; slice along
  plan steps. A worker that fails or stalls → take the slice inline. A
  `model failed: stopReason=error` means the provider is down, not slow.
- Budget (`budgetMin`; default 60 implement, 30 review, 20 reflect): steered
  to wrap up at 75%, asked once for its report when cut.
