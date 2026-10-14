# Changelog

Format: newest first. `Unreleased` collects what's merged but not yet tagged.

## [Unreleased]

## [0.15.0] - 2026-10-14

### Added

- `release.artifact` playbook key: `release-done` verifies the published artifact (any command — `docker manifest inspect`, registry `curl` — with `{version}`/`{tag}` placeholders) after the tag lands on origin; failure blocks the release; `--no-artifact-check` skips once (operator's call, audited). Set = every tag must show its artifact; unset = none

### Changed

- `release-done` refuses local-only tags: the tag ref must exist on `origin` (`git ls-remote`) when a remote is configured — `git push --follow-tags` silently skipping lightweight tags was producing releases that never existed upstream
- Doctor flags an implement stage whose tier-1 gates nothing (no test, no health, no `flow-check`)
- SKILL: annotated tags with explicit `git push origin v<ver>` (never `--follow-tags`); incremental worktree commits instead of a monolith at review time; plan-stage check for local-only default-branch commits that would fall out of the worktree base

## [0.14.2] - 2026-10-12

### Added

- GitHub release opt-out valves: playbook key `release.github = false` never attempts `gh release create` (self-hosted or Releases-unused repos); `flow release-done --no-github-release` skips it once, recorded in the audit line; the single release question states whether a GitHub release will be created; SKILL restricts skipping to explicit operator decisions

## [0.14.1] - 2026-10-12

### Changed

- SKILL: handling additions mid-implement — same-feature scope grows in place (plan.md amended with an "Added mid-stage:" line, stay at implement; edit invalidation makes verify re-cover it); a different problem becomes a new flow instead of a folded second feature; formal re-review of an amended plan is a chat re-approval — no reopen gate by design

## [0.14.0] - 2026-10-12

### Changed

- `flow release-done` creates the GitHub release for the verified tag (title = tag, notes = tag annotation) — advisory: missing gh, no GitHub remote or an existing release prints a note and never blocks
- A clean release now closes itself: when the worktree has no uncommitted changes and nothing unmerged, `release-done` removes worktree, branch and feature dir in one step — zero operator actions after merge; dirty or unmerged-looking worktrees still stop at `flow cleanup` and ask
- `flow cleanup`/`flow deploy` remain as the not-clean / manual path

## [0.13.0] - 2026-10-12

### Changed

- One crisp question per checkpoint: gate confirms are single-line questions (multi-line markdown blobs rendered unreadably where clients collapse newlines); plan and checklist detail live in files
- Tier-2 checklist items support a `(ui)` marker in project.md — UI-only items vanish entirely (dialog, injection, confirmation hash) for non-UI features; non-UI work is no longer asked about mockups or visual passes
- `--confirmed` operator-presence flag (approve/verify/release-done/cleanup): when the operator answered the stage question in chat, gates proceed without a second dialog and record the audit line — one checkpoint per stage
- New `dev` implement-stage command: `flow verify` deploys to dev first (recorded tier-1 check) so the operator reviews the running app; unconfigured verify says nothing about dev (the dead "no run command configured" text is gone)
- `flow release-done` asks the single release question (changelog, tag and merged PR covered by one answer)
- `flow cleanup` is silent when the worktree is safe and asks only when commits look unmerged; `flow deploy` never asks — production deploy is manual and out of scope

### Fixed

- Approve/verify dialogs no longer present UI checklist items to non-UI features

## [0.12.0] - 2026-10-12

### Added

- `reflect` — the agent's suggestion queue: `flow reflect "<note>" [--to playbook|plugin|doctor]` appends one line to `.dev-flow/reflections.md` (drifted commands, gate friction, plugin bugs), `flow reflect` lists open items. The open count surfaces in `flow status`, stage injections and the init doctor; fold-in goes through the existing validated `playbook --write` path and items are checked off with a normal edit. Advisory by design — reflections never gate anything, and `project.md` keeps its operator-only contract

## [0.11.0] - 2026-10-12

### Changed

- Push guard is now ref-aware: each push's refspec is parsed (deletes judged by source, `HEAD` = current branch, `--mirror` worst-case) and bare names resolved against `refs/tags` — only pushes that write the default branch require stage `release`; tag pushes and feature-branch pushes pass from any stage. The old substring heuristic (which blocked `git push origin v1.0` and anything mentioning `main` in a chained command) and the park-`.dev-flow` tag-push workaround are gone

### Fixed

- Draft playbooks no longer inject a placeholder health check (`curl localhost:3000/healthz`) — in repos without a server it was an always-red tier-1 gate blocking verify forever
- Doctor refresh no longer drops explicit `flow-check` blocks — every tier-1 check is carried through regeneration (previously the refreshed playbook silently lost teeth)
- `.gitignore` entry `node_modules` matches symlinked `node_modules` (trailing-slash pattern didn't)

## [0.10.0] - 2026-10-12

### Added

- **Flow by default**: in a repo with `.dev-flow/`, an unbound session can no longer touch source files — every request goes through `flow start`/`flow use` unless the operator exempts the session with `/flow exempt <reason>` (session-scoped, survives resume, `flow exempt off` clears, `◆ exempt` shown in the status bar; `project.md`/`state.json` stay protected even when exempt). Unbound sessions get the posture injected at turn start, including a flag when the main checkout isn't on the default branch
- Doctor (init) git-consistency findings: orphan worktrees, orphan feature branches, and features whose worktree vanished; `flow abort` now prints the exact commands to remove worktree + branch

### Changed

- `flow start` refuses when the main checkout is on another branch (`--force` to override) — features must base on the default branch
- Worktrees are created from `origin/<default>` explicitly (fallback `<default>`) — never from whatever HEAD the main checkout happened to sit on
- The agent cannot check feature-pattern branches out in the main checkout; feature branches are only usable inside their own worktree
- `flow use` prints the bound feature's worktree path

## [0.9.0] - 2026-10-12

### Added

- `project.md` — the operator playbook in Markdown, three tiers by notation: ` ```flow key = value ` blocks and named ` ```flow-check <name> ` blocks are tier 1 (gates run every check via `flow check`, record pass/fail, worktree edits invalidate); `- [ ]` checklist items are tier 2 (confirmed as a hashed set in gate confirms — edits reset the confirmation); stage prose is tier 3 (injected to the agent at stage entry). Unknown stages/keys warn, never fail; broken syntax rejects with line numbers. `project.json` remains as legacy base (project.md overrides; doctor flags having both)
- `flow init` v2 — advisory dialogue instead of the scripted wizard: fresh repos draft from detection and confirm once; `--draft` / `--write "<content>"` is the validated agent path (line-pointed rejection); on an existing file init becomes the **doctor** (command drift, dead script files, missing/unparseable version manifest, dual configs, missing health check — file probes only, never runs project commands) offering a refresh that keeps configured values
- Init review UX: TUI opens the draft in a multi-line editor (review *and* edit before anything is written); elsewhere a per-stage digest confirms instead of a raw markdown dump; every write prints how to change the playbook afterwards
- `flow check` runs the whole tier-1 set (auto-includes configured test/health commands) and records each result

### Changed

- Gates generalize to named checks: `flow verify` demands every tier-1 check green plus the tier-2 confirmation before asking the operator; `flow status` flags pending doctor findings
- Git ops in bash gates are judged by the branch of the directory git actually runs in (`git -C`, preceding `cd`), so worktree work no longer misjudges against the session root; cleanup unstuck for worktree-hosted releases

### Removed

- The interactive init wizard (`--step` machinery) — replaced by draft/discuss/write; `flow init --yes` and `--force` keep the scripted fast paths

## [0.8.0] - 2026-08-05

### Added

- `flow init --force`: overwrite an existing `project.json` with fresh detection (silent fast path; destructive reset for a misconfigured repo)

### Changed

- `flow init --yes` never overwrites an existing config, even headless; the "already exists" note now advertises `--force`

## [0.7.0] - 2026-08-04

### Added

- Interactive `flow init` wizard: walks the operator through every setting (default branch, commands, version manifest + tag pattern, worktree dir, main-hook) showing `value [configured|detected|default]` — keep/change/remove per item, pick manifest from candidates; nothing writes before a final diff confirm, Esc aborts unchanged
- Re-running `flow init` on an initialized project is a review-and-edit flow (existing config wins over re-detection); `flow init --yes` and headless sessions keep the silent fast path

### Fixed

- Default branch is never proposed from a feature branch (origin/HEAD → current branch only if it looks default-like → "main"), preventing a hooked-up repo from blocking its own feature branches

## [0.6.0] - 2026-08-04

### Added

- Healthy local run as implementation-complete criteria: optional `commands.seedData` (ensure pre-existing data) and `commands.health` (must exit 0 only when the app is up locally with real data); new `flow health` gate records the check; `flow verify` now requires green test AND health (when configured) checks plus build; worktree edits invalidate both checks — "running and healthy" is enforced, not honor-system
- Versioning approach: `flow init` detects the version manifest (`VERSION` → `package.json` → `Cargo.toml` → `pyproject.toml`) into `versioning.file`, with an explicit "clarify with the operator" report line when none exists; `versioning.pattern` (default `v{version}`) derives the release tag from the manifest; `flow release-done` refuses unless that tag exists and is reachable from the default branch — manifest, changelog and tag must agree

### Changed

- Release playbook and status hints now derive the tag from the version manifest (`flow next` shows the exact bump + tag to perform)

## [0.5.0]
### Added
- Session-scoped flows: a pi session binds to one feature (persisted per session branch, restored on resume/fork). `flow start` binds, new `flow use <slug>` switches; a lone unfinished feature binds automatically, ambiguous sessions must bind or pass explicit slugs. One feature per session, many sessions per repo, is now the supported concurrency model.
- Write enforcement is by path attribution: every write is judged by the stage of the feature owning that worktree, whichever session attempts it — parallel sessions cannot clobber each other or write into plan-stage features.
- Release playbook requires the project's version manifest (`package.json`/`pyproject`/`Cargo.toml`/`VERSION`) to be bumped to the exact tagged version in the same release; dev-flow's own manifest (drifting at 0.1.0) is re-synced here.

### Removed
- `.dev-flow/.current` (repo-global pointer) — superseded by session bindings; `flow init` migrates it away.

## [0.4.1]
### Fixed
- Detail panel check timestamps now show local time instead of UTC.

## [0.4.0]
### Added
- Flow status in the pi status bar: `◆ <slug> ▸ <stage>` in the footer, stage-colored, `✗` when a recorded check is failing; cleared when no feature is active. Refreshed at session start, every turn end, and after each gate.
- `ctrl+,` opens a detail panel (slug, stage, branch/worktree, approvals, checks with timestamps, next step); Esc closes. Non-TUI modes degrade to notifications.

## [0.3.0]
### Changed
- UI features now gate on **rendered mockup screenshots**: default `mockupGlobs` is `["*.png"]`, and an `--ui` plan without renders under `plan/` cannot be approved. HTML sources stay encouraged but ungated.

### Added
- The `dev-flow` skill documents the mockup workflow: HTML sources + renders in `plan/mockups/`, headless chromium probe (system chrome → playwright `chrome-headless-shell`), per-width renders embedded in plan.md (`![screen — width](mockups/x.png)`) so approval is one browsable document, and an explicit no-chromium fallback that never fakes a screenshot.

## [0.2.0]
### Added
- `flow init` analyzes the project and writes a starter `.dev-flow/project.json` — default branch from git, package manager from `packageManager`/lockfiles, `test`/`build`/`run` from npm scripts, or cargo/go/python (uv/poetry/pytest) conventions. Existing config is never overwritten; the report shows what was guessed and what was left empty.
- `.dev-flow/` now ignores itself and everything under it via a folder-local `.gitignore` containing `*`.

### Changed
- `flow init` no longer edits the tracked root `.gitignore`.

## [0.1.0]
- Initial release: stage gates (`start`/`approve`/`test`/`verify`/`release-done`/`cleanup`/`deploy`) over a per-feature state machine, tool-call guardrails (main-branch protection, worktree confinement, untouchable state), per-turn stage context, the `dev-flow` agent skill, and the main-branch `pre-commit` hook.
