# Guardrails

What dev-flow enforces while a feature is in flight, and what it deliberately doesn't do.

All of this applies only in an initialized repo, one where `.dev-flow/project.md` exists. Without the
playbook, dev-flow stays silent.

## What is enforced

**Nothing lands on main until release.**
- `git commit`, `git merge` and pushes *to* the default branch are blocked at every stage except
  `release`. Tag pushes and feature-branch pushes are fine from any stage.
- One exception: a commit whose only change is `.dev-flow/project.md`, since tracking your playbook
  is setup, not feature work.
- A `pre-commit` hook covers commits made outside Pi.

**Shipping waits for `flow release`.** Before the release stage, tagging, merging the PR
(`gh pr merge`, `glab mr merge`) and creating a forge release are refused. Reads like `git tag -l`
and opening the PR are fine.

**No code before an approved plan.** During plan, the agent can only write in its own
`.dev-flow/<slug>/` folder.

**Work stays in the worktree.**
- During implement and pre-release, the agent can only write in its own feature's worktree. Each
  write is judged by the feature that owns the path, so sessions can't write into each other's
  worktrees.
- Paths are checked after resolving symlinks.
- Scratch files outside the repo (the OS temp dir) are always fine. A bound feature's `TMPDIR`
  points to `.dev-flow/<slug>/tmp/`, which is cleaned up at finish.
- Creating a new branch inside a feature worktree is refused. An unrelated fix gets its own flow.

**No work outside a flow.**
- In a repo with `.dev-flow/`, an unbound session can't edit source files. Everything starts with
  `flow start` or `flow use`.
- Files git ignores (like a local secrets file) stay writable.
- `flow start` requires the main checkout to be on the default branch.

**Gates can't be faked.**
- The agent can't write, move or delete `state.json`, `claim.json`, a feature folder or `.dev-flow/`
  itself, through either edit tools or bash.
- The playbook is yours. The agent can only edit it inside a docs or patch flow's worktree, and every
  sanctioned overwrite keeps a `project.md.bak`.
- Every check result is tied to a fingerprint of the worktree. Any change, even through `sed -i` or a
  formatter, makes it stale, and the next gate re-runs it.

**Your own rules.** The `deny` / `confirm` / `protect` / `forbid` rules in your playbook's
`flow-guard` block run on every bash command and every edit, at every stage, before dev-flow's own
checks. A block always shows the reason you wrote. See the [playbook](playbook.md).

**Force pushes ask you.** `git push --force` / `-f` / `--force-with-lease` needs your OK. The
refusal prints the prefix that marks it as approved: `DEV_FLOW_ALLOW_REWRITE=1`.

**Shell calls can't hang.** The model often omits a timeout, so a `gh` waiting on a prompt could
freeze a session for hours. A shell call without a timeout gets a default for its kind:

| Kind | Timeout |
|---|---|
| quick inspection | 30s |
| local git, unknown commands | 120s |
| network | 180s |
| containers and services | 300s |
| builds, tests, installs | 900s |
| watchers (`gh run watch`) | 1,200s |

Explicit timeouts are capped at 1,800s. A command wrapped in its own `timeout N` gets N + 15s. When
dev-flow's default kills a command, the result says so. Set `bashTimeout = require` in `## global` to
refuse calls without a timeout instead.

**There is no `flow` CLI.** A bash command named `flow` is refused. Gates live inside the Pi session.
If your project ships its own `flow` binary, call it by path or through `npx`.

**The rules reach the agent.** Pi loads a skill only when the model decides to read it. So dev-flow
injects the ground rules (about a thousand tokens) into each session once, and again after a
compaction removes them. Each stage then names the one reference file it needs.

**Compaction is flow-aware.** dev-flow uses your effective `reserveTokens`. When Pi compacts anyway,
dev-flow redoes the compaction with flow-aware summary instructions. If auto-compaction is off in
your settings, dev-flow leaves it off.

## Status bar

In an initialized repo, the footer shows the bound feature:

| Glyph | Means |
|---|---|
| 📝 🔨 🔍 🚀 | plan · implement · pre-release · release |
| ⚡ 📚 🎱 | patch · docs · yolo mode |
| 💬 | a checkpoint is waiting for your answer |
| ⚠️ | a check is failing |

An unbound session shows `💬 N flow(s) open` or `💬 no flows`. In pi-web, the footer is a chip you
can click to see the other open flows. `flow status` spells all of it out.

## Limitations

These guards stop the common mistakes an agent makes. They are **not a security sandbox**.

- **Production deploys stay manual.** `flow finish` only closes the flow.
- **The git guard reads shell commands.** It splits commands into segments and understands
  `cd … &&`, `git -C`, quotes, and wrappers like `sh -c`, `env` and `xargs`. An exotic wrapper
  (a subshell, or a command held in a variable) can still slip past.
- **Quoted text is data.** `gh pr create --body "…git commit…"` isn't a commit. That means a command
  built at runtime isn't caught either.
- **`protect` / `forbid` cover edit tools only, judged from the repo root.** A copy inside a
  worktree is a different path. Use a `deny` rule to stop a bash redirect.
- **Read-only commands can still write.** `find -delete` and `awk … > file` can write, so a `deny`
  on `rm` doesn't cover them. Write the rule for the effect you want to prevent.
- **Where gate commands run.** Before the worktree exists, gate commands run in the main checkout.
  After that, they run in the worktree.
- **Keep real validation in CI.** Write rules for common mistakes, and keep checks you truly depend
  on in scripts and CI.
