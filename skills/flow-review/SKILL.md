---
name: flow-review
description: >
  Read-only senior-engineer review of a change before it ships: correct, safe,
  holds under load, tested, fast, lean — judged also against the flow's plan.
  Report only, changes no code. Use for "review this", "code review", "is this
  ready to ship?", and as the dev-flow pre-release review step. Default target:
  the bound flow's branch diff against the default branch.
argument-hint: "[ref | base..head | file...]"
---

# flow-review

Review a change like the senior engineer who gets paged when it breaks.
Order of importance: **correct, safe, holds under load, tested, fast, lean.**
Read the connected code, not only the diff. This is a report the operator
asked for: give it in full. Change no files, mutate no git state.

## 1. Pick the target

- What the operator names: a ref, a `base..head` range, or files.
- Nothing named and the session is bound to a dev-flow feature
  (`[dev-flow] this session is bound to: <slug>`): review the **whole feature**
  — `git diff $(git merge-base origin/<default> HEAD)` plus the uncommitted
  worktree changes (run `flow status` for the worktree and default branch).
- Otherwise: uncommitted/staged changes; if none, the last commit.

## 2. Understand first

- Read the diff, then what it touches: callers of every changed function,
  what it calls, the tests, the README.
- **Plan check:** if a flow is bound and `.dev-flow/<slug>/plan/plan.md`
  exists, read it. Judge the diff against the plan: missing planned parts and
  unexplained deviations are findings; if the plan itself is what is wrong,
  say so — that is the operator's call, not the branch's defect.
- Trace the real flow: where data enters, what is stored, what leaves.
- Find the expected load (README, deploy config): one person on a script, or
  many users at once. Judge scale against that; name the load you assumed.

## 3. Look for

1. **Bug:** wrong result, crash, missed edge (empty, zero, last item,
   rounding, time zones), a caller broken by the change, a fix in one caller
   while the shared function stays broken.
2. **Risk:** injection, weak randomness, secrets, missing checks on user
   input; data loss (swallowed errors, writes in the wrong order, no transaction).
3. **Scale:** check-then-write races, per-process state that must be shared,
   unbounded growth, a query per item, O(n²) on real input.
4. **Missing test:** risky new logic (branch, parser, money, security, data
   writes, bug fix) with no test that fails when it breaks. One good test,
   not coverage.
5. **Speed:** big slowdowns are findings; small wins are suggestions.
6. **Lean:** delete (dead code, speculative features), reuse (name the
   existing helper's path), stdlib/installed-dep doing it already, yagni
   (abstraction with one implementation, config nobody sets), merge
   (near-copies), split (one function doing unrelated jobs).

## 4. Refute before you report

- Every finding needs a concrete case: "this input or situation leads to this
  wrong result". **No case, no finding.**
- Re-read the lines and try to refute it first — a covering test, a nearby
  guard, a type that rules the case out. A refuted case is dropped; a
  near-refute is reported with the missing evidence named.
- A `shortcut: <limit>, <upgrade>` comment that names its ceiling is a
  decision, not a finding — unless the expected load already crosses it.
- Propose the smallest fix; prefer fixes that delete. Never add layers,
  frameworks or config the problem does not need.
- No style taste, no "consider…", no vague worries. Never review code you
  did not read.

## 5. Output

Plain English, short sentences; the reader may have never seen this code.

Start with `What this change does:` (two or three sentences), then findings
in three groups, skip empty ones:

- **Must fix:** bug, security, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication,
  code that should not exist, a plan deviation nobody explained.
- **Nice to have:** small speed-ups, shorter forms.

Number across all groups ("fix 2 and 5"). Each finding, all four parts:

2. **Orders land on the wrong day** (`billing/close_day.py:40-52`)
   - **What:** at midnight the job closes the day using the UTC server clock.
   - **Problem:** an order placed 00:30 Berlin time bills on the day before.
   - **Fix:** compute the day once in the shop's zone:
     `datetime.now(ZoneInfo("Europe/Berlin")).date()`.
   - **If skipped:** late orders show the wrong date; accounting fixes by hand.

End with **`Verdict: Ship.`** or **`Verdict: fix 1 and 3 first.`**, plus
`Lean: -<N> lines possible.` when lean findings exist and `Not checked:`
one line when something mattered and you could not check it. Acknowledge
what is genuinely good — only if it is.

Nothing found: `What this change does:`, then `Looks good. Ship.` and one
line on what you checked.

---
_Adapted for dev-flow from: DietrichGebert/ponytail (MIT), obra/superpowers
requesting-code-review (MIT), jwilger/pi-development-system reviewer (MIT)._
