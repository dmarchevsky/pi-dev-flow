# Gate reference

Every gate: what it advances and what makes it refuse.

You normally type none of this. The agent runs the gates, and you answer in chat. `/flow <sub>` is
your **manual override**: use it to read state when the agent is confused, or to advance a gate
yourself when the agent is stuck.

**How checkpoints work.** The agent's `flow` call never opens a dialog. A checkpoint gate refuses
with `NEEDS-OPERATOR <Question?>`, the agent asks you in chat, and it re-runs the gate with
`--confirmed` once you answer. A `/flow` command you type yourself asks you in a dialog instead.
`--confirmed` means "the operator literally answered this question". The agent must never add it on
its own.

## Overview

| Gate | Advances | Refuses unless |
|---|---|---|
| `start <slug>` | → plan | the slug is new and the playbook has a `merge` policy |
| `use <slug>` | binds this session | the feature is unfinished |
| `approve` | plan → implement | `plan/plan.md` exists (plus embedded mockups for `--ui`) and you said yes |
| `verify` | implement → pre-release | the branch has commits, checks are green, the deploy is healthy, and you said yes |
| `release` | pre-release → release, then publishes | the version and changelog are right, nothing is uncommitted, and you said yes (or it answered itself) |
| `finish` | release → done | the release is published and recorded, main is clean and pushed, and you said yes (or it answered itself) |

Tools that never gate: `test`, `check`, `health`, `status`, `abort`, `doctor`, `reflect`, `roadmap`,
`help`, `version`.

## start

`flow start <slug> [--ui | --patch | --docs] [--merge=<style>] [--check-upstream]`

Creates the feature, binds this session to it, and renames the session after the slug.

- `--ui` means the plan gate requires rendered mockups. The agent turns it on by itself when screens
  change (it only adds a check); turning it off (`--no-ui` at plan, or aborting a ui feature) needs
  your OK. `--patch` (a small fix, no written plan) and `--docs` (docs only, no build checks) are
  lighter modes the agent proposes at start. Your Approve? answer grants the mode: the question
  names it, and nothing the mode relaxes can happen before you approve.
- **The playbook needs a `merge` policy.** If it has none, start asks which style to use (squash,
  merge, rebase or any), suggests one from your git history, and writes your answer into
  `## release`.
- It prints the dev-flow version, warns if this session runs an older build than the checkout
  (`--check-upstream` also asks npm), and lists playbook gaps.
- A leftover `.dev-flow/<slug>/` without `state.json` (a "ghost") is shown to you and adopted on
  `--confirmed`, unless it still holds a `worktree/`.
- If the roadmap has an item picked for this slug, the plan starts from it.

## use

`flow use <slug>` binds this session to an unfinished feature, records a claim on disk, and renames
the session. It also takes over a feature another session holds. Nothing binds automatically.

## approve: Approve?

`flow approve [--yolo] [--version=patch|minor|major | --no-version]`

- `plan/plan.md` must exist with exactly that name.
- For a `--ui` feature, every screenshot under `plan/` must be embedded in plan.md, every
  `mockups/<screen>.html` needs a `<screen>-<width>.png` render, and no mockup may link into another
  feature's worktree.
- On yes, it creates the worktree and the `feat/<slug>` branch, then runs `setup` there. If setup
  fails, the next `approve` retries it.

**The release call rides on Approve?** On a versioned project with `version = ask` (the default),
the question also asks: *patch, minor or major release, or merge unreleased?* Your answer is recorded
with `--version=<kind>` or `--no-version`; an Approve? answer without it is refused and nothing is
kept. Only the kind of step is recorded, never a number: the number is counted from the newest tag
when the release runs, so a flow that released first moves yours along instead of colliding with it.
No later gate asks the call again. You can change it at any point until the tag is cut: say so,
and the agent runs `flow bump <patch|minor|major|none> --confirmed`, or passes
`--version=<kind>` / `--no-version` on a confirmed `verify` or `release` call. A fold flow — one started with `--reflections`, as `flow reflect plan` prints it — is never asked the call: on a versioned project it always merges unreleased, and `--version=<kind>` or `flow bump <kind>` is refused. A flow approved by an
older dev-flow, with no call on record, is asked at Verified? instead.

