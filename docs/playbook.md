# The playbook — `.dev-flow/project.md`

The operator-owned file that says how *your* project is tested, run, versioned and guarded. Written once per repo with `flow init`, edited by you.

## Quickstart

1. `/flow init`. dev-flow reads the repo and prints what it found, then one numbered question per knob. Each question shows what was detected (`detected:`), the answer that keeps it (`accept: merge=squash`), and why it matters. Nothing is written yet.
2. Answer in chat. Saying "keep these" is enough for every question that has an `accept` line.
3. The agent applies all your answers in one call, `flow init --answers merge=squash versionFile=VERSION check.lint="npm run lint" …`. That shows a summary and a diff and writes nothing.
4. You confirm. The agent re-runs the same call with `--confirmed --track`, which validates and writes the playbook, then commits it.
5. Anything detection can't know goes in later through `flow init --write-file <path>` with the whole file: checklist items, standing guidance, guard rules. You can also run `flow init --answers key=value` for a single knob at any time.

In a TUI, one dialog shows the summary with every detected value already accepted ("Accept the detected setup?"), followed by a commit offer. Decline it to answer the questions in chat first.

**What detection reads** (deterministic, files and git only, never runs your commands):
- the language manifest (package.json, Cargo.toml, go.mod, pyproject/requirements), the package manager and its scripts (`npm run build`, never `npm build`)
- lint, typecheck and format scripts, ruff and mypy config → extra `flow-check` blocks
- Makefile, justfile and Taskfile targets when no manifest decides
- CI workflows (the commands they run, which your checks should match) and publish steps (npm, crates, container image) → a suggested `artifact` check
- Dockerfile and compose files → suggested `preflight` and `dev`
- `.env` and `secrets/` on disk → drafted `protect`/`forbid` guard rules; an `.env.example` → a reminder that `setup` must copy it
- the version manifest, existing tags (the `versionTag` convention), the changelog, the merge style seen in history, monorepo workspaces
- CLAUDE.md, AGENTS.md and CONTRIBUTING.md (named, so their rules can be proposed as guidance; never copied silently)

Anything detection can't find is left out and asked about, never invented. No health check, no version file, no merge style is ever guessed.

**Typical playbooks.** These are minimal; add to them as the project teaches you:

| Project | `## implement` | `## pre-release` / `## release` |
|---|---|---|
| library (npm) | `test`, `build`, `flow-check lint` / `typecheck` | `versionFile = package.json`, `artifact = npm view --prefer-online <name>@{version} version`, `merge = …` |
| CLI (go/rust) | `test`, `build`, `flow-check vet` / `clippy` | `versionFile = VERSION`, `releases = true`, `merge = …` |
| web service | `setup` (install + copy `.env`), `test`, `run`, `flow-check health`, `(ui)` checklist items | `versionFile`, `merge = …` |
| Docker app | `dev = docker compose up -d --build`, `flow-check health` | `preflight = docker build .`, `artifact = docker buildx imagetools inspect <image>:{version}` |

The rest of this page is the reference.

`.dev-flow/` ignores itself — its own `.dev-flow/.gitignore` is `*` with the single exception
`!project.md`, so no state, plan or worktree path is ever tracked by accident. Tracking the playbook
in a repo that ignores the folder is a deliberate one-off:
`git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"` — the
env prefix is for dev-flow's `pre-commit` hook, which allows a main commit whose only change is the
playbook.

It is **committed to git**; you edit it (the agent is blocked from writing the main-checkout copy
and may edit it only inside a docs/patch flow's worktree, or apply it through `flow init --write`
on your word, which validates). Content is organized per stage
(`## plan`, `## implement`, `## pre-release`, `## release`…) in **three tiers** — tier 1 splits into
executable checks and hard safety rules:

