> Part of the **dev-flow** playbook. Ground rules: [../SKILL.md](../SKILL.md).

## Reflect (this project's suggestion queue)

Friction worth fixing gets parked, not complained about. One line each, real
friction only, never the same issue twice. `.dev-flow/reflections.md` holds
**this project's** items only.

| Command | Files under | Fixed by |
| --- | --- | --- |
| `flow reflect --playbook "<note>"` | `## playbook` (fix lives in `project.md`) | a docs flow: `flow start fold-<topic> --docs --confirmed` |
| `flow reflect --code "<note>"` | `## code` (this project's code, maybe the playbook) | a patch flow: `flow start fix-<topic> --patch --confirmed` (normal when bigger) |
| `flow reflect --plugin "<note>"` | nothing — prints the upstream recipe | a GitHub issue, filed only on the operator's word |

- `--plugin`: search first (`gh issue list --repo <dev-flow repo> --state all
  --search "<keywords>"`); an issue already answered is reported back, never
  re-filed. Body ends `— reflection from <slug> <date>`. In the dev-flow repo
  itself, plugin feedback is code.
- No flag → the wording decides and the printed line says why.
- `flow reflect list` numbers the queue; `flow reflect move <n>
  --playbook|--code` re-files; `flow reflect done <n> ["<what fixed it>"]`
  checks one off; `flow reflect tidy` drops closed items.
- `flow doctor "<observation>"` prints an investigation brief without queueing.
- The end-of-session reflection runs at finish (see [finish.md](finish.md)).

**When to suggest a fix** — only when the tool prints `⚑ fix the open
reflections now?` (an item recurred, is ≥ 14 days old, ≥ 3 playbook items, or
a code item between flows). It surfaces at finish, unbound, and in `flow
doctor` — never mid-feature. One line; the operator decides.

**Folding items in** on the operator's word: investigate, propose, confirm,
open the routed flow and apply it there (`project.md` is editable only in a
docs/patch worktree), then `flow reflect done <n> "<what>"` once merged.

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
- Shipped outside a flow: `flow roadmap done <n>`; `flow roadmap tidy` drops
  checked lines. Not wanted any more (never built): `flow roadmap drop <n>` —
  `done` would claim it shipped.
