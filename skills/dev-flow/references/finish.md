> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: finish

**Reflect before you finish** — `flow finish` deletes `.dev-flow/<slug>/` and
the session context goes with it. Run the end-of-session reflection now:

1. `flow_stage({ op: "reflect", note })` — a fresh **read-only** reviewer reads
   this session's transcript **and every `flow_stage` worker transcript**,
   re-checks the open items in `.dev-flow/reflections.md`, dedupes against them
   and the upstream issues, and returns numbered findings, each classified
   **docs** (fix only in `project.md` → docs flow), **code** (fix in this
   project's code, maybe the playbook too → patch flow) or **plugin** (dev-flow
   itself → GitHub issue upstream), with a **fold** or **drop** recommendation.
   `note` = anything the operator said about friction this session. If the
   worker fails, run the review inline (bare `flow reflect` prints the protocol).
2. Show the operator the list with your recommendation per item and ask
   **fold or drop** for each (`fold 1,3 drop 2` is a fine answer) — then stop.
3. Apply the answer: fold docs → `flow reflect --playbook "<note>"`; fold code →
   `flow reflect --code "<note>"`; fold plugin → `flow reflect --plugin "<note>"`
   prints the upstream recipe — search first, then `gh issue create` (the fold
   answer is the confirmation; report the URL). **Plugin findings never become
   rows in the project's `reflections.md`.** Drop → nothing is recorded. Open
   items the reviewer found fixed → propose checking them off.
4. Offer the fix / tidy suggestions the tool printed (`⚑ fix the open
   reflections now?`, `↻ N closed reflection(s)`) — one line each, only when
   printed; never start a fix flow without the operator's word.

The fold/drop answer replaces **Finish?** — act on it, then run
`flow finish --confirmed` without asking again. Nothing found → ask the
operator **Finish?** → `flow finish --confirmed`. A finish question with no
reflection recorded for the flow names it (advisory, never a block).
Checkpoint report: stage line **🏁 finish · `<slug>`** — release recorded ·
main state · unmerged count · reflections open · release-checklist open,
then `Done:`/`Next steps:` per the Stage reports rule.

The question covers the whole cleanup and mentions any commits that look
unmerged. `flow finish [slug]`:

- refuses until `release-done` recorded the release — abandoned features go
  through `flow abort` instead;
- requires the main checkout **clean and pushed** — an uncommitted changelog or
  a local-only release commit is exactly what it protects against;
- removes the worktree and branch, then deletes `.dev-flow/<slug>/` (its
  `tmp/` scratch dir included) and unbinds the session. A feature branch still on `origin` is deleted **only on
  proof it was merged** — ancestor of `origin/<default>`, or a merged PR via gh
  or glab (what a squash leaves behind); otherwise kept with a note. Uncommitted worktree edits block
  finish; commits that never reached the default branch are read against the playbook's `merge` policy —
  expected under `squash`/`rebase`, a **violation** under `merge` (which `yolo` cannot answer for), and
  called out at Finish? without an operator answer → stop and show them.

Production deployment stays manual and out of scope: never ask the operator
whether a prod deploy happened.

