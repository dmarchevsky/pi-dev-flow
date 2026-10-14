---
name: dev-flow
description: >
  The repo's enforced feature workflow: plan → implement → release → cleanup →
  deploy, one feature at a time, driven through the flow tool. Read before
  starting ANY feature work in a repo that has a .dev-flow/ directory — the
  stage guards block out-of-stage edits and main-branch git ops, so working
  outside this flow fails at the guard.
---

# dev-flow: the stage-by-stage playbook

A feature moves through stages; only the **flow tool** advances stages, and each
gate refuses until its exit criteria hold. Drive it with the `flow` tool using
args arrays, e.g. `["start", "dark-mode", "--ui"]`, `["test"]`, `["status"]`.
The user can run the same things as `/flow ...`.

Ground rules:

- A pi session is bound to exactly one feature (flow + branch + worktree). Parallel sessions, one feature each, are the model. The binding is automatic when one unfinished feature exists, set by `flow start`, and switched with `flow use <slug>`; with several unfinished features and no binding, gates demand an explicit slug and main-checkout writes stay blocked.
- **Flow is the default for all work.** An unbound session cannot edit source files — start a feature (`flow start <slug>`, main checkout must be on the default branch) or bind an unfinished one (`flow use <slug>`). The only bypass is the operator running `/flow exempt <reason>` themselves: you may *mention* it when a task seems flow-worthy-exempt, never run it for yourself, and suggest `flow exempt off` when exempted work finishes.
- Never read/write `.dev-flow/<slug>/state.json` yourself — it is flow-owned (the guard blocks it anyway). `flow status` is your view.
- `.dev-flow/project.json` is operator-owned: read it for commands (test/build/run), the default branch, worktree path — never edit it; ask the user.
- Also obey the repo's own AGENTS.md and project skills; dev-flow sequences stages, the project defines its conventions.
- If a guard blocks you, you are trying to skip a stage or write outside your session's feature. Stop and run the gate instead of working around it.
- **Checkpoint questions are one verb: Approve? / Verified? / Ship?** The verb doubles as the operator's answer; ask exactly that word at each gate and treat the same verb (or an explicit equivalent) in chat as the answer — then `--confirmed` carries the checkpoint with zero dialogs.

## Start

