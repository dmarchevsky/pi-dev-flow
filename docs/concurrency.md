# Concurrency: several sessions, one repo

**One Pi session = one feature = one branch and worktree.** A repo can have as many features in
flight as you like, each in its own session. This is the normal way to use dev-flow, not an edge
case.

## Binding

- A session binds to a feature only when you say so: `flow start <slug>` for a new one, or
  `flow use <slug>` for an existing one. Even a lone unfinished feature waits to be claimed.
- Binding renames the session after the slug, so the session picker shows which feature it holds.
- The binding survives reload, resume and fork.
- With nothing bound and nothing unfinished, the session has to start a flow. Work doesn't happen
  outside a flow.

## Claims

- Each bind writes a claim (`claim.json`). Gates, including `flow abort`, refuse a feature that
  another live session has claimed. `flow use <slug>` takes it over explicitly.
- The agent can't edit or delete a claim, just like `state.json`.
- **A claim ends with its session, not its process.** Hosts like pi-web run many sessions in one
  process. So dev-flow releases a session's claims when that session shuts down, and a resumed
  session reclaims what it held.
- If the host gives sessions no id, all sessions in a directory share one binding.
  `flow status` says so.

## Who may write where

A write inside worktree X is judged by X's own stage, whichever session makes it. Sessions can't
dirty each other's branches or borrow each other's approvals. The main checkout's code stays closed
while your feature is at plan or implement.

## Sharing one dev stack

A dev deploy is machine state, not branch state, so `flow verify` keeps a small registry in
`.dev-flow/dev-ports.json` (port → slug, commit, time). `flow status` shows it.

If the flow holding your port is already past its **Verified?** (at pre-release or release, and not
re-asking it), nobody is reviewing that deploy, so verify replaces it and says so. If the holder is
still being reviewed or still in implement, verify doesn't deploy. Instead it asks
**Dev port?**, showing who holds the port and how much RAM and disk are free, and offers:

- **run alongside** on the next free port (`--port=<n>`). This needs `parallelDev` not set to `no`,
  `dev`/`health` using `$DEV_FLOW_PORT`, and enough resources;
- **replace** that deploy (`--replace`);
- **wait**.

`--port` and `--replace` count as your answer, so the agent can only use them after you reply.
Finished and aborted flows hold no port. `flow finish` stops an extra-port instance with `devDown`.
Playbook setup is in [playbook → Dev port](playbook.md#dev-port-and-parallel-flows).

## Reviewing what will ship

Parallel flows release while others are still working. So `flow verify` rebases a branch that fell
behind main before deploying it for your review. `flow verify --confirmed` refuses if main moved
again before you answered.
