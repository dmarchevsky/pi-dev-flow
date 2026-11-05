> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status`
or the injection line) — writes elsewhere are blocked; other sessions'
worktrees are theirs (attribution guards judge every path by its owning
feature).

1. Implement per the approved plan with project conventions and the **stage
   guidance injected at stage start** (tier-3 prose — your playbook's
   `prose.implement`, or dev-flow's built-in senior-discipline guidance when
   the playbook sets none). Commit in the worktree
   **as you go** — small reviewable commits; a twelve-file monolith saved for
   the end faces review blind and is not crash-safe. The gate enforces the
   habit: `flow verify` refuses while the branch holds **no commit** (checks
   describe the working tree, so nothing committed means nothing reviewed was
   ever recorded; a **release-only flow** — a versioned project whose code is
   already on main, unreleased since the last tag — passes with an empty branch,
   and its bump is the pre-release commit) and every verify line reports
   `commits: N ahead of <default>, M uncommitted path(s)` — uncommitted paths
   never block verify, they are what the operator sees they are approving.
2. Write tests as you go (project framework: the `test` key / `flow-check`
   blocks).
   Throwaway scripts and scratch output go in `$TMPDIR` (or `mktemp`), not a
   hard-coded `/tmp/...`: in a bound session, and in every command a gate runs,
   it is `.dev-flow/<slug>/tmp/`, and finish removes it with the feature. The
   same commands get that dir as `GIT_CEILING_DIRECTORIES`, so a test fixture
   made under it is not inside the checkout (git does not climb out of it).
3. `flow check` runs every tier-1 check (test, health, named `flow-check`
   blocks) and records each against a fingerprint of the worktree; any later
   worktree change makes them stale — verify reruns stale checks itself.
4. UI flag set? An actual browser visual pass (screenshot or the project's
   automated pass) — not just a typecheck.
5. Done means **running and healthy with pre-existing data**, not "compiles":
   `commands.seedData` (if set) puts real data in place, the app starts with
   the `run` command, and the health check passes — `flow check` covers it
   (seedData runs before health) and `flow verify` probes **the deployed app
   again**, because the deploy is what has to be proven. Probes retry every 2s
   up to `healthWait` (default 30s) — a service needing a moment after its
   container starts is not a failed deploy; say so rather than declaring a
   healthy deploy broken. Walk the **tier-2 checklist** (`- [ ]`) with the
   operator honestly — it cannot be scripted. Keep the app **running** when
   you ask **Verified?** → `flow verify --confirmed` — the operator reviews
   the live app, so never tear the test server down before the checkpoint is
   answered (with no `dev` deploy configured, `flow verify` live-re-probes
   `health` itself and refuses while nothing is answering). Checkpoint report: stage line **🔨 implement ·
   `<slug>`** — commits `N ahead, M uncommitted` · tier-1 · tier-2 · deploy/
   health · `branch@sha`, then `Done:`/`Next steps:` per the Stage reports rule. Fixes = iterate and re-verify; that loop is
   free.

### Optional: a fresh-session worker (`flow_stage`)

Big slices can go to a worker so this conversation stays lean; small work and
small fixes are fine inline. **Delegation is a tool, not a rule** — no gate
asks who wrote a commit.

**The rule of thumb:** delegate a slice when it is in the plan, provable by
`flow check`, needs no operator input, and is large enough (≈4+ files or heavy
reading) that doing it here would crowd out the context you need for verify;
otherwise do it inline. The worker starts fresh and is briefed with the plan,
commits and checks, but it cannot see this chat, cannot ask the operator and
holds no gate.

Delegate when most of these hold:
- **Specifiable** — the slice fits a short `note`; its decisions are in
  `plan.md`, not only in chat (write them there first if they are not).
- **Mechanically done** — `flow check` green plus an acceptance criterion you
  can state proves it.
- **Broad** — ≈4+ files, a few hundred lines, or a lot of reading this session
  will not need again (a mechanical sweep, a new module with its tests, a
  migration).
- **Clean boundary** — it does not overlap uncommitted work in progress.
- **Context pressure** — this conversation is past ~40–50% of its window;
  delegating beats compacting away detail.
- **Hands-off** — nothing mid-slice needs the operator.

Stay inline when any of these hold:
- **Small** — one or two files, a review finding, a verify follow-up, an
  operator tweak: the note would cost more than the change.
- **Context already loaded** — mid-debug, you hold the failure; a handoff
  throws that away.
- **Still being decided** — the approach is still moving in chat.
- **Operator-judged** — a UI pass, tier-2 items, anything that ends in a
  question to the operator.
- **Integration** — the final wiring and polish before Verified? is yours: you
  own verify.
- **Exploratory** — "find out why X": what you learn shapes the next step, and
  a worker's summary is lossy.

Running it: one slice per worker, in sequence — read each returned diff before
briefing the next. Slice along the plan's steps, never into half-working
commits. When workers wrote most of the code, run a `review` before Verified?.
A worker that fails or stalls → take the slice over inline rather than
resending the same note.

- `flow_stage({ op: "implement", note, label })` — a fresh pi session in the
  worktree, with read/bash/edit/write, edits and commits one slice. The tool
  adds the facts itself: the absolute plan path, the branch's commits, the
  uncommitted paths and the project checks. Your `note` is just the slice, plus
  any operator answers the worker cannot see. A worker whose turn ends in prose
  is nudged to continue, up to twice. On return the tool reruns `flow check` and
  lists the new commits and anything uncommitted.
- `flow_stage({ op: "review", note })` — a fresh **read-only** reviewer (at
  implement or pre-release): findings plus `verdict: PASS|FAIL`. It is advisory:
  no stamp, no gate waits on it. On a non-trivial feature, run one before
  Verified?. Fix what is real (inline is fine), and re-review only if the fix
  was large.
- `flow_stage({ op: "reflect", note })` — a fresh **read-only** reviewer of this
  session's transcripts (driver + every worker), at any stage; its standard
  moment is finish (see Stage: finish). It returns classified reflection
  findings with fold/drop recommendations and writes nothing.
- One worker at a time per session. The worker holds no flow tool, so gates
  and checkpoints stay with you. Its transcript nests under this session in
  pi's picker.
- Budget (`budgetMin`; default 60 implement, 30 review, 20 reflect): at 75% the
  worker is steered to wrap up and report. A worker cut at the budget is asked
  once, with no tools, for its REPORT, so what it found comes back marked
  partial instead of being lost.

`flow verify` re-runs build, runs the `dev` deploy when configured (the
operator reviews the running app; the gate **prints what it ran** —
`build ran (…)` / `dev ran (…)` / `dev: none configured`; the command must
**background and exit**, e.g. `docker compose up -d .` — verify waits and kills
runs past 15 min), re-runs the health probe **against what it just deployed**
(`seedData` first when configured; a failing probe retries every 2s up to
`healthWait`, then refuses the gate reporting its attempts — a pre-deploy PASS
describes a container that no longer exists; no probe prints
`health: none configured` and the doctor flags it), and demands all tier-1
checks green before the single question. The operator's confirm covers the
tier-2 list as a set (hashed; edits reset it). A `--docs` feature prints
`docs mode: project commands skipped` and asks only the verify question.
Verify lands the feature in **pre-release**.

Mid-stage additions — do not bounce the flow, do not grow it silently:
**this feature grew** → stay at implement, append a `**Added mid-stage:**` line
to `plan.md` (what was asked and how), implement, `flow check` again — edits
make the checks stale, so verify re-covers the addition. **Different problem** →
a spin-off: once the operator agrees to split it, park it in the roadmap with
what you worked out — `flow roadmap add "<title>" --slug=<new-slug>
--brief=<notes>` (or `--brief-file=<path>`; the item records it was split from
this feature) — then finish this feature, and `flow start <new-slug>` (any
session, fresh is fine) seeds the new `plan/plan.md` from the brief. **Never
create `.dev-flow/<new-slug>/` by hand**: a plan dir with no `state.json` is a
ghost no gate picks up (the guard refuses it; `flow start <slug> --confirmed`
adopts one that already exists). Never fold two features into one plan, PR and
verify — the audit trail is the point. **Heavily amended plan** → show it and have the
operator re-approve in chat; verify remains the checkpoint — no reopen command
exists by design.

