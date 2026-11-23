> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Stage: plan

No code edits before approval. Reads are always allowed.

1. **Research** the code the plan needs.
2. **Clarify before drafting — when there is something to clarify**: open
   questions, or more than one sound approach → give your direction in chat
   (the problem in one sentence, the fix in a few plain lines, the unknowns)
   and ask. Draft after the direction is confirmed. Nothing open and one
   obvious approach → skip this round: write plan.md and go to Approve?,
   which is the operator's chance to redirect. File-by-file detail belongs
   in plan.md, not chat.
3. **Write `.dev-flow/<slug>/plan/plan.md`** — problem, approach, files to
   touch, test strategy, risks. Reviewable, not exhaustive.
   - Create it as soon as the direction is confirmed and keep it current: chat
     is lost at compaction, the gate reads the file.
   - The name is the proof: `plan.md`. A preliminary direction goes inside it
     (marked draft) — never a separate file.
   - **Every revision rewrites, never appends.** On feedback, edit plan.md
     into the current plan: replace what changed, delete dropped options,
     requirements and mockups outright, no round markers ("v2", "updated:",
     "previously…", strikethrough). A settled choice reads as a plain
     decision, no rejected alternatives beside it. Chat holds the history;
     plan.md holds only the result.
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
   - Revisions: a dropped screen or variant → delete its `.html`, its
     `<screen>-<w>.png` shots and its embed; a changed screen → edit the same
     `<screen>.html` and re-render over the same filenames (no `-v2` copies).
     At Approve?, `plan/mockups/` holds only what plan.md shows.
   - No chromium anywhere → tell the operator and ask; HTML-only only with
     their OK. Never fake or skip silently.
   - Tips: prefer a static strip (just the component, real stylesheet) over a
     full page; shots never scroll; use a fresh `--user-data-dir` per UI
     state; caption planned behavior as planned; if a shot fights you twice,
     verify the state in the DOM and move on.
5. **Ask Approve? and stop.** Report opening: **📝 plan · `<slug>`** (the
   gate's stage line). A `--patch` / `--docs` flow: name the mode and the
   one-line change in the question — the answer grants the mode. Versioned project with playbook `version = ask`
   (the default): the same question asks the **release call** — a patch, minor or major release (propose one by
   the playbook's versioning rule) or merge unreleased. Only the kind is recorded, never a number: the gate counts
   it from the newest tag when the release runs. Answer → `flow approve --confirmed --version=patch|minor|major` or
   `--no-version` (yolo → add `--yolo`); without the call the gate refuses and keeps nothing.
   The call is not asked again. The operator can change it at any later point until the tag: `flow bump
   <patch|minor|major|none> --confirmed`, or `--version=<kind>` / `--no-version` on a confirmed verify or release call.

Approval creates the worktree and branch and runs `commands.setup` there; a
failing setup fails the gate and the next approve retries it. `(ui)` playbook
items apply only to UI features.
