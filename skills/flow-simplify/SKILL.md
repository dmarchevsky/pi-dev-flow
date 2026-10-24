---
name: flow-simplify
description: >
  Operative cut-down of code: delete dead code, collapse near-copies, reuse
  shared helpers, remove unused options and speculative abstractions — while
  behavior and the green test suite are contract. Unlike the read-only
  flow-review and flow-audit, this one edits, commit by verified commit. Use
  for "simplify this", "slim this down", "compact this code", "remove dead
  code", "dedupe this". Default target: what the operator names, or the bound
  flow's branch diff.
argument-hint: "[file... | dir...]"
---

# flow-simplify

Cut real weight: less system, same behavior. Review and audit report; this
skill edits — under a discipline that keeps every cut reviewable and cheaply
revertible. Order of importance: **behavior preserved, honest cuts, least
code.** Editing means working where editing is allowed — a dev-flow worktree
or a branch, never a bare default branch. Deleting or changing a feature is
one cut too far: that is the operator's call.

## 0. The game's rules

- Behavior-preserving only: same inputs, outputs, error behavior, side
  effects, edges. Tests define that behavior.
- Green baseline first: run the project's checks (playbook test/build/lint
  commands, or README's). Red baseline → stop; never simplify on top of red.
- Never touch a test to make it pass after a cut. A cut that breaks a green
  test changed behavior — or found a bug. Revert and report; the bug is a
  separate flow.
- Small steps: one cut, one check, one commit (§6).

## 1. Pick the target

- What the operator names: files, a folder, a subsystem.
- Nothing named and the session is bound to a dev-flow feature: the code
  this flow's branch touched — `git diff $(git merge-base origin/<default> HEAD)`
  plus uncommitted work (run `flow status` for the worktree and default).
- Neither: ask. Never silently widen to the whole repo — that is
  `/flow-audit`'s job: audit finds it, you cut it.

## 2. Baseline and tools

- Count lines per area (app code, tests) before you start, measured through
  the project's formatter so a reformat cannot fake a win.
- Dead-code claims come from semantic tooling — language server, knip,
  vulture, `cargo machete`, whatever the repo has. Grep confirms a tool's
  hit; grep alone lies: it misses re-exports, dynamic and string dispatch,
  tear-offs, and config references.
- Name the floor you will not touch: generated files, vendored code,
  platform scaffolding. A line that was never yours is not bloat.

## 3. Chesterton's fence

Understand why the code exists before you touch it: who calls it, what it
calls, which tests pin it, what `git blame` says about its origin. If you
cannot say why it exists and what exact maintenance cost removing it lifts,
leave it and list it under `Untouched:`. Commented-out blocks and
unreachable branches are the exception — they never get a fence.

## 4. The cut order

Safe to risky; risk rises as you go down, so stopping at any line is a fine
answer. Verify each cut (§6) before the next.

1. **Dead code:** files, exports, functions, branches with zero references —
   §2-verified, tests, fixtures, config and dynamic references included.
2. **No-op places:** fully plumbed subsystems that do nothing, toggles
   hardcoded off, config nobody sets, options with no effect. Dead weight
   in feature clothing.
3. **Misplaced scaffolding:** dev/debug/test harnesses in shipping code →
   move them to their real home.
4. **Duplication:** same logic in two places → one remains. Search for an
   existing helper before extracting a new one — reuse beats inventing.
   Near-identical files become one; two helpers doing one job keep the
   better path, by name.
5. **Speculative structure:** an interface with one implementation, a
   factory or strategy for one case, a wrapper that only forwards. Delete
   the layer; call the thing.
6. **Comment hygiene:** comments restating the code die; comments saying
   *why* stay. This rides along on files you are already editing — a
   standalone comment-trim is not simplification, it is silencing.
7. **Only when asked and the tests are a faithful spec:** clean-room rewrite
   of a worst file against its tests, discarding accumulated cruft. Riskiest
   lever here; without trusting tests you rewrite bugs into features.

## 5. Honest cuts

The number is the temptation; the system is the point. Never: reformat, pack
lines or strip blanks to shrink; delete docs or features to win; move code
out of the counted path; adjust the measuring tool. When done, split your
cuts: **structural** (dead, no-op, duplication, layers) vs **cheap**
(comments, whitespace, cosmetic moves). Cheap in the majority means the
metric was gamed — say so plainly and report that the structural well is
dry; that report is itself a good result.

## 6. The loop

One cut → project checks → commit, or revert and reconsider. Never batch cuts
into one commit — a regression must name its cut. A single cut touching 500+
lines gets scripted (codemod, AST transform, sed), not hand-edited. Pure
reformatting, when you must have any, rides a separate commit from real cuts.

## 7. Do not over-simplify

- Never inline away a helper whose name was the concept.
- Never merge two functions into one with two jobs.
- Never remove error handling "for cleanliness"; never delete an abstraction
  that exists for testability — ask before that one.
- Never trade if/else for a nested ternary to save lines; explicit and a
  touch longer beats clever and short.
- Never rename to your taste — project conventions win; churn dressed as
  cleanup is just churn.

## 8. When to stop

The remaining cuts are architecture reshuffles you cannot finish and verify
here, product scope, or riskier than their value: stop and report. No
refactor→regret→revert loops, no half-migrated layer left behind — half a
migration is worse than none. A legitimate ending is *"already lean"*:
small cut, suite green, nothing worth removing.

## 9. Report

Plain English, short sentences. Start with **`Cut:`** — counts per §4
category, files and lines before → after, the structural:cheap split (§5),
checks green. Then **`Reused:`** — the existing helpers duplicated logic
folded into (paths). Then **`Untouched:`** — fences left standing and why,
parts not covered and anything you could not verify. Close with
**`Decisions needed:`** only when a remaining cut is scope or product — with
the numbers, so the operator can choose.

---
_Adapted for dev-flow from: maxim-saplin/goal-sloc (MIT), addyosmani/
agent-skills code-simplification (MIT),
anthropics/claude-plugins-official code-simplifier (Apache-2.0)._