## test, check, health

- `flow test` runs the `test` command and records the result.
- `flow check` runs every tier-1 check from `## implement`. If the branch fell behind main, it says
  by how many commits and which files a rebase would conflict in.
- `flow health` runs `seedData` and then the health probe, retrying for up to `healthWait` seconds.

Each record carries a fingerprint of the worktree. When the tree changes, the record goes stale and
the next gate re-runs it. A `--docs` flow runs none of these.

## verify: Verified?

`flow verify [--yolo] [--version=patch|minor|major|<v> | --no-version] [--port=<n> | --replace]`

Run without `--confirmed`, it deploys for your review:

1. Fetches, and rebases the branch if main moved ahead. Conflicts or uncommitted tracked edits
   refuse, and the branch is left untouched.
2. Checks the dev port. If the flow holding it isn't waiting on its Verified?, nobody is reviewing
   that deploy, so verify takes it over and says so. If it is under review, verify runs alongside on
   the next free port when `parallelDev = yes` and a second instance fits; otherwise it asks
   **Dev port?**: replace that deploy, or wait. See [concurrency](concurrency.md).
3. Runs the checks (re-running any that are stale or missing), the build, the `dev` deploy, and then
   the health probe against what it just deployed.
4. Asks **Verified?**

It refuses if:
- no review is on record (see below);
- the branch has no commits (except a release-only flow on a versioned project with unreleased
  commits on main);
- a check, the build or the post-deploy health probe fails;
- `servedBuild` is set and the running app isn't serving this commit.

With `--confirmed`, it never rewrites history. If main moved since the review deploy, re-run
`flow verify`. It also doesn't build or deploy a second time: when the tree is the one it deployed for
your review, it only checks that the app still answers. If the tree changed, or the app stopped
answering, it deploys again.

**The review comes before Verified?** The playbook's review step (`release.review`, `/flow-review`
by default) runs in implement, once `flow check` is green, and the first `flow verify` refuses until
it is on record: a `flow_stage` review worker records itself, and an inline review is recorded with
`flow review done "<verdict>"`. Run after Verified?, every review finding changed the tree you had
already approved and you were asked again. Reviewed first, your one look covers the tree that ships.
Docs flows and release-only cuts owe none, `review = ""` under `## release` turns it off, and
skipping it is your call (`flow review --skip`, asked as **Skip review?**).

**At pre-release, `verify` is the re-verify:** after a late fix, it re-runs the build, deploy and
probes on the current tree and asks Verified? again. A standing yolo never answers this, and
`flow release` refuses until the answer is recorded with `flow verify --confirmed`.

## release: Release?

`flow release [--yolo] [--version=<kind> | --no-version] [--no-fold-check] [--no-marker-check]`

Proves the branch is ready to ship:

- **The version** matches your release call. Patch, minor or major is counted from the newest tag
  at release time, so if a parallel flow shipped first, yours moves to the next number. Versions
  that carry more than x.y.z (a `v` prefix, a suffix such as `-letta_0.34.68`) are ordered and
  bumped by their x.y.z part.
- **The version is new**: the manifest's version isn't tagged yet.
- **The changelog** has a heading for this version, this branch edited it, every entry that was
  pending under `Unreleased` is kept in the new section, and `Unreleased` is now empty.
- **Merge unreleased** (`--no-version`): no bump, but the branch adds its own line under
  `Unreleased`. Docs flows are exempt.
- The checks are green. The gate runs any that are stale or missing itself. Checks that passed
  before a commit holding only release prep (version file, changelog) stay green without a re-run;
  set `recheck = always` in `## release` to re-run them anyway. `release.preflight` passes if set.
