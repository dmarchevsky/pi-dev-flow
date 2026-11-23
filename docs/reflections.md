# Reflections: the agent's notes to you

When something costs the agent a step, it writes the problem down instead of quietly working
around it. Examples: a playbook command that no longer exists, a guard that blocked the wrong thing,
or a gate that forced a detour. That is how your playbook stays in sync with your project.

Reflections are advisory. They never block a gate, and nothing is fixed without your word.

## Where notes go

`.dev-flow/reflections.md` is your project's queue. It has two sections:

| Section | The fix lives in | Fixed by |
|---|---|---|
| `## playbook` | `.dev-flow/project.md` | a docs flow |
| `## code` | your project's code | a patch flow |

**Feedback about dev-flow itself never goes into your project.** It becomes a GitHub issue on the
dev-flow repo, filed only when you say so.

| Command | Does |
|---|---|
| `flow reflect --playbook "<note>"` | adds a playbook note |
| `flow reflect --code "<note>"` | adds a code note |
| `flow reflect --plugin "<note>"` | prints how to file a dev-flow issue (search first, then `gh issue create`); writes nothing |
| `flow reflect "<note>"` | guesses the section from the wording and says why |
| `flow reflect --code "<note>" --evidence="<file:line>"` | adds a note with the transcript line that shows it |
| `flow reflect list` | lists the open notes by id (`r<n>`). An id never changes and is never reused. |
| `flow reflect plan` | groups the open notes into flows, most-hit first, each with its start command |
| `flow reflect --same <id> "<evidence>"` | counts a recurrence on an existing note instead of adding a copy |
| `flow reflect move <id> --code` | moves a note to the other section |
| `flow reflect done <id> "<what>"` | checks a note off as fixed. `done r3,r4,r7 "<what>"` closes several at once; one bad id closes none. |
| `flow reflect reopen <id> "<why>"` | reopens a note closed by mistake, from the archive too |
| `flow reflect tidy` | moves the checked-off notes to `reflections-archive.md` |
| `flow start <slug> --reflections=r3,r7` | links notes to the flow that fixes them. `finish` closes them, except any the flow left open with `flow reflect defer <id> "<why>"`. |

`flow status` and `flow doctor` show how many notes are open.

## The closing review at finish

Before `flow finish` removes anything, a fresh read-only reviewer reads the whole session: the main
transcript and every worker's. It checks the findings against the open notes and the upstream
issues, then gives you a numbered list. Each finding is marked docs, code or plugin, with a
suggestion to **fold** (keep) or **drop** it.

Finish files the reviewer's own recommendation for each finding, without asking: a fold records a
note (or counts a recurrence on the note it duplicates), a drop records nothing. The output lists
each one with how to undo it (`flow reflect done <id> "dropped"`, or `flow reflect --playbook|--code
"<note>"` to keep a drop). A plugin finding outside the dev-flow repo is an upstream issue, which is
public, so it's named for you to file and never filed by the gate. Set `finish = always` in
`## release` to answer fold/drop yourself, for example `fold 1,3 drop 2`.

The review is skipped when the flow ran into no friction: no guard block, no gate refusing for a
process reason (wrong stage, a missing plan, a proof that doesn't hold), no gate refusing twice in a
row, no code change after Verified?, and no `--note`. A failing test or build is not friction by
itself: finding it is what the checks are for. Set `reflect = always` in the playbook's `## release` section to run it every time. Only
your explicit `--no-reflect` skips it; *yolo* doesn't. A fold flow (started with `--reflections`) never runs it: it fixes notes, it doesn't review for new ones.

## Nudges

The agent suggests working through the notes only at good moments: at finish, between flows, or in
`flow doctor`, and never in the middle of a feature.

- **"Fix the open reflections now?"** appears when a note came up again this session, a note is 14
  days old, three playbook notes could share one docs flow, or a code note is waiting while you're
  between flows.
- **"Tidy?"** appears once 5 notes are closed, closed notes outnumber open ones, or a closed note is
  a month old.

To fix them, ask the agent to go through them, usually with `flow doctor`. It sends each note to the
flow that should fix it: playbook notes to a docs flow, code notes to a patch flow.

## GitHub issues alongside

If the repo has a GitHub remote, `flow doctor` and `flow reflect list` also show open GitHub issues
next to your notes:

- a note that an open issue already covers is marked `⟷ gh#120`;
- the other issues are listed below as upstream rows;
- a possible duplicate is flagged (`~ gh#NNN may duplicate`), never merged automatically.

This view is display-only. Issues are closed on GitHub and notes are checked off in the file. If
`gh` is missing or fails, you get one line saying so. Set `DEV_FLOW_NO_ISSUES=1` to turn the view
off.