Repo without `.dev-flow/`? Run `flow init` — it writes `.dev-flow/project.md` from detection immediately, then your job is the review loop: show the operator the file (path + what was detected) and ask **confirm as-is, or change?** If they want changes, ask one short question per unclear knob (default branch, real commands, versioning, checklist items, prose rules — explain each in a line when it isn't obvious), apply their answers with `flow init --write "<content>"` (never hand-edit the file), and re-present until confirmed. With an existing config, `flow init` acts as a **doctor** — discuss its findings and fix them via the same write path; it never overwrites hand edits without confirming. `--yes` = silent draft (CI), `--force` = rewrite from fresh detection, `--draft` = print the file without writing.

`flow start <slug> --ui` when the work touches anything user-visible, else `flow start <slug>`. Slug: lowercase words-dashed. Check `flow status` first to see whether one is already active.

**Patches and chores**: a small change you intend to release (a one-file fix, a docs/version chore) starts with `flow start <slug> --patch` — no plan file; one line of description in chat is the plan. Everything else is identical: approve, worktree, tier-1 checks, verify, tagged release. Never use `--patch` to dodge planning for real features — if the change grows past one line, start the feature properly.

## Stage: plan

1. Research the code needed for the plan (reads are always allowed).
2. Write the plan to `.dev-flow/<slug>/plan/plan.md`: problem, approach, files to touch, test strategy, risks. Keep it reviewable, not exhaustive. Before asking for approval check `git log origin/<default>..<default> --oneline` — local-only default-branch commits fall out of the worktree's base (push them or re-plan around them).
3. **UI flag set?** Build the mockups in `plan/mockups/` and render them — a mockup that was never rendered is not a mockup:   - Write one HTML per screen/state at `plan/mockups/<screen>.html`. Reuse the project's real stylesheet and class names where it exists (relative links work from inside `.dev-flow/`) — fidelity by construction.
   - Find a headless chromium: probe `chromium`, `chromium-browser`, `google-chrome` on PATH; else playwright's shell at `~/.cache/ms-playwright/*/chrome-headless-shell-linux64/chrome-headless-shell`.
   - Render each screen at the widths the project cares for (default: phone 390, desktop 1280):
     `<binary> --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=<width>,<height> --screenshot=plan/mockups/<screen>-<width>.png file://<absolute path to html>`
     (height: pick per-screen, re-render if content clips).
   - Embed every render in plan.md under its section: `![<screen> — phone](mockups/<screen>-390.png)`. The plan is then one self-contained reviewable document.
   - No chromium anywhere? Tell the user and ask — fall back to `*.html`-only plans only with their OK (they can set `mockupGlobs`); never fake or skip a screenshot silently.
4. Tell the user the plan is ready and **stop** — one word: **Approve?** They answer in chat (or run `/flow approve` themselves). When they answered, run `flow approve --confirmed` — **exactly one checkpoint per stage**: a chat answer must never trigger a second dialog. `--confirmed` is only for a literal operator answer, never your inference; without an answer and without interactive UI the gate refuses.

Approval creates the worktree and branch. Until then no code edits are possible. `(ui)`-marked playbook checklist items do not apply to non-UI features — they never appear in prompts or confirmations.

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status` or the injection line). Edit and write outside it are blocked. When other sessions hold other features, their worktrees are theirs — never edit them; attribution guards judge every path by its owning feature.

1. Implement per the approved plan, following project conventions and the **stage guidance injected at stage start** (tier-3 prose from project.md). Commit in the worktree **as you go** — small reviewable commits; a twelve-file monolith saved for the end faces review blind and is not crash-safe.
2. Write appropriate tests for the change as you go (project test framework — see the `test` key / `flow-check` blocks).
3. Run `flow check` — it runs every tier-1 check (test, health, named `flow-check` blocks) and records each. Any later edit in the worktree invalidates checks and the tier-2 confirmation; rerun before verify.
4. UI flag set? Perform an actual visual check with a browser (screenshot or automated visual pass per the project's tooling) — not just a typecheck.
5. Done means **running and healthy, with pre-existing data** — not "compiles":
   - `commands.seedData` (if set) puts real data in place; start the app with the `run` command;
   - the health check (tier 1) must pass — `flow check` covers it (it runs seedData before health);
   - walk the **tier-2 checklist** (`- [ ]` items) with the operator honestly — those can't be scripted;
   - then ask the user **Verified?** When they answer, run `flow verify --confirmed` (no second dialog); interactively they can run `/flow verify` themselves. Fixes requested = iterate and re-verify; that loop is free.

`flow verify` re-runs build, runs the `dev` deploy command when configured (the operator reviews the running dev app — absent config means dev-flow says nothing about dev; the command must **background and exit** — e.g. `docker compose up -d .` — verify waits for it and kills runs past 15 min) and demands every tier-1 check green before the single question; the operator's confirm covers the tier-2 list as a set (hashed; edits reset it) — criteria structured, conversation minimal.

### Handling additions mid-implement

The operator asks for something extra while you are implementing. Do not bounce the flow and do not grow it silently:

- **Same feature, grown scope** → stay at implement. Append to `plan.md` a `**Added mid-stage:**` line describing what was asked and how, then implement it and `flow check` again. Any edit invalidates checks and the tier-2 confirmation, so verify re-covers the addition — nothing can slip past the gate.
- **Different problem** → finish the current feature; it is a new flow (`flow start <new-slug>` after this one ships). Never fold a second feature into one plan, PR and verify — the audit trail is the point.
- **Heavily amended plan needs formal re-review** → show the operator the amended plan and ask them to re-approve it in chat; the verify gate remains the checkpoint. There is no reopen command by design.

## Stage: release

You are now cleared to touch main-repo git state (merge/tag/push on the default branch is allowed only here). **Versioning:** the version manifest in project.json `versioning.file` is the single source of truth; tags are always `versioning.pattern` rendered from it — one number everywhere. If `versioning.file` is unset, stop and clarify the scheme with the user before touching any version; never invent one mid-release. Recommended sequence — run it in the worktree unless noted:

1. `/ponytail-review` the change; fix every **must-have** and **should-have** finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the version manifest (`versioning.file`) to the exact version you will tag — manifest, changelog, and tag must all agree; `flow release-done` verifies the tag exists and is reachable from the default branch.
4. Commit everything on the feature branch, push the branch, open the PR, wait for it to be merged (merge yourself with `gh pr merge` or ask the user).
5. `git fetch` and confirm the merge landed, create the release tag **annotated** (`git tag -a`) and push the ref explicitly (`git push origin v<ver>`) — never `git push --follow-tags`, which silently skips lightweight tags (tags then never reach the remote and CI never publishes). After merge, a tag points at what actually shipped. If CI publishes artifacts from the tag, set `release.artifact` in the playbook so `release-done` verifies the published artifact — it also refuses local-only tags outright.
6. Ask the operator **Ship?** — then run `flow release-done --confirmed` (or interactively; the gate's single dialog covers changelog, tag and PR together). release-done creates the GitHub release from the tag (advisory — a note if gh or a GitHub remote is missing) and, when the worktree is clean and fully merged, removes worktree + branch + feature dir itself: the release is the end of the flow. Skipping the GitHub release is the operator's call only — `--no-github-release` (once) or `release.github = false` in the playbook (always) — never decide it on your own initiative. The artifact check works the same way: `release.artifact` set means every release must show the published artifact; `--no-artifact-check` skips it once, operator's call only.

## Stage: cleanup + deploy (only when release-done couldn't auto-close)

- `["cleanup"]` is reached when the worktree was dirty or commits looked unmerged (squash merges). Fix what it reports, then run it; it asks the operator only on unmerged-looking commits — if it reports those and you have no operator answer, stop and show them.
- `["deploy"]` closes the feature — no questions. Production deployment is manual and out of scope; if the playbook defines a `commands.deployNote` runbook it is printed for reference. Never ask the operator whether a prod deploy happened.

## When things go sideways

- User wants to abandon a feature: `flow abort <slug>` unbinds the session — at plan stage (nothing approved) it removes the feature outright; once a worktree exists, state stays for manual recovery and the exact worktree/branch removal commands are printed.
- A gate refuses: read its reasons — they list exactly what is missing. Fix that, rerun the gate.

## Reflect (your suggestion queue)

When you notice something the playbook or the plugin should improve — drifted commands, gate friction, a plugin bug — park it instead of complaining in chat: `flow reflect "<one-line note>" [--to playbook|plugin|doctor]` (default `playbook`). The operator sees the open count in status and stage context and decides what happens next:

- Only reflect real friction, one line each; never reflect the same issue twice.
- `flow reflect` lists open items. When the operator says "fold them in": draft the playbook update (read current file via `flow init --draft` → adjust → `flow init --write`), then check items off (`- [x]`) in `.dev-flow/reflections.md` with a normal edit — that file is your queue; `project.md` is not.
- `to=plugin` items: offer to file a GitHub issue against dev-flow; the operator confirms.