| Tier | Notation | Enforcement |
|---|---|---|
| 1 — executable | ` ```flow` (`key = value`) config blocks; ` ```flow-check <name>` command blocks | gates run every check, record pass/fail against a worktree fingerprint, a changed tree makes them stale — hard |
| 1 — guard | ` ```flow-guard ` (`deny`/`confirm`/`protect`/`forbid`) rules in `## global` | enforced on every bash command and every edit/write path, at every stage — hard block or operator confirmation |
| 1 — worker setup | ` ```flow-worker ` lines in `## global` (e.g. `export APP_TEST_PASSWORD="$(cat /path/to/.secrets/test-password)"`) | copied into every `flow_stage` worker's brief as a setup block to run before any project check, so a check that needs a variable or file the worktree lacks still runs there; a reviewer that could not run a check must say so (`checks not run:`) instead of passing |
| 2 — checklist | `- [ ] item` lines (`- [ ] (ui) item` = only for `--ui` features; `- [ ] (versioned) item` = only when the flow ships a version — it stands down on `--no-version`; on a `--docs` flow the `## implement` items stand down, since nothing is built or deployed, except those tagged `- [ ] (docs) item`; an open count names its items and the section they sit under) | gate confirms cover them as a set (hashed: changing the items asks again); `(ui)` items never appear for non-UI features, `(versioned)` items never for an unversioned flow (a deploy proof of the tagged image, say) |
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

**Dev port and parallel flows.** Two flows on one machine share one dev stack unless you say otherwise:

```flow
port = 8090                 # the default dev port — exported to dev/health/servedBuild as $DEV_FLOW_PORT
parallelDev = yes           # can two instances run side by side? (no = only replace or wait are offered)
instanceMem = 2G            # what one instance needs — checked against available RAM
instanceDisk = 5G           # …and against free disk
dev = BFF_PORT=$DEV_FLOW_PORT COMPOSE_PROJECT_NAME=app$DEV_FLOW_SUFFIX docker compose up -d
devDown = COMPOSE_PROJECT_NAME=app$DEV_FLOW_SUFFIX docker compose down
servedBuild = curl -fsS http://127.0.0.1:$DEV_FLOW_PORT/version   # must print the served commit
```

`$DEV_FLOW_SUFFIX` is empty on the default port and `-<slug>` on any other, so a second instance gets its own
compose project. The `dev ran (…)` and `dev deploy FAILED` lines print the command as written, followed by what
it resolved to (`resolved: DEV_FLOW_PORT=8090, DEV_FLOW_SUFFIX="", compose project app`), so a record says
which stack a deploy touched. `flow verify` records who deployed on which port in `.dev-flow/dev-ports.json`; when the
port it would use belongs to another live flow it asks you first (see [concurrency](concurrency.md)).
`flow finish` runs `devDown` for an instance on a non-default port. `servedBuild` turns "something answers"
into "this branch answers": verify refuses when its output names no prefix of the worktree's HEAD.

Your project's own safety rules are a `flow-guard` block in `## global` — the reason a project
adopting dev-flow can delete its own guard extension:

