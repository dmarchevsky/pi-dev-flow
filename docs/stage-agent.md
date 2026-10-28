# Stage worker: one stage's work in a disposable sub-session

A big `implement` costs more context than the rest of the flow will ever need:
the driving session carries those hundred tool calls into every later gate and
checkpoint. `flow_stage` runs that work in a fresh, disposable session
instead, and hands back one bounded report. The conversation that talks to you
stays lean.

## What delegates, what does not

`flow_stage(stage: "implement" | "pre-release", note)` runs the **work** of
the stage you are in. Everything else stays with the driving session:

- **every gate and every checkpoint** — the worker holds no flow tool; Approve?/
  Verified?/Release?/Finish? are still your chat, answered by you, run by the
  bound session;
- **the claim** — the driving session binds the feature and keeps the live
  claim the whole time; nothing is taken over;
- **verification** — the worker's stage report is a handoff, never a check:
  after a worker run the driving session reruns `flow check` (the worker's
  edits invalidated the tier-1 records like any other edit) and still faces
  the normal `verify` gate.

`plan` is the operator dialogue and `release`/`finish` carry the checkpoint
words — both stay in-session by design. One worker per session at a time
(`flow_stage { op: "status" }` reads the live one); sequential re-delegation is
legal and often right. `flow verify` cannot be delegated.

## Why an unbound worker is safe here

The guards already judge a second session by attribution, so a helper needs no
binding of its own:

- worktree writes are judged by the **owning feature's stage** — the worker may
  edit and commit on the feature branch exactly while the flow allows it, and
  nothing else;
- default-branch discipline (no commit/merge/push on main) is enforced on every
  session's git calls alike;
- `.dev-flow/state.json` and `claim.json` stay flow-owned — a worker cannot
  forge a stage or a claim, and it runs no gates because its toolset holds
  coding tools only.

## The handoff

The worker receives a brief assembled by the tool: the stage's playbook
reference, `flow status --json`, live `git status` in the worktree, the plan
file, and the driving session's `note`. The note is the only channel for
conversation-only context — operator answers not yet recorded by a gate,
decisions, warnings, the exact next action. Everything else the worker re-reads
from disk.

It closes with a `STAGE REPORT` block — `done` / `files` / `notes` /
`blockers` — and the parent digests exactly that (bounded). A worker that skips
the block is surfaced loudly (`reportMissing`), never silently trusted.

The brief also carries a standing order: **commit each completed unit of work
as you go** (one module, one file-group). If a run is ever cut, that costs one
unit — never a worktree.

## You can watch it work

A worker is a real pi session in pi's standard session directory, named
`⏳ stage worker · <stage> · <slug>` while it runs and `✓`/`✗ …` when it ends:
it shows up in the pi-web sidebar and the `/resume` picker with the transcript
rendering live as turns land (the ⏳ means live — resuming it forks it;
browsing is safe). `pi export <file>` turns any finished transcript into
readable HTML; the tool result names the file and the export command.

For hosts with no live partial rendering there are two more surfaces:

- the driving session's **footer** beats `⏳ stage worker mm:ss · <tool> · <slug>`
  while a worker runs (cleared when it ends);
- every tool call appends a line to `.dev-flow/<slug>/stage-live.log` —
  tail-able, and `flow_stage { op: "status" }` prints its last lines plus elapsed
  time, budget, the worktree state and recent commits, on any host, no model call.

## The budget, and the soft landing

One run gets `budgetMin` minutes (default 45, clamped 5–120). At 75% of the
budget the worker is not killed — it is **steered**: “stop starting new units,
finish the edit you are in, commit everything done, close with the STAGE
REPORT”. A worker that obeys lands its work and reports honestly (the result
says so). The hard cut at the full budget is the backstop for a worker that
ignores the steer or wedges; a hard-cut run is marked mid-stage and is an error.

Either way, **a dirty worktree is never handed back**: the tool snapshots it
(tracked *and* untracked) with a throwaway index — no WIP commit on the branch,
no touching the real index — and names the `.dev-flow/<slug>/stage-sessions/*.diff`
file to read before deciding what to keep.

## Transcripts

Session JSONL lives where pi keeps sessions (standard dir, discoverable by the
picker and `pi export`); snapshots live under `.dev-flow/<slug>/stage-sessions/`
(gitignored, like all flow-owned state).

## Deliberate limits (v1)

Same model for worker and driver (a per-stage model/tool policy is a playbook
conversation for later); no delegating of verify's fix loop; the worker cannot
ask you anything — if it needed to, the note was too thin.
