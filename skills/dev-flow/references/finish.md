> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: finish

`flow finish` removes the worktree, branch and `.dev-flow/<slug>/` and
unbinds the session — so anything that needs them runs first.

1. **`flow finish [--note="<friction the operator mentioned>"]`**
   - Published by hand and not recorded yet → it runs the release record
     first (no question).
   - **Closing reflection** — skipped on a fold flow (started with
     `--reflections`: it fixes reflections, it doesn't review for new ones).
     Otherwise, while none is recorded, a read-only worker
     reviews this session's transcript and every worker transcript, dedupes
     against `.dev-flow/reflections.md` and upstream issues, and returns
     numbered findings, each **docs** / **code** / **plugin** with a **fold**
     or **drop** recommendation. Finish files those recommendations itself
     (a fold is a note or a recurrence on the row it duplicates; a drop
     records nothing) and goes on — no fold/drop question. Relay the list it
     prints, with its undo line. A plugin finding outside the dev-flow repo
     is listed for the operator to file upstream on their word — never file
     it yourself.
   - A flow with **no friction** (no guard block, no process refusal, no gate
     stuck twice in a row, no `--note`) skips the worker, unless the playbook
     says `reflect = always`. A red test or build is not friction.
   - Worker failed or died → the gate says so and nothing is removed: re-run, or review inline (bare `flow
     reflect` prints the protocol). Only the operator's explicit word skips
     it: `flow finish --no-reflect --confirmed` — yolo never does.
   - `finish = always` in the playbook, or a report whose rows did not parse →
     the gate asks **Fold or drop?** / **Finish?** as before: ask it, apply the
     answer (`flow reflect --playbook|--code "<note>"`, `--same r<id>`,
     `--plugin` prints the upstream recipe), then `flow finish --confirmed`.
2. **Release-stage checklist items** (`- [ ]` under `## release`) are work:
   the first `flow finish` stops once (`release-stage work —`, not a
   question) and lists them. Do each from the main checkout, then run `flow
   finish` again — no question to ask; report what each showed.
   - A red after-merge check (`flow-check` under `## release`, run from the
     main checkout) stops finish with its output: fix, re-run.
3. **Never ask Finish? before calling the gate.** Run `flow finish` as soon
   as the release is recorded; it answers Finish? itself when nothing is left
   open, and returns `NEEDS-OPERATOR Finish?` only when something is (a
   skipped forge release, `finish = always`). Report it; do not ask
   afterwards.
4. Open items the reviewer found fixed are listed as proposals — check them
   off only on the operator's word (`flow reflect done r<id> "<where>"`).
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
