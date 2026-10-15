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

A feature moves through stages; only the **flow tool** advances stages, and each
gate refuses until its exit criteria hold. Drive it with the `flow` tool using
args arrays, e.g. `["start", "dark-mode", "--ui"]`, `["test"]`, `["status"]`.
The user can run the same things as `/flow ...`.

Ground rules:

- A pi session is bound to exactly one feature (flow + branch + worktree). Parallel sessions, one feature each, are the model. The binding is automatic when one unfinished feature exists — unless another live session already claims it (`flow use <slug>` is the explicit takeover) — set by `flow start`, and switched with `flow use <slug>`; with several unfinished features and no binding, gates demand an explicit slug and main-checkout writes stay blocked.
- **Flow is the default for all work.** An unbound session cannot edit source files — start a feature (`flow start <slug>`, main checkout must be on the default branch) or bind an unfinished one (`flow use <slug>`). There is no bypass: every request runs through the flow.
- **A project's own `flow-guard` rules** (`deny`/`confirm`/`protect`/`forbid` in project.md `## global`) apply at **every** stage and are judged ahead of dev-flow's own verdicts — they are the operator's safety rules, not flow discipline. When one fires, its reason is the answer: stop, show it, and let the operator decide; never route around it.
- Never read/write `.dev-flow/<slug>/state.json` yourself — it is flow-owned (the guard blocks it anyway). `flow status` is your view.
- `.dev-flow/project.md` is the operator-owned playbook — commands (test/build/run), the default branch, worktree path and the safety rules live there: read it freely, never edit it; changes go through `flow init --write` on the operator's word (a legacy `project.json` still loads but is superseded).
- Also obey the repo's own AGENTS.md and project skills; dev-flow sequences stages, the project defines its conventions.
- If a guard blocks you, you are trying to skip a stage or write outside your session's feature. Stop and run the gate instead of working around it.
- **Checkpoint questions are one verb: Approve? / Verified? / Release? / Finish?** The verb doubles as the operator's answer; ask exactly that word at each gate and treat the same verb (or an explicit equivalent) in chat as the answer — then `--confirmed` carries the checkpoint with zero dialogs. Ask it as a **plain chat message**: a structured question tool (AskUserQuestion-style dialog) is not chat — its answer never licenses `--confirmed`. The same rule covers mode grants: `--patch`/`--docs` on `flow start` require the operator having granted that mode in chat, with `--confirmed` as the anchor — never self-grant. Two more operator words work the same way: **yolo** at Approve? → `flow approve --yolo --confirmed` — every later gate question (Verified?/Release?/Finish?) is then pre-confirmed and you run the gates without asking, while checks and guardrails stay fully enforced (a flow-guard `confirm` rule still asks the operator); and at Release? an operator who chooses **no version/tag for this flow** → `flow release --no-version --confirmed` (default is versioned: bump + tag).

## Start

