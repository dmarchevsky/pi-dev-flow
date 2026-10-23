---
name: flow-audit
description: >
  Read-only quality audit of a whole repo (or a named subtree): bugs, security
  holes, what breaks under real load, risky code without tests, slow paths,
  and what to delete/merge/split. Ranked report, changes nothing. Use for
  "audit this codebase", "review the whole project", "find bloat",
  "what can I delete".
---

# flow-audit

Audit the repo like the senior engineer who just inherited it and will be
paged when it breaks. Order of importance: **correct, safe, holds under load,
tested, fast, lean.** One-shot report; change no files, mutate no git state.

## 1. Map first

- Audit what the operator names: a folder, a package, a subsystem. Nothing
  named: the whole repo.
- Read the README, build and deploy config, the dependency list, the entry
  points (main, routes, handlers, jobs, CLI) and the tests.
- Find the expected load: one person on a script, or many users and
  processes at once. Judge scale against that; say which load you assumed.
- Trace the main flows end to end — input from users, money, auth, data
  writes, background jobs, anything shared between processes. Read those
  paths fully.
- Big repo: go deep where a mistake costs the most, not file by file, and
  name the parts you did not read.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge (empty, zero, last item,
   rounding, time zones), callers that disagree with what a function
   returns, the same rule implemented differently in two places.
2. **Risk:** injection, weak randomness, secrets in code, missing checks on
   user input; data loss (swallowed errors, writes in the wrong order, no
   transaction).
3. **Scale:** check-then-write races, the same work redone by every process,
   unbounded growth, a query per item, O(n²) on real input, per-process
   state that must be shared.
4. **Missing test:** risky logic with no test that fails when it breaks.
   One good test, not coverage.
5. **Speed:** big slowdowns are findings; small wins are suggestions.
6. **Lean:** delete (dead code, unused options/flags/config, speculative
   features), reuse (two helpers doing one job — keep one, name the path),
   stdlib/platform/installed-dep doing it already, yagni (interface with one
   implementation, pass-through wrapper), merge (near-copies), split (one
   function or class doing unrelated jobs — split by job, never by line
   count).

## 3. Refute before you report

- Every finding needs a concrete case: "this input or situation leads to
  this wrong result". **No case, no finding.**
- Before calling code unused, grep the whole tree — tests, fixtures, config,
  dynamic and string references included.
- Try to refute each finding first (a guard, a covering test, a type); drop
  what refutes, report near-refutes with the missing evidence named.
- A `shortcut: <limit>, <upgrade>` comment naming its ceiling is a decision,
  not a finding — unless the expected load already crosses it.
- Propose the smallest fix; prefer fixes that delete. No style taste, no
  "consider…", no vague worries.

## 4. Output

Plain English, short sentences; explain a technical term on first use.

Start with `What this repo does:` (two or three sentences) and the load you
assumed. Then findings in three groups, most important first, skip empty:

- **Must fix:** bug, security, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication,
  code that should not exist.
- **Nice to have:** small speed-ups, shorter forms.

**At most 20 findings**, numbered across groups ("fix 2 and 5"); if smaller
ones were left out, say how many. Each finding, all four parts:

2. **Orders land on the wrong day** (`billing/close_day.py:40-52`)
   - **What:** at midnight the job closes the day using the UTC server clock.
   - **Problem:** an order placed 00:30 Berlin time bills on the day before.
   - **Fix:** compute the day once in the shop's zone:
     `datetime.now(ZoneInfo("Europe/Berlin")).date()`.
   - **If skipped:** late orders show the wrong date; accounting fixes by hand.

End with **`Verdict:`** one line (healthy, or what to fix first),
`Lean: -<N> lines, -<M> dependencies possible.` when lean findings exist,
and `Not checked:` the parts you did not read or could not run.

Nothing found: `What this repo does:`, then `Healthy. Nothing to fix.` and
one line on what you checked.

---
_Adapted for dev-flow from: DietrichGebert/ponytail (MIT),
jwilger/pi-development-system reviewer (MIT)._
