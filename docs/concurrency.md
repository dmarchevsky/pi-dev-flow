# Concurrency: one session, one feature

How several agents work one repo at the same time without stepping on each other.

**One pi session = one feature** (flow + branch + worktree). A repo can host any number of
features, worked by separate sessions in parallel — that is the supported shape, not an edge
case. The binding lives with the session (persisted via session entries, restored on
resume/fork), so nothing is repo-global. One unfinished feature binds automatically and the
single-session case needs no ceremony — unless a **live** session already works that feature:
every bind leaves a claim (`claim.json`, session + pid) and auto-bind refuses foreign features,
so a second session must `flow use <slug>` to take over — and the gates honor the claim too:
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
Enforcement is by attribution: a write inside worktree X is judged
by X's own feature stage no matter which session touches it; main-checkout code stays closed
while your bound feature is in `plan`/`implement` and while any feature is unbound-and-ambiguous.