Repo without `.dev-flow/`? Run `flow init` — it writes `.dev-flow/project.md` from detection immediately, then your job is the review loop: show the operator the file (path + what was detected) and ask **confirm as-is, or change?** If they want changes, ask one short question per unclear knob (default branch, real commands, versioning, checklist items, prose rules — explain each in a line when it isn't obvious), apply their answers with `flow init --write "<content>"` (never hand-edit the file), and re-present until confirmed. With an existing config, `flow init` acts as a **doctor** — discuss its findings and fix them via the same write path; it never overwrites hand edits without confirming. Ghost feature dirs (a `plan/` whose `state.json` is gone) come with a delete offer: surface that dialog as it comes and let the operator answer it — never delete a feature directory on your own initiative. `flow doctor` runs the same probes **read-only** — prefer it whenever you (or the operator) just want the findings; `flow init` is the fix path, the one that can write. `--force` = rewrite from fresh detection, `--draft` = print the file without writing.

`flow start <slug> --ui` when the work touches anything user-visible, else `flow start <slug>`. Slug: lowercase words-dashed. Check `flow status` first to see whether one is already active.

**Modes are proposed, never taken** — every `flow start` carries the mode you propose and why, and the operator's grant makes it real. `normal` (default): a written plan is enforced (plan/plan.md before Approve?). `--patch`: a small change you intend to release (one-file fix, version chore) — no plan file, one line in chat is the plan, every other gate identical. `--docs`: docs-only work — no plan file **and no tier-1 checks** (build/lint/test); worktree discipline and the full release stay. Relaxed modes are operator-granted: the gate refuses `--patch`/`--docs` until the operator's chat grant is anchored with `--confirmed`. Suggest patch/docs only when they fit — if the change grows past one line or touches behavior, it is a normal feature.

## Stage: plan

1. Research the code needed for the plan (reads are always allowed).
2. **Clarify before drafting** — do not jump to the plan file. Present a preliminary direction to the operator in chat (what you found, the shape of the fix, open unknowns), propose the mode (normal / patch / docs) with a one-line reason, ask your clarifying questions and let the operator ask his. Draft only after the direction is confirmed.
3. Write the plan to `.dev-flow/<slug>/plan/plan.md`: problem, approach, files to touch, test strategy, risks. Keep it reviewable, not exhaustive. Before asking for approval check `git log origin/<default>..<default> --oneline` — local-only default-branch commits fall out of the worktree's base (push them or re-plan around them).
4. **UI flag set?** Build the mockups in `plan/mockups/` and render them — a mockup that was never rendered is not a mockup:   - Write one HTML per screen/state at `plan/mockups/<screen>.html`. Reuse the project's real stylesheet and class names where it exists (relative links work from inside `.dev-flow/`) — fidelity by construction.
   - Find a headless chromium: probe `chromium`, `chromium-browser`, `google-chrome` on PATH; else playwright's shell at `~/.cache/ms-playwright/*/chrome-headless-shell-linux64/chrome-headless-shell`.
   - Render each screen at the widths the project cares for (default: phone 390, desktop 1280):
     `<binary> --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --window-size=<width>,<height> --screenshot=plan/mockups/<screen>-<width>.png file://<absolute path to html>`
     (height: pick per-screen, re-render if content clips).
   - Embed every render in plan.md under its section: `![<screen> — phone](mockups/<screen>-390.png)`. The plan is then one self-contained reviewable document.
   - No chromium anywhere? Tell the user and ask — fall back to `*.html`-only plans only with their OK (they can set `mockupGlobs`); never fake or skip a screenshot silently.
5. Tell the user the plan is ready and **stop** — one word: **Approve?** They answer in chat (or run `/flow approve` themselves). When they answered, run `flow approve --confirmed` — **exactly one checkpoint per stage**: a chat answer must never trigger a second dialog. `--confirmed` is only for a literal operator answer, never your inference; without an answer and without interactive UI the gate refuses. If the operator answered **yolo**, run `flow approve --yolo --confirmed` instead — later gates then need no further questions.

Approval creates the worktree and branch (running `commands.setup` inside it when configured — a failing setup fails the gate). Until then no code edits are possible. `(ui)`-marked playbook checklist items do not apply to non-UI features — they never appear in prompts or confirmations.

## Stage: implement

Work happens **only in the worktree** the gate created (path in `flow status` or the injection line). Edit and write outside it are blocked. When other sessions hold other features, their worktrees are theirs — never edit them; attribution guards judge every path by its owning feature.

1. Implement per the approved plan, following project conventions and the **stage guidance injected at stage start** (tier-3 prose from project.md). Commit in the worktree **as you go** — small reviewable commits; a twelve-file monolith saved for the end faces review blind and is not crash-safe.
2. Write appropriate tests for the change as you go (project test framework — see the `test` key / `flow-check` blocks).
3. Run `flow check` — it runs every tier-1 check (test, health, named `flow-check` blocks) and records each. Any later edit in the worktree invalidates checks and the tier-2 confirmation; rerun before verify.
4. UI flag set? Perform an actual visual check with a browser (screenshot or automated visual pass per the project's tooling) — not just a typecheck.
5. Done means **running and healthy, with pre-existing data** — not "compiles":
   - `commands.seedData` (if set) puts real data in place; start the app with the `run` command;
   - the health check (tier 1) must pass — `flow check` covers it (it runs seedData before health), and `flow verify` runs it **again after** the `dev` deploy, because the deploy is what has to be proven;
   - walk the **tier-2 checklist** (`- [ ]` items) with the operator honestly — those can't be scripted;
   - then ask the user **Verified?** When they answer, run `flow verify --confirmed` (no second dialog); interactively they can run `/flow verify` themselves. Fixes requested = iterate and re-verify; that loop is free.

`flow verify` re-runs build, runs the `dev` deploy command when configured (the operator reviews the running dev app — the gate **prints what it ran** (`build ran (…)` / `dev ran (…)` / `dev: none configured`) because the command can take minutes and touch live services; it must **background and exit** — e.g. `docker compose up -d .` — verify waits for it and kills runs past 15 min), then **re-runs the health probe against what it just deployed** (with `seedData` first when configured; a failing probe refuses the gate — the pre-deploy PASS describes a container that no longer exists; no probe configured prints `health: none configured` and the doctor flags it) and demands every tier-1 check green before the single question; the operator's confirm covers the tier-2 list as a set (hashed; edits reset it) — criteria structured, conversation minimal. Verify lands the feature in **pre-release**.

### Handling additions mid-implement

The operator asks for something extra while you are implementing. Do not bounce the flow and do not grow it silently:

- **Same feature, grown scope** → stay at implement. Append to `plan.md` a `**Added mid-stage:**` line describing what was asked and how, then implement it and `flow check` again. Any edit invalidates checks and the tier-2 confirmation, so verify re-covers the addition — nothing can slip past the gate.
- **Different problem** → finish the current feature; it is a new flow (`flow start <new-slug>` after this one ships). Never fold a second feature into one plan, PR and verify — the audit trail is the point.
- **Heavily amended plan needs formal re-review** → show the operator the amended plan and ask them to re-approve it in chat; the verify gate remains the checkpoint. There is no reopen command by design.

## Stage: pre-release

The change is implemented, tested and running locally; now you prepare the release — still entirely in the worktree, main-repo git state stays off-limits until this gate hands over. **Versioning:** the version manifest in project.json `versioning.file` is the single source of truth; tags are always `versioning.pattern` rendered from it — one number everywhere. If `versioning.file` is unset, stop and clarify the scheme with the user before touching any version; never invent one mid-release. Sequence:

1. `/ponytail-review` the change; fix every **must-have** and **should-have** finding; `flow test` again if code changed.
2. Update documentation to reflect the change.
3. Update the changelog and bump the version manifest (`versioning.file`) to the exact version you will tag — manifest, changelog, and tag must all agree; commit the prep on the feature branch.
4. Run `flow check` — the prep edits invalidated the implement checks and the release gate demands them green again.
5. Tell the operator what the PR will contain, present the version and the changelog entry, and **stop** — one word: **Release?** When they answered, run `flow release --confirmed` (interactively they can run `/flow release` themselves). The gate re-checks tier-1, requires the manifest version to be **ahead of the last tag** and the changelog to mention it — then you are in release. If the operator says this flow ships **without a version/tag**, do not bump or changelog-edit for it: run `flow release --no-version --confirmed` — the version/changelog requirements are skipped for this flow.

## Stage: release

You are now cleared to touch main-repo git state (merge/tag/push on the default branch is allowed only here) — this stage publishes, the preparation happened in pre-release. Recommended sequence — run it in the worktree unless noted:

1. Commit everything on the feature branch, push the branch, open the PR, wait for it to be merged (merge yourself with `gh pr merge` or ask the user).
2. `git fetch` and confirm the merge landed, create the release tag **annotated** (`git tag -a`) and push the ref explicitly (`git push origin v<ver>`) — never `git push --follow-tags`, which silently skips lightweight tags (tags then never reach the remote and CI never publishes). After merge, a tag points at what actually shipped. If CI publishes artifacts from the tag, set `release.artifact` in the playbook so `release-done` verifies the published artifact — it also refuses local-only tags outright. An unversioned flow (operator granted `--no-version`): no bump, no tag — publish the merge only and `release-done` asks nothing version-side.
3. Run `flow release-done` — **no question**: the operator's Release? answer covered the whole publication, release-done only re-verifies (tag on the default branch, on origin, artifact when configured), creates the GitHub release from the tag (advisory — a note if gh or a GitHub remote is missing) and records the release; `flow finish` is what closes the feature out. Skipping the GitHub release is the operator's call only — `--no-github-release` (once) or `release.github = false` in the playbook (always) — act on it only when the operator says so, never on your own initiative. The artifact check works the same way: `release.artifact` set means every release must show the published artifact; `--no-artifact-check` skips it once, operator's call only.

## Stage: finish

Ask the operator **Finish?** — then run `flow finish --confirmed` (or interactively; the gate's one question covers the whole cleanup and mentions any commits that look unmerged). `flow finish [slug]` is the last step of a released feature — the one command that closes it out:

- it refuses until `release-done` recorded the release, so an unfinished feature never gets a tidy
  ending (abandon those with `flow abort`);
- it requires the main checkout to be **clean and pushed** — an uncommitted changelog or a local-only
  release commit is exactly what it protects against — and it refuses until that is fixed;
- it removes the worktree and the branch, then deletes `.dev-flow/<slug>/` and unbinds the session.
  If `origin` still has the feature branch it is deleted **only on proof it was merged** — an ancestor of
  `origin/<default>`, or a merged PR via gh (squash merges); otherwise it is kept with a note in the output.
  Uncommitted worktree edits block it; commits that look unmerged (squash merges) are called out in
  the Finish? question — if the gate asks and you have no operator answer, stop and show them.

Production deployment stays manual and out of scope: never ask the operator whether a prod deploy happened.

## When things go sideways

- User wants to abandon a feature: `flow abort <slug>` unbinds the session — at plan stage (nothing approved) it removes the feature outright; once a worktree exists, state stays for manual recovery and the exact worktree/branch removal commands are printed.
- A gate refuses: read its reasons — they list exactly what is missing. Fix that, rerun the gate.

## Reflect (your suggestion queue)

When you notice something the playbook or the plugin should improve — drifted commands, gate friction, a plugin bug — park it instead of complaining in chat: `flow doctor reflect "<one-line note>"`. The note lands under `## playbook` (what to change in this project's playbook) or `## plugin` (what to change in dev-flow itself) — the wording decides, and a note about both is written to both. The operator sees the open count in status and stage context and decides what happens next:

- Only reflect real friction, one line each; never reflect the same issue twice.
- `flow doctor reflect` lists open items. When the operator says "fold them in": draft the playbook update (read current file via `flow init --draft` → adjust → `flow init --write`), then check items off (`- [x]`) in `.dev-flow/reflections.md` with a normal edit — that file is your queue; `project.md` is not.
- `## plugin` items: offer to file a GitHub issue against dev-flow; the operator confirms.
