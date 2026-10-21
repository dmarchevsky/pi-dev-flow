---
name: dev-flow
description: >
  The repo's enforced feature workflow: plan → implement → pre-release →
  release → done, one feature at a time, driven through the flow tool. Read before
  starting ANY feature work in a repo that has a .dev-flow/ directory — the
  stage guards block out-of-stage edits and main-branch git ops, so working
  outside this flow fails at the guard.
---

# dev-flow: the stage-by-stage playbook

Only the **flow tool** advances stages, and each gate refuses until its exit
criteria hold. Drive it with args arrays — `["start", "dark-mode", "--ui"]`,
`["test"]`, `["status"]`; the operator can run the same as `/flow ...`.

Ground rules:

- **One session = exactly one feature** (flow + branch + worktree); parallel
  sessions, one feature each, are the model. The bind is automatic when one
  unfinished feature exists and no live session already claims it
  (`flow use <slug>` = explicit takeover); `flow start <slug>` sets the bind
  (main checkout must be on the default branch). Unbound with several
  unfinished features: gates demand an explicit slug and main-checkout writes
  stay blocked. There is no bypass — an unbound session cannot edit source.
- **Project `flow-guard` rules** (`deny`/`confirm`/`protect`/`forbid` in
  project.md `## global`) apply at **every** stage and are judged ahead of
  dev-flow's verdicts — operator safety rules, not flow discipline. When one
  fires, its reason is the answer: stop, show it, let the operator decide;
  never route around it.
- **Every bash/shell call states its own `timeout`** or the guard refuses it
  (`bashTimeout = require`, the default; the playbook may set `inject`). Name
  the budget you actually expect.
- `.dev-flow/<slug>/state.json` is flow-owned — never read or write it;
  `flow status` is your view. **project.md is the operator-owned playbook**
  (test/build/run commands, default branch, forge, worktree path, safety
  rules): read freely, **never edit** — changes go through `flow init --write`
  on the operator's word. In-life playbook updates run as a docs flow:
  project.md is editable only inside a docs/patch flow's worktree and is
  committed to git like any file. A leftover `project.json` is never read; the
  doctor flags it.
- Also obey the repo's own AGENTS.md and project skills: dev-flow sequences
  stages, the project defines its conventions.
- **A guard blocking you means you are skipping a stage or writing outside
  your feature** — run the gate instead of working around it. The guard reads
  **commands**: quoted text is an argument's prose (a PR body discussing a
  commit is not a commit); a wrapper that execs its argument
  (`sh -c "git push origin main"`) is judged on its payload — blocked commands
  cannot ride through one.
