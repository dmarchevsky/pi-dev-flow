# Driving dev-flow from an orchestrator (headless)

For whoever puts a Pi session behind a bot, a web UI or a queue. The interactive story is in [the README](../README.md#how-you-work-it).

There is **no `flow` CLI** — gates exist only inside a Pi session (the `flow` tool, `/flow`
command). A remote orchestrator therefore drives a **Pi session** (e.g. via the Pi SDK) and
calls the `flow` tool from inside it. That is not a limitation: the guards are harness-side,
so a driver that shelled around Pi would bypass every teeth except the `pre-commit` hook.

The contract a headless driver (a session with no UI) relies on:

- **Refuse → relay → `--confirmed`.** A checkpoint gate (`approve`, `verify`, `release`,
  `finish`) never dialogs headless — it refuses with a line that starts with the stable
  marker `NEEDS-OPERATOR <Question?> — …` (the four questions: Approve? / Verified? /
  Release? / Finish?). Route on the marker, relay the question verbatim to the human, and on
  their literal answer re-run the same gate with `--confirmed`. A project `flow-guard`
  `confirm` rule with no UI present refuses with the same marker (no question word). The
  marker is also on top of prose that stays readable for humans — nothing to parse beyond
  the first token.
- **`--confirmed` is honor-system.** The plugin cannot verify a human answered; the flag
  means "the operator literally answered this question in chat". In remote setups the
  orchestrator owns that trust — relaying the exact question and adding `--confirmed` on its
  own inference is the one orchestrator bug dev-flow cannot catch. `--patch`/`--docs` mode
  grants work the same way (operator grant in chat, then `--confirmed`).
- **Machine surfaces.** `flow status --json` (bound slug + per-feature stage, mode flags,
  branch, worktree, checks, next hint — no git subprocesses) and `flow help --json` (the
  gate contract as data, incl. the checkpoint questions and flag names). Both are additive:
  the prose views are unchanged. Read-only-safe at any stage/binding, even without
  `.dev-flow/`: `status`, `help`, `version`, `doctor`, `roadmap` (list).
- **One session = one feature.** Bindings are per-session and survive resume/fork; a
  reconnecting driver either rejoins the same session or rebinds with `flow use <slug>`.
  Nothing auto-binds — always bind explicitly or pass the slug explicitly.
  Parallel features = parallel sessions.
- **Budget for long gates.** `approve` runs `commands.setup`; `verify` runs build and the
  `dev` deploy (runs are killed past 15 min) and re-probes health with `healthWait` retries.
  A remote timeout must be minutes, not seconds — the gate prints progress lines while it
  runs.
- **Edits invalidate checks.** Any worktree write clears recorded checks and the tier-2
  confirmation — re-run `flow check` before `verify` after the last edit.
- **Version skew.** Gates execute the dev-flow build the session loaded at start; `flow version`
  reports when the checkout has moved ahead of it. `flow release` turns the skew into a question —
  update (`/reload`, then re-run) or proceed with the old release — never a block: publishing under
  an older gate is a legitimate choice. The operator's proceed is stamped into the release and
  `release-done` repeats the acknowledgement (its after-the-fact warning stays for a release that
  went out without the question being answered).
