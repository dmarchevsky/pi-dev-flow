> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: pre-release

Implemented, tested, running locally; prepare the release entirely in the
worktree — main-repo git state stays off-limits until this gate hands over.
**Versioning:** the `versioning.file` manifest is the single source of truth
and tags are `versioning.pattern` rendered from it — one number everywhere. If
`versioning.file` is unset, stop and clarify the scheme with the user; never
invent one mid-release. Sequence:

1. `/flow-review` the change; fix every **Must fix** and **Should fix**
   finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the manifest to the exact version you will
   tag — manifest, changelog and tag must agree; commit the prep on the feature
   branch. A versioned release **folds the `Unreleased` section** (entries
   `--no-version` flows left there) under the new version heading: the gate
   refuses while entries remain, refuses a fold that **drops or rewrites** one
   (move the lines as they are and reword afterwards in a follow-up), and
   refuses a changelog this branch never touched. `--no-fold-check` skips only
   the line proofs, on the operator's word.
4. `flow check` — the prep edits invalidated the implement checks; the release
   gate demands them green again.
5. State what the PR will contain, present version and changelog entry,
   **stop** — **Release?** → `flow release --confirmed`. The gate re-checks
   tier-1, requires the manifest **ahead of the last tag**, a changelog
   **heading** naming that version (a mention in prose is not an entry) and that
   this branch prepared the entry. Operator ships this flow **without
   version/tag** → `flow release --no-version --confirmed` — no bump, but the
   changelog entry under `Unreleased` is still required: the gate proves the
   branch **added a line there**, not that it edited some older section.

