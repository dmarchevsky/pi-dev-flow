# Changelog

Format: newest first. `Unreleased` collects what's merged but not yet tagged.

## [Unreleased]

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
