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

Creates `.dev-flow/` — which **ignores itself** via its own `.dev-flow/.gitignore`
(`*`, with the single exception `!project.md` — no tracked file is touched) — and **asks before it
writes anything**: a setup brief from repository analysis (default branch and forge from git, package
manager from `packageManager`/lockfiles, test/build/run from npm scripts or cargo/go/python
conventions, version manifest) plus one question per knob detection cannot decide — forge
(github/gitlab/self-hosted), version convention, automatic forge releases, registry artifacts
(Docker Hub & friends), the real check commands, tier-2 items and prose. The agent relays the
questions to you, fills the draft with your answers and writes it validated
(`--write <content>`); an interactive `flow init` can also review the detection draft with you and
write it on the spot. Running `/flow init` again with an existing project.md runs the **doctor**: cheap
consistency probes (command drift, dead scripts, unparseable manifest, legacy files) with an offer
to refresh — it never runs your commands and never rewrites your hand-edited file without your confirm.
`/flow init --force` rewrites from fresh
detection (destructive reset — it needs your word, one confirm dialog or `--confirmed` for an
agent, and keeps the previous playbook as `project.md.bak`; every sanctioned playbook overwrite
keeps that backup). It also installs a `pre-commit` hook that
rejects direct commits to the main branch (the hook lives in `.git/hooks`, nothing is committed).
The flow is completely inert in repos without `.dev-flow/`.

## Commands

`/flow <sub>` for you, the `flow` tool for the agent — same gates either way:

