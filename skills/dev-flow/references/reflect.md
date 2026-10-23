> Part of the **dev-flow** playbook. The always-on ground rules live in
> [../SKILL.md](../SKILL.md); this file is the detail for one stage — read it
> when the session reaches that stage.

## Reflect (your suggestion queue)

Anything the playbook or plugin should improve (drifted commands, gate friction,
a plugin bug) gets parked, not complained about:
`flow reflect "<one-line note>"`; gate flags are ignored —
`flow reflect "<note>" --confirmed` queues the note alone. For a note to chase
**now**: `flow doctor "<observation>"` prints an investigation brief without
queueing. Notes land under `## playbook` or `## plugin` — the wording decides,
a note about both goes to both. The open count shows in status and stage
context; the operator decides:

- Reflect real friction only, one line each, never the same issue twice.
- **`flow reflect tidy` drops the closed (`- [x]`) items** — the `— fixed:` note has
  already recorded the outcome, so the check-off is history and the file stays
  scannable. Queueing a note, bare `reflect` and `doctor` all print the closed
  count with this verb when the pile grows; offer the tidy to the operator then.
- **Bare `flow reflect` is the end-of-session reflection** — it runs as part
  of every finish (before the slug folder is deleted — see Stage: finish) and
  whenever the operator asks. It prints the
  protocol: review the full session log (messages, tool calls, results);
  re-check each open item against the current playbook and newer dev-flow
  versions (`npm view pi-dev-flow version` vs the running version, or
  `git ls-remote` for a git-installed copy — a newer one that fixes an
  item → recommend updating the plugin, check it off); queue deduplicated new
  findings; report playbook vs plugin items structurally; ask whether to fix
  now. The command writes nothing; you execute the protocol.
- Plain `flow doctor` reviews the open items and **routes** each to the flow
  that implements it — playbook item → docs flow; plugin item → upstream issue
  (or a patch/normal flow in the dev-flow repo). To fold items in on the
  operator's word: investigate, propose the fix, get confirmation, open the
  routed flow (playbook items: `flow start fold-<topic> --docs --confirmed`)
  and apply it there — project.md is editable only in that worktree. Check
  items off in `.dev-flow/reflections.md` (your queue, gitignored, yours to
  edit; not `project.md`) with `- [x]` and a `— folded: <what>` or
  `— fixed: <what>` note.
- `## plugin` items, on the operator's go: search upstream first —
  `gh issue list --repo <dev-flow repo> --state all --search "<keywords>"` —
  an issue the author already answered (fixed or won't-fix) is reported back,
  never re-filed; no match → offer to file one (`gh issue create`; `glab issue
  create` on GitLab) with a detailed description, session evidence and a
  suggested fix; the operator confirms.


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
