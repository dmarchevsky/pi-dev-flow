> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Stage: plan

1. Research the code the plan needs (reads are always allowed).
2. **Clarify before drafting**: preliminary direction in chat (findings, shape
   of the fix, open unknowns), mode proposal with its reason, your questions
   and the operator's; draft only after the direction is confirmed.
3. Write `.dev-flow/<slug>/plan/plan.md` — problem, approach, files to touch,
   test strategy, risks; reviewable, not exhaustive. **Land it on disk early and
   keep it current**: create the file the moment the direction is confirmed —
   don't wait for the finished plan — and amend it in the file as the discussion
   continues. Plan talk held only in the conversation is gone when pi
   auto-compacts mid-stage; the gate reviews the file, not the memory. First check
   `git log origin/<default>..<default> --oneline`: local-only default-branch
   commits fall out of the worktree's base (push them or re-plan).
4. **UI flag set?** Mockups live in `plan/mockups/`, one HTML per screen/state
   (`<screen>.html`), linking the project's real stylesheet and class names
   where they exist (relative links work from `.dev-flow/`). Every mockup
   must be **rendered** — an unrendered mockup is not a mockup:
   - Headless chromium: PATH `chromium`/`chromium-browser`/`google-chrome`,
     else playwright's
     `~/.cache/ms-playwright/*/chrome-headless-shell-linux64/chrome-headless-shell`.
     Render at the project's widths (default phone 390, desktop 1280):
     `<binary> --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=<width>,<height> --screenshot=plan/mockups/<screen>-<width>.png file://<absolute path to html>`
     — height per screen, re-render if clipped.
   - Embed every render in plan.md under its section —
     `![<screen> — phone](mockups/<screen>-390.png)`. Image syntax only (a
     filename in prose is a broken link); before Approve? re-check that every
     tag points at an existing file.
   - No chromium anywhere → tell the operator and ask; `*.html`-only plans
     only with their OK (knob: `mockupGlobs`); never fake or skip silently.
   - Gotchas: for a component question prefer a **static strip** — standalone
     HTML with the real stylesheet carrying only the markup in question, one
     first-try render; a full-page render is for layout context only. Shots
     start top-left and never scroll — hide what is above a below-the-fold
     region (inline `<style>`) or use a strip. `--user-data-dir` profiles keep
     localStorage between shots — fresh profile dir per intended UI state.
     Planned behavior must be visibly patched into the shot and captioned as
     such — never caption the current app's render with the behavior you plan
     to add. The app's repaint can destroy a transient state (an inline
     editor) — freeze it for the shot (e.g. stub the render entry point after
     opening). If the harness fights the same shot twice, verify that state
     via DOM/code and move on — screenshots are a spot-check, not a test loop.
5. Tell the user the plan is ready and **stop** — one word: **Approve?**
   Answered → `flow approve --confirmed` (yolo → `flow approve --yolo
   --confirmed`).

Approval creates the worktree and branch, running `commands.setup` inside when
configured — a failing setup fails the gate and the next `approve` **retries**
setup in the kept worktree (stamping `setupAt` on success) instead of silently
reusing it. A `--docs` feature runs no project command at all. No code edits
before approval. `(ui)` playbook items never apply to non-UI features or
appear in prompts.