| Gate | Advances | Refuses unless |
|---|---|---|
| `start <slug> [--ui] [--patch|--docs --confirmed]` | → plan | slug is new (binds the session); relaxed modes are operator-granted in chat, anchored by `--confirmed`: `--patch` = chore release, no plan document, every gate unchanged; `--docs` = docs-only, no plan document and no tier-1 checks (worktree and release intact). Start prints the dev-flow build and stamps it into the feature state (`flow status` shows `flow=<ver>`) |
| `use <slug>` | — (binds this session to a feature) | slug unfinished |
| `approve [--yolo]` | plan → implement (creates worktree + branch) | `plan/*.md` exists; if `--ui`, rendered mockup screenshots (per `mockupGlobs`, default `*.png`) exist under `plan/` — headless chromium renders embedded in plan.md; **one question** — or `--confirmed` after you answered in chat; **yolo** (your chat answer at **any** checkpoint question) → run that gate with `--yolo --confirmed` (`approve`/`verify`/`release`/`finish`): that question is answered and every later one (Verified?/Release?/Finish?) is pre-confirmed — the agent then runs the remaining gates back to back, honoring guidance attached to the yolo word (e.g. "yolo, create a patch version release") — checks and guardrails stay fully enforced. `commands.setup` runs in the worktree and is retried until it succeeds once (a worktree left behind by a failed setup is set up on the next `approve`, never silently reused); a `--docs` feature runs no project command at all and says `setup skipped (docs mode)` |
| `test` | records a check | — (runs the `test` command/check, records pass/fail) |
| `check` | records all tier-1 checks | — (runs every `flow-check`/test/health from project.md `## implement`) |
| `health` | records a check | — (runs `seedData` + the health command, retrying up to `healthWait` seconds; app must be up locally with real data) |
| `verify [--yolo]` | implement → pre-release | all tier-1 checks green, **the feature branch holds at least one commit** (verify refuses a branch with nothing committed — the checks describe the working tree, so an uncommitted state has never been recorded — and prints `commits: N ahead of <default>, M uncommitted path(s)` with what it ran; uncommitted paths are reported, never gated), build (if configured) green, `dev` deploy (if configured) runs first so you can review the running app **and the health probe (if configured) re-runs against what it just deployed, retrying every 2s up to `healthWait` seconds** (a failing probe refuses the gate and reports how many attempts it took: the `flow check` PASS predates the deploy, and a service that needs seconds after its container starts is not a broken deploy; with no probe the output says `health: none configured`), tier-2 checklist (ui-only items excluded for non-UI features) confirmed as a set; a `--docs` feature runs none of it (`docs mode: project commands skipped`) and only asks you; **one question** — or `--confirmed`; `--yolo --confirmed` = you answered 'yolo' at Verified? — answers it and pre-confirms the rest |
| `release [--yolo|--no-version]` | pre-release → release | checks re-greened after the prep edits; with `versioning.file`: the manifest version parses and is **not tagged yet** (the bump must be ahead of the last release); with `release.changelog`: the file exists, mentions the version and its `Unreleased` section holds no leftover entries (a versioned release **folds** what `--no-version` flows left there under the new version heading); tier-2 `## pre-release` checklist confirmed; the manifest version it validates is **stamped as the release's version of record** (`release-done` publishes that, whatever the checkouts say later); **one question** (Release?) — or `--confirmed`; `--no-version` (your call at Release?) ships this flow as **merge + changelog** — the bump/tag requirements and the tag checks at `release-done` are skipped for it, but the branch must still change the changelog (your entry rides under `Unreleased` until the next versioned release folds it) (default: versioned) |
| `release-done` | records the release (the stage stays `release`) | **no question — the Release? answer covered the publication**; verify approval; the version published is the one `release` **stamped** from the manifest it validated (a main checkout still behind cannot republish the previous version), and it must not be older than the newest matching tag **on origin** (tag lists come from `git ls-remote`, so an unfetched clone does not decide what exists; when an origin exists but cannot be asked (offline, no ssh agent) **both release gates refuse** rather than answering with local tags); with `versioning.file`: that tag exists, is reachable from the default branch **and is on origin** (a local-only tag is not a release); with `release.artifact`: the published-artifact check runs (`{version}`/`{tag}` placeholders — the line it prints names the version it verified; skip once with `--no-artifact-check`, operator-instructed only) · creates the forge release from the tag, its body the tag's annotation, else the `release.changelog` entry for that version, else nothing (and it says why — a body that is really a shell error is dropped, never shipped) — `gh` for GitHub, `glab` for GitLab, skipped for `forge = self` (advisory — a note on failure, stamped so `finish` will name the missing release; skip per-release with `--no-release-create`, per-project with `release.releases = false`) |
| `finish [--yolo] [slug]` | release → done (removes worktree + branch, deletes `.dev-flow/<slug>/`, and deletes `origin/<branch>` **only** when its merged state is verified — ancestor of the default branch or a merged PR/MR via `gh`/`glab`; unverifiable branches stay with a note) | a release is recorded (`release-done` ran), the main checkout is clean **and** pushed to `origin/<default>`, and the worktree has no uncommitted changes; **one question** (Finish? — mentions unmerged-looking squash-merge commits, and warns when the forge release create failed at `release-done` and no retry succeeded) — or `--confirmed`; to abandon an unreleased feature use `abort` |
| `reflect ["<note>"]` | — | `reflect "<note>"` queues a suggestion in `reflections.md` (never gates; gate flags such as `--confirmed` are ignored, they never become part of the note). Bare `reflect` prints the full **session-reflection protocol** for the agent (from the `/flow reflect` bar it additionally wakes the model, so the protocol executes immediately): review the whole session log, re-check every open item against the current playbook and **newer dev-flow versions** (`git ls-remote` tags vs the running version — dev-flow ships from git; recommend `pi install git:github.com/<upstream>` + `/reload`, the operator performs updates), dedupe new findings against the open ones, then report playbook vs plugin items to the operator and ask whether to fix now — plugin items: search upstream issues first (`gh issue list --repo <upstream> --state all --search …`; an author-addressed match is reported back, no match → `gh issue create` with a detailed description and a suggested fix), playbook items: `flow doctor` routes each to the docs flow that implements it |
| `roadmap [add "<feature>" \| pick <n> <slug> \| done <n> \| tidy]` | — | manages `.dev-flow/roadmap.md`, the gitignored backlog of future features (`- [ ]` checklist): bare prints the numbered open items, `add` appends one, `pick <n> <slug>` stamps open item n with `(slug)` so `flow start <slug>` can take it — **`finish` checks the stamped item off when that feature ships**; `done <n>` checks off by hand (items shipped outside a flow), `tidy` drops the checked lines. Never gates; the open count is surfaced in `status` and session context |
| `doctor ["<issue note>"]` | — | read-only findings: playbook drift, dead commands/scripts, untracked playbook, ghost feature dirs, orphan worktrees/branches — **plus a review of every open reflection, each routed to the flow that should fix it** (playbook item → docs flow; plugin item → upstream issue, or a patch/normal flow inside the dev-flow repo). It writes nothing and asks nothing, safe for agents and CI at any stage; the agent investigates, you confirm, the routed flow implements. `doctor "<note>"` prints an investigation brief and a fix route for a fresh observation |
| `status [slug]` / `abort [slug]` | — | — |
| `help` (`--help`, `-h`) | — | — (prints the gate help — answerable in any repo, at any stage, with no `.dev-flow/`) |
| `version` | — | — (prints dev-flow's **own** version and the directory it was loaded from — which copy this session runs, this checkout vs an installed `pi-dev-flow`; when the checkout has moved past the build this session loaded it says so and names both, because the gates execute the loaded code — `/reload` to run the newer one; answerable in any repo, at any stage, with no `.dev-flow/`) |

`--confirmed` is the operator-presence flag: pass it only after the operator literally answered the stage question in chat — one checkpoint per stage, no second dialog.

## Enforcement (the teeth)

While a feature is active, the extension intercepts every tool call:

- **Nothing on main, ever** (until release): `git commit` on the default branch is blocked at every stage except `release` — where release chores commit in the main checkout (prefixed `DEV_FLOW_ALLOW_MAIN=1` for the hook) — and except one chore that needs no flow: a commit whose **only** change in the checkout is `.dev-flow/project.md`, because tracking the operator's playbook is setup, not feature work (any other dirty path closes that lane). pushes are judged by the ref they write — only pushing *to* the default branch (or a bare push while on it) requires stage `release`, so tag pushes and feature-branch pushes pass from any stage; `git merge` onto the default branch also requires stage `release`. Plus the standalone pre-commit hook for commits made outside Pi.
- **No code before an approved plan**: at stage `plan`, edits are confined to `.dev-flow/<slug>/` — the session's **own** feature directory, so one session cannot write another feature's plan and have its gate rubber-stamp what it never wrote.
- **Work stays in the worktree**: at stages `implement` and `pre-release`, edits are confined to that feature's worktree — judged per-path by the owning feature, so one session can never write into another session's worktree or into the main checkout.
- **Flow by default**: in a repo with `.dev-flow/`, an unbound session cannot touch source files at all — every request goes through `flow start`/`flow use`; there is no bypass. `flow start` refuses when the main checkout isn't on the default branch, worktrees are always created from the default branch, and the agent cannot check feature branches out in the main checkout.
- **Gates can't be skipped**: flow state is untouchable by the agent (edit tool and bash) — writing `state.json`, moving it away, or deleting a feature directory or the whole `.dev-flow/` folder all block; the `project.md` playbook is operator-owned — the main-checkout copy is blocked for the agent outright, and only a **docs or patch flow's** worktree copy may be edited (normal features route playbook changes to their own flow); every sanctioned playbook overwrite keeps the previous file as `project.md.bak`; editing worktree code invalidates a passing test check until `flow test` reruns.
- **Your project's own rules**: every `deny`/`confirm`/`protect`/`forbid` rule from the `flow-guard` block in project.md `## global` runs on every bash command and every edit/write path — in every stage and binding, ahead of dev-flow's own verdicts. A block always carries the reason you wrote.
- **Shell calls can't hang forever**: pi kills a shell command only when the model passed a `timeout` — it omits one in ~75% of calls, so a `gh` waiting on a prompt or a dead `curl` froze sessions for hours. By default the call is therefore **refused** until the model states one (`bashTimeout = require`): the refusal names the exact value the class table would have armed, so the retry is a one-token fix and the call line in the transcript shows the timeout that is actually running. The injected class default (30s quick inspection · 120s local git and unknown · 180s network · 300s containers/services · 900s builds/tests/installs · 1,200s watchers like `gh run watch`) stays armed underneath either way, and absurd explicit values clamp to 1,800s. A project that would rather not nag sets `bashTimeout = inject` in `## global` — then the default is armed silently and the call passes. It applies to every session that loads the package, flow-bound or not (a session with no playbook has no way to opt out).
- **Compact-aware**: dev-flow paces compaction the way pi counts it: the self-compaction trigger uses the *effective* `reserveTokens` (settings and per-model overrides, not the built-in default) and is checked at every turn end, not only when a run settles. When pi force-compacts on its threshold anyway — the chat-only states (open tier-2 dialog, plan discussion not yet in `plan/`) refuse to self-compact by design — dev-flow takes the compaction over and redoes it with flow-aware summary instructions (overflow recovery keeps pi's compact-and-retry and is left alone). Auto-compaction turned off in settings is honored; a note about any compaction dev-flow could not shape still lands in `reflections.md`.
- The active stage is injected into the model's context every turn; the bundled `dev-flow` skill is the agent's playbook, including the recommended sequences: pre-release — review (`/ponytail-review`) → fixes → docs → changelog/version bump; release — PR → merge → tag → `release-done`.
- **Status bar**: while a feature is active the pi footer shows `<stage glyph> <slug>` plus mode markers — stages 📝 plan, 🔨 implement, 🔍 pre-release, 🚀 release; markers ⚡ patch, 📚 docs, 🎱 yolo, and `⚠️` while a check fails (emoji render in their own color, so the footer carries no theme coloring). `flow status` is the spelled-out surface: `stage=implement`, the per-feature mode tags (`[ui]`, `[yolo]`, `[no-version]`) and the `flow=<ver>` stamp of the build that started the feature.

## Driving dev-flow from an orchestrator (headless)

There is **no `flow` CLI** — gates exist only inside a Pi session (the `flow` tool, `/flow`
command). A remote orchestrator therefore drives a **Pi session** (e.g. via the Pi SDK) and
calls the `flow` tool from inside it. That is not a limitation: the guards are harness-side,
so a driver that shelled around Pi would bypass every teeth except the `pre-commit` hook.

The contract a headless driver (a session with no UI) relies on:

- **Refuse → relay → `--confirmed`.** A checkpoint gate (`approve`, `verify`, `release`,
  `finish`) never dialogs headless — it refuses with a line that starts with the stable
  marker `NEEDS-OPERATOR <Question?> — …` (the four questions: Approve? / Verified? /
  Release? / Finish?). Route on the marker, relay the question verbatim to the human, and on
  their literal answer re-run the same gate with `--confirmed`. A project `flow-guard`
  `confirm` rule with no UI present refuses with the same marker (no question word). The
  marker is also on top of prose that stays readable for humans — nothing to parse beyond
  the first token.
- **`--confirmed` is honor-system.** The plugin cannot verify a human answered; the flag
  means "the operator literally answered this question in chat". In remote setups the
  orchestrator owns that trust — relaying the exact question and adding `--confirmed` on its
  own inference is the one orchestrator bug dev-flow cannot catch. `--patch`/`--docs` mode
  grants work the same way (operator grant in chat, then `--confirmed`).
- **Machine surfaces.** `flow status --json` (bound slug + per-feature stage, mode flags,
  branch, worktree, checks, next hint — no git subprocesses) and `flow help --json` (the
  gate contract as data, incl. the checkpoint questions and flag names). Both are additive:
  the prose views are unchanged. Read-only-safe at any stage/binding, even without
  `.dev-flow/`: `status`, `help`, `version`, `doctor`, `roadmap` (list).
- **One session = one feature.** Bindings are per-session and survive resume/fork; a
  reconnecting driver either rejoins the same session or rebinds with `flow use <slug>`.
  Auto-bind fires only for a single unclaimed unfinished feature — with several, always pass
  the slug explicitly. Parallel features = parallel sessions.
- **Budget for long gates.** `approve` runs `commands.setup`; `verify` runs build and the
  `dev` deploy (runs are killed past 15 min) and re-probes health with `healthWait` retries.
  A remote timeout must be minutes, not seconds — the gate prints progress lines while it
  runs.
- **Edits invalidate checks.** Any worktree write clears recorded checks and the tier-2
  confirmation — re-run `flow check` before `verify` after the last edit.
- **Version skew.** Gates execute the dev-flow build the session loaded at start; `flow version`
  reports when the checkout has moved ahead of it (and `release-done` stamps a warning into
  its output when the session shipped from behind) — reload the session before publishing.

## Concurrency model

**One pi session = one feature** (flow + branch + worktree). A repo can host any number of
features, worked by separate sessions in parallel — that is the supported shape, not an edge
case. The binding lives with the session (persisted via session entries, restored on
resume/fork), so nothing is repo-global. One unfinished feature binds automatically and the
single-session case needs no ceremony — unless a **live** session already works that feature:
every bind leaves a claim (`claim.json`, session + pid) and auto-bind refuses foreign features,
so a second session must `flow use <slug>` to take over — and the gates honor the claim too:
passing another session's slug to `flow approve`/`verify`/`finish` is refused until you take over,
or two sessions quietly overwrite one state file. `flow use <slug>` switches, and ambiguous sessions must
bind or pass explicit slugs. With nothing unfinished and no binding, the session must start a
flow — work does not happen outside the flow.
Enforcement is by attribution: a write inside worktree X is judged
by X's own feature stage no matter which session touches it; main-checkout code stays closed
while your bound feature is in `plan`/`implement` and while any feature is unbound-and-ambiguous.

## Project configuration — `.dev-flow/project.md`

The operator-owned playbook, **committed to git** (the one file under `.dev-flow/` that is),
edited by you (the agent is blocked from writing the main-checkout copy
and may edit it only inside a docs/patch flow's worktree, or apply it through `flow init --write`
on your word, which validates). Content is organized per stage
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
healthWait = 30
```
```flow-check overflow
node scripts/check-overflow.mjs
```
- [ ] visual pass at 390px and 1280px: no overflows, no stray scrollbars
Prefer feature flags for risky paths.
````

`healthWait` (default 30) is the seconds the post-deploy probe may keep retrying, every 2s — a service
whose readiness lags its container start needs a wait, not a poll loop hand-written into the playbook.
`healthWait = 0` restores the single shot.

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
`grep "git push --force" docs/` searches, it does not push. A read-only head that can still write
(`find -delete`, `find -exec …`, `sort -o FILE`, `awk 'BEGIN{system(…)}'`) is judged like a writer —
your `deny` rules do not have a back door through the read-only list.

`## pre-release` prose is where rules like “follow semver: minor for user-facing features, patch
otherwise; confirm the number before tagging” live — the agent sees them at stage entry, and
`flow release` / `flow release-done` hard-check the manifest side (bumped past the last tag, then
manifest↔tag agreement). `## global` holds
`defaultBranch`, `branchPattern`, `worktreeDir`, `mainHook`, `mockupGlobs`, `bashTimeout = require`
(default: every shell call must state its own timeout) `| inject`, `release.review`,
`release.changelog` (default `CHANGELOG.md`; set it empty to opt out), `release.releases` and `release.artifact = <cmd>` (verify the published artifact — image registry probe etc. — before release-done completes); the implement stage takes `setup`/`test`/`build`/`run`/`seedData`/`health`/
`dev`. Of those, `setup` runs once inside a freshly created worktree at `approve` (where `cp .env` +
`npm install` belong — a failing setup fails the gate), and `run` is advisory: the agent starts the app
with it for the running-and-healthy walk, dev-flow never runs it itself. `dev` is the dev deploy run by
`flow verify` before the operator question — it must background and exit,
e.g. `docker compose up -d .`; the gate names what it ran (`dev ran (<cmd>)`, or
`dev: none configured`) so minutes of deploys never read as "nothing happened". After a deploy that
ran, verify re-runs the health probe (`commands.health` or a `flow-check` block named `health`, with
`seedData` first when set) in the worktree and refuses the gate when it fails — the pre-deploy
`flow check` PASS describes a container that no longer exists. What "healthy and serving this
build" means stays the project's own assertion: the probe runs with the worktree as cwd, so it can
wait for readiness and compare the served build stamp with `git rev-parse HEAD`. No probe → the
gate prints `health: none configured` and `flow doctor` flags the combination. The pre-release and release stages take
`versionFile`/`versionTag` (defaults `v{version}`; accepted under either section). `## global` also takes
`forge = github | gitlab | self` — the release machinery's target; when unset it is detected from the
`origin` URL at the moment of use (GitHub gets `gh`, GitLab gets `glab`, self-hosted stays forge-neutral:
no automatic release creation, merge proof by ancestry only), and `release.releases = false` skips
automatic release creation entirely (the legacy `github` key still parses, with a rename warning).
A leftover `project.json` is no longer read — the doctor tells you to fold it in and delete it.

`flow init` is the dialogue around this file: **fresh repo** → prints the setup brief (detection report
plus one question per undetected knob — forge, version convention, releases, artifacts, checks, prose),
the agent asks you each question, fills the draft and writes your answers back validated
(`--write <content>`; `--draft` prints the draft or current file whenever you'd rather read raw — an
interactive init may also confirm the draft with you on the spot and write it then); **existing file** → doctor mode (drift, dead commands/scripts,
unparseable manifest, dual configs, **ghost feature dirs** (a `.dev-flow/<slug>/` whose `state.json`
is gone — it offers to delete those, on your confirm, and says so instead when no UI is present) —
it never runs your commands) offering a refresh — which it
**refuses** whenever your file has lines a regenerated draft cannot reproduce (prose, your own
checklist items, hand-set keys): it prints the findings and the lines it would drop instead of
overwriting them. `--force` remains the deliberate overwrite — with your word (`--confirmed`, or one
confirm dialog) and a `project.md.bak` of what was there. At any time
you can just edit `.dev-flow/project.md` yourself — the next `flow init` (doctor) validates and
flags problems, and `flow doctor` runs the same probes on demand without offering to change
anything (findings are also printed whenever `flow init` runs without a UI, e.g. in CI). `--force`
rewrites from fresh detection. Improvement
ideas the agent notices along the way queue up in `.dev-flow/reflections.md` under `## playbook`
(what to change in *your* playbook) and `## plugin` (what to change in dev-flow itself) —
`flow reflect "<note>"` appends them, plain `flow doctor` reviews the open ones and routes
each fix to the flow that implements it (docs flow for playbook items — those edits only pass a
docs/patch flow's worktree), bare `flow reflect` hands the agent the full end-of-session
reflection protocol (review the session log, re-check open items against fixes that already
shipped, dedupe new findings, put the fix decision to the operator) — and nothing there ever gates.
Future features have their own file: `.dev-flow/roadmap.md`, a gitignored backlog `flow roadmap`
manages (add / pick → `flow start` / done / tidy) — a picked item is checked off by `finish` when
its feature ships, and it never gates either.


## Layout in a project

```
.dev-flow/                    (self-ignoring, flow-owned — except project.md, which is committed)
  project.md                  operator-owned playbook (in git)
  reflections.md              the agent's suggestion queue for the operator
  roadmap.md                  gitignored backlog of future features (flow roadmap)
  <slug>/
    plan/
      plan.md                 the review document (embeds the renders)
      mockups/                mockup HTML + chromium renders (*.png)  ← UI plan output
    worktree/                 feature worktree    ← implement/pre-release/release work
    state.json                stage, approvals, checks (agent cannot write)
```

## Limitations (deliberate, v1)

- Production deployment stays manual by design (phase 2 automation); `flow finish` only closes the flow.
- Bash git-guard parses shell segments to find real `git` invocations (honoring `cd … &&`, `git -C`, full paths) and judges them by the branch of the directory the command runs in — the feature worktree when you work there. Splitting respects quotes, so text inside `"…"` / `'…'` is an argument's prose, never a command: `gh pr create --body "…git commit…"` is not a commit. A wrapper that execs its argument (`sh`, `bash`, `node`, `python`, `env`, `xargs`, …) is judged on its payload — `sh -c "git push origin main"` is a push. An exotic wrapper (subshell, variable) could still slip past; the `.git` hook covers plain commits outside Pi too, but neither is a security sandbox.
- `flow-guard` and the git guard are guardrails for what an agent types, **not a parser and not a sandbox**. Doing-verbs an agent types in the clear are caught; quoted prose is deliberately read as data, so a wrapper deciding to run something at runtime is out of reach. Write rules for the common mistakes, keep validation you actually depend on in scripts and CI.
- `protect`/`forbid` judge edit/write tools against the repo root the session runs in — a copy of a protected file inside a feature worktree is a different path, and a bash redirect (`echo k > docker/secrets/k`) is a `deny` rule's job.
- The read-only heads that get skipped (`find`, `awk`, `jq`, …) can write in their own dialects — `find . -delete`, `awk … > file`. A deny rule on `rm` does not cover them; write a rule for the effect you actually need to prevent.
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
