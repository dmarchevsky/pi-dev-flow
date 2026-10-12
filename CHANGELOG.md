# Changelog

Format: newest first. `Unreleased` collects what's merged but not yet tagged.

## [Unreleased]

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
