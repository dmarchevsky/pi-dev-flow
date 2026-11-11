# The playbook: `.dev-flow/project.md`

Your playbook says how *your* project is tested, run, versioned and guarded. `flow init` writes it,
and after that it's yours to edit. The agent can't change the main copy. It can only edit the
playbook inside a docs or patch flow, so every change is reviewed like any other.

## Quickstart

1. Run `/flow init`. dev-flow reads the repo, prints what it found, then asks one numbered question
   per setting. Each question shows what was `detected:`, the answer that keeps it (`accept:`), and
   `why:` it matters. Nothing is written yet.
2. Answer in chat. "Keep these" answers every question that has an `accept` line.
3. The agent applies your answers in one call (`flow init --answers merge=squash test="npm test" …`)
   and shows you a summary and a diff.
4. You confirm. The agent writes the playbook and commits it (`--confirmed --track`).
5. Add anything detection can't know later: checklist items, guidance, guard rules. Edit the file
   yourself or ask the agent.

In a TUI, a single dialog offers to accept everything detected. Decline it to go through the
questions in chat.

**What detection reads** (files and git only; it never runs your commands):
- language manifests, the package manager and its scripts;
- lint, typecheck and format scripts, Makefile / justfile / Taskfile targets;
- CI workflows and publish steps (npm, crates, container images);
- Dockerfile and compose files;
- `.env` files and `secrets/` folders, which become suggested guard rules;
- the version file, existing tags, the changelog, the merge style in your history;
- CLAUDE.md, AGENTS.md and CONTRIBUTING.md, named so their rules can be proposed but never copied
  silently.

Anything detection can't find is asked about, never guessed.

**Typical playbooks**, to start small and grow:

| Project | `## implement` | `## pre-release` / `## release` |
|---|---|---|
| npm library | `test`, `build`, lint/typecheck checks | `versionFile = package.json`, `artifact = npm view --prefer-online <name>@{version} version`, `merge = …` |
| Go / Rust CLI | `test`, `build`, vet/clippy checks | `versionFile = VERSION`, `merge = …` |
| web service | `setup` (install + copy `.env`), `test`, `run`, a `health` check, `(ui)` checklist items | `versionFile`, `merge = …` |
| Docker app | `dev = docker compose up -d --build`, a `health` check | `preflight = docker build .`, `artifact = docker buildx imagetools inspect <image>:{version}` |

## How the file is organized

Sections follow the stages (`## global`, `## plan`, `## implement`, `## pre-release`, `## release`).
Inside each one, content has three tiers:

| Tier | Written as | What happens |
|---|---|---|
| 1. checks | a ` ```flow ` block of `key = value` lines, and ` ```flow-check <name> ` command blocks | gates run them and record pass/fail. **Hard.** |
| 1. guard rules | a ` ```flow-guard ` block in `## global` | checked on every command and edit. **Hard.** |
| 1. worker setup | a ` ```flow-worker ` block in `## global` | runs first in every `flow_stage` worker (for example, exporting a test password) |
| 2. checklist | `- [ ] item` lines | you confirm them as a set at the gate |
| 3. prose | any other text | shown to the agent when the stage starts. Advisory. |

**Checklist tags:**
- `- [ ] (ui) …` applies only to `--ui` features.
- `- [ ] (versioned) …` applies only when the flow ships a version.
- `- [ ] (docs) …` is kept on a `--docs` flow. Other `## implement` items are skipped there, since a
  docs flow builds nothing.

If you change the items, you're asked again.

**Prose:** your `## implement` prose replaces dev-flow's built-in "senior discipline" guidance.

Example:

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

## Implement settings

| Key | What it does |
|---|---|
| `setup` | runs once in a fresh worktree at `approve`, for example `cp .env.example .env && npm ci`. A failure fails the gate. |
| `test` | your test command |
| `build` | runs at `verify` |
| `run` | how the agent starts the app to try it. dev-flow never runs it itself. |
| `dev` | the dev deploy `verify` runs before asking you. It must start in the background and exit, like `docker compose up -d`. |
| `seedData` | runs before the health probe |
| `health` | the health probe. After a deploy, `verify` re-runs it and refuses if it fails. |
| `healthWait` | seconds the probe keeps retrying, every 2s (default 30; `0` = try once) |
| `servedBuild` | prints the commit the running app serves. `verify` checks it's this branch's HEAD. |

