> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: plan

No code edits before approval. Reads are always allowed.

1. **Research** the code the plan needs.
2. **Clarify before drafting**: give your direction in chat — the problem in
   one sentence, the fix in a few plain lines, open unknowns, the mode you
   propose and why — and ask your questions. File-by-file detail belongs in
   plan.md, not chat. Draft only after the direction is confirmed.
3. **Write `.dev-flow/<slug>/plan/plan.md`** — problem, approach, files to
   touch, test strategy, risks. Reviewable, not exhaustive.
   - Create it as soon as the direction is confirmed and keep it current: chat
     is lost at compaction, the gate reads the file.
   - The name is the proof: `plan.md`. A preliminary direction goes inside it
     (marked draft) — never a separate file.
   - Part of the scope deferred? `flow roadmap add "<title>" --slug=<slug>
     --brief=<notes>` — never a second `.dev-flow/<slug>/` by hand.
   - Run `git log origin/<default>..<default> --oneline` first: local-only
     default-branch commits fall out of the worktree's base (push or re-plan).
4. **UI feature?** Mockups in `plan/mockups/`, one `<screen>.html` per
   screen/state, using the project's real stylesheet and class names.
   - No worktree exists yet: link the **main checkout's** stylesheet
     (`../../../../<path>`), never another feature's worktree (refused).
   - Render every mockup with headless chromium (`chromium`,
     `chromium-browser`, `google-chrome`, else playwright's
     `~/.cache/ms-playwright/*/chrome-headless-shell-linux64/chrome-headless-shell`)
     at the project's widths (default 390 and 1280):
     `<binary> --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=<w>,<h> --screenshot=plan/mockups/<screen>-<w>.png file://<abs path>`
   - Embed every render in plan.md as an image:
     `![<screen> — phone](mockups/<screen>-390.png)`. The gate refuses any
     render not embedded and any `.html` without a shot.
   - No chromium anywhere → tell the operator and ask; HTML-only only with
     their OK. Never fake or skip silently.
   - Tips: prefer a static strip (just the component, real stylesheet) over a
     full page; shots never scroll; use a fresh `--user-data-dir` per UI
     state; caption planned behavior as planned; if a shot fights you twice,
     verify the state in the DOM and move on.
5. **Ask Approve? and stop.** Report opening: **📝 plan · `<slug>`** (the
   gate's stage line). Answer → `flow approve --confirmed` (yolo → `flow
   approve --yolo --confirmed`).

Approval creates the worktree and branch and runs `commands.setup` there; a
failing setup fails the gate and the next approve retries it. `(ui)` playbook
items apply only to UI features.
