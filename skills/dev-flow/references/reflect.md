> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Reflect (this project's suggestion queue)

Friction worth fixing gets parked, not complained about. One line each, real
friction only, never the same issue twice. `.dev-flow/reflections.md` holds
**this project's** items only.

| Command | Files under | Fixed by |
| --- | --- | --- |
| `flow reflect --playbook "<note>"` | `## playbook` (fix lives in `project.md`) | a docs fold flow: the `--reflections` start `flow reflect plan` prints |
| `flow reflect --code "<note>"` | `## code` (this project's code, maybe the playbook) | a patch fold flow: the `--reflections` start `flow reflect plan` prints (normal when bigger) |
| `flow reflect --plugin "<note>"` | nothing — prints the upstream recipe | a GitHub issue, filed only on the operator's word |

- `--plugin`: search first (`gh issue list --repo <dev-flow repo> --state all
  --search "<keywords>"`); an issue already answered is reported back, never
  re-filed. Body ends `— reflection from <slug> <date>`. In the dev-flow repo
  itself, plugin feedback is code.
- No flag → the wording decides and the printed line says why.
- Every row has an id, `r<n>`. It never changes and is never reused, so
  ids read off one `list` stay valid after any done, move or tidy, from this
  session or another.
- `flow reflect list` prints the queue by id; `flow reflect move <id>
  --playbook|--code` re-files; `flow reflect done <id>[,<id>…] ["<what fixed
  it>"]` checks rows off; `flow reflect tidy` moves closed rows to
  `reflections-archive.md`; `flow reflect reopen <id> ["<why>"]` brings back
  one closed by mistake, from the archive too.
- A finding the reflect worker marks `dup: r<id>` is a recurrence:
  `flow reflect --same <id> "<evidence>"` counts it on that row. Never file it
  again as a new row.
- File a finding with its evidence: `flow reflect --code "<note>"
  --evidence="<transcript file:line>"`. Whoever fixes it re-checks the claim
  there before writing a rule from it.
- `flow doctor "<observation>"` prints an investigation brief without queueing.
- The end-of-session reflection runs at finish (see [finish.md](finish.md)).

**When to suggest a fix** — only when the tool prints `⚑ fix the open
reflections now?` (an item recurred, is ≥ 14 days old, ≥ 3 playbook items, or
a code item between flows). It surfaces at finish, unbound, and in `flow
doctor` — never mid-feature. One line; the operator decides.

**Folding items in** on the operator's word: `flow reflect plan` groups the
open rows into flows (shared files make a group; playbook rows are one docs
flow), most-hit first, each with its start command. Start the flow with the
rows it fixes: `flow start fix-<topic> --patch --reflections=r3,r7`. Fix them
on the branch, and run `flow reflect defer <id> "<why>"` for any linked row
the flow won't fix. `finish` closes the others as fixed by the flow, so never
check linked rows off by hand. Rows not linked to a flow are closed with
`flow reflect done <id> "<what>"`. Never edit `reflections.md`. A fold flow
always merges unreleased on a versioned project (no release call at
Approve?, the entry goes under Unreleased) and finishes without a closing
reflection.

**GitHub issues** fold into `flow doctor` / `reflect list` when the repo has a
GitHub remote: a local row an open issue covers shows `⟷ gh#NNN` (check it off
`— filed: gh#NNN`); `~ gh#NNN may duplicate` is your call, never an auto-merge.
`DEV_FLOW_NO_ISSUES=1` turns it off.

## Roadmap (the operator's backlog)

`.dev-flow/roadmap.md` — a gitignored `- [ ]` list the operator owns. Advisory,
never gating.

- `flow roadmap` lists open items; `flow roadmap add "<feature>"` (or editing
  the file) adds one, on the operator's request.
- Handed a feature: `flow roadmap pick <n> <slug>` stamps it, then `flow start
  <slug>`; its finish checks the item off.
- Spin-off mid-flow (on the operator's word): `flow roadmap add "<title>"
  --slug=<slug> --brief=<notes>` — `flow start <slug>` later seeds the plan
  from the brief. A hand-made `.dev-flow/<slug>/plan/` is a ghost; `flow start
  <slug> --confirmed` adopts it.
- Shipped outside a flow: `flow roadmap done <n>` (several: `done 6,7` in one
  call); `flow roadmap tidy` drops checked lines. Not wanted any more (never
  built): `flow roadmap drop <n>` — `done` would claim it shipped.
- `<n>` is the row number `flow roadmap` prints: `done` leaves every other
  number in place; `drop` and `tidy` renumber, so list again after them.