The health probe runs in the worktree, so it can compare the app's build stamp with
`git rev-parse HEAD`. Without a probe, `verify` says `health: none configured` and `flow doctor`
flags it.

### Dev port and parallel flows

By default, two flows on one machine share one dev stack. To let them run side by side:

```flow
port = 8090                 # default dev port, exported as $DEV_FLOW_PORT
parallelDev = yes           # can two instances run side by side? (no = replace or wait only)
instanceMem = 2G            # what one instance needs, checked against free RAM
instanceDisk = 5G           # ...and against free disk
dev = BFF_PORT=$DEV_FLOW_PORT COMPOSE_PROJECT_NAME=app$DEV_FLOW_SUFFIX docker compose up -d
devDown = COMPOSE_PROJECT_NAME=app$DEV_FLOW_SUFFIX docker compose down
servedBuild = curl -fsS http://127.0.0.1:$DEV_FLOW_PORT/version
```

`$DEV_FLOW_SUFFIX` is empty on the default port and `-<slug>` on any other, so a second instance gets
its own compose project. The deploy output shows what the variables resolved to.
`flow finish` runs `devDown` for an instance on a non-default port. See
[concurrency](concurrency.md#sharing-one-dev-stack).

## Guard rules

Your project's own safety rules go in a `flow-guard` block in `## global`:

````markdown
## global
```flow-guard
deny    \bgit\b[^\n]*\bworktree\s+prune\b :: it prunes other sessions' worktrees
confirm \bgit\b[^\n]*\bbranch\s+(?:-D\b|--delete\b) :: deletes a branch git can't see as merged
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b :: drops a permanent upstream connection
protect docker/.env*                 :: live secrets, and any backup copied beside them
forbid  docker/secrets               :: secret storage
```
````

| Verb | Applies to | What happens |
|---|---|---|
| `deny` | a bash command (regex) | blocked |
| `confirm` | a bash command (regex) | asks you; blocked when there's no UI to ask |
| `protect` | an edit/write path | asks you; blocked when there's no UI |
| `forbid` | an edit/write path | blocked |

Tips:
- Text after ` :: ` is the reason, shown when the rule fires.
- An invalid regex makes the playbook invalid, and `flow init` refuses it.
- Match the **verb** you mean, not a flag. `\bgit\b[^\n]*--force` also blocks
  `git filter-branch --force`.
- You don't need a rule for force pushes. dev-flow already asks you about every one.
- A path rule on a directory covers everything under it, including files that don't exist yet.
- A glob only works in the **last** path segment: `docker/.env*` covers `.env` and
  `.env.bak-2026`. A glob anywhere else matches nothing, and `flow init` warns about it.
- Rules are matched per shell segment (`;`, `|`, `&&`). Read-only commands like `grep`, `cat` and
  `git log` are skipped, so `grep "git push --force" docs/` is just a search. Read-only commands that
  can write (`find -delete`, `sort -o`) are still checked.
- Guard rules belong in `## global` only. A block under a stage is ignored with a warning.

## Release settings

These go under `## pre-release` or `## release`. Either section works.

| Key | Default | What it does |
|---|---|---|
| `versionFile` | — | the version manifest (`package.json`, `VERSION`, …). Without it, releases are unversioned. |
| `versionTag` | `v{version}` | tag format |
| `changelog` | `CHANGELOG.md` | set it empty to opt out |
| `merge` | *(asked)* | how a PR lands: `squash`, `merge`, `rebase` or `any`. See below. |
| `version` | `ask` | who makes the release call: `ask` (you, at Verified?), or `versioned` / `unversioned` for every flow |
| `ask` | `on-change` | `on-change`: Release? answers itself when only release prep changed. `always`: ask every time. |
| `yolo` | `all` | `until-release`: a yolo given earlier never answers Release? |
| `reflect` | `on-friction` | `always`: run the closing reflection on every finish |
| `review` | `/flow-review` | the review step at pre-release |
| `preflight` | — | runs in the worktree at `flow release` before anything ships, for example `docker build .` |
| `artifact` | — | proves the release was published, for example `npm view <pkg>@{version} version` |
| `releases` | `true` | `false` skips creating a forge release |

`## pre-release` prose is a good place for your versioning rules, such as "minor for user-facing
features, patch otherwise". The gates check the mechanics: the version is bumped past the last tag,
and the changelog has the entry. See [gates](gates.md#release-release).

A changelog entry describes the branch's **net change**, not its commit history. A feature that took
several commits is one entry.

### The merge policy

A squash and a merge commit look the same until someone needs to know which one a release contains.
So dev-flow asks.

| Policy | Main gains | Provable with git alone? |
|---|---|---|
| `merge` | a merge commit plus the branch's commits | yes |
| `squash` | one new commit | no, it asks the forge |
| `rebase` | the branch's commits with new SHAs | no, it asks the forge |
| `any` | no policy, and no asking | — |

- **`flow init` and `flow start` ask** if it isn't set, with evidence from your history.
- **The guard enforces it.** `gh pr merge <n> --squash` under `merge = merge` is blocked, and a merge
  with no style flag asks you. Put the PR number *before* the flag.
- **Merge only once CI is green** (`gh pr checks <n> --watch`). Local checks can't run CI-only jobs.
- **`release-done` proves** that what landed matches the policy. When it can't tell, it prints a note
  instead of refusing.

dev-flow can't stop someone clicking the merge button in the web UI. Use your forge's
merge-strategy setting for that.

## Global settings

| Key | Default | What it does |
|---|---|---|
| `defaultBranch` | `main` | |
| `forge` | detected from `origin` | `github` (uses `gh`), `gitlab` (uses `glab`) or `self` (no automatic releases; merges proven by git ancestry) |
| `branchPattern` | `feat/{slug}` | |
| `worktreeDir` | `.dev-flow/{slug}/worktree` | |
| `mainHook` | `true` | install the `pre-commit` hook that blocks main commits |
| `mockupGlobs` | `*.png` | what counts as a mockup render for `--ui` |
| `bashTimeout` | `inject` | `require`: refuse shell calls with no timeout, instead of adding one |

## flow init in detail

- **Fresh repo:** prints the detection report and the questions. Writes nothing.
- **`--answers key=value …`** (or `--answers-file <path>`) applies answers as targeted edits. Your
  hand-written lines survive. It shows a diff, and writes only with `--confirmed`. Keys include
  `forge`, `defaultBranch`, `setup` / `test` / `build` / `run` / `dev` / `health`,
  `versionFile` / `versionTag` / `changelog`, `releases` / `artifact` / `preflight` / `merge`, and
  `check.<name>` for a check block (an empty value removes it).
- **`--write-file <path>`** (or `--write "<content>"`) replaces the whole file, after validating it.
- **`--track`** commits the playbook. **`--draft`** prints the draft without writing.
- **Existing playbook:** init becomes a doctor. It reports drift, dead commands, an unparseable
  manifest and leftover feature folders, and never rewrites your file. `--force` regenerates it from
  fresh detection, with your OK and a `.bak`. `flow doctor` runs the same checks without offering
  changes.
- **Hook managers** (husky, lefthook): init prints the hook lines for you to add instead of installing
  a hook git would ignore.

`.dev-flow/` ignores itself except for `project.md`. To track the playbook in a repo that ignores
the folder: `git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"`.

## How the agent reports

The gates enforce state. How the agent *talks* about it is a convention built into the skill, so
every repo gets it without writing any prose.

**Two copies of each result.** The agent's copy has every instruction. Your copy shows a header
(`✅ Verification · dark-mode`, `❌ … refused`, or `💬` when it's waiting on you), the stage line, the
facts, and the one question for you. It never shows a command for you to type.

**The stage line** is the decision record. The gate builds it from state and the agent pastes it
as is. Every value carries a mark:

| Mark | Means |
|---|---|
| `✓` | you decided |
| `✓playbook` / `✓detected` | a rule or detection decided |
| `~` | the agent assumed it, and you can veto it |
| `?` | waiting on you |

**A checkpoint message** is the stage line, a title, then **Done:** (what works now, in plain
words) and **Next steps:** (your options as words to say, recommended first, yolo last):

> **🔍 pre-release · `dark-mode`** — `normal` ✓playbook · ui `on` ✓ · commits `4 ahead, 0 uncommitted` · checks test ✓ build ✓ · version `0.56.0` ~ · merge `merge` ✓playbook
>
> **Release prep done**
>
> **Done:**
> review 0 must / 0 should; CHANGELOG `## [0.56.0]` folded from `Unreleased`; manifest bumped
>
> **Next steps:**
> - ***Release*** → tag `v0.56.0`, forge release
> - *No-version* → merge only, entry stays under `Unreleased`
> - *Yolo* → release with these settings, remaining gates back to back
> - or say what to do differently
