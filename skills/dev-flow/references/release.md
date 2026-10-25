> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: release

Cleared for main-repo git (merge/tag/push on the default branch is allowed only
here) — this stage publishes; the preparation happened in pre-release. Run in
the worktree unless noted:

1. Commit everything, push the feature branch, open the PR, wait for the merge
   (`gh pr merge <n> --merge` or ask the user) — with the **playbook's merge style spelled out**
   (`gh pr merge <n> --squash` under `merge = squash`), and **the PR number before the flag**: a bare
   `gh pr merge --merge main` makes gh read `main` as the PR selector ("no pull requests found for
   main"). The guard blocks a style that contradicts the
   playbook and asks the operator about a merge with no style flag, so let the playbook decide rather
   than the forge default. Merge without `--delete-branch`: it fails when
   the default branch is checked out in the main worktree, and `flow finish`
   deletes the branch on merge proof anyway.
2. `git fetch`, confirm the merge landed, create the **annotated** tag
   (`git tag -a`) and push the ref explicitly (`git push origin v<ver>`) —
   never `--follow-tags` (it silently skips lightweight tags: they never reach
   the remote, CI never publishes). After the merge a tag points at what
   actually shipped. If CI publishes from the tag, set `release.artifact` in
   the playbook — `release-done` then verifies the published artifact and
   refuses local-only tags outright. Unversioned flow (`--no-version` granted):
   no bump, no tag — publish the merge only (your entry rides under
   `Unreleased` until the next versioned release folds it), `release-done`
   asks nothing version-side.
3. `flow release-done` — **no question** (the Release? answer covered the
   publication). It re-verifies (tag on the default branch, on origin, artifact
   when configured) against **the version the release gate stamped** — never a
   re-read from a checkout that may be behind — and refuses anything older than
   the newest matching tag on origin (lists come from `git ls-remote`, so an
   unfetched clone never decides what is tagged). It creates the forge release
   — `gh` for GitHub, `glab` for GitLab, nothing for `forge = self`, advisory
   note if a CLI or remote is missing; body = the `release.changelog` entry for
   that version — the changelog is what the release page must read like — else
   the tag's annotation, else nothing with the reason printed (annotate with
   `git tag -a`), and it reads the stored body back and refuses a mismatch
   (#97) — and records the release;
   `flow finish` closes the feature out. Skipping the forge release
   (`--no-release-create`, once, or `release.releases = false`, always) and
   the artifact check (`--no-artifact-check`, once) are operator calls only —
   act when told, never on your own. If this session runs an older build than
   the checkout, **the release gate asks instead of blocking**: it prints both
   builds, lists what shipped between them (those proofs will not run), and
   puts the choice to the operator — **update (`/reload` and re-run) or
   proceed with the old release?** Publishing under an older gate is a
   legitimate choice (hotfix, offline reload); the answer is recorded in the
   release output and `release-done` repeats the acknowledgement as the
   backstop for headless runs.
   Release-stage checklist items have no gate of their own: `release-done`
   lists the open ones and the Finish? answer closes them.


Once `flow release-done` has recorded the release, the playbook continues in
[finish.md](finish.md) — reflect first, then **Finish?**, then cleanup.
