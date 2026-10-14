# dev-flow

An enforced feature workflow for [Pi](https://pi.dev), shipped as a pi package. One feature at a time:

```
plan → implement → pre-release → release → done
```

The flow lives in **this repo**; each project only gets a gitignored `.dev-flow/` folder. State is a file, checkpoints are gates, and the guardrails are enforced by the harness — not by prose the model may forget.

## Install

```bash
pi install git:<your-host>/dev-flow        # or: pi install ./dev-flow  (local)
```

In each project repo, once:

```
/flow init
```

Creates `.dev-flow/` — which **ignores itself and everything under it** via its own
`.dev-flow/.gitignore` containing `*` (no tracked file is touched) — and **drafts a project.md
playbook from analysis** (default branch from git, package manager from `packageManager`/lockfiles,
test/build/run from npm scripts, or cargo/go/python conventions, version manifest), **writes it
straight to `.dev-flow/project.md`**, and hands it to you: confirm as-is, or say what to change —
the agent then walks you through the knobs conversationally and writes your answers back validated
(`--write <content>`). Running `/flow init` again with an existing project.md runs the **doctor**: cheap
consistency probes (command drift, dead scripts, unparseable manifest, dual configs) with an offer
to refresh — it never runs your commands and never rewrites your hand-edited file without your confirm.
`/flow init --force` rewrites from fresh
detection (destructive reset). It also installs a `pre-commit` hook that
rejects direct commits to the main branch (the hook lives in `.git/hooks`, nothing is committed).
The flow is completely inert in repos without `.dev-flow/`.

## Commands

`/flow <sub>` for you, the `flow` tool for the agent — same gates either way:

| Gate | Advances | Refuses unless |
|---|---|---|
| `start <slug> [--ui] [--patch]` | → plan | slug is new (binds the session); `--patch` = chore release: no plan document, every gate unchanged |
| `use <slug>` | — (binds this session to a feature) | slug unfinished |
| `approve` | plan → implement (creates worktree + branch) | `plan/*.md` exists; if `--ui`, rendered mockup screenshots (per `mockupGlobs`, default `*.png`) exist under `plan/` — headless chromium renders embedded in plan.md; **one question** — or `--confirmed` after you answered in chat |
| `test` | records a check | — (runs the `test` command/check, records pass/fail) |
| `check` | records all tier-1 checks | — (runs every `flow-check`/test/health from project.md `## implement`) |
| `health` | records a check | — (runs `seedData` + the health command; app must be up locally with real data) |
| `verify` | implement → pre-release | all tier-1 checks green, build (if configured) green, `dev` deploy (if configured) runs first so you can review the running app, tier-2 checklist (ui-only items excluded for non-UI features) confirmed as a set; **one question** — or `--confirmed` |
| `release` | pre-release → release | checks re-greened after the prep edits; with `versioning.file`: the manifest version parses and is **not tagged yet** (the bump must be ahead of the last release); with `release.changelog`: the file exists and mentions the version; tier-2 `## pre-release` checklist confirmed; **one question** (Release?) — or `--confirmed` |
| `release-done` | records the release (the stage stays `release`) | verify approval; with `versioning.file`: tag rendered from the manifest version exists, is reachable from the default branch **and is on origin** (a local-only tag is not a release); with `release.artifact`: the published-artifact check runs (`{version}`/`{tag}` placeholders; skip once with `--no-artifact-check`); **the one release question** (tag+merged PR) — or `--confirmed` · creates the GitHub release from the tag (advisory — needs gh + GitHub remote; skip per-release with `--no-github-release`, per-project with `release.github = false`) |
| `finish [slug]` | release → done (removes worktree + branch, deletes `.dev-flow/<slug>/`) | a release is recorded (`release-done` ran), the main checkout is clean **and** pushed to `origin/<default>`, and the worktree has no uncommitted changes; **one question** (Finish? — mentions unmerged-looking squash-merge commits when it sees them) — or `--confirmed`; to abandon an unreleased feature use `abort` |
| `doctor [reflect "<note>"]` | — | read-only findings: playbook drift, dead commands/scripts, ghost feature dirs, orphan worktrees/branches, open reflections — it writes nothing and asks nothing, safe for agents and CI at any stage. `doctor reflect "<note>"` queues an agent suggestion in `reflections.md`, under `## playbook`, `## plugin` or both, chosen from the note's wording (never gates) |
| `status [slug]` / `abort [slug]` | — | — |
| `version` | — | — (prints dev-flow's **own** version and the directory it was loaded from — which copy this session runs, this checkout vs an installed `pi-dev-flow`; answerable in any repo, at any stage, with no `.dev-flow/`) |

`--confirmed` is the operator-presence flag: pass it only after the operator literally answered the stage question in chat — one checkpoint per stage, no second dialog.

## Enforcement (the teeth)

While a feature is active, the extension intercepts every tool call:

- **Nothing on main, ever**: `git commit` on the default branch is blocked; pushes are judged by the ref they write — only pushing *to* the default branch (or a bare push while on it) requires stage `release`, so tag pushes and feature-branch pushes pass from any stage; `git merge` onto the default branch also requires stage `release`. Plus the standalone pre-commit hook for commits made outside Pi.
- **No code before an approved plan**: at stage `plan`, edits are confined to `.dev-flow/<slug>/`.
- **Work stays in the worktree**: at stages `implement` and `pre-release`, edits are confined to that feature's worktree — judged per-path by the owning feature, so one session can never write into another session's worktree or into the main checkout.
- **Flow by default**: in a repo with `.dev-flow/`, an unbound session cannot touch source files at all — every request goes through `flow start`/`flow use`; there is no bypass. `flow start` refuses when the main checkout isn't on the default branch, worktrees are always created from the default branch, and the agent cannot check feature branches out in the main checkout.
- **Gates can't be skipped**: `state.json` is untouchable by the agent (edit tool and bash); `project.json` is operator-owned; editing worktree code invalidates a passing test check until `flow test` reruns.
- **Your project's own rules**: every `deny`/`confirm`/`protect`/`forbid` rule from the `flow-guard` block in project.md `## global` runs on every bash command and every edit/write path — in every stage and binding, ahead of dev-flow's own verdicts. A block always carries the reason you wrote.
- **Compact-aware**: when context nears pi's auto-compaction threshold, dev-flow compacts *itself* at a safe point — right after a gate wrote state to disk, or when a run settles — with flow-aware summary instructions. It never compacts while chat is the state (open tier-2 dialog, plan discussion not yet in `plan/`), so pi's mid-work compaction rarely fires; when it does, a note lands in `reflections.md`.
- The active stage is injected into the model's context every turn; the bundled `dev-flow` skill is the agent's playbook, including the recommended sequences: pre-release — review (`/ponytail-review`) → fixes → docs → changelog/version bump; release — PR → merge → tag → `release-done`.
- **Status bar**: while a feature is active the pi footer shows `◆ <slug> ▸ <stage>` (stage-colored, `✗` on failing checks); press `ctrl+,` for the detail panel (approvals, checks, branch/worktree, next step).

## Concurrency model

**One pi session = one feature** (flow + branch + worktree). A repo can host any number of
features, worked by separate sessions in parallel — that is the supported shape, not an edge
case. The binding lives with the session (persisted via session entries, restored on
resume/fork), so nothing is repo-global. One unfinished feature binds automatically and the
single-session case needs no ceremony; `flow use <slug>` switches, and ambiguous sessions must
bind or pass explicit slugs. With nothing unfinished and no binding, the session must start a
flow — work does not happen outside the flow.
Enforcement is by attribution: a write inside worktree X is judged
by X's own feature stage no matter which session touches it; main-checkout code stays closed
while your bound feature is in `plan`/`implement` and while any feature is unbound-and-ambiguous.

## Project configuration — `.dev-flow/project.md`

The operator-owned playbook, gitignored, edited by you (the agent is blocked from writing it
directly; it goes through `flow init --write` which validates). Content is organized per stage
(`## plan`, `## implement`, `## pre-release`, `## release`…) in **three tiers** — tier 1 splits into
executable checks and hard safety rules:

| Tier | Notation | Enforcement |
|---|---|---|
| 1 — executable | ` ```flow` (`key = value`) config blocks; ` ```flow-check <name>` command blocks | gates run every check, record pass/fail, worktree edits invalidate — hard |
| 1 — guard | ` ```flow-guard ` (`deny`/`confirm`/`protect`/`forbid`) rules in `## global` | enforced on every bash command and every edit/write path, at every stage — hard block or operator confirmation |
| 2 — checklist | `- [ ] item` lines (`- [ ] (ui) item` = only for `--ui` features) | gate confirms cover them as a set (hashed, invalidated on edits); `(ui)` items never appear for non-UI features |
| 3 — prose | any other text | injected to the agent when its stage begins — advisory |

Example `## implement` section:

````markdown
## implement
```flow
test = npm test
run = npm run dev
health = curl -fs localhost:3000/healthz
```
```flow-check overflow
node scripts/check-overflow.mjs
```
- [ ] visual pass at 390px and 1280px: no overflows, no stray scrollbars
Prefer feature flags for risky paths.
````

Your project's own safety rules are a `flow-guard` block in `## global` — the reason a project
adopting dev-flow can delete its own guard extension:

````markdown
## global
```flow-guard
deny    \bgit\b[^\n]*--force(?!\w)   :: history stays linear — PRs squash-merge
deny    \bgit\b[^\n]*\bworktree\s+prune\b :: it prunes other sessions' worktrees
confirm \bgit\b[^\n]*\bbranch\s+(?:-D\b|--delete\b) :: deletes a squash-merged branch git cannot see as merged
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b :: drops a permanent upstream connection
protect docker/.env                  :: gitignored live secrets — never echo the values
forbid  docker/secrets               :: gitignored secret storage
```
````

| Verb | Applies to | What happens |
|---|---|---|
| `deny` | one segment of a bash command | hard block — no confirmation offered |
| `confirm` | one segment of a bash command | asks the operator; **blocked when no UI is present** — a hidden confirmation is not a confirmation |
| `protect` | an edit/write path | asks the operator, same no-UI rule |
| `forbid` | an edit/write path | hard block |

` :: ` separates the matcher from the reason, so reasons are free text and show up verbatim when a
rule fires. `deny`/`confirm` matchers are JS regex sources — an unparseable regex is a hard finding,
so `flow init --write` refuses the file (an unknown verb is a warning). `protect`/`forbid` take a
repo-relative path; a rule on a directory covers its subtree, including files that do not exist yet.
The block belongs to `## global` — these rules are never stage-scoped, and one under a stage warns and
applies nothing.

Matching is per shell segment (the guard splits on `;`, `|`, `&&` and newlines, honouring `cd … &&` and
`git -C`), and a segment whose head only reads (`grep`, `cat`, `ls`, `git log`, `jq`, …) is skipped — so
`grep "git push --force" docs/` searches, it does not push.

`## pre-release` prose is where rules like “follow semver: minor for user-facing features, patch
otherwise; confirm the number before tagging” live — the agent sees them at stage entry, and
`flow release` / `flow release-done` hard-check the manifest side (bumped past the last tag, then
manifest↔tag agreement). `## global` holds
`defaultBranch`, `branchPattern`, `worktreeDir`, `mainHook`, `mockupGlobs`, `release.review`,
`release.changelog` and `release.github = false` (skip GitHub release creation) and `release.artifact = <cmd>` (verify the published artifact — image registry probe etc. — before release-done completes); the implement stage takes `setup`/`test`/`build`/`run`/`seedData`/`health`/
`dev`. Of those, `setup` runs once inside a freshly created worktree at `approve` (where `cp .env` +
`npm install` belong — a failing setup fails the gate), and `run` is advisory: the agent starts the app
with it for the running-and-healthy walk, dev-flow never runs it itself. `dev` is the dev deploy run by
`flow verify` before the operator question — it must background and exit,
e.g. `docker compose up -d .`. The pre-release and release stages take
`versionFile`/`versionTag` (defaults `v{version}`; accepted under either section). A legacy
`project.json` still works — project.md overrides it, and the doctor flags having both.

`flow init` is the dialogue around this file: **fresh repo** → writes the detection draft
immediately, then asks you to confirm the file or change it — the agent asks one short question per
knob you want adjusted and writes your answers back validated (`--write <content>`; `--draft` prints
the current file whenever you'd rather read raw); **existing file** → doctor mode (drift, dead commands/scripts,
unparseable manifest, dual configs, **ghost feature dirs** (a `.dev-flow/<slug>/` whose `state.json`
is gone — it offers to delete those, on your confirm, and says so instead when no UI is present) —
it never runs your commands) offering a refresh — which it
**refuses** whenever your file has lines a regenerated draft cannot reproduce (prose, your own
checklist items, hand-set keys): it prints the findings and the lines it would drop instead of
overwriting them. `--force` remains the deliberate overwrite. At any time
you can just edit `.dev-flow/project.md` yourself — the next `flow init` (doctor) validates and
flags problems, and `flow doctor` runs the same probes on demand without offering to change
anything (findings are also printed whenever `flow init` runs without a UI, e.g. in CI). `--force`
rewrites from fresh detection. Improvement
ideas the agent notices along the way queue up in `.dev-flow/reflections.md` under `## playbook`
(what to change in *your* playbook) and `## plugin` (what to change in dev-flow itself) —
`flow doctor reflect "<note>"` appends them, you decide what gets folded in, and nothing there ever gates.


## Layout in a project

```
.dev-flow/                    (gitignored, flow-owned)
  project.json                operator-owned config
  .current                    active feature pointer
  <slug>/
    plan/
      plan.md                 the review document (embeds the renders)
      mockups/                mockup HTML + chromium renders (*.png)  ← UI plan output
    worktree/                 feature worktree    ← implement/pre-release/release work
    state.json                stage, approvals, checks (agent cannot write)
```

## Limitations (deliberate, v1)

- Production deployment stays manual by design (phase 2 automation); `flow finish` only closes the flow.
- Bash git-guard parses shell segments to find real `git` invocations (honoring `cd … &&`, `git -C`, full paths) and judges them by the branch of the directory the command runs in — the feature worktree when you work there. An exotic shell wrapper (subshell, variable) around `git commit` could still slip past; the `.git` hook covers plain commits outside Pi too, but neither is a security sandbox.
- `flow-guard` and the git guard are guardrails for what an agent types, **not a parser and not a sandbox**. Quoted payloads still match — `gh pr create --body "…git branch -D…"` trips a rule (the mitigation is `--body-file`), and rules fire on doing-verbs an agent types in the clear, not on every way a side effect could be reached. Write rules for the common mistakes, keep validation you actually depend on in scripts and CI.
- `protect`/`forbid` judge edit/write tools against the repo root the session runs in — a copy of a protected file inside a feature worktree is a different path, and a bash redirect (`echo k > docker/secrets/k`) is a `deny` rule's job.
- The read-only heads that get skipped (`find`, `awk`, `jq`, …) can write in their own dialects — `find . -delete`, `awk … > file`. A deny rule on `rm` does not cover them; write a rule for the effect you actually need to prevent.
- ~~One active feature per pointer~~ — replaced by session bindings (v0.5.0): one feature per pi session, parallel sessions supported; `abort` unbinds.
- Gate commands (`test`, `check`, `verify` build, `health`) run inside the feature worktree once it exists — the code under test lives there; before the worktree exists they run in the main checkout.

## Development

```bash
npm i && npm test     # unit tests + wiring smoke test (node --test)
pi -e . run /flow status   # try it against any repo
```

This checkout dogfoods itself: `.pi/extensions/dev-flow.ts` is a committed one-line re-export of
`extensions/dev-flow.ts`, so pi loads the working tree rather than an installed copy, and a fresh
clone needs no setup. It is a pointer, not a copy — after any merge or pull, new sessions here run
main's current code, with nothing to re-run. A symlink would not work: pi resolves a module's
relative imports from the link's own directory, so the extension's `../src/core.ts` would not
resolve. `flow doctor` flags a missing or edited shim.

A release cannot update a session that is already running — pi keeps the code it loaded at startup.
After merging and tagging, `/reload` in every session that must carry the new behavior.
