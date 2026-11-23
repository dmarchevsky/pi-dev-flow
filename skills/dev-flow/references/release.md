> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: release

Nothing in this stage asks the operator anything — Release? covered it (answered
by the operator, or by the gate itself under `ask = on-change`). Report with the
gate's stage line, **🚀 release · `<slug>`**; no `Done:` / `Next steps:` block.

### The gate publishes (GitHub)

`flow release` does the whole stage in the same call that passed Release?: it
pushes the branch, opens the PR (changelog entry as body), waits for the PR's
CI, merges in the playbook's style, waits for the merge commit's own CI to go
green, cuts and pushes the annotated tag on the merge commit, then records the
release (tag on origin, artifact, forge release
created from the changelog entry and read back). You run no git or `gh` step.

It stops with one of two results, and **re-running `flow release` resumes** —
it skips whatever the forge already shows as done:

- **`publish waiting — …`**: CI was still running after 30 minutes. Re-run
  `flow release` now, in this turn. Nothing wakes you once the turn ends, so
  never end it with "I'll keep watching".
- **`publish stopped — …`**: something needs fixing, and the result names it.
  - A red check: fix it on the branch and commit (the re-run pushes it), or
    re-run a flaky job, then `flow release`.
  - Runs stuck in `queued` (~15 min, while other runs on the repo start):
    `gh run cancel <id>` then `gh run rerun <id>`, then `flow release`.
  - The forge refused the merge (required review, merge queue): tell the
    operator what it needs and stop. Once the PR is merged, `flow release`
    carries on from there.
  - A red CI you can't fix ends the turn: report it plainly ("stopped: … — say
    *go* to resume").

Then [finish.md](finish.md): `flow finish`.

### By hand (`publish = manual`, GitLab, self-hosted, no `gh`)

The gate result says `next: publish: push the branch, open the PR…`. Main-repo
git (merge, tag, push on the default branch) is allowed only in this stage.

1. **PR and merge.** Push the feature branch, open the PR. Merge only once CI
   is green (`gh pr checks <n> --watch`), and wait for it inside the turn. Merge in the **playbook's
   style**, PR number before the flag (`gh pr merge <n> --squash`). No
   `--delete-branch` — finish deletes the branch on merge proof.
2. **Tag** (versioned flows). `git fetch`, confirm the merge landed, create an
   **annotated** tag (`git tag -a v<ver> -m …`) and push it explicitly:
   `git push origin v<ver>`. Never `--follow-tags`. A `--no-version` flow has
   no tag.
3. **`flow finish`** records the release itself first, then closes out.

### Either way

- Skipping the forge release (`--no-release-create`, or `release.releases =
  false`) or the artifact check (`--no-artifact-check`) is the operator's call
  only.
- `release.artifact` set and CI publishes from the tag: the record step waits
  for that CI (up to 15 min) — no hand-run `gh run watch`.
- After-merge work: `flow-check` blocks under `## release` are run by
  `flow finish` from the main checkout; `- [ ]` items there are work — the
  first `flow finish` stops once to list them, the next one closes out.
