# dev-flow

An enforced feature workflow for [Pi](https://pi.dev), shipped as a pi package. You say what you
want; an agent builds it; **the harness — not the agent's good manners — decides whether a stage
may advance.** One feature at a time, five stages, and four questions asked of you —
`plan → implement → pre-release → release → done`, mapped out under [How you work it](#how-you-work-it).

## The idea

**Every feature starts as a spec.** `flow start <slug>` opens a feature: a folder under
`.dev-flow/<slug>/` where the agent researches and writes a plan — problem, approach, files to
touch, test strategy, risks — plus rendered screenshots for anything user-visible. Until you approve
it, the agent cannot edit code anywhere else in the repo. That is the whole "does it actually plan?"
question, answered by the harness instead of by trust.

**Stages end in gates, not vibes.** Each stage has one exit gate that refuses until its criteria
hold: your plan file exists; every command your playbook names as a check passes; the app really
starts, with real data, and answers a health probe **after** a real deploy; changelog and version
manifest agree and the version is ahead of the last tag; the release is tagged and on the remote.
Gates read state that the agent is blocked from writing, so a step cannot be quietly skipped — and
each gate asks you exactly **one** question.

The flow itself ships with the plugin; a project carries only a `.dev-flow/` folder — state files,
plans and worktrees, nothing the plugin needs to run.

**Git stays clean by construction.** Nothing commits to the default branch while a feature is in
flight: work happens in its own git worktree and branch (`feat/<slug>`), so your checkout keeps
moving while a feature is under way. Publishing has one order — PR → merge → annotated tag → forge
release — and only in the release stage does dev-flow let git touch main again. A `pre-commit` hook
covers commits made outside Pi.

**Many features at once.** One Pi session = one feature = one worktree, and a repo can host as many
as you want in parallel. A write inside worktree X is judged by X's stage whoever made it, so
sessions cannot dirty each other's branches or borrow each other's approvals. [More here.](docs/concurrency.md)

## Install

```bash
pi install git:<your-host>/dev-flow      # or: pi install ./dev-flow (local checkout)
```

Then, once per project repo, `/flow init`. It reads the repo (default branch and forge from git,
package manager, test/build/run conventions, version manifest) and writes **`.dev-flow/project.md`
— your playbook**: the commands that count as checks, the manual checklist, the version and tag
convention, and any hard safety rules of your own. It asks about everything detection could not
decide (self-hosted forge? Docker artifacts? what "healthy" means?) and installs a `pre-commit` hook
that blocks direct main commits. Run `/flow init` again later and it becomes a **doctor**: drift in
your playbook, dead commands, config problems — it never rewrites your hand edits without asking.
The flow is completely inert in repos with no `.dev-flow/`.

→ [The playbook](docs/playbook.md) — what goes in `project.md`, the three tiers, your own guard rules.

## How you work it

You are not a command runner. You ask for a feature and then answer four words — say *"sessions
expire silently, add sliding renewal and a test"* and it becomes the feature `session-renewal`,
walking five stages with a gate between each:

```
        you ask for a feature
                 │
        ┌────────▼────────┐
        │      plan       │  spec (+ mockups) in .dev-flow/<slug>/plan/
        └────────┬────────┘
         Approve?  · refuses without the written plan (and renders for UI work)
        ┌────────▼────────┐
        │    implement    │  code + tests, only inside the feature worktree
        └────────┬────────┘
        Verified?  · refuses until checks are green and the deployed app is healthy
        ┌────────▼────────┐
        │   pre-release   │  review, docs, changelog entry, version bump
        └────────┬────────┘
          Release?  · refuses unless the version passes the last tag and the changelog agrees
        ┌────────▼────────┐
        │     release     │  PR → merge → annotated tag → release notes
        └────────┬────────┘
           Finish?  · refuses until the release is recorded and main is clean and pushed
        ┌────────▼────────┐
        │      done       │  worktree, branch and feature folder removed
        └─────────────────┘
```

| Stage | What the agent does | It asks you |
|---|---|---|
| **plan** | reads the code, asks its clarifying questions, writes the spec to `.dev-flow/session-renewal/plan/plan.md` | **Approve?** — the plan is right, build it |
| **implement** | works in a fresh worktree on `feat/session-renewal`, commits in small steps, runs your `test` command to green, walks the manual checks with you | **Verified?** — after you used it running |
| **pre-release** | review and fixes, docs, changelog, version bump, checks re-run; shows the PR summary and the version it means to tag | **Release?** — ship it |
| **release** | PR → merge → annotated tag → release notes; only here may git touch main | **Finish?** — clean up, we're done |
| **done** | removes the worktree, branch and `.dev-flow/session-renewal/` | — |

Four answers from you; everything between them was the agent's problem and your playbook's gates. If
the feature grows mid-flight it is folded into this one (the plan gains an `Added mid-stage:` line and
checks re-run); a *different* problem waits for the next flow — one feature, one plan, one PR.

Your answers at a checkpoint:

- **yes** — or **no**, with the reason. The agent fixes it and asks again; that loop is free.
- **yolo** — answers this checkpoint *and* pre-confirms the rest, so the remaining gates run back to
  back with every check still enforced. Attach your wishes to the word: *"yolo, patch bump"*,
  *"yolo, no tag"*.
- **no version this time** (at Release?) — merge and changelog land, no bump or tag; the next
  versioned release folds your `Unreleased` entry under its heading.

Two things you grant rather than run: a **mode** when the agent proposes one (`normal` is the
default; `--patch` for a small change you intend to ship now, `--docs` for docs-only work — both skip
the written plan), and a **`/reload`** whenever dev-flow itself was updated — a running session keeps
the code it loaded at startup, and `flow version` tells you when it is behind. Updating or installing
the plugin, and running git outside Pi when one of your `confirm` rules fires with no UI to ask you,
are the only things dev-flow cannot do for you.

Nothing here trusts the agent in either direction: a checkpoint gate refuses if you never answered
(its refusal begins `NEEDS-OPERATOR Approve?`), and the agent is told never to ask *you* to type a
`flow` command. `/flow …` is your manual override — for when the session is stuck, wrong, or
claiming a gate result it never produced. → [Gate reference](docs/gates.md)

## What is enforced

While a feature is active, every tool call passes a guard:

- no commit, merge or push to the default branch outside the release stage (plus a git hook for work outside Pi);
- at plan stage the agent can only write inside its own feature folder;
- at implement/pre-release it can only write inside its own worktree;
- with a `.dev-flow/` present, an unbound session cannot edit source at all — everything goes through the flow;
- `.dev-flow/*/state.json` is unwritable by the agent, so gates cannot be skipped or forged;
- `project.md` is yours: the agent cannot write it (except inside a docs/patch flow), and every
  sanctioned overwrite keeps a `.bak`;
- your own `deny` / `confirm` / `protect` / `forbid` rules run on every command and path, ahead of
  dev-flow's verdicts, with the reason you wrote;
- a shell call must state its own timeout, and a bash command named `flow` is refused (there is no
  CLI — gates live in the session).

→ [Guardrails](docs/guardrails.md) — the full list, and [what this is *not*](docs/guardrails.md#limitations-deliberate-v1).

## Where things live

```
.dev-flow/
  project.md            your playbook — the only committed file here
  reflections.md        the agent's suggestion queue for you (advisory)
  roadmap.md            your backlog of future features (advisory)
  <slug>/
    plan/plan.md        the spec you approve (embeds the mockup renders)
    plan/mockups/       mockup HTML + screenshots          ← UI features
    worktree/           the feature's git worktree         ← all the work
    state.json          stage, approvals, checks (agent cannot write)
```

`reflections.md` and `roadmap.md` never gate anything: the first is where the agent parks "your
playbook / dev-flow should change" notes for you to `flow doctor`, the second is the backlog
`flow roadmap` manages, and a shipped feature checks its picked item off itself.

## Documentation

| Doc | For |
|---|---|
| [docs/playbook.md](docs/playbook.md) | writing `project.md`: checks, checklist, prose, guard rules, `flow init`/`doctor` |
| [docs/gates.md](docs/gates.md) | every gate and flag, what makes each refuse |
| [docs/guardrails.md](docs/guardrails.md) | everything enforced, and the deliberate limits |
| [docs/concurrency.md](docs/concurrency.md) | several agents, one repo: bindings, claims, attribution |
| [docs/headless.md](docs/headless.md) | driving a session from a bot/UI/queue: `NEEDS-OPERATOR`, `--json` surfaces |
| [docs/development.md](docs/development.md) | hacking on dev-flow itself: tests, self-hosting, `/reload` |
