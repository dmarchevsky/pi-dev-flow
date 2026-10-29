> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status`
or the injection line) — writes elsewhere are blocked; other sessions'
worktrees are theirs (attribution guards judge every path by its owning
feature).

**Delegating the stage's work.** Non-trivial implement is **delegated by default**: run it in
a disposable worker session with `flow_stage` (`stage: "implement"`) — this session keeps its
context for the gates and the checkpoint; stay inline only for a tail you can finish in a
handful of file edits. The
worker gets a fresh context holding the plan, live git and `flow status
--json` — it keeps nothing from this conversation, so put every operator
answer, decision, warning and the exact next action into `note`. The worker
may edit and commit in the worktree but holds no flow tool: gates,
checkpoints and the claim stay with you. When it returns, digest its stage
report (done/files/notes/blockers — a handoff, never a verification), rerun
`flow check` (its edits invalidated tier-1 records), and close the remaining
loose ends yourself. A missing report block or a crashed worker means the
worktree is mid-stage: read the transcript path and (if it names one) the
snapshot `.diff` the result gives. Delegate a real slice, not the tail: do not
delegate a stage you are about to finish anyway. One worker per session at a
time — but **sequential re-delegation is legal and often right**: a second
worker whose `note` says what the first one proved is how a big stage is
sliced. While one runs, the **tool card streams the worker's live output into
your transcript** (current tool, last assistant line, ✓/✗ results, clock against budget,
usage); the footer beats progress, the worker is visible as a
named session in the picker, and `flow_stage { op: "status" }` answers “how’s it
going?” without a model call on any host (the tail also mirrors to `stage-live.log`). Size `budgetMin` to the slice (default 45; verify/reflect default 30): at 75%
the worker is steered to commit and report rather than cut off.

1. Implement per the approved plan with project conventions and the **stage
   guidance injected at stage start** (tier-3 prose — your playbook's
   `prose.implement`, or dev-flow's built-in senior-discipline guidance when
   the playbook sets none). Commit in the worktree
   **as you go** — small reviewable commits; a twelve-file monolith saved for
   the end faces review blind and is not crash-safe. The gate enforces the
   habit: `flow verify` refuses while the branch holds **no commit** (checks
   describe the working tree, so nothing committed means nothing reviewed was
   ever recorded) and every verify line reports
   `commits: N ahead of <default>, M uncommitted path(s)` — uncommitted paths
   never block verify, they are what the operator sees they are approving.
2. Write tests as you go (project framework: the `test` key / `flow-check`
   blocks).
3. `flow check` runs every tier-1 check (test, health, named `flow-check`
   blocks) and records each; any later worktree edit invalidates checks and
   the tier-2 confirmation — rerun before verify.
4. UI flag set? An actual browser visual pass (screenshot or the project's
   automated pass) — not just a typecheck.
5. **The independent checker speaks before the operator does:** `flow_stage { op: "verify" }`
   runs a read-only reviewer (toolset read + bash, standing order *check, don't fix*) over the
   plan and the branch diff; it closes with a `VERIFY REPORT` verdict. Its **PASS is a
   precondition of `flow verify`** and belongs to the tree it read: any edit after it — yours or
   a delegated fixer's — drops it like a tier-1 record, so fix → a **fresh** verify worker;
   a verdict from an interrupted or tree-touching worker never stamps (a reviewer that edits
   voids its own report). FAIL means: fix (or delegate), then rerun a fresh one — the report is
   a handoff, the gate's own rerun is the proof.
6. Done means **running and healthy with pre-existing data**, not "compiles":
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
   free — but every fix re-owes the verify worker's PASS.

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
invalidate checks and the tier-2 confirmation, so verify re-covers the
addition. **Different problem** → finish this feature first, then a new flow
(`flow start <new-slug>` after this one ships); never fold two features into
one plan, PR and verify — the
audit trail is the point. **Heavily amended plan** → show it and have the
operator re-approve in chat; verify remains the checkpoint — no reopen command
exists by design.

