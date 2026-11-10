# Concurrency: one session, one feature

How several agents work one repo at the same time without stepping on each other.

**One pi session = one feature** (flow + branch + worktree). A repo can host any number of
features, worked by separate sessions in parallel — that is the supported shape, not an edge
case. The binding lives with the session (persisted via session entries, restored on
resume/fork), so nothing is repo-global — and the session carries its feature's name: `flow start`
and `flow use` rename the pi session to the slug (overwriting any previous name), so the session
picker always says which feature a session holds. A session binds **explicitly, never automatically**:
`flow start` binds its own feature, `flow use <slug>` takes one over — even the lone unfinished
feature waits to be claimed. Every bind leaves a claim (`claim.json`, session + pid),
and the gates honor the claim too — `flow abort` included, so the verb that erases a feature cannot
erase one a live session is working. The claim file is as guarded as `state.json`: neither the write
tools nor bash may change or delete it — a lock is not unlocked by whoever it locks out.
passing another session's slug to `flow approve`/`verify`/`finish` is refused until you take over,
or two sessions quietly overwrite one state file. `flow use <slug>` switches, and ambiguous sessions must
bind or pass explicit slugs. With nothing unfinished and no binding, the session must start a
flow — work does not happen outside the flow.

**A claim dies with its session, not with its process.** Hosts like pi-web run many sessions inside
one long-lived Node process, so the pid on a claim says nothing about whether its holder still
exists — `session_shutdown` releases the dead session's binding and every claim it held, and a
restored session (reload, resume, fork) reclaims what its own branch history says it holds. A claim
key names the identity it came from: `sid:<session id>` when pi provides one, `cwd:<directory>`
when the host hands out none — and in that second case every session in that directory shares one
binding, so `flow status` prints the key and says so instead of leaving a shared binding to be
guessed from a path. Dev-flow keeps no per-process session state beyond that keyed map, released on
shutdown; the one other process-wide cache (`compile()` in `src/core.ts`) holds flag-less regexes,
which carry no mutable state to leak between sessions.
**One dev stack, several flows.** A dev deploy is machine state, not branch state, so `flow verify`
keeps a small registry (`.dev-flow/dev-ports.json`: port → slug, commit, time) and `flow status` prints
it (`dev: port 8090 → <slug> @ <sha>`). Before deploying, verify checks whether its port was last
deployed by **another live flow**. If so it does not deploy: it returns `NEEDS-OPERATOR Dev port?` with
who holds the port (stage, commit, age), the available RAM and free disk against the playbook's
`instanceMem` / `instanceDisk`, and the options — run alongside on the next free port
(`flow verify --port=<n>`), replace that deploy (`--replace`), or wait. Running alongside is offered
only when the playbook allows it (`parallelDev` is not `no`, `dev`/`health` read `$DEV_FLOW_PORT`) and
the resources fit. `--port=<n>` and `--replace` are the operator's answer, so they bind like
`--confirmed` (gh#203): a re-run carrying either before the operator has sent a message since
`Dev port?` was asked is refused. A finished or aborted flow holds no port. `flow finish` stops a flow's
non-default-port instance with `devDown`.

**The review is of the tree that ships.** Parallel flows release while others are still implementing,
so `flow verify` rebases a branch that fell behind the default branch before it deploys for review,
and `flow verify --confirmed` refuses if the default branch moved again before the answer.

Enforcement is by attribution: a write inside worktree X is judged
by X's own feature stage no matter which session touches it; main-checkout code stays closed
while your bound feature is in `plan`/`implement` and while any feature is unbound-and-ambiguous.
