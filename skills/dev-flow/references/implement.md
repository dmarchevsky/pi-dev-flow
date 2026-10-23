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
5. Done means **running and healthy with pre-existing data**, not "compiles":
   `commands.seedData` (if set) puts real data in place, the app starts with
   the `run` command, and the health check passes — `flow check` covers it
   (seedData runs before health) and `flow verify` probes **the deployed app
   again**, because the deploy is what has to be proven. Probes retry every 2s
   up to `healthWait` (default 30s) — a service needing a moment after its
   container starts is not a failed deploy; say so rather than declaring a
   healthy deploy broken. Walk the **tier-2 checklist** (`- [ ]`) with the
   operator honestly — it cannot be scripted. Then ask **Verified?** →
   `flow verify --confirmed`. Fixes = iterate and re-verify; that loop is
   free.

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

