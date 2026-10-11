# dev-flow

An enforced feature workflow for [Pi](https://pi.dev), shipped as a pi package. One feature at a time:

```
plan → implement → release → cleanup → deploy → done
```

The flow lives in **this repo**; each project only gets a gitignored `.dev-flow/` folder. State is a file, checkpoints are gates, and the guardrails are enforced by the harness — not by prose the model may forget.

## Install

```bash
pi install git:<your-host>/dev-flow        # or: pi install ./dev-flow  (local)
```

In each project repo, once:

```
/flow init
```

Creates `.dev-flow/`, adds it to `.gitignore`, and installs a `pre-commit` hook that rejects direct commits to the main branch (the hook lives in `.git/hooks`, nothing is committed). The flow is completely inert in repos without `.dev-flow/`.

## Commands

`/flow <sub>` for you, the `flow` tool for the agent — same gates either way:

| Gate | Advances | Refuses unless |
|---|---|---|
| `start <slug> [--ui]` | → plan | slug is new |
| `approve` | plan → implement (creates worktree + branch) | `plan/*.md` exists; if `--ui`, mockups (per `mockupGlobs`) exist in `plan/`; **you confirm interactively** |
| `test` | records a check | — (runs `commands.test`, records pass/fail) |
| `verify` | implement → release | test check green, build (if configured) green, **you confirm it works locally** |
| `release-done` | release → cleanup | verify approval recorded |
| `cleanup` | cleanup → deploy | worktree clean, no unmerged commits (squash-merges need your explicit confirm), **you confirm removal** |
| `deploy` | → done (deletes `.dev-flow/<slug>/`) | **you confirm the manual deploy happened or was skipped** |
| `status` / `abort [slug]` | — | — |

## Enforcement (the teeth)

While a feature is active, the extension intercepts every tool call:

- **Nothing on main, ever**: `git commit` on the default branch is blocked; `git push`/`git merge` onto it requires stage `release`; tag pushes require stage `release`. Plus the standalone pre-commit hook for commits made outside Pi.
- **No code before an approved plan**: at stage `plan`, edits are confined to `.dev-flow/<slug>/`.
- **Work stays in the worktree**: at stages implement+ edits outside the worktree (or `.dev-flow/`) are blocked.
- **Gates can't be skipped**: `state.json` is untouchable by the agent (edit tool and bash); `project.json` is operator-owned; editing worktree code invalidates a passing test check until `flow test` reruns.
- The active stage is injected into the model's context every turn; the bundled `dev-flow` skill is the agent's playbook, including the recommended release sequence: review (`/ponytail-review`) → fixes → docs → changelog/version → PR → merge → tag → `release-done`.

## Project configuration — `.dev-flow/project.json`

Optional, gitignored, **edited only by you** (the agent is blocked from it). Defaults shown:

```json
{
  "defaultBranch": "main",
  "branchPattern": "feat/{slug}",
  "worktreeDir": ".dev-flow/{slug}/worktree",
  "mockupGlobs": ["*.html"],
  "commands": {
    "setup": "npm ci",
    "test": "npm test",
    "build": "npm run build",
    "run": "npm run dev",
    "deployNote": "Manual: ssh prod && ./deploy.sh <tag>"
  },
  "release": {
    "review": "/ponytail-review",
    "changelog": "CHANGELOG.md",
    "tagPattern": "v{version}"
  },
  "mainHook": true
}
```

`{slug}` is substituted in `branchPattern`/`worktreeDir`. Point `worktreeDir` elsewhere (e.g. `.worktrees/{slug}`) if the project has its own convention. Project conventions themselves stay in the repo's `AGENTS.md`/skills — dev-flow sequences stages, it doesn't duplicate project rules.

## Layout in a project

```
.dev-flow/                    (gitignored, flow-owned)
  project.json                operator-owned config
  .current                    active feature pointer
  <slug>/
    plan/                     plan.md + mockups   ← plan stage output
    worktree/                 feature worktree    ← implement/release work
    state.json                stage, approvals, checks (agent cannot write)
```

## Limitations (deliberate, v1)

- Deploy is manual by design (phase 2 automation).
- Bash git-guard matching is regex-based: an exotic shell wrapper around `git commit` could slip past; the `.git` hook covers plain commits outside Pi too, but neither is a security sandbox.
- One *active* feature per pointer (`abort` clears it); multiple feature dirs can coexist, guards follow `.current`.
- `flow test` runs in the main checkout; if tests must run inside the worktree, make `commands.test` cd-aware (`cd {…}` yourself) — no templating provided.

## Development

```bash
npm i && npm test     # unit tests + wiring smoke test (node --test)
pi -e . run /flow status   # try it against any repo
```
