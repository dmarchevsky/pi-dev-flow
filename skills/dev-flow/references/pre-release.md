> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: pre-release

Prepare the release entirely in the worktree; main stays off-limits until the
release gate hands over.

**Versioning:** the `versioning.file` manifest is the single source of truth;
tags are `versioning.pattern` rendered from it. No `versioning.file` → stop
and settle the scheme with the operator; never invent one.

1. **Review**: it ran in implement, before Verified? — don't run it again.
   A flow that reached pre-release without one (started on an older dev-flow)
   runs it now: `/flow-review`, fix, `flow check`, `flow review done
   "<verdict>"`; `flow release` refuses until a review is on record.
   - A fix that changes behaviour → `flow verify` again: it redeploys, then
     ask **Verified?** over the fixed build and run `flow verify --confirmed`
     on the answer (stays in pre-release; a standing yolo does not answer it).
     `flow release` refuses while that re-verify is unanswered.
2. **Docs**: update them to match the change.
3. **Changelog + bump** — manifest, changelog heading and tag must agree;
   commit the prep on the feature branch. The release call made at Approve?
   decides which: its kind of step, counted from the newest tag (the gate
   names the number — another flow that released first moves it, and the
   gate re-checks it before the merge and again at the tag), or *merge
   unreleased* — no bump, the line goes under `Unreleased`. A project whose
   versions carry more than x.y.z (a `v` prefix, a suffix) keeps those parts;
   the call governs the x.y.z.
   - **Another release landed first** (`flow release` stops: conflict, or "must
     be <x.y.z>") → merge the default branch in, set the version file and its
     changelog heading to the number the gate names, commit, re-run. Never
     tag by hand around it: the gate tags the merged tree's own version.
   - **The changelog writer reviews the branch, not its commit list**: read
     `git log <default>..HEAD` *and* `git diff <default>...HEAD`, then write
     what the branch delivers in the reader's terms (what was broken, what
     works now). The entry is also the forge release body.
   - **One entry per net change, never one per commit.** Iteration commits
     are one line about the final state; reverted or invisible work gets none.
     Rewriting your own entry is fold-safe — the proofs guard only lines that
     were already pending.
   - A versioned release **folds `Unreleased`** under the new heading: move
     pending lines verbatim (reword in a later flow). The gate refuses a
     dropped or rewritten pending line, leftovers under `Unreleased`, and a
     changelog this branch never touched. `--no-fold-check` only on the
     operator's word.
4. **PR body**: if the repo has a pull-request template, write
   `.dev-flow/<slug>/pr-body.md` from it (every section; the changelog entry; the
   commit Verified? was given over). `flow release` opens the PR with it, and
   refuses without it.
5. No `flow check` is owed after the prep commit: the gate keeps green checks across a commit that
   holds only the bump and changelog, and runs any stale check itself.
6. **Run `flow release` before asking anything.** Never ask Release? in
   chat ahead of the call: the gate did not see that question, and when it
   needs the word it asks again, so the operator answers twice. By default (`ask = on-change`) it answers
   Release? itself when the release call is on record and only the prep,
   docs or tests landed since Verified? — the operator's Verified? is the
   release word. Say in a few lines what the PR delivers (the
   changelog entry usually is that) and the version, and carry on with the
   release stage.
7. **It returned `NEEDS-OPERATOR Release?`** (it says why: code after
   Verified?, no call on record, a standing yolo under `yolo =
   until-release`, a major bump, or the playbook's `ask = always`) → **ask Release? and
   stop**, with the same summary and the version. Report opening:
   **🔍 pre-release · `<slug>`** (the gate's stage line; the version field
   reads `pending` until decided — never invent a bump or a no-version
   decision). Answer → `flow release --confirmed`.
   - Standing yolo → run `flow release` bare, without asking. It still returns
     `NEEDS-OPERATOR Release?` when commits landed after Verified? or the
     playbook says `yolo = until-release` — then ask. A stale session build is
     a note in the output, never a question. A `--confirmed` passed before the gate asked is not an answer
     there: the gate asks first. Never carry the standing yolo onto the call
     as `--yolo`: the operator's answer is `flow release --confirmed`.
   - Operator ships **without a version** → `flow release --no-version
     --confirmed`: no bump or tag, but the branch must add its line under
     `Unreleased`. A changed call is `--version=<kind>` / `--no-version` with
     `--confirmed` (or `flow bump <kind> --confirmed`), on their word — taken
     on any call until the tag, a resumed publish included.

The gate runs any tier-1 check that is stale, requires the manifest ahead of the last tag and a
changelog **heading** for that version written on this branch.