- There are no leftover conflict markers (`<<<<<<<`) and no uncommitted files in the worktree.
- **A review is on record.** It normally ran before Verified? (see [verify](#verify-verified)); a
  flow that reached pre-release without one owes it here. The verdict stays advisory; only that a
  review ran is checked.
- **No re-verify is waiting.** When `flow verify` at pre-release asked Verified? again, the answer
  has to be recorded (`flow verify --confirmed`) before the release ships under it.

**Release? usually answers itself** (`ask = on-change`, the default): your Verified? is the release
word. That happens when your call is on record and only release prep (bump, changelog), docs
(`docs/`, README, CHANGELOG) or tests changed since Verified?; the output names any docs/test commit
that rode under it. A `--confirmed` given before the gate asked doesn't count where a question carries news you haven't
seen (commits after Verified? on a yolo flow, or a stale build): the gate asks first. A yolo held back
only by `yolo = until-release` is asked like any flow, so your chat answer stands on the first call.

It still asks when:
- code changed after Verified? (a CI fix, a late review fix: news you haven't seen);
- a standing yolo reaches it and the playbook sets `yolo = until-release` (a Verified? you gave yourself is not held back);
- it's a major bump the playbook made rather than you.

A session running an older dev-flow build than the install is a note on the release output, not a
question: it names both builds and what didn't run, and `/reload` picks up the newer one.

Set `ask = always` in `## release` to be asked every time.

Escape hatches, used only on your word: `--no-fold-check` skips the line-level changelog check, and
`--no-marker-check` allows intentional conflict-marker lines.

### Publishing

On GitHub, the same `flow release` call then publishes. Your Release? answer is what authorizes it:

1. Pushes the branch and opens the PR. The body is `.dev-flow/<slug>/pr-body.md` when the agent
   wrote one, else the changelog entry. If the repo has a pull-request template
   (`.github/pull_request_template.md`), the gate refuses until `pr-body.md` exists, before
   Release? is asked, so the template's sections are filled before the merge.
2. Checks the branch merges cleanly into the default branch. On a conflict it names the files and pushes nothing.
   It also checks the version again against the newest tag: if another release landed since Release?, it
   names the number to re-bump to (with the conflict, when there is one) and merges nothing until the branch
   carries it.
3. Waits for the PR's CI, up to 30 minutes. A repo with no CI is given a minute for checks to show up. A check pending for 5 minutes has its Actions job asked directly: GitHub can leave a check run `in_progress` after its job finished, and the job's result is used then.
4. Merges in the playbook's `merge` style.
5. Waits for the merge commit's own CI to go green, because the tag publishes from that commit. If it's red, the
   gate stops without tagging. If no CI runs on that commit, it tags after a minute. `tagWait = none` under
   `## release` skips this wait.
6. Creates an annotated tag on the PR's merge commit and pushes it (versioned flows). The tag is the version
   file **at that merge commit**, checked against your call one last time. No number is fixed earlier, so a
   re-bump after a merge of the default branch is what gets tagged. A tag of the same name on another commit
   stops it. A failed run that a tag push started does not count as the merge commit's CI.
7. Records the release (below).

Each step first asks GitHub whether it's already done, so a re-run picks up where it stopped, and a
step you did by hand (merging a PR that needed your review, for example) is accepted. The gate stops
with `publish waiting` when CI is still running, and with `publish stopped` when a check is red, the
forge refuses the merge, or `gh` can't answer. In both cases, `flow release` again resumes.

Set `publish = manual` in `## release` to have the agent run these steps instead. That is also what
happens on GitLab, on a self-hosted forge, and without `gh`.

### The release record

Asks no question, because your Release? answer covered it. On the manual path, `finish` runs it.

- The tag exists, is reachable from main, and is **on origin**. If origin can't be reached, it
  refuses rather than trust local tags.
- `release.artifact` (for example `npm view <pkg>@{version} version`) passes. On GitHub, it waits
  for the CI runs the tag started.
- It creates the forge release (`gh` / `glab`), using the changelog entry as the body, then reads it
  back to confirm it exists and matches.
- It checks that the merge matched the `merge` policy. If that can't be seen (self-hosted forge, no
  CLI), it prints a note instead of refusing.

Skip flags (on your word): `--no-artifact-check`, `--no-release-create`. You can also set
`release.releases = false` or `forge = self` to skip creating the forge release.

`/flow release-done` runs the record by itself. It's a manual override; the agent has no reason to
call it.

## finish: Finish?

`flow finish [--yolo] [--no-reflect] [--note=<text>] [slug]`

1. Records the release if `flow release` didn't already (manual publishing). If the `## release` checklist still has open
   items, it stops and lists them.
2. Runs the after-merge checks (`flow-check` blocks under `## release`) from the main checkout. A red
   one stops finish and removes nothing.
3. Runs the **closing reflection** (see [reflections](reflections.md)) and files the reviewer's own
   fold/drop recommendations: a fold becomes a note (or a recurrence on the note it duplicates), a
   drop records nothing. The output lists each with how to undo it. dev-flow feedback for upstream is
   named for you, never filed by the gate. `finish = always` asks fold/drop as before.
4. Cleans up, on `--confirmed` or when Finish? answers itself: removes the worktree, the branch and `.dev-flow/<slug>/`. It deletes
   the remote branch only once it's proven merged. If local main is just behind origin, it
   fast-forwards it.

It refuses until the release is recorded, the main checkout is clean, the local default branch has
nothing origin lacks, and the worktree has no uncommitted changes. It reads the local default branch
even when the main checkout is on another branch, and names the commits that are local-only.
Playbook commits from `flow init --track` are only noted: they reach origin through a docs flow,
never a direct push. Under `merge = merge`, commits missing from main are a policy violation that
yolo can't answer.

**Finish? answers itself** (`finish = on-change`, the default) once the release is recorded, the
closing reflection was skipped or filed, and no forge release was skipped. `## release` checklist
items are work, not a question: the first `finish` stops once and lists them (run from the main
checkout), and the next `finish` closes out. It still asks when a forge release was skipped or the
reflection's report didn't parse, and always with `finish = always` in `## release`.

To drop an unreleased feature, use `flow abort` instead.

## reflect, roadmap, doctor

- `flow reflect …` manages the notes queue. See [reflections](reflections.md).
- `flow roadmap [add "<feature>" [--slug=] [--brief=] | pick <n> <slug> | done <n>[,<n>…] | drop <n>[,<n>…] | tidy]` — `<n>` is the row number the list prints; `done` leaves the others in place, `drop` and `tidy` renumber
  manages `.dev-flow/roadmap.md`. `pick` stamps an item for `flow start <slug>`, and `finish` checks
  it off when the feature ships.
- `flow doctor ["<note>"]` is a read-only health report: playbook drift, dead commands, ghost
  folders, orphan worktrees and branches, and a review of every open reflection. It writes nothing,
  so it's safe at any stage and in CI.

## status, abort, help, version

- `flow status [slug]` shows where every feature stands. `--json` gives machine output.
- `flow abort [slug]` drops a feature. Before approval, that removes it. After approval, it unbinds
  the session and keeps the worktree, branch and state so nothing is lost.
- `flow abort [slug] --purge` removes what an aborted feature left: the worktree (uncommitted files
  included), the local branch and `.dev-flow/<slug>/`. It asks **Purge?** first and lists what would
  be lost. It never touches origin; a remote branch or open PR is named for you to remove.
- `flow help` (`--json`) prints the gate contract.
- `flow version [--check-upstream]` prints which dev-flow copy this session runs and whether the
  checkout is newer.

These work in any repo, even without `.dev-flow/`.

## yolo

Answering **yolo** at any checkpoint runs that gate with `--yolo --confirmed`. That answers the
question and pre-confirms the rest, so the agent runs the remaining gates back to back, following
any wishes you added ("yolo, patch bump"). Every check and guard still applies. Yolo never answers:
- the re-verify at pre-release;
- Release? when code changed after Verified?, or when the playbook sets `yolo = until-release`;
- a `merge = merge` policy violation at finish;
- skipping the closing reflection.
