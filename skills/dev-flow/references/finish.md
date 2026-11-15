> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: finish

`flow finish` removes the worktree, branch and `.dev-flow/<slug>/` and
unbinds the session — so anything that needs them runs first.

1. **`flow finish [--note="<friction the operator mentioned>"]`**
   - Published by hand and not recorded yet → it runs the release record
     first (no question).
   - **Closing reflection** — while none is recorded, a read-only worker
     reviews this session's transcript and every worker transcript, dedupes
     against `.dev-flow/reflections.md` and upstream issues, and returns
     numbered findings, each **docs** / **code** / **plugin** with a **fold**
     or **drop** recommendation. Finish then stops.
   - A flow with **no friction** (no guard block, no process refusal, no gate
     stuck twice in a row, no `--note`) skips the worker, unless the playbook
     says `reflect = always`. A red test or build is not friction.
   - Worker failed or died → the gate says so and nothing is removed: re-run, or review inline (bare `flow
     reflect` prints the protocol). Only the operator's explicit word skips
     it: `flow finish --no-reflect --confirmed` — yolo never does.
2. **Findings → ask fold or drop** per item — one plain line each — with
   your recommendation (`fold
   1,3 drop 2` is a fine answer), and stop. That answer **is** Finish?.
3. **Apply it**: fold docs → `flow reflect --playbook "<note>"`; fold code →
   `flow reflect --code "<note>"`; fold plugin → `flow reflect --plugin
   "<note>"` prints the upstream recipe — search first, then `gh issue create`
   and report the URL. Plugin findings never go into `reflections.md`. Open
   items the reviewer found fixed → propose checking them off.
4. **`flow finish --confirmed`** without asking again. Nothing found → ask
   **Finish?** first.
   - **A clean flow needs no question**: no friction, no open release-stage
     item, nothing skipped → the first `flow finish` closes the feature and
     says Finish? answered itself (`finish = always` in the playbook asks
     every time). Report it; do not ask afterwards.
   - A red after-merge check (`flow-check` under `## release`, run from the
     main checkout) stops finish with its output: fix, re-run.
5. Offer the printed suggestions (`⚑ fix the open reflections now?`, `↻ N
   closed reflection(s)`) in one line each; never start a fix flow without
   the operator's word.

Report opening: **🏁 finish · `<slug>`** — release recorded · main state ·
unmerged count · reflections open · release-checklist open, then `Done:` /
`Next steps:`. Never say findings were "reviewed" unless you are showing the
worker's list.

Finish refuses until:

- the release is recorded (abandoned features use `flow abort`);
- the main checkout is **clean and pushed**;
- the worktree has no uncommitted edits.

Commits not on the default branch are expected under `squash`/`rebase`, a
**violation** under `merge` (yolo cannot answer it — ask). A remote feature
branch is deleted only on proof it merged.

Production deployment is out of scope: never ask whether a prod deploy
happened.
