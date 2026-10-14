# Changelog

Format: newest first. `Unreleased` collects what's merged but not yet tagged.

## [Unreleased]

### Added

- **`flow doctor` — the doctor as an endpoint, not a side effect of `flow init`.** Findings on demand: playbook drift and dead commands/scripts, ghost feature dirs, orphan worktrees and branches, open reflections — printed as `doctor: N finding(s)` plus one line each, or `doctor: no findings — playbook, flow state and git layout are consistent`. It writes nothing, asks nothing and deletes nothing, so an agent or a CI job can run it at any stage with no flow bound; `flow init` stays the fix path, the one that can write.

### Changed

- `flow init` **without a UI prints the findings it computed** (the `--yes`/CI path said "the doctor ran" and showed nothing).
- `flow status` runs the cheap probes even when no feature is unfinished — it used to return `no features` before reaching them — and points at `flow doctor` for the full list.

## [0.19.1] - 2026-10-14

### Added

- **The doctor finds ghost feature dirs and offers to remove them.** A `.dev-flow/<slug>/` holding a `plan/` with no `state.json` — a feature closed by hand before auto-close existed, or an interrupted `flow start` — was invisible: `flow status`, the guards and auto-bind all key off `state.json`, so the clutter was only findable by eye. `flow status` now counts it as a doctor finding and `flow init` offers to delete exactly those directories, one confirm, with the plan files called out as unrecoverable; decline keeps them, and with no UI nothing is deleted (the finding says how to do it by hand). Live features, `cleanup`/`deploy` leftovers and `project.md` are untouched by construction.

### Changed

- The status warning reads `⚠ doctor: N finding(s) — run flow init` instead of `⚠ project.md:`, since findings now cover flow state as well as the playbook.
- Internal: `loadProject(dfDir)` dropped its never-read `root` parameter.

## [0.19.0] - 2026-10-14

### Added

- **`flow-guard` — the playbook carries the project's own safety rules**, so an adopting project can delete its own guard extension. A ` ```flow-guard ` block in `## global` of project.md holds `deny`/`confirm` rules (JS regex over one shell segment of a bash command) and `protect`/`forbid` rules (a repo-relative edit/write path; a directory covers its subtree, files that do not exist yet included). `deny`/`forbid` block outright; `confirm`/`protect` ask the operator and block when no UI is present — a hidden confirmation is not a confirmation. Every rule carries a ` :: <why>` reason that shows up verbatim in the block, and a bad regex is a hard finding so `flow init --write` refuses the file. Enforcement reuses the existing tool-call guards (rules cover `docker`/`gh`/everything, not only git), runs at every stage, and is not lifted by `flow exempt`. Read-only segments are skipped, so `grep "git push --force" docs/` searches instead of pushing.

### Fixed

- **`flow init` no longer destroys a hand-written project.md.** The doctor's refresh regenerated the file from detection + config, which silently reverted hand-set keys (`versionTag = {version}` → `v{version}`) and deleted every tier-3 prose line and extra checklist item — and its confirm could be answered by an agent driving `flow init` through the `flow` tool. The refresh is now refused outright when the current file has lines a regenerated draft cannot reproduce: it prints the findings plus the lines it would drop. `--force` stays the deliberate overwrite.
- **`commands.setup` now runs** — once, inside a freshly created worktree at `approve`, which is where `cp docker/.env` + `bun install` belong; a failing setup fails the gate instead of approving an unusable worktree. `commands.run` was documented as if executed and never is: it is now documented as advisory (the agent starts the app with it for the running-and-healthy walk).
- **Doctor stopped flagging worktree-relative paths forever**: command arguments are only probed as repo-root paths, so `cp -n ../../docker/.env` — correct relative to the worktree the check runs in — is no longer reported as a missing file.

## [0.18.0] - 2026-10-13

### Added

- **Compact-aware**: when context nears pi's auto-compaction threshold, dev-flow now compacts *itself* at a safe point — right after a gate wrote state to disk, or when a run settles — with flow-aware summary instructions (slug/stage-aware; keeps operator answers, uncommitted-change rationale and next action verbatim). It never self-compacts while chat is the state: an open tier-2 dialog or a plan discussion not yet in `plan/` blocks it. If pi force-compacts anyway (threshold/overflow while a feature is bound), a pacing note lands in `reflections.md` for the operator — advisory, never a gate.

## [0.17.0] - 2026-10-14

### Changed

- First `flow init` writes `.dev-flow/project.md` immediately — the pre-write editor/confirm dialogs are gone. The review loop moved onto the file: confirm as-is, or say what to change; the skill tells the agent to ask one short question per knob, apply answers via `flow init --write`, and re-present until confirmed

### Kept

- Doctor mode (existing playbook) still confirms before refreshing — it must never silently overwrite hand edits; `--draft` prints without writing; `--force` remains the deliberate overwrite

## [0.16.1] - 2026-10-14

### Fixed

- `flow init` confirm dialog is now human: one line per phase with real values (commands quoted, checklist items and guidance verbatim, rendered tag pattern, whether a GitHub release is created, which artifact check runs) instead of parser notation (`set: file, pattern · prose`); states plainly what Cancel does and where to read the full file first
- `flow init --draft` — referenced by the docs since v0.9 but never implemented — now prints the draft (or the current file in doctor mode) and writes nothing; tool help lists `--draft` and `--patch`

## [0.16.0] - 2026-10-14

### Added

- `flow start <slug> --patch` — chore releases with reduced paperwork: no plan document (the one-line start description is the plan); approve, worktree discipline, tier-1 checks, verify, tagged release and audit trail unchanged. Status marks patch features with an amber marker. (Folded reflection: release-patch shortcut)

## [0.15.2] - 2026-10-14

### Changed

- `flow abort` at plan stage (nothing approved) removes the feature dir outright — a kept-over plan-stage state dir stayed "unfinished" forever and the one-unfinished-feature auto-bind resurrected the ghost into every unbound session

### Fixed

- Per-segment git guard: each git command in a chain is judged by the branch of the directory it actually runs in (incl. its own `git -C`); previously the last `cd` in a compound command set the verdict for all git calls, blocking legitimate worktree commits (hit two real releases) and weakening mixed-chain checks symmetrically
- `git checkout -b feat/x` in the main checkout is now blocked like a plain checkout of a feature branch
- `flow init` reports when an existing pre-commit hook prevents installing the dev-flow hook (main commits outside Pi are then unguarded)
- `flow` tool description matches its actual subcommands (shared const with the help line)
- Docs: the `dev` command must background and exit — `flow verify` waits for it (15-min cap)

## [0.15.1] - 2026-10-14

### Changed

- One-word checkpoints: gates ask **Approve? / Verified? / Ship?** — the verb doubles as the operator's answer; dialogs carry the same verb with just enough context, cleanup still asks only when unsafe, deploy stays silent

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