- **Checkpoints are one verb: Approve? / Verified? / Release? / Finish?** —
  ask exactly that word as a **plain chat message**, mention that **yolo** is
  an available answer, and stop. Never ask the operator to run a flow command
  at a checkpoint — you run the gate when they have answered. The same verb
  (or an explicit equivalent) in chat is the answer; then run that gate with
  `--confirmed` — zero dialogs, **exactly one checkpoint per stage**. A
  structured question tool (AskUserQuestion-style) is not chat and never
  licenses `--confirmed`; never infer the answer.
  - **yolo** at any checkpoint → run that gate `--yolo --confirmed`; every
    later checkpoint is pre-confirmed — run the remaining gates back to back
    without asking, honoring guidance attached to the word ("yolo, create a
    patch version release" → bump patch; "yolo, no tag" → `--no-version`).
    Checks and guardrails stay fully enforced — a flow-guard `confirm` rule
    still asks the operator.
  - At Release?, choosing **no version/tag for this flow** →
    `flow release --no-version --confirmed` (default is versioned: bump + tag).
- **Modes are proposed, never taken**: every `flow start` carries the mode and
  a one-line why; the operator grants it in chat and the gate refuses
  `--patch`/`--docs` until the grant is anchored with `--confirmed` — never
  self-grant. `normal` (default): a written plan is enforced (`plan/plan.md`
  before Approve?). `--patch`: a small change you intend to release
  (one-file fix, version chore) — no plan file, one chat line is the plan,
  everything else identical. `--docs`: docs-only — no plan file **and no
  tier-1 checks** (build/lint/test); worktree discipline and the full release
  stay. A change that grows past one line or touches behavior is a normal
  feature, not patch/docs.

## Start

**No `.dev-flow/`?** `flow init` analyzes the repo and prints a **setup
brief**: what was detected plus one question per knob detection cannot decide
(forge github/gitlab/self, version manifest and tag convention, automatic
forge releases, registry artifacts like Docker Hub, the real
test/build/lint/health commands, tier-2 items, prose). Relay the questions
(one per knob, detected default shown, explain in a line when not obvious),
fill `flow init --draft` with the answers, present it, then apply
`flow init --write "<content>"` **only after the operator confirms** — never
hand-edit, never write project.md before the confirmation. The playbook
belongs in git; the chore is legal unbound:
`git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"`
(force — a tracked file outranks a `.gitignore` of `.dev-flow/`; the env
prefix lets the installed hook accept a main commit that only touches the
playbook). **With existing config** `flow init` is a **doctor**: discuss
findings, fix via the same write path, never overwrite hand edits without
confirming; ghost feature dirs (a `plan/` whose `state.json` is gone) come
with a delete offer — surface the dialog, never delete on your own.
`flow doctor` runs the same probes **read-only** (prefer it when you only want
findings); `--force` re-detects from scratch, `--draft` prints without
writing.

`flow start <slug> [--ui]` — `--ui` whenever anything user-visible is touched;
slug lowercase words-dashed; check `flow status` for an active feature first.

## Stage: plan

1. Research the code the plan needs (reads are always allowed).
2. **Clarify before drafting**: preliminary direction in chat (findings, shape
   of the fix, open unknowns), mode proposal with its reason, your questions
   and the operator's; draft only after the direction is confirmed.
3. Write `.dev-flow/<slug>/plan/plan.md` — problem, approach, files to touch,
   test strategy, risks; reviewable, not exhaustive. First check
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

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status`
or the injection line) — writes elsewhere are blocked; other sessions'
worktrees are theirs (attribution guards judge every path by its owning
feature).

1. Implement per the approved plan with project conventions and the **stage
   guidance injected at stage start** (tier-3 prose). Commit in the worktree
   **as you go** — small reviewable commits; a twelve-file monolith saved for
   the end faces review blind and is not crash-safe.
2. Write tests as you go (project framework: the `test` key / `flow-check`
   blocks).
3. `flow check` runs every tier-1 check (test, health, named `flow-check`
   blocks) and records each; any later worktree edit invalidates checks and
   the tier-2 confirmation — rerun before verify.
4. UI flag set? An actual browser visual pass (screenshot or the project's
   automated pass) — not just a typecheck.
5. Done means **running and healthy with pre-existing data**, not "compiles":
   `commands.seedData` (if set) puts real data in place, the app starts with
   the `run` command, and the health check passes — `flow check` covers it
   (seedData runs before health) and `flow verify` probes **the deployed app
   again**, because the deploy is what has to be proven. Probes retry every 2s
   up to `healthWait` (default 30s) — a service needing a moment after its
   container starts is not a failed deploy; say so rather than declaring a
   healthy deploy broken. Walk the **tier-2 checklist** (`- [ ]`) with the
   operator honestly — it cannot be scripted. Then ask **Verified?** →
   `flow verify --confirmed`. Fixes = iterate and re-verify; that loop is
   free.

`flow verify` re-runs build, runs the `dev` deploy when configured (the
operator reviews the running app; the gate **prints what it ran** —
`build ran (…)` / `dev ran (…)` / `dev: none configured`; the command must
**background and exit**, e.g. `docker compose up -d .` — verify waits and kills
runs past 15 min), re-runs the health probe **against what it just deployed**
(`seedData` first when configured; a failing probe retries every 2s up to
`healthWait`, then refuses the gate reporting its attempts — a pre-deploy PASS
describes a container that no longer exists; no probe prints
`health: none configured` and the doctor flags it), and demands all tier-1
checks green before the single question. The operator's confirm covers the
tier-2 list as a set (hashed; edits reset it). A `--docs` feature prints
`docs mode: project commands skipped` and asks only the verify question.
Verify lands the feature in **pre-release**.

Mid-stage additions — do not bounce the flow, do not grow it silently:
**this feature grew** → stay at implement, append a `**Added mid-stage:**` line
to `plan.md` (what was asked and how), implement, `flow check` again — edits
invalidate checks and the tier-2 confirmation, so verify re-covers the
addition. **Different problem** → finish this feature first, then a new flow
(`flow start <new-slug>` after this one ships); never fold two features into
one plan, PR and verify — the
audit trail is the point. **Heavily amended plan** → show it and have the
operator re-approve in chat; verify remains the checkpoint — no reopen command
exists by design.

## Stage: pre-release

Implemented, tested, running locally; prepare the release entirely in the
worktree — main-repo git state stays off-limits until this gate hands over.
**Versioning:** the `versioning.file` manifest is the single source of truth
and tags are `versioning.pattern` rendered from it — one number everywhere. If
`versioning.file` is unset, stop and clarify the scheme with the user; never
invent one mid-release. Sequence:

1. `/ponytail-review` the change; fix every **must-have** and **should-have**
   finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the manifest to the exact version you will
   tag — manifest, changelog and tag must agree; commit the prep on the feature
   branch.
4. `flow check` — the prep edits invalidated the implement checks; the release
   gate demands them green again.
5. State what the PR will contain, present version and changelog entry,
   **stop** — **Release?** → `flow release --confirmed`. The gate re-checks
   tier-1, requires the manifest **ahead of the last tag** and the changelog to
   mention it. Operator ships this flow **without version/tag** →
   `flow release --no-version --confirmed` — no bump, no changelog edit.

## Stage: release

Cleared for main-repo git (merge/tag/push on the default branch is allowed only
here) — this stage publishes; the preparation happened in pre-release. Run in
the worktree unless noted:

1. Commit everything, push the feature branch, open the PR, wait for the merge
   (`gh pr merge` or ask the user).
2. `git fetch`, confirm the merge landed, create the **annotated** tag
   (`git tag -a`) and push the ref explicitly (`git push origin v<ver>`) —
   never `--follow-tags` (it silently skips lightweight tags: they never reach
   the remote, CI never publishes). After the merge a tag points at what
   actually shipped. If CI publishes from the tag, set `release.artifact` in
   the playbook — `release-done` then verifies the published artifact and
   refuses local-only tags outright. Unversioned flow (`--no-version` granted):
   no bump, no tag — publish the merge only, `release-done` asks nothing
   version-side.
3. `flow release-done` — **no question** (the Release? answer covered the
   publication). It re-verifies (tag on the default branch, on origin, artifact
   when configured) against **the version the release gate stamped** — never a
   re-read from a checkout that may be behind — and refuses anything older than
   the newest matching tag on origin (lists come from `git ls-remote`, so an
   unfetched clone never decides what is tagged). It creates the forge release
   — `gh` for GitHub, `glab` for GitLab, nothing for `forge = self`, advisory
   note if a CLI or remote is missing; body = the tag's annotation, else the
   `release.changelog` entry for that version, else nothing with the reason
   printed (annotate with `git tag -a`) — and records the release;
   `flow finish` closes the feature out. Skipping the forge release
   (`--no-release-create`, once, or `release.releases = false`, always) and
   the artifact check (`--no-artifact-check`, once) are operator calls only —
   act when told, never on your own. If `flow version` says this session runs
   an older build than the checkout, **stop and ask the operator to `/reload`
   before publishing** — gates execute the code loaded at session start.
   Release-stage checklist items have no gate of their own: `release-done`
   lists the open ones and the Finish? answer closes them.

## Stage: finish

Ask **Finish?** → `flow finish --confirmed`; the one question covers the whole
cleanup and mentions any commits that look unmerged. `flow finish [slug]`:

- refuses until `release-done` recorded the release — abandoned features go
  through `flow abort` instead;
- requires the main checkout **clean and pushed** — an uncommitted changelog or
  a local-only release commit is exactly what it protects against;
- removes the worktree and branch, then deletes `.dev-flow/<slug>/` and
  unbinds the session. A feature branch still on `origin` is deleted **only on
  proof it was merged** — ancestor of `origin/<default>`, or a merged PR via gh
  (squash merges); otherwise kept with a note. Uncommitted worktree edits block
  finish; unmerged-looking commits called out at Finish? without an operator
  answer → stop and show them.

Production deployment stays manual and out of scope: never ask the operator
whether a prod deploy happened.

## When things go sideways

- Abandon a feature: `flow abort <slug>` unbinds — at plan stage (nothing
  approved) it removes the feature outright; once a worktree exists the state
  stays for manual recovery and the exact removal commands are printed.
- A gate refuses: its reasons list exactly what is missing — fix that, rerun
  the gate.

## Reflect (your suggestion queue)

Anything the playbook or plugin should improve (drifted commands, gate friction,
a plugin bug) gets parked, not complained about:
`flow reflect "<one-line note>"`; gate flags are ignored —
`flow reflect "<note>" --confirmed` queues the note alone. For a note to chase
**now**: `flow doctor "<observation>"` prints an investigation brief without
queueing. Notes land under `## playbook` or `## plugin` — the wording decides,
a note about both goes to both. The open count shows in status and stage
context; the operator decides:

- Reflect real friction only, one line each, never the same issue twice.
- **Bare `flow reflect` is the end-of-session reflection** — run when the
  operator asks or after a long friction-laden session. It prints the
  protocol: review the full session log (messages, tool calls, results);
  re-check each open item against the current playbook and newer dev-flow
  versions (`git ls-remote` vs the running version — a newer one that fixes an
  item → recommend updating the plugin, check it off); queue deduplicated new
  findings; report playbook vs plugin items structurally; ask whether to fix
  now. The command writes nothing; you execute the protocol.
- Plain `flow doctor` reviews the open items and **routes** each to the flow
  that implements it — playbook item → docs flow; plugin item → upstream issue
  (or a patch/normal flow in the dev-flow repo). To fold items in on the
  operator's word: investigate, propose the fix, get confirmation, open the
  routed flow (playbook items: `flow start fold-<topic> --docs --confirmed`)
  and apply it there — project.md is editable only in that worktree. Check
  items off in `.dev-flow/reflections.md` (your queue, gitignored, yours to
  edit; not `project.md`) with `- [x]` and a `— folded: <what>` or
  `— fixed: <what>` note.
- `## plugin` items, on the operator's go: search upstream first —
  `gh issue list --repo <dev-flow repo> --state all --search "<keywords>"` —
  an issue the author already answered (fixed or won't-fix) is reported back,
  never re-filed; no match → offer to file one (`gh issue create`; `glab issue
  create` on GitLab) with a detailed description, session evidence and a
  suggested fix; the operator confirms.

## Roadmap (your backlog)

`.dev-flow/roadmap.md` — a gitignored `- [ ]` checklist; the operator owns the
content, you maintain and honor it. Advisory like reflections, never gating:

- `flow roadmap` lists the open items (the count is surfaced in status and
  stage context). Update on the operator's request —
  `flow roadmap add "<feature>"` or direct file edits are equally fine.
- Handed a feature: `flow roadmap pick <n> <slug>` stamps the item with the
  slug (pick is one verb — it starts nothing), then `flow start <slug>` builds
  it as a normal flow; its `flow finish` checks the item off automatically.
- Shipped outside a flow: `flow roadmap done <n>` (date-stamped by hand);
  `flow roadmap tidy` drops checked lines when history clutters the list.
