> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: release

Main-repo git (merge, tag, push on the default branch) is allowed only here.
Nothing in this stage asks the operator anything — Release? covered it. Report
each step with the gate's stage line, **🚀 release · `<slug>`**; no `Done:` /
`Next steps:` block.

1. **PR and merge.** Commit everything, push the feature branch, open the PR.
   - **Merge only once CI is green**: `gh pr checks <n> --watch` (or your
     forge's equivalent) first — CI runs jobs the host may not.
   - Merge in the **playbook's style**, PR number before the flag:
     `gh pr merge <n> --squash` under `merge = squash`, `--merge` under
     `merge = merge`. (`gh pr merge --merge main` reads `main` as the PR.)
   - No `--delete-branch` — finish deletes the branch on merge proof.
2. **Tag** (versioned flows). `git fetch`, confirm the merge landed, create an
   **annotated** tag (`git tag -a v<ver> -m …`) and push it explicitly:
   `git push origin v<ver>`. Never `--follow-tags`.
   - CI builds from the tag? `release.preflight` proves that build at
     `flow release`; `release.artifact` makes the record step verify the
     published artifact. On GitHub it waits for the publish CI the tag
     started (up to 15 min) — no hand-run `gh run watch` before it.
   - `--no-version` flow: no bump, no tag — publish the merge only.
3. **Hand over to finish.** Once merged and tagged, the playbook continues in
   [finish.md](finish.md): `flow finish` records the release itself first
   (the same proofs `flow release-done` runs — tag on the default branch and
   on origin, artifact, forge release created from the changelog entry and
   read back) and then closes the feature out.
   - Skipping the forge release (`--no-release-create`, or `release.releases
     = false`) or the artifact check (`--no-artifact-check`) is the
     operator's call only.
   - Session on an older build than the checkout: the release gate prints
     both builds and what shipped between them and asks **update (`/reload`
     and re-run) or proceed?** — a recorded choice, not a block.
   - Release-stage checklist items close with the Finish? answer.
