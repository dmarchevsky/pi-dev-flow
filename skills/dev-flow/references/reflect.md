> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Reflect (this project's suggestion queue)

Anything this project's playbook or code should improve (drifted commands, a
checklist that no longer fits, a script that keeps biting) gets parked, not
complained about. `.dev-flow/reflections.md` is **this project's** queue only:

- `flow reflect --playbook "<note>"` — the fix lives only in `project.md` →
  `## playbook`, fixed by a **docs flow** (`flow start fold-<topic> --docs --confirmed`).
- `flow reflect --code "<note>"` — the fix touches this project's code (maybe
  the playbook too) → `## code`, fixed by a **patch flow**
  (`flow start fix-<topic> --patch --confirmed`; a normal flow when bigger).
- `flow reflect --plugin "<note>"` — dev-flow itself. **Never written to
  reflections.md**: it prints the upstream recipe — `gh issue list --repo
  <dev-flow repo> --state all --search "<keywords>"` first (an issue the author
  already answered is reported back, never re-filed), then `gh issue create`
  with a detailed body ending `— reflection from <slug> <date>` so the fold
  matches it. File it only on the operator's word. In the dev-flow repo itself
  plugin is code, so `--plugin` files under `## code`.

Gate flags are ignored (`flow reflect "<note>" --confirmed` queues the note
alone). With no flag the wording guesses (plugin-shaped → the upstream recipe,
otherwise `## playbook`) and the printed line says why; `flow reflect list`
numbers the queue and `flow reflect move <n> --playbook|--code` re-files an
item — never hand-retype it. A legacy `## plugin` row from an older dev-flow is
flagged by `flow doctor` / `reflect list`: file it upstream and check it off
`— filed: gh#NNN`. For a note to chase **now**: `flow doctor "<observation>"`
prints an investigation brief without queueing.

- Reflect real friction only, one line each, never the same issue twice.
- **The end-of-session reflection runs at finish** (see Stage: finish): a
  `flow_stage({ op: "reflect" })` worker reviews the whole session — driver and
  every worker transcript — and the operator decides **fold or drop** per
  finding. Bare `flow reflect` prints that protocol (bound: delegate to the
  worker; unbound: review inline); the command writes nothing.
- **When to suggest fixing open items** — the tool prints `⚑ fix the open
  reflections now?` only when a rule fires: an open item **recurred** this
  session (strongest signal), an item is **≥ 14 days** old, **≥ 3 playbook
  items** (one docs flow takes them all), or a **code** item while **between
  flows**. It surfaces at finish, in an unbound session, and in `flow doctor` —
  never mid-feature. Offer it in one line; the operator decides.
- **When to suggest the tidy** — `flow reflect tidy` drops the closed (`- [x]`)
  items (the `— fixed:` note already recorded the outcome). The hint
  `↻ N closed reflection(s)` prints when **≥ 5** are closed, when closed
  **≥ open** with at least 3 closed, or when a closed item was filed **≥ 30
  days** ago — at finish, after a `reflect` write, in bare `reflect` and doctor.
- Plain `flow doctor` reviews the open items and **routes** each — `## playbook`
  → docs flow, `## code` → patch flow. To fold items in on the operator's word:
  investigate, propose the fix, get confirmation, open the routed flow and apply
  it there — project.md is editable only in a docs/patch worktree. Check items
  off in `.dev-flow/reflections.md` (gitignored, yours to edit; not
  `project.md`) with `- [x]` and a `— folded: <what>` or `— fixed: <what>` note.
- **Open GitHub issues fold into the view** when the repo has a GitHub remote: `flow doctor` and
  `flow reflect list` list them under the local queue (read-time fold — issues are never imported,
  each item keeps one home). A local row an open issue already covers carries `⟷ gh#NNN` — fold it
  by checking the row off `— filed: gh#NNN` and resolving on GitHub. Unmatched upstream rows get a
  route, but their resolution is on GitHub (close there, never in reflections.md). A
  `~ gh#NNN may duplicate` hint is your verdict to make, never an auto-merge. No GitHub remote =
  silent; missing/offline `gh` or `DEV_FLOW_NO_ISSUES=1` = one skip line.


## Roadmap (your backlog)

`.dev-flow/roadmap.md` — a gitignored `- [ ]` checklist; the operator owns the
content, you maintain and honor it. Advisory like reflections, never gating:

- `flow roadmap` lists the open items (the count is surfaced in status and
  stage context). Update on the operator's request —
  `flow roadmap add "<feature>"` or direct file edits are equally fine.
- Handed a feature: `flow roadmap pick <n> <slug>` stamps the item with the
  slug (pick is one verb — it starts nothing), then `flow start <slug>` builds
  it as a normal flow; its `flow finish` checks the item off automatically.
- Shipped outside a flow: `flow roadmap done <n>` (date-stamped by hand);
  `flow roadmap tidy` drops checked lines when history clutters the list.
