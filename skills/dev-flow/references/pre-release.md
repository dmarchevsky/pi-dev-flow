> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: pre-release

Prepare the release entirely in the worktree; main stays off-limits until the
release gate hands over.

**Versioning:** the `versioning.file` manifest is the single source of truth;
tags are `versioning.pattern` rendered from it. No `versioning.file` → stop
and settle the scheme with the operator; never invent one.

1. **Review**: `/flow-review` the change; fix every **Must fix** and **Should
   fix**; `flow check` again if code changed.
   - A fix that changes behaviour → `flow verify` again: it redeploys, then
     ask **Verified?** over the fixed build and run `flow verify --confirmed`
     on the answer (stays in pre-release; a standing yolo does not answer it).
     Otherwise `flow release` warns that the fix shipped after Verified?.
2. **Docs**: update them to match the change.
3. **Changelog + bump** — manifest, changelog heading and tag must agree;
   commit the prep on the feature branch. The release call recorded with
   Verified? decides which: its kind, counted from the newest tag (the gate
   names the number — another flow that released first moves it), an exact
   version (taken by another flow → ask again, never pick one), or
   *merge unreleased* — no bump, the line goes under `Unreleased`.
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
4. `flow check` — the prep made the earlier checks stale.
5. **Run `flow release`.** By default (`ask = on-change`) it answers
   Release? itself when the release call is on record and only the prep
   landed since Verified? — say in a few lines what the PR delivers (the
   changelog entry usually is that) and the version, and carry on with the
   release stage.
6. **It returned `NEEDS-OPERATOR Release?`** (it says why: code after
   Verified?, no call on record, a stale build, `yolo = until-release`, a
   major bump, or the playbook's `ask = always`) → **ask Release? and
   stop**, with the same summary and the version. Report opening:
   **🔍 pre-release · `<slug>`** (the gate's stage line; the version field
   reads `pending` until decided — never invent a bump or a no-version
   decision). Answer → `flow release --confirmed`.
   - Standing yolo → run `flow release` without asking. It still returns
     `NEEDS-OPERATOR Release?` when commits landed after Verified? or the
     playbook says `yolo = until-release` — then ask.
   - Operator ships **without a version** → `flow release --no-version
     --confirmed`: no bump or tag, but the branch must add its line under
     `Unreleased`. A changed call is `--version=<v>` / `--no-version` with
     `--confirmed`, on their word.

The gate re-checks tier-1, requires the manifest ahead of the last tag and a
changelog **heading** for that version written on this branch.
