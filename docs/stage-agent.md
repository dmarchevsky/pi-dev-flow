# Stage worker: a stage's work or an independent review in a disposable sub-session

A big `implement` costs more context than the rest of the flow will ever need:
the driving session carries those hundred tool calls into every later gate and
checkpoint. `flow_stage` runs that work in a fresh, disposable session
instead, and hands back one bounded report. The conversation that talks to you
stays lean — which is why non-trivial implement work is **delegated by default**,
not inlined (see `references/implement.md`). Three ops share one mechanism: `run` (a stage's work), `verify` (an
independent, check-only reviewer of the implement work) and `reflect` (an
independent review of the whole finished flow at release). Only the brief, the
toolset, the budget default and the closing contract differ — the safety story
is identical, and a second mechanism would drift.

## What delegates, what does not

`flow_stage(stage: "implement" | "pre-release", note)` runs the **work** of
the stage you are in; `flow_stage(op: "verify")` (legal only while the flow is
at implement) and `flow_stage(op: "reflect")` (at release, after
`release-done`) run the two independent reviews. Everything else stays with
the driving session:

- **every gate and every checkpoint** — the worker holds no flow tool; Approve?/
  Verified?/Release?/Finish? are still your chat, answered by you, run by the
  bound session;
- **the claim** — the driving session binds the feature and keeps the live
  claim the whole time; nothing is taken over;
- **verification** — no worker's report is a check: after a `run` the driving
  session reruns `flow check` (the worker's edits invalidated the tier-1
  records like any other edit) and still faces the normal `verify` gate. The
  **verify worker is a checker, not the gate**: its `VERIFY REPORT` PASS stamps
  the current tree and `flow verify` refuses without that stamp, but the gate
  re-runs everything itself and the operator's **Verified?** stays the
  checkpoint. Any tree edit after the PASS drops the stamp like a tier-1
  record — every fix cycle owes a fresh verify worker.

`plan` is the operator dialogue and `release`/`finish` carry the checkpoint
words — both stay in-session by design. One worker per session at a time
(`flow_stage { op: "status" }` reads the live one); sequential re-delegation is
legal and often right.

## Why an unbound worker is safe here

The guards already judge a second session by attribution, so a helper needs no
binding of its own:

- worktree writes are judged by the **owning feature's stage** — a `run` worker
  may edit and commit on the feature branch exactly while the flow allows it,
  and nothing else; `verify` and `reflect` workers hold no edit/write tool at
  all, and a check-only worker that moves the tree through `bash` anyway
  **voids its own verdict**: the tool compares `git status`, `git rev-parse
  HEAD` and the branch pointer before and after (each leg alone has a
  clean-tree bypass), a moved tree is snapshotted and the stamp never lands —
  and the PASS itself is stamped against a worktree+plan fingerprint, so even a
  later edit to the plan it was written against demotes it;
- default-branch discipline (no commit/merge/push on main) is enforced on every
  session's git calls alike;
- `.dev-flow/state.json` and `claim.json` stay flow-owned — the guard denies
  workers the edit/write tools for them and `stateTamper` refuses the direct
  bash shapes, and the worker runs no gates because its toolset holds coding
  tools only. Honest scope, same line guardrails.md draws: these are strong
  guardrails for what an agent types, **not a sandbox** — a determined wrapper
  reaching around them is a hardening decision, not a control this feature
  claims.

## The handoff

The worker receives a brief assembled by the tool. A `run` worker gets the
stage's playbook reference, `flow status --json`, live `git status` in the
worktree, the plan file, and the driving session's `note`. A `verify` worker
gets the plan, the branch diff, the tier-1 commands and the standing order
**check, don't fix**. A `reflect` worker gets the driver's own session file,
every worker transcript listed in the flow's `transcripts.log`, the plan and
live status. The note is the only channel for conversation-only context —
operator answers not yet recorded by a gate, decisions, warnings, the exact
next action. Everything else the worker re-reads from disk.

Each op closes with its bounded contract: `run` a `STAGE REPORT` (`done` /
`files` / `notes` / `blockers`), `verify` a `VERIFY REPORT` (`verdict:
pass|fail` / `findings` / `evidence`), `reflect` `[playbook]`/`[plugin]`-tagged
finding lines — and the parent digests exactly that. A worker that skips its
block is surfaced loudly (`reportMissing`), never silently trusted.

The brief also carries a standing order: **commit each completed unit of work
as you go** (one module, one file-group). If a run is ever cut, that costs one
unit — never a worktree.

## You can watch it work

The **tool card is the guaranteed surface**: every worker line (current tool +
args, last assistant line, ✓/✗ tool results, clock against budget, usage)
travels as the tool's own streamed update, so the live tail renders inside the
driver's transcript identically in the TUI and in pi-web; expansion adds the
fuller stream, the report and the transcript path. Around it, three mirrors:

- a worker is a real pi session in pi's standard session directory, named
  `⏳ stage worker · <stage> · <slug>` while it runs and `✓`/`✗ …` when it ends:
  it shows up in the pi-web sidebar and the `/resume` picker with the transcript
  rendering live as turns land (the ⏳ means live — resuming it forks it;
  browsing is safe). Every finished worker appends its transcript path to
  `.dev-flow/<slug>/stage-sessions/transcripts.log` — the durable index the
  reflect worker reads;
- the driving session's **footer** beats `⏳ stage worker mm:ss · <tool> · <slug>`
  while a worker runs (cleared when it ends);
- every line appends to `.dev-flow/<slug>/stage-live.log` — tail-able, and
  `flow_stage { op: "status" }` prints the same tail plus elapsed time, budget,
  the worktree state and recent commits, on any host, no model call.

Lifecycle is also on the bus: `dev-flow:worker-started` / `-completed` /
`-failed` events (slug, op, elapsed, usage) let other extensions react without
touching dev-flow. `pi export <file>` turns any finished transcript into
readable HTML; the tool result names the file and the export command.

## The budget, and the soft landing

One run gets `budgetMin` minutes (default 45 for `run`, 30 for `verify` and
`reflect`, clamped 5–120). At 75% of the budget the worker is not killed — it
is **steered**: “stop starting new units, finish the edit you are in, commit
everything done, close with the report”. A worker that obeys lands its work and
reports honestly (the result says so). The hard cut at the full budget is the
backstop for a worker that ignores the steer or wedges; a hard-cut run is
marked mid-stage and is an error.

Either way, **a dirty worktree is never handed back**: the tool snapshots it
(tracked *and* untracked) with a throwaway index — no WIP commit on the branch,
no touching the real index — and names the `.dev-flow/<slug>/stage-sessions/*.diff`
file to read before deciding what to keep.

## Transcripts

Session JSONL lives where pi keeps sessions (standard dir, discoverable by the
picker and `pi export`); snapshots and the `transcripts.log` index live under
`.dev-flow/<slug>/stage-sessions/` (gitignored, like all flow-owned state).

## Deliberate limits (v2)

Same model for worker and driver (a per-stage model/tool policy is a playbook
conversation for later); no delegating verify's fix loop — the checker is
fresh each cycle, the fixing stays the driver's call (inline or via a fresh
`run` worker); the worker cannot ask you anything — if it needed to, the note
was too thin.
