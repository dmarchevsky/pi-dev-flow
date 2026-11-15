# Driving dev-flow headless

For anyone putting a Pi session behind a bot, a web UI or a queue. The interactive story is in the
[README](../README.md#how-it-works).

There's **no `flow` CLI**. Gates exist only inside a Pi session, as the `flow` tool and the `/flow`
command. So an orchestrator drives a **Pi session** (for example through the Pi SDK). That's
deliberate: the guards live in the harness, so anything that went around Pi would skip all of them
except the `pre-commit` hook.

## The contract

- **Refuse → relay → `--confirmed`.** Without a UI, a checkpoint gate (`approve`, `verify`,
  `release`, `finish`) never opens a dialog. It refuses with a line that starts with
  `NEEDS-OPERATOR <Question?>`, where the question is Approve?, Verified?, Release? or Finish?. Route
  on that marker, show the question to a human word for word, and when they answer, re-run the same
  gate with `--confirmed`. A `flow-guard` `confirm` rule with no UI refuses with the same marker.
- **`--confirmed` runs on trust.** dev-flow can't verify that a human answered. If your
  orchestrator adds `--confirmed` on its own guess, dev-flow can't catch it. A `--patch` or
  `--docs` mode is granted by the Approve? answer, so it runs on the same trust.
- **Not every question is asked.** Release? and Finish? often answer themselves (`ask` and `finish`
  default to `on-change`), so a driver must not wait for all four checkpoints.
- **Machine-readable output.** `flow status --json` gives the bound slug and, per feature: stage,
  modes, branch, worktree, checks and next hint. `flow help --json` gives the gate contract:
  questions and flag names. `status`, `help`, `version`, `doctor` and `roadmap` (list) are safe at any
  time, even without `.dev-flow/`.
- **One session = one feature.** Bindings are per session and survive resume and fork. A driver that
  reconnects either rejoins its session or rebinds with `flow use <slug>`. Nothing binds
  automatically. Parallel features need parallel sessions.
- **Long gates need long timeouts.** `approve` runs `setup`. `verify` runs the build and the `dev`
  deploy (killed after 15 minutes), then retries the health probe. On GitHub, `release` waits for
  the PR's CI (up to 30 minutes) and then for the publish CI the tag started (up to 15). It returns
  `publish waiting` when the budget runs out; call it again. Give the driver minutes, not
  seconds. Gates print progress while they run.
- **Edits make checks stale.** Each check result is tied to a worktree fingerprint, and
  `verify` / `release` re-run stale ones themselves. A commit that holds only release prep (version
  file, changelog) doesn't make them stale.
- **Version skew.** Gates run the dev-flow build the session loaded at start. `flow version` says
  when the checkout is newer. `flow release` asks whether to `/reload` or proceed with the old build,
  and never blocks on it.