````markdown
## global
```flow-guard
deny    \bgit\b[^\n]*\bpush\b[^\n]*--force(?!\w) :: history stays linear — the playbook sets the merge style
deny    \bgit\b[^\n]*\bworktree\s+prune\b :: it prunes other sessions' worktrees
confirm \bgit\b[^\n]*\bbranch\s+(?:-D\b|--delete\b) :: deletes a merged branch git cannot see as merged
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b :: drops a permanent upstream connection
protect docker/.env*                 :: gitignored live secrets — and any backup copied beside them
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
so `flow init --write` refuses the file (an unknown verb is a warning). Anchor a matcher on the **verb**
you mean, not on a flag that can appear anywhere after `git`: `\bgit\b[^\n]*--force` also refuses
`git filter-branch --force` (a local rewrite) and `git show -f`, and a rule that blocks unrelated
commands gets routed around. You do not need a rule for forced pushes at all — dev-flow confirms every
`git push --force` / `-f` with the operator itself, and prints the one prefix that answers for it
(`DEV_FLOW_ALLOW_REWRITE=1`). `protect`/`forbid` take a repo-relative path; a rule on a directory covers
its subtree, including files that do not exist yet. A rule whose **last segment** globs
(`protect docker/.env*`) covers the siblings in that directory whose name matches — the backup copied
beside a secret is the same secret, and the commit that adds it never names the file, so no `deny` regex
ever sees it. A glob anywhere else in the path warns at `flow init`: it names one literal file called
`.env*` and guards nothing.
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
manifest↔tag agreement) and the changelog side (a heading for the version, an entry this branch
prepared, and every entry that was pending before the release folded into it — see
[gates.md](gates.md)).
What an entry **is** stays the agent's stage convention, not a gate matter: the changelog records the
net change of a branch, not its commit history — a feature that landed through several iteration
commits is one entry telling the final state, and the fold proofs (which guard only lines already
pending under `Unreleased`) never stand in the way of merging your own lines. Say it differently
here if your project wants that (per-sprint grouping, issue numbers, a strict Keep-a-Changelog
vocabulary).

`## global` holds
`defaultBranch`, `branchPattern`, `worktreeDir`, `mainHook`, `mockupGlobs`, `bashTimeout = inject`
(default: the class timeout is armed silently on every shell call) `| require` (refuse calls that do not state one), `release.review`,
`release.changelog` (default `CHANGELOG.md`; set it empty to opt out), `release.releases`, `release.preflight = <cmd>` (run in the worktree by `flow release` before anything ships — e.g. `docker build .`, so the build the tag triggers is proven first; a failure refuses the gate) and `release.artifact = <cmd>` (verify the published artifact — image registry probe etc. — before release-done completes); the implement stage takes `setup`/`test`/`build`/`run`/`seedData`/`health`/
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
`versionFile`/`versionTag` (defaults `v{version}`; accepted under either section) and
`merge = squash | merge | rebase | any` — how a merged PR lands on the default branch (see below) — and
`yolo = all | until-release`: with `until-release` a yolo given at an earlier checkpoint never answers Release?
(for repos whose rules want the release word given after the commits exist; default `all`) — and
`version = ask | versioned | unversioned` (gh#198): who makes the release call — `ask` (default) puts *a patch, minor or
major release, or merge unreleased?* into the Verified? question (a kind is turned into a number at release, from the
newest tag, so parallel flows never fight over one); the other two make it for every flow — and
`ask = on-change | always`: with `on-change` (default) Release? answers itself when the call is on record and nothing but
release prep (the bump, the changelog) changed since Verified? (a stale build, `yolo = until-release` or a major
bump the operator did not name still ask; `always` asks it every flow, as before 0.89) — and
`reflect = on-friction | always`: when `flow finish` runs the closing reflection worker. `on-friction` (default)
skips it for a flow that hit no gate refusal and no guard block and carries no `--note`; `always` runs it every
time. `## global` also takes
`forge = github | gitlab | self` — the release machinery's target; when unset it is detected from the
`origin` URL at the moment of use (GitHub gets `gh`, GitLab gets `glab`, self-hosted stays forge-neutral:
no automatic release creation, merge proof by ancestry only), and `release.releases = false` skips
automatic release creation entirely.

### The merge policy (`merge = squash | merge | rebase | any`)

The one knob a repo can silently lack: a squash and a merge commit look identical right up until someone
needs to know which one the release contains. Three things read the key:

| policy | `main` gains | provable with git alone |
|---|---|---|
| `merge` | a merge commit plus the branch's own commits | **yes** — the branch is an ancestor of `origin/<default>` |
| `squash` | one new commit | no — ask the forge (`gh`/`glab`) |
| `rebase` | the branch's commits, replayed with new SHAs | no — same |

- **`flow init` asks** with evidence from your own history (`merge history: 6 merge commit(s), 3 squash(es)
  — the most recent PR landed as squash`), and **`flow start` refuses until it is set**: the agent asks you
  in chat, re-runs with `--merge=<style> --confirmed`, and the answer is inserted as a single line under
  `## release` (validated before the write, `.bak` kept, committed as a playbook chore when the playbook is
  the only dirty path). `any` is the explicit opt-out: no policy, no asking.
- **the guard enforces it where the decision is made** — `gh pr merge <n> --squash` against `merge = merge` is
  blocked outright, and a merge that carries no style flag (so the forge default decides) needs your
  confirmation; a local `git merge --squash` only ever confirms, because merging main into a branch is
  ordinary work. Spell the PR number **before** the flag: `gh pr merge --merge main` reads `main` as the
  PR selector ("no pull requests found for main") and never merges anything.
- **whatever the style, merge only once CI is green** (`gh pr checks <n> --watch`): the local gate cannot run
  CI-only jobs — a tool the host lacks turns a locally-green branch into a red default branch (gh#134).
- **`release-done` proves what actually landed** matched the policy (branch ancestry plus what the forge
  reports), and `flow finish` says whether commits missing from the default branch are expected (squash,
  rebase) or a violation (merge — where `yolo` does not answer for you). A shape dev-flow cannot see —
  `forge = self`, no CLI, an unfetched branch — prints an advisory instead of refusing a legal release.

What it cannot do is bind a human clicking the merge button in the Web UI: only the forge's own
require-a-merge-strategy setting does that, and setting it stays your step in the forge, not dev-flow's.

`flow init` is the dialogue around this file (see the Quickstart above).

On a **fresh repo** it prints the setup brief: the detection report, plus one question per knob, each with `detected:` / `accept:` / `why:` lines. It writes nothing.

`--answers key=value …` (or `--answers-file <path>`, one pair per line, `#` for comments) applies answers as targeted edits onto the fresh draft, or onto the current file if one exists:
- Keys: `forge`, `defaultBranch`, `setup`/`test`/`build`/`run`/`dev`/`health`, `versionFile`/`versionTag`/`changelog`, `releases`/`artifact`/`preflight`/`merge`, and `check.<name>` for a `flow-check` block. An empty value removes a check.
- Hand-written lines survive, and a key already written under one release section stays there.
- It previews the summary and the diff, and writes only with `--confirmed` (or on a dialog yes).

`--write "<content>"` / `--write-file <path>` replace the whole file. The content is hard-validated, and the result shows the diff.

`--track` commits the playbook as a playbook chore (`git add -f` + the main-hook prefix). `--draft` prints the draft, or the current file, without writing.

On an **existing file** init is doctor mode. It reports drift, dead commands and scripts, an unparseable manifest, dual configs, and **ghost feature dirs** (a `.dev-flow/<slug>/` whose `state.json` is gone). It offers to delete ghost dirs on your confirm, and says so instead when no UI is present; to keep one as a new feature's draft, decline and run `flow start <slug> --confirmed`, which adopts it. It never runs your commands.

When a hook manager sets `core.hooksPath` (husky, lefthook…), git ignores `.git/hooks`, so init prints the main-branch guard lines for you to add to that hook instead of installing one that would never run. An existing foreign `pre-commit` gets the same printout.

Init prints its findings and never regenerates your file: a draft cannot reproduce your prose, checklist items and hand-set keys. `--force` is the deliberate overwrite — with your word (`--confirmed`, or one
confirm dialog) and a `project.md.bak` of what was there. At any time
you can just edit `.dev-flow/project.md` yourself — the next `flow init` (doctor) validates and
flags problems, and `flow doctor` runs the same probes on demand without offering to change
anything (findings are also printed whenever `flow init` runs without a UI, e.g. in CI). `--force`
rewrites from fresh detection. Improvement
ideas the agent notices along the way queue up in `.dev-flow/reflections.md` — *this project's*
queue only: `## playbook` (the fix lives in your playbook → docs flow) and `## code` (the fix
touches your code → patch flow). Feedback about dev-flow itself never lands there: it becomes a
GitHub issue on the dev-flow repo. `flow reflect --playbook|--code "<note>"` appends a note,
`flow reflect --plugin "<note>"` prints the upstream issue recipe instead (no flag guesses from the
wording and prints why), `flow reflect list` numbers the open ones, `flow reflect move <n>
--playbook|--code` re-files one, `flow reflect tidy` drops the closed (`- [x]`) ones, plain
`flow doctor` reviews the open ones and routes each fix to the flow that implements it. At finish
— run by `flow finish` itself, before it removes anything — a fresh read-only **reflect worker**
(`flow_stage` op `reflect`) reviews the whole session — the
driver's and every worker's transcript — and returns classified findings with a fold/drop
recommendation each; the operator decides per item (fold = a queue row or an upstream issue, drop
= nothing recorded). Suggestions to fix open items or tidy closed ones are timed (finish, between
flows, doctor — never mid-feature) — and nothing there ever gates.
Future features have their own file: `.dev-flow/roadmap.md`, a gitignored backlog `flow roadmap`
manages (add / pick → `flow start` / done / tidy) — a picked item is checked off by `finish` when
its feature ships, and it never gates either.

### Structured stage reports (a convention, not a gate)

The gates enforce *state*; how the agent *talks* about that state is presentation. The norm lives in
the skill itself — the **Stage reports** clause in `SKILL.md` ground rules, echoed by the
`Stage reports:` line in every stage-context injection — so every repo using dev-flow gets the same
output protocol without writing a word of playbook prose. This is the human explanation of it.

**Two readers, one result.** Every `flow` tool result is split. The agent's copy keeps every
instruction (what to run next, what to ask). Your copy — the tool row in the TUI — shows a header
(`✅ Verification · dark-mode`, `❌ … refused`, `💬` when it waits on you), the stage line, the facts,
and the one question waiting on you, phrased as a word to answer in chat. Lines the gate marks
agent-only, and any clause that names a `flow` command, are left out of your copy (expand the row to see
them dimmed). The test suite checks every gate it drives: no operator view names a command. If an answer
still hands you a command to type, the next run gets a hidden correction.

**The gate writes the stage line.** It is built from state on every gate that has a feature in scope,
so it is the same every time; the agent pastes it as is (`stage line for your report`) instead of
rebuilding glyphs and marks from memory.

One gate message = **stage line** + event title + **`Done:`** / **`Next steps:`** blocks, all plain
markdown, **never fenced** (a fenced block renders monospace with a horizontal scrollbar in web UIs;
fences stay for diffs and command output).

**The stage line** *is* the decision record — one copy of every fact. It opens with the statusbar's
own stage glyph (the footer is the legend: 💬 pre-flow "operator, your turn" · 📝 plan · 🔨 implement
· 🔍 pre-release · 🚀 release · 🏁 finish), then `slug — key value` pairs separated by `·`, with the
mode glyphs after the slug as in the footer (⚡ patch · 📚 docs · 🎱 yolo). Every value carries a
provenance mark:

| mark | meaning |
|---|---|
| `✓` | operator-decided |
| `✓playbook` / `✓detected` | decided by a rule or auto-detection |
| `~` | agent-assumed — vetoable; flips to `✓` when the stage's verb is given |
| `?` | pending the operator's word |

A decision not made reads `pending` — never left unstated, never silently invented (a version bump
needs the operator's word; `no-version` too). Per-stage fields after the core (stage · slug · mode ·
ui): plan status and mockups; commits `N ahead, M uncommitted`, tier-1, deploy/health, `branch@sha`;
the version decision (`bump <level> → vX.Y.Z ~`) with tag/changelog/fold/review/merge-style beside
it; PR/tag/artifact/forge proofs at 🚀 (stage lines only there — that stage asks nothing); release-
recorded / main-state / unmerged / reflections at 🏁.

**The checkpoint** closes exactly one message per stage (the operator's verb stays a plain-chat word
— a structured-question tool is not chat). Event title, then the labels **`Done:`** and
**`Next steps:`** standing alone on their own lines. `Done:` says what now works, in plain words and
counts, not vibes; a path or SHA only when the operator needs it. Internals (modules, code paths)
stay out of chat unless asked. `Next steps:` lists the operator's verbs in italics (the recommended one
***bold italic***, and no line needs a "(recommended)" tag when the styling carries it) and **never
gate commands** (the agent runs those): recommended first, then alternatives, then *yolo* last with
what it pre-confirms, then the plain closing line "or say what to do differently". Example:

> **🔍 pre-release · `dark-mode`** — `normal` ✓playbook · ui `on` ✓ · commits `4 ahead, 0 uncommitted` · checks test ✓ build ✓ · version `0.56.0` ~ · merge `merge` ✓playbook · `feat/dark-mode@3f2c1a9`
>
> **Release prep done**
>
> **Done:**
> review 0 must / 0 should; CHANGELOG `## [0.56.0]` folded from `Unreleased`; manifest bumped
>
> **Next steps:**
> - ***Release*** → tag `v0.56.0`, forge release — locks the `~` fields
> - *No-version* → merge only, entry rides under `Unreleased`
> - *Yolo* → release with these parameters, remaining gates back to back
> - or say what to do differently — bump level, changelog wording

Mid-stage (non-checkpoint) reports are the stage line plus a short body — no `Next steps:` block —
and mid-stage scope additions amend `plan.md` with an `**Added mid-stage:**` line instead of opening
a second checkpoint. Like all tier-3 prose this is advisory: gates refuse what gates refuse no matter
how the report is formatted. A project can still set `prose.<stage>` for its own stage guidance —
that replaces the built-in guidance text but the Stage reports rule keeps applying.
