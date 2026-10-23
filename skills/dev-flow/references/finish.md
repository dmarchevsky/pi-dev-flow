> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: finish

**Reflect before you finish** — `flow finish` deletes `.dev-flow/<slug>/` and
the session context goes with it. Run the end-of-session reflection (bare
`flow reflect` protocol under *Reflect*) now and park real issues with
`flow reflect`; then:

- issues parked → ask **Fold? Fix? Drop?** and stop: fold = write the items
  into `.dev-flow/reflections.md` (your queue), fix = route them now via
  `flow doctor`, drop = discard them. The answer replaces **Finish?** — act
  on it, then run `flow finish --confirmed` without asking again;
- nothing parked → ask the operator **Finish?** → `flow finish --confirmed`.

The question covers the whole cleanup and mentions any commits that look
unmerged. `flow finish [slug]`:

- refuses until `release-done` recorded the release — abandoned features go
  through `flow abort` instead;
- requires the main checkout **clean and pushed** — an uncommitted changelog or
  a local-only release commit is exactly what it protects against;
- removes the worktree and branch, then deletes `.dev-flow/<slug>/` and
  unbinds the session. A feature branch still on `origin` is deleted **only on
  proof it was merged** — ancestor of `origin/<default>`, or a merged PR via gh
  or glab (what a squash leaves behind); otherwise kept with a note. Uncommitted worktree edits block
  finish; commits that never reached the default branch are read against the playbook's `merge` policy —
  expected under `squash`/`rebase`, a **violation** under `merge` (which `yolo` cannot answer for), and
  called out at Finish? without an operator answer → stop and show them.

Production deployment stays manual and out of scope: never ask the operator
whether a prod deploy happened.

