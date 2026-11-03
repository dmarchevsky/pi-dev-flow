# The playbook — `.dev-flow/project.md`

The operator-owned file that says how *your* project is tested, run, versioned and guarded. Written once per repo with `flow init`, edited by you.

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
`versionFile`/`versionTag` (defaults `v{version}`; accepted under either section) and
`merge = squash | merge | rebase | any` — how a merged PR lands on the default branch (see below). `## global` also takes
`forge = github | gitlab | self` — the release machinery's target; when unset it is detected from the
`origin` URL at the moment of use (GitHub gets `gh`, GitLab gets `glab`, self-hosted stays forge-neutral:
no automatic release creation, merge proof by ancestry only), and `release.releases = false` skips
automatic release creation entirely (the legacy `github` key still parses, with a rename warning).
A leftover `project.json` is no longer read — the doctor tells you to fold it in and delete it.

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
- **`release-done` proves what actually landed** matched the policy (branch ancestry plus what the forge
  reports), and `flow finish` says whether commits missing from the default branch are expected (squash,
  rebase) or a violation (merge — where `yolo` does not answer for you). A shape dev-flow cannot see —
  `forge = self`, no CLI, an unfetched branch — prints an advisory instead of refusing a legal release.

What it cannot do is bind a human clicking the merge button in the Web UI: only the forge's own
require-a-merge-strategy setting does that, and setting it stays your step in the forge, not dev-flow's.

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
`flow reflect "<note>"` appends them (`--playbook` / `--plugin` says which section, no flag guesses
from the wording and prints why), `flow reflect list` numbers the open ones, `flow reflect move <n>
--plugin|--playbook` re-files one, `flow reflect tidy` drops the closed (`- [x]`) ones,
plain `flow doctor` reviews the open ones and routes
each fix to the flow that implements it (docs flow for playbook items — those edits only pass a
docs/patch flow's worktree), bare `flow reflect` hands the agent the full end-of-session
reflection protocol (review the session log, re-check open items against fixes that already
shipped, dedupe new findings, put the fix decision to the operator) — and nothing there ever gates.
Future features have their own file: `.dev-flow/roadmap.md`, a gitignored backlog `flow roadmap`
manages (add / pick → `flow start` / done / tidy) — a picked item is checked off by `finish` when
its feature ships, and it never gates either.

### Structured stage reports (a convention, not a gate)

The gates enforce *state*; how the agent *talks* about that state is presentation. The norm lives in
the skill itself — the **Stage reports** clause in `SKILL.md` ground rules, echoed by the
`Stage reports:` line in every stage-context injection — so every repo using dev-flow gets the same
output protocol without writing a word of playbook prose. This is the human explanation of it.

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
**`Next steps:`** standing alone on their own lines. `Done:` names the review surface — paths, SHAs,
counts, not vibes. `Next steps:` lists the operator's verbs in italics (the recommended one
***bold italic***, and no line needs a "(recommended)" tag when the styling carries it) and **never
gate commands** (the agent runs those): recommended first, then alternatives, then *yolo* last with
what it pre-confirms, then the plain closing line "or say what to do differently". Example:

> **🔍 pre-release · `dark-mode`** — `normal` ✓ · ui `on ✓` · version **`bump minor → 0.56.0 ~`** · tag `v0.56.0 ~` · changelog `ready ~` · merge `merge ✓playbook`
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
