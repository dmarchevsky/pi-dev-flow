> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: pre-release

Implemented, tested, running locally; prepare the release entirely in the
worktree — main-repo git state stays off-limits until this gate hands over.
Prep that is mostly review and judgment (the review itself, changelog wording,
the version decision) stays in-session; `flow_stage` (`stage: "pre-release"`)
can take heavy mechanical work on the same terms as the implement stage —
operator words travel in `note`, gates and checkpoints stay with you, rerun
`flow check` after the worker returns (see implement.md).
**Versioning:** the `versioning.file` manifest is the single source of truth
and tags are `versioning.pattern` rendered from it — one number everywhere. If
`versioning.file` is unset, stop and clarify the scheme with the user; never
invent one mid-release. Sequence:

1. `/flow-review` the change; fix every **Must fix** and **Should fix**
   finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the manifest to the exact version you will
   tag — manifest, changelog and tag must agree; commit the prep on the feature
   branch. **The changelog writer reviews the branch, not its commit list**:
   read `git log <default>..HEAD` *and* `git diff <default>…HEAD` first and
   write the entry from the net change the branch delivers, in the reader's
   terms (what was broken, what works now) — this entry is also the forge
   release body, so it publishes verbatim. **One entry per net change, never
   one per commit:** a feature that needed iteration commits (the fix, its
   follow-up, the test that chases it) is **one** line telling the final state;
   two lines sharing a subject are the tell to merge them. Work that never
   reached the reader — reverted mid-branch, dropped on the way, pure moves —
   gets no line. Consolidating your own entry is fold-safe: the fold proofs
   below guard lines that were already pending under `Unreleased` (another
   flow's), which you move verbatim; your own prose is yours until the heading
   ships. A versioned release **folds the `Unreleased` section** (entries
   `--no-version` flows left there) under the new version heading: the gate
   refuses while entries remain, refuses a fold that **drops or rewrites** one
   (move the lines as they are and reword afterwards in a follow-up), and
   refuses a changelog this branch never touched. `--no-fold-check` skips only
   the line proofs, on the operator's word.
4. `flow check` — the prep edits invalidated the implement checks; the release
   gate demands them green again.
5. State what the PR will contain, present version and changelog entry,
   **stop** — **Release?** → `flow release --confirmed`. Checkpoint report:
   stage line **🔍 pre-release · `<slug>`** — version decision (`pending` /
   `bump <level> → vX.Y.Z ~` / `no-version ✓`) · tag · changelog · fold ·
   review tally · merge style, then `Done:`/`Next steps:` per the Stage
   reports rule. The gate re-checks
   tier-1, requires the manifest **ahead of the last tag**, a changelog
   **heading** naming that version (a mention in prose is not an entry) and that
   this branch prepared the entry. Operator ships this flow **without
   version/tag** → `flow release --no-version --confirmed` — no bump, but the
   changelog entry under `Unreleased` is still required: the gate proves the
   branch **added a line there**, not that it edited some older section.

