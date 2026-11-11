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
| `release` | pre-release → release | the version and changelog are right, nothing is uncommitted, and you said yes (or it answered itself) |
| `release-done` | records the release | the tag is on origin, the artifact is published, and the forge release exists |
| `finish` | release → done | the release is recorded, main is clean and pushed, and you said yes |

Tools that never gate: `test`, `check`, `health`, `status`, `abort`, `doctor`, `reflect`, `roadmap`,
`help`, `version`.

## start

`flow start <slug> [--ui | --patch | --docs] [--merge=<style>] [--check-upstream]`

Creates the feature, binds this session to it, and renames the session after the slug.

- `--ui` means the plan gate requires rendered mockups. The agent turns it on by itself when screens
  change (it only adds a check); turning it off (`--no-ui` at plan, or aborting a ui feature) needs
  your OK. `--patch` (a small fix, no written plan) and `--docs` (docs only, no build checks) are
  lighter modes and need your OK in chat, after which the agent adds `--confirmed`.
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

`flow approve [--yolo]`

- `plan/plan.md` must exist with exactly that name.
- For a `--ui` feature, every screenshot under `plan/` must be embedded in plan.md, every
  `mockups/<screen>.html` needs a `<screen>-<width>.png` render, and no mockup may link into another
  feature's worktree.
- On yes, it creates the worktree and the `feat/<slug>` branch, then runs `setup` there. If setup
  fails, the next `approve` retries it.

## test, check, health

- `flow test` runs the `test` command and records the result.
- `flow check` runs every tier-1 check from `## implement`.
- `flow health` runs `seedData` and then the health probe, retrying for up to `healthWait` seconds.

Each record carries a fingerprint of the worktree. When the tree changes, the record goes stale and
the next gate re-runs it. A `--docs` flow runs none of these.

## verify: Verified?

`flow verify [--yolo] [--version=patch|minor|major|<v> | --no-version] [--port=<n> | --replace]`

Run without `--confirmed`, it deploys for your review:

1. Fetches, and rebases the branch if main moved ahead. Conflicts or uncommitted tracked edits
   refuse, and the branch is left untouched.
2. Checks the dev port. If another flow that is past its Verified? holds it, verify takes it over
   and says so. If one still under review holds it, it asks **Dev port?**: run alongside on
   another port, replace that deploy, or wait. See [concurrency](concurrency.md).
3. Runs the checks (re-running any that are stale or missing), the build, the `dev` deploy, and then
   the health probe against what it just deployed.
4. Asks **Verified?**

It refuses if:
- the branch has no commits (except a release-only flow on a versioned project with unreleased
  commits on main);
- a check, the build or the post-deploy health probe fails;
- `servedBuild` is set and the running app isn't serving this commit.

**The release call rides on Verified?** On a versioned project with `version = ask` (the default),
the question also asks: *patch, minor or major release, or merge unreleased?* Your answer is recorded
with `--version=…` or `--no-version`.

With `--confirmed`, it never rewrites history. If main moved since the review deploy, re-run
`flow verify`.

**At pre-release, `verify` is the re-verify:** after review fixes, it re-runs the build, deploy and
probes on the current tree and asks Verified? again. A standing yolo never answers this.

## release: Release?

`flow release [--yolo] [--version=<v> | --no-version] [--no-fold-check] [--no-marker-check]`

Proves the branch is ready to ship:

- **The version** matches your release call. Patch, minor or major is counted from the newest tag
  at release time, so if a parallel flow shipped first, yours moves to the next number.
- **The version is new**: the manifest's version isn't tagged yet.
- **The changelog** has a heading for this version, this branch edited it, every entry that was
  pending under `Unreleased` is kept in the new section, and `Unreleased` is now empty.
- **Merge unreleased** (`--no-version`): no bump, but the branch adds its own line under
  `Unreleased`. Docs flows are exempt.
- The checks are green again after the prep edits, and `release.preflight` passes if set.
- There are no leftover conflict markers (`<<<<<<<`) and no uncommitted files in the worktree.

**Release? often answers itself** (`ask = on-change`, the default). That happens when your call is
on record and only release prep (bump, changelog) changed since Verified?. It still asks when:
- code changed after Verified?;
- the session runs an old build (proceeding is allowed, and it says what you'd miss);
- the playbook sets `yolo = until-release`;
- it's a major bump the playbook made rather than you.

Set `ask = always` in `## release` to be asked every time.

Escape hatches, used only on your word: `--no-fold-check` skips the line-level changelog check, and
`--no-marker-check` allows intentional conflict-marker lines.

## release-done

Records the release. It asks no question, because your Release? answer covered it. `finish` runs it
for you if the agent didn't.

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

## finish: Finish?

`flow finish [--yolo] [--no-reflect] [--note=<text>] [slug]`

1. Records the release if `release-done` never ran. If the `## release` checklist still has open
   items, it stops and lists them.
2. Runs the **closing reflection** (see [reflections](reflections.md)) and waits for your fold/drop.
3. On `--confirmed`, cleans up: removes the worktree, the branch and `.dev-flow/<slug>/`. It deletes
   the remote branch only once it's proven merged. If local main is just behind origin, it
   fast-forwards it.

It refuses until the release is recorded, the main checkout is clean and pushed, and the worktree has
no uncommitted changes. Under `merge = merge`, commits missing from main are a policy violation that
yolo can't answer.

To drop an unreleased feature, use `flow abort` instead.

## reflect, roadmap, doctor

- `flow reflect …` manages the notes queue. See [reflections](reflections.md).
- `flow roadmap [add "<feature>" [--slug=] [--brief=] | pick <n> <slug> | done <n> | drop <n> | tidy]`
  manages `.dev-flow/roadmap.md`. `pick` stamps an item for `flow start <slug>`, and `finish` checks
  it off when the feature ships.
- `flow doctor ["<note>"]` is a read-only health report: playbook drift, dead commands, ghost
  folders, orphan worktrees and branches, and a review of every open reflection. It writes nothing,
  so it's safe at any stage and in CI.

## status, abort, help, version

- `flow status [slug]` shows where every feature stands. `--json` gives machine output.
- `flow abort [slug]` drops a feature.
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
