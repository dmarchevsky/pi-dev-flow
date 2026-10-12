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
- Never read/write `.dev-flow/<slug>/state.json` yourself — it is flow-owned (the guard blocks it anyway). `flow status` is your view.
- `.dev-flow/project.json` is operator-owned: read it for commands (test/build/run), the default branch, worktree path — never edit it; ask the user.
- Also obey the repo's own AGENTS.md and project skills; dev-flow sequences stages, the project defines its conventions.
- If a guard blocks you, you are trying to skip a stage or write outside your session's feature. Stop and run the gate instead of working around it.

## Start

`flow start <slug> --ui` when the work touches anything user-visible, else `flow start <slug>`. Slug: lowercase words-dashed. Check `flow status` first to see whether one is already active.

## Stage: plan

1. Research the code needed for the plan (reads are always allowed).
2. Write the plan to `.dev-flow/<slug>/plan/plan.md`: problem, approach, files to touch, test strategy, risks. Keep it reviewable, not exhaustive.
3. **UI flag set?** Build the mockups in `plan/mockups/` and render them — a mockup that was never rendered is not a mockup:
   - Write one HTML per screen/state at `plan/mockups/<screen>.html`. Reuse the project's real stylesheet and class names where it exists (relative links work from inside `.dev-flow/`) — fidelity by construction.
   - Find a headless chromium: probe `chromium`, `chromium-browser`, `google-chrome` on PATH; else playwright's shell at `~/.cache/ms-playwright/*/chrome-headless-shell-linux64/chrome-headless-shell`.
   - Render each screen at the widths the project cares for (default: phone 390, desktop 1280):
     `<binary> --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=<width>,<height> --screenshot=plan/mockups/<screen>-<width>.png file://<absolute path to html>`
     (height: pick per-screen, re-render if content clips).
   - Embed every render in plan.md under its section: `![<screen> — phone](mockups/<screen>-390.png)`. The plan is then one self-contained reviewable document.
   - No chromium anywhere? Tell the user and ask — fall back to `*.html`-only plans only with their OK (they can set `mockupGlobs`); never fake or skip a screenshot silently.
4. Tell the user the plan is ready and **stop**. They review and run `/flow approve` themselves — you may run `flow approve` only when the user explicitly told you they approve; the gate still asks them to confirm interactively.

Approval creates the worktree and branch. Until then no code edits are possible.

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status` or the injection line). Edit and write outside it are blocked. When other sessions hold other features, their worktrees are theirs — never edit them; attribution guards judge every path by its owning feature.

1. Implement per the approved plan, following project conventions.
2. Write appropriate tests for the change as you go (project test framework — see project.json `commands.test`).
3. Run `flow test` — it runs the project's test command and records the result. Any later edit in the worktree invalidates the check; rerun before verify.
4. UI flag set? Perform an actual visual check with a browser (screenshot or automated visual pass per the project's tooling) — not just a typecheck.
5. Build (`commands.build`) and run locally (`commands.run`), then **ask the user to verify** and stop. They run `/flow verify`; only they can confirm it works.

## Stage: release

You are now cleared to touch main-repo git state (merge/tag/push on the default branch is allowed only here). Recommended sequence — run it in the worktree unless noted:

1. `/ponytail-review` the change; fix every **must-have** and **should-have** finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the version if configured (project.json `release.changelog` / `release.tagPattern`). Bump the project's own version manifest to the exact version you will tag — `package.json` `version`, `pyproject.toml`, `Cargo.toml`, or a `VERSION` file, whatever this repo uses. The manifest and the tag must never diverge; cut them from the same number in the same release.
4. Commit everything on the feature branch, push the branch, open the PR, wait for it to be merged (merge yourself with `gh pr merge` or ask the user).
5. `git fetch` and confirm the merge landed, create the release tag (after merge — a tag points at what actually shipped) and push it.
6. Run the flow tool with `["release-done"]`.

## Stage: cleanup + deploy

- `["cleanup"]` safety-checks the worktree (clean, no unmerged commits) and removes worktree + branch after operator confirmation. If it reports unmerged commits, stop and show the user — do not force.
- `["deploy"]` prints the manual deploy runbook (project.json `commands.deployNote`) and records the operator's confirmation; then the feature directory is deleted. Deployment itself is manual and is the user's action.

## When things go sideways

- User wants to abandon a feature: `flow abort <slug>` unbinds the session; remove the worktree/branch manually.
- A gate refuses: read its reasons — they list exactly what is missing. Fix that, rerun the gate.
