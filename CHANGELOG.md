# Changelog

Format: newest first. `Unreleased` collects what's merged but not yet tagged.

## [Unreleased]

### Changed

- **Repo dogfood of `/flow-simplify`, shipped as a patch**: dropped the one dead import `tsc --noUnusedLocals` reports repo-wide (`unreleasedBody` in `test/core.test.ts`), and collapsed the thrice-duplicated yolo-word intake — the byte-identical `--yolo` acceptance block and its error string in the verify, release and finish gates — into one `takeYoloWord` helper, so the operator-word wording lives in one place. Also committed the `package-lock.json` version fields `npm install` rewrites in every worktree since the 0.64.1 bump left them unsynced.

## [0.64.1] - 2026-10-24

### Changed

- **Whole-repo `/flow-simplify` pass on dev-flow itself.** A full simplification sweep (dead-code hunt with grep + semantic confirmation, sliding-window duplication scan across `src/` and `extensions/`) found a lean codebase and three honest cuts: the `STAGES` constant in core was a zero-reference export (stage order lives in the state transitions and `MD_STAGES`), and `changelogEntry`/`MergeStyle` were imported by files that never used them (tsc `--noUnusedLocals`-confirmed). The one real duplication — the recorded `seedData` step written twice, once in the verify deploy probe and once in `flow health` — now lives in a single `seedStep` helper; as a side effect `flow health` names the seed command in its failure message the way verify always did. Cross-file duplicate blocks of four or more lines: none found; the one remaining structural weight (`runFlow`'s size) is an architecture reshuffle left for its own flow.

## [0.64.0] - 2026-10-24

### Fixed

- **Reflections land where they are filed, and `flow doctor` reads the file.** The `## playbook` / `## plugin` section was a keyword guess, and it was re-guessed on every surface instead of being read back: `reflectionRoutes` classified the whole item line, ` — <slug> <date>` tail included, so one slug full of trigger words (`fix-versioning-guard` = "versioning" + "guard") made **every** open item read as `playbook+plugin` and routed every fix — a drifted project command included — to "file an issue against pi-dev-flow upstream". Meanwhile the heading the note actually sits under, which `appendReflection` has treated as authoritative since #69, was flattened away by the reader, so doctor's table argued with the file it had just read. Open items now come back from one section-aware reader that carries its heading, routing labels from that heading, and the classifier only ever sees the note body — an item's verdict can no longer change because of what its slug spells. A note that describes dev-flow without saying one of the old magic words also stopped being misfiled quietly: dev-flow's own commands and files (`flow doctor`, `.dev-flow`, `state.json`, gate/guard, worktree) are high-precision plugin signals, so "doctor prints the same finding twice" is a plugin item now, while "the deploy gate in CI is flaky" and "our repo's commit hook rejects rebases" stay the project's own business.

### Added

- **`flow reflect --playbook|--plugin "<note>"` — you file it, the tool does not guess.** The session-reflection protocol tells the agent to decide playbook-or-plugin for every finding, and then the tool re-guessed from the sentence. An explicit flag now wins, and a note queued without one prints the guess and its reason — `reflected (plugin — "gate" names dev-flow itself)`, `reflected (playbook — nothing plugin-shaped in the note — if it is a dev-flow bug: flow reflect move <n> --plugin)` — so a wrong filing is visible at the moment it is filed instead of months later in a queue nobody re-reads. `--both` stays for a genuine two-ticket note (it then gets one route per section).
- **`flow reflect list` and `flow reflect move <n> --plugin|--playbook`.** The queue numbered (same convention as `flow roadmap`), and one command to re-file an item under the other heading — correcting a misfile used to mean hand-editing markdown and hoping the next rewrite kept it where you put it. An item outside both sections (a legacy flat line, or under a `## Plugin notes` heading nobody recognises) is reported by `flow doctor` instead of silently inheriting the previous bucket on the next write.

### Changed

- **A both-shaped note has one home.** When both keyword sets matched, the note was written under *both* headings — the operator checked the same issue off twice, and only the plugin half was ever routed (`reflectionRoutes` returned one route and picked the plugin branch first). A guess now picks a primary section (plugin on a strong dev-flow signal, otherwise the playbook, where the operator notices and moves it), and the printed line names the reason.

## [0.63.0] - 2026-10-24

### Added

- **`/flow-simplify` — the review skill that actually cuts.** `/flow-review` and `/flow-audit` only report; the new third sibling edits: dead code, no-op placeholder subsystems, misplaced dev scaffolding, genuine duplication (reuse the existing helper before inventing one) and speculative abstractions, removed in a risk-ascending order with the safe levers first. The rails are the feature: a green baseline before any cut (red → stop), behavior-preserving only — a test touched to pass is a reverted cut, Chesterton's fence for anything you cannot explain, semantic dead-code tooling with grep demoted to confirmation, one cut → checks → commit so every regression names its cut, and a structural-vs-cheap self-audit that forces the skill to admit when it shrank the number instead of the system (reformatting, comment-trimming-as-strategy and counted-path moves are named as gaming). Deleting a feature is always escalated, never done. Default target: what you name, else the bound flow's branch diff — whole-repo stays `/flow-audit`'s job. Adapts maxim-saplin/goal-sloc (MIT), addyosmani/agent-skills code-simplification (MIT) and Anthropic's code-simplifier plugin (Apache-2.0).

## [0.62.2] - 2026-10-24

### Added

- **The plan stage now lands its spec on disk early.** Step 2 told agents to draft only after the direction is confirmed, and many read that as "hold the discussion in the conversation and write `plan/plan.md` at the end, just before Approve?" — when pi auto-compacts mid-stage, undrafted plan discussion is gone before the implement stage ever sees it (hit on a live flow). The plan-stage reference now says: create `plan/plan.md` the moment the direction is confirmed — don't wait for the finished plan — and let the rest of the discussion land as in-file amendments, because the gate reviews the file, not the memory (#116).

## [0.62.1] - 2026-10-24

### Fixed

- **The release-done version-skew warning is now self-contained.** When the release gate passed unstamped but `flow release-done` found the session behind the checkout, the warning said only "this session runs dev-flow X, not the build the disk ships" — naming no second version and no second source, so it was not actionable where it printed (`flow status` said the pair; the release output did not). It now prints both versions — `this session runs dev-flow X, <this checkout|the dev-flow install> ships Y` — and appends the two-copies warning when another dev-flow copy is registered in the process, since that duplicate was the real source of the reported confusion (#117).

## [0.62.0] - 2026-10-24

### Added

- **A bound session wears its feature's name.** `flow start` and `flow use` now rename the pi session to the flow slug (pi's public `setSessionName` API), so the session picker always says which feature each session holds — the missing surface of one-session-one-feature: the footer, the branch and the worktree already named the feature, the picker named nothing. A previous name (pi's auto-title or a hand-set `/rename`) is overwritten — under the flow's model the slug *is* the session's identity; unbind (`abort`/`finish`) keeps the name as the trace of what the session held. The rename rides the binding seam and stays a courtesy: a host without the naming API degrades to a silent no-op and cannot fail a gate, and re-binding the slug a session already carries writes nothing.

## [0.61.1] - 2026-10-23

### Changed

- **The newest dev-flow copy judges the guards alone.** When one process runs several copies (the documented two-sources situation — a checkout's own `pi.extensions` manifest beside the npm install is the common one), every copy's event hooks now run an election first: a copy with a lower registered version answers nothing — no guard vetoes, no context injection, no footer, no compaction takeover. Stale code judging alongside fresh was the real hazard the two-sources warning hinted at: on a 22-hour-old pi-web server a 0.57.0-era copy blocked tool calls beside the current one, and nobody could say which copy answered. Node cannot unload a loaded module and pi cannot unregister its hooks, so silence is the most in-package removal can be — only a host restart drops the stale code, and the warnings now say so. Equal versions both judge; a copy whose version cannot be read is never outranked; gate tool handlers stay live on every copy (the host dispatches those per session, and the stale-build warnings already cover them).

### Fixed

- **The duplicate-copy warning names its speaker** — `this call served by <dir> (v); this copy is the newest and judges the guards` (or admits it is the older one and stays silent) — and the stale-build notes across `start`, `status` and `version` tell the truth about what fixes skew: `/reload` re-binds session state, but in a shared-process host (pi-web) only restarting the host swaps loaded code; docs/development.md and the README's two-sources section now say the same. Proven on the live server: a working-tree stamp frozen at 0.57.0 survived a day of reloads while the checkout shipped two versions.

## [0.61.0] - 2026-10-23

### Fixed

- **A green now belongs to the tree it ran against.** Every recorded check carries a fingerprint of its worktree — `status --porcelain`, a hash of the uncommitted diff, and HEAD — and `verify`/`release` drop records the tree has outgrown before deciding what is pending, then rerun them at the gate and say so (`stale record(s) rerun after a worktree change: …`). Edits through the edit tools already cleared records at once, but a write through bash — `sed -i`, a formatter, codegen — fires no hook, and the whole #84 sequence (check green, a bash-side fix, `verify`) rode a PASS measured against code that no longer existed. A commit after the check now re-proves at the gate too, so a green standing at a gate means the committed state. A record with no fingerprint (older build, or git could not answer) is never proven stale — the same measurement-failure stance as `commitsAhead`.
- **The delete guard reads absolute paths.** `rm -rf /abs/repo/.dev-flow/<slug>` deleted a feature — plan included — while the relative form was refused: `DF_FOLDER` demanded whitespace or a quote before `.dev-flow`, and absolute paths are the shape harnesses hand the agent. The boundary now accepts `/` too; quoted prose stays prose (the masked-payload exemption, #53, survives).
- **`flow abort` honors a live claim, and `claim.json` is now guarded.** Every gate refused another session's in-flight feature — except the one verb that deletes the whole feature: an unbound or other-session abort could erase a plan-stage directory while its owner was still writing it. The claim now locks `abort` exactly as it locks the gates (`flow use` remains the only takeover), and `claim.json` joins `state.json` as flow-owned in both guards — a lock is not unlocked by whoever it locks out.
- **`writeGuard` judges where the bytes land, not where the path points.** A symlink inside the worktree laundered a write anywhere: the stage rules compared lexical strings, so a worktree symlink into the main checkout passed a main-checkout write as confined — while `guardPath` had resolved the same symlink through realpath all along. The target, the feature worktrees and `.dev-flow` are now compared as realpaths (`realAbs`), and a symlinked escape gets the refusal its real target deserves.

### Changed

- **The UI plan hint names its file instead of eating it.** With `--ui`, the hint's mockup clause replaced the sentence's tail, leaving "write the plan into .dev-flow/<slug>/plan/" pointing at a directory; it now reads `plan/plan.md` and appends the mockup clause. Approval always demanded a real file — the hint just stopped saying so.
- **`buildConfig` leaves production code.** Nothing at runtime has built a `Config` from a raw object since `project.md` became the only config source — the tests keep the shorthand as a test helper. `getPath` (dead once the `project.json` loader was gone) and `gitInvocation`'s unused top-level last-cd-wins `dir` (the guard judges each segment's own dir) were deleted with it.

## [0.60.0] - 2026-10-23

### Changed

- **dev-flow is fully dormant until the playbook exists — and fully present after.** *Initiated* now means exactly one thing: `.dev-flow/project.md` (written by `flow init`) exists. Until then a folder hears nothing at all: no context injection, no footer, and no guards — the stage discipline, main-branch git rules and the bash-timeout refusal and its silent arming included (`flow init` is the opt-in; a stray `.dev-flow/` without the playbook keeps the folder asleep), and every gate verb but `flow init`/`flow version` says so plainly instead of half-running. Once initiated, the footer never goes silent: bound sessions see the stage glyph + slug as before, unbound ones the `⧖ N flow(s) open` count, and a repo with nothing in flight now shows `⧖ no flows` instead of nothing — you can see dev-flow is watching. The footer also repaints at the **start** of every agent run, not just at session start and turn end: `setStatus` is a fire-and-forget push in pi-web, and run start is the earliest moment a late-attaching web client is certainly listening (a push the browser missed before attaching could leave the bar blank until the next gate).

## [0.59.1] - 2026-10-23

### Fixed

- **A session running an older dev-flow build than the checkout now says so — including in the dev-flow repo, where it never could.** `flow start` carried a behind-the-checkout warning and `flow release` carried the update-or-proceed question, but both compared the loaded build against `pluginVersion(import.meta.dirname)` — the `package.json` sitting beside the running code, which is the same file `loadedVersion()` reads — so the comparison was X against X and only the `DEV_FLOW_LOADED_VERSION` test seam ever made it unequal. A session that loaded 0.54.0 while this checkout already shipped 0.58.1 started, released and finished looking current, and the gate proofs shipped in between silently did not run. `checkoutBuild(root)` now answers what the disk says to run: this checkout's own manifest in the dev-flow repo, the installed package's everywhere else. `start`, `status`, `version`, `release` and `release-done` read it, the stamp in `state.json` records the build that actually ran rather than the one the disk claims, and `flow version` names the directory the stale code lives in. The stale release question stays a question — an operator who ships from behind is a choice, never a block.
- **Scratch outside the checkout is stage-free.** With a flow bound at `implement` or `pre-release`, the write guard refused every path that was not the worktree or `.dev-flow/` — `/tmp/split_skill.py` included — so an agent doing a mechanical multi-file rewrite had nowhere to keep a throwaway script and learned to park junk inside the checkout instead. A path whose realpath is under the OS temp dir is now allowed at every stage and with no flow bound, checked after the dev-flow-owned refusals and after per-path owner attribution, so neither a symlink out of the temp dir nor a `worktreeDir` an operator parked there reaches those rules; a repository that merely lives under the temp dir (every smoke-test repo) keeps the stage rules untouched. The refusal that remains names the temp dir as its own way out.

## [0.59.0] - 2026-10-23

### Added

- **The playbook's ground rules are now handed to the session, not left waiting to be read.** Pi lists a skill's name, description and path and loads the file only if the model chooses to — so a session could open in a dev-flow repo having never seen the rules the guards enforce, guess at a checkpoint, and then argue with the refusal that followed. `skills/dev-flow/SKILL.md` now carries a marker-delimited **core**: flow-is-a-tool-not-a-shell-command, you-run-the-gates with the checkpoint verbs and yolo, binds are explicit, `state.json` and `project.md` are read-only, project `flow-guard` rules outrank flow, the bash `timeout` rule, `flow abort` for abandonment. The extension extracts that block and appends it to the hidden `[dev-flow]` line it already writes — **once per session**: a `dev-flow-skill` entry records the injection so a reload, resume or fork does not pay the ~1k tokens twice; a compaction that summarizes it away re-arms exactly one re-injection, recorded on the branch as well as in memory, so a session that survives a compaction as a reload gets the rules back instead of quietly running without them; a branch rewound or forked past the injection gets them back too. A copy shipped without its `skills/` directory, or a skill whose markers were damaged, leaves every message exactly as it was — the extractor returns nothing rather than throwing inside a guard hook — and `package.test.ts` refuses a core over 4,000 characters, because that budget is what every session in a dev-flow repo pays.

### Changed

- **The rest of the skill is one file per stage, and each stage names its own.** The stage detail moved verbatim into `skills/dev-flow/references/{start,plan,implement,pre-release,release,finish,reflect}.md` (SKILL.md: 25,817 → 5,085 chars), and a bound session's stage turn now ends with the absolute path of the one file its stage needs (`…/references/plan.md` at plan), so the model reads a 3k-char stage brief instead of either guessing what a gate wants or hauling the whole playbook into context. pi never advertises the reference files — only `SKILL.md` registers as a skill, and a directory holding one is not scanned deeper — and the tests keep both halves honest: every stage has a file, the map in `SKILL.md` names every file, and `release.md` hands over to `finish.md`, because the state machine has no finish stage that could name it.

## [0.58.1] - 2026-10-23

### Fixed

- `flow finish` now closes with a prompt to **re-read `flow status` before reporting open flows** — a sibling feature finished while a session was running, and the agent reported the session-start status, naming the shipped flow as open while the footer count was already correct. A stale after-finish report can no longer mislead the operator about what is still in flight.

## [0.58.0] - 2026-10-23

### Added

- **Bundled review skills — dev-flow now ships its own code review, no companion plugin needed.** `/flow-review` reviews a change (default: the bound flow's branch diff against the default branch, plus uncommitted work) as a read-only senior-engineer report — correct, safe, holds under load, tested, fast, lean — judged also against the feature's `plan/plan.md`; every finding must carry a concrete triggering case (refute-before-report), grouped Must fix / Should fix / Nice to have, with a verdict and a `Not checked:` line. `/flow-audit` audits the whole repo in the same style: map first, expected-load assessment, at most 20 ranked findings, changes nothing.
- **Built-in implement-stage senior discipline**: when the playbook sets no `prose.implement`, the stage guidance injected each turn now carries a compact writing-discipline block (smallest complete change, no speculative abstraction, finish what your change breaks, failing-first test for risky logic, `shortcut:` markers for deliberate deferrals); operator prose still replaces it wholesale. The injected line names its source (`project.md` vs `dev-flow default`).

### Changed

- The pre-release review step defaults to `/flow-review` (was `/ponytail-review` — dev-flow no longer assumes the ponytail plugin; `release.review` remains operator-settable). The review rules adapt ponytail, obra/superpowers and jwilger/pi-development-system (all MIT), credited in the skill files.

## [0.57.1] - 2026-10-23

### Removed

- **The dogfood shim is gone — one global dev-flow copy is the only source.** `.pi/extensions/dev-flow.ts`, the committed one-line re-export that made every session in this checkout load the working tree, was itself a second registered extension beside the global npm install — the exact two-sources hazard the README warns about (pi dedupes extensions by path, not by package), and the copy `flow version` had started naming in this very repo. Sessions here now load the single global install (`pi update --extensions` reconciles it after a release, `/reload` carries it into a running session); `pi -e .` stays the explicit way to dogfood the working tree. The `flow doctor` probe that demanded the shim, its test, and the `development.md` dogfood paragraph were removed with it.

## [0.57.0] - 2026-10-23

### Changed

- **The footer now tells the truth about bindings: a slug only when bound, a count when not — and nothing binds itself anymore.** The status bar rendered only for a session's bound feature, so an unbound session saw a blank footer however much work was in flight — and `boundFeature` made that blank worse than it looked: with exactly one unfinished feature it silently auto-bound *and claimed* it, so merely opening a new session steered the lone feature nobody handed it. Sessions now bind **explicitly and only** — `flow start` binds its own feature, `flow use <slug>` takes one over; `boundFeature` lost its lone-feature fallback and its claim-writing side effect, and slugless gates answer `nothing bound — flow use <slug> or pass an explicit slug (unfinished: …)` instead of quietly picking the one left. The unbound footer reads `⧖ N flow(s) open` — the count of unfinished features, never a slug, no `⚠️` (the failing-check marker stays the bound flow's own signal); with nothing unfinished the footer stays clear, and rendering stays a pure read that can never claim anything. `flow status --json`'s `current` follows the same rule — only a bound session has a current feature — and the guardrails, concurrency and headless docs plus the skill teach the explicit-bind model (`flow use <slug>` is now the *only* way onto a feature, not the takeover of an auto-bind).

## [0.56.0] - 2026-10-22

### Added

- **`flow reflect tidy` drops the closed reflections.** Checking items off was the end of their story — the `- [x]` lines just piled up in `reflections.md` while every surface counts only open ones, so the checked-off history was invisible weight the agent kept walking past. Now the verb mirrors `roadmap tidy`: it deletes every `- [x]` item (the `— fixed:` note has already recorded the outcome), leaves the preamble and the open lines verbatim, and drops a `## playbook`/`## plugin` heading left empty. And the pile no longer waits to be noticed: queueing a note, the bare `reflect` protocol and `flow doctor` all print `↻ N closed reflection(s) — flow reflect tidy drops them` while any closed items exist — exactly the surfaces where items get checked off, quiet once the file is clean.

### Fixed

- **The guard no longer mistakes an unattributed command for a stage violation.** pi can register dev-flow twice in one process (the documented two-sources hazard — a project pointer beside the installed package), and *every* copy evaluates every guard hook: the copy that never served the flow call judges with an empty in-memory binding, and whenever a second unfinished feature exists — which kills the single-feature auto-bind that used to mask it — `git merge`/`push` to the default branch was refused with *'requires stage release'* while the bound feature sat at release the whole time (it blocked the v0.55.0 release's own chore git, live). The on-disk claim is now a binding: an unfinished feature whose `claim.json` carries this session's key attributes the call regardless of how many features are unfinished, so a second copy judges from disk instead of guessing. When attribution truly fails, the refusal says so — *not attributed to a bound feature (session key, which dev-flow, what to do)* — instead of lying about the stage. `flow version`, `status` and `start` also name every dev-flow copy registered in the process, and the README's two-sources warning says which copy to remove.
- **`flow finish` fast-forwards a main checkout that trails origin.** Close-out used to probe only `origin/<default>` (tag there, HEAD an ancestor), so a local main left behind by the release — exactly what a guard misattribution produces — passed silently and rotted. Now, once the checkout is clean and proven pushed, `finish` fast-forwards local `<default>` to `origin/<default>` with its own git (never a merge: a diverged or not-checked-out main prints the operator's exact `git pull --ff-only` command instead of touching it).

## [0.55.0] - 2026-10-22

### Changed

- **A stale session build is a question at `flow release`, not a stop.** Gates execute the dev-flow build the session loaded at start, and the checkout moves past it with every release — and shipping from behind had already cost releases: 0.53.0 and 0.53.1 were both published under 0.52.2 code (so #97's changelog proofs never fired and the release pages took tag annotations), and the 0.54.0 release itself ran under loaded 0.53.0, so its own new proofs (merge shape, artifact freshness) never fired in-session. The old answer was prose — *stop and ask the operator to `/reload` before publishing* — a refusal with no gate behind it, and a refusal is the wrong shape: publishing under an older gate is a legitimate operator choice (hotfix, offline reload), exactly the emergency the relaxed modes exist for. Now, when the loaded build is **behind** the checkout's, `flow release` prints both builds, lists the changelog versions that shipped between them (the proofs that will not run this release), and folds *update (`/reload`, then re-run) or proceed with the old release?* into the Release? question — still exactly one checkpoint. The decision is stamped into the release (`staleBuild`) and `release-done` repeats the acknowledgement in place of its bare after-the-fact warning, which stays as the backstop for headless runs; a session build **ahead** of the checkout's manifest is asked nothing, because no proof is missing there. `DEV_FLOW_LOADED_VERSION` lets the smoke suite stand in for an old session — the override can only ever make a gate more cautious, never lift a proof.

## [0.54.0] - 2026-10-22

### Added

- **The playbook says how a merged PR lands, and the gates hold it to that.** Every repo has a merge style; almost none has ever written it down, so the answer was whatever the last click chose — and dev-flow could only react afterwards, asking at `flow finish` whether commits missing from the default branch were a squash merge. `merge = squash | merge | rebase` (or `any` for "no policy, stop asking") now lives under `## release`, and four places read it. **`flow init` suggests it from your own history** — a first-parent log counts merge commits against `(#NN)` squash commits and asks with that evidence (`merge history: 17 merge commit(s), 6 squash(es) — the most recent PR landed as merge`) instead of asking blind. **`flow start` asks once and writes the answer**: while the key is unset the gate refuses with the question, the suggestion and the exact re-run, and `flow start <slug> --merge=<style> --confirmed` inserts one line into `## release` — a surgical insert, not a draft regeneration, so hand-written prose and checklist items cannot be dropped, validated before the write with `.bak` kept, committed as the playbook chore only when the playbook is the only dirty path. **The guard enforces the style where the decision is made**: `gh pr merge --squash` against `merge = merge` is a hard block, a merge carrying no style flag (the forge default decides) needs the operator, and a local `git merge --squash` only ever confirms, because folding main into a branch is ordinary work. **`release-done` proves what actually shipped** matched it — branch ancestry for `merge`, plus what the forge itself reports (`gh pr list --json squashCommit,rebaseCommit,mergeCommit`, GitLab through `glab api`) for the two styles that erase ancestry — so a squash under a merge policy refuses to record the release, while a shape dev-flow cannot see (`forge = self`, no CLI, unfetched branch) prints an advisory instead: an invisible topology never blocks a legal release. Only a human clicking the button in the Web UI stays beyond its reach — that needs the forge's own require-a-merge-strategy setting, and docs say so plainly.
- **`flow start` preflights before it creates anything.** It warns when this session runs an older dev-flow build than the checkout (the gates execute the loaded code, so `/reload` first), prints the playbook gaps `flow doctor` would report instead of promising them later, and stamps the build as before. `flow start --check-upstream` and `flow version --check-upstream` add the published npm version, opt-in so both stay instant and offline by default.

### Changed

- **`flow finish` reads unmerged-looking commits against the policy**: commits that never reached the default branch are *expected* under `squash`/`rebase` instead of a shrug, and a **violation** under `merge` — one `yolo` cannot answer for, only the operator can. The verdict needs measurable ancestry, so a local-only repo is never accused of squashing.
- **`flow doctor` gains two findings**: a playbook with no merge policy (the one knob a repo can silently lack), and a `squash`/`rebase` policy on `forge = self`, which is unprovable by construction.
- The release hint and the skill now spell the playbook's style at the stage where the PR is merged (`gh pr merge --squash`), and the guard-rule examples in the docs no longer claim "PRs squash-merge" — this repo merge-commits, and an example that contradicts the playbook it documents teaches the wrong lesson.

## [0.53.2] - 2026-10-22

### Fixed

- **A claim now dies with its session, not with the process.** Dev-flow's session state is module-level, and pi runs many sessions inside one long-lived Node process (pi-web's agent lives in the server) — so bindings and the compaction flag outlived the session that wrote them, and claim liveness asked only `pidAlive(claim.pid)`, a pid that never goes away in a shared host. The result was a lock nobody could see the owner of: one pi-web session starts a feature, that session ends, and every later session in the repo is refused the auto-bind and told the feature `is claimed by another live session` — forever, because the claim's pid is the server itself. `session_shutdown` now releases the dead session's binding, its compaction flag and every claim it held; a restored session (reload, resume, fork) reclaims what its own branch history says it holds, and a foreign live claim still wins, because restoring is not a takeover.
- **Claim keys say what kind of identity they are.** A key was either pi's session id or, when the host hands out none, the working directory — indistinguishable in `claim.json`, which made a shared-directory collision read exactly like a session that had gone missing. Keys are now `sid:<session id>` and `cwd:<directory>`, and `flow status` prints the session's own key (saying plainly when it is the directory one, because then every pi session in that directory shares a single dev-flow binding and must pass `flow use <slug>`). One migration seam, expected and harmless: a claim written by an older build carries the old bare key, so the first rival session after this upgrade needs one explicit `flow use` — the same path a takeover already takes.

## [0.53.1] - 2026-10-22

### Fixed

- **`flow check` no longer runs tier-1 checks for a `--docs` flow.** Every other gate already exempted docs flows — `pendingChecks`, verify and the release gate all skip the check requirement there, and verify says `docs mode: project commands skipped` — but `flow check` ran the project's commands anyway. In a fresh checkout that has never built anything, a CHANGELOG-only change therefore came back `health: FAIL` (`/bin/sh: kill: No such process` from a probe aimed at a binary that does not exist), which reads exactly like a broken deploy. It now answers in verify's words: `docs mode: project commands skipped`, and says plainly that CI on the tag and the artifact proof are what still stand behind the release. Nothing about the docs contract changed — this removed a command surface that contradicted it.

## [0.53.0] - 2026-10-22

### Fixed

- **The release gate now proves the changelog instead of asking for it.** The stage told the agent to keep manifest, changelog and tag in step, but the machine checked almost none of that, and the gap showed up in the wild: a project shipped `v0.14.0` with **no changelog entry at all** while `flow check`, verify, release and `release-done` (artifact probe and all) stayed green. Four holes closed at the gate (#97): a versioned release never had to **touch** the changelog — the proof existed and was wired only to `--no-version`, so a merge commit could inherit whatever `CHANGELOG.md` main already carried; "mentions the version" was a substring test, so prose, a link reference or an older entry naming the number all passed without an entry existing (and `## [1.2.0-beta]` could stand in for the `1.2.0` release); an unversioned release could satisfy its rule by editing some unrelated older section instead of putting its line under `Unreleased`; and "folded" only meant `Unreleased` was empty, so **deleting** the pending entries passed where moving them was required. Now the gate wants a heading that names the version, an entry this branch actually prepared, and every line that was pending before the release still present inside that entry — compared on normalized lines, so re-indenting a fold is free while rewording or dropping one is refused by quoting the line that vanished.
- **The forge release page now says what the changelog says.** `release-done` published the **tag annotation** first and fell back to the changelog entry, which meant any `git tag -a` body shipped instead of the entry, and nothing ever checked what the release page ended up holding. The changelog entry for the version is now the body of record, the annotation stands in only when the changelog has no entry for that version, and the gate **reads the stored body back** and refuses a mismatch (normalized first — the forge reflows markdown — with the missing body's own text quoted so `gh release edit` is one copy-paste away).

### Added

- **`flow release --no-fold-check`** — the operator's escape from the line-level fold proofs, for the case where a pending entry is deliberately rewritten rather than moved. Same convention as `--no-release-create` and `--no-artifact-check`: one flow, granted in chat, and the gate output carries the note that the proofs were skipped. The entry-heading and touched proofs are not escapable.

### Changed

- **A baseline that cannot be resolved is an advisory, not a refusal.** The fold comparison needs to know what was pending before the release: it reads the changelog at the **newest tag** (what actually shipped), falling back to the branch's merge base. A rebased or squash-merged branch — or a clone that has not fetched the tag — used to be the shape where a git-topology accident would block a legal release, so when no baseline resolves the two git-dependent proofs are skipped **out loud** (`Warning: no tag or merge base to compare against…`) while the content proofs — the heading exists, its body is not empty — always run. Changelogs that never adopted the `Unreleased` convention stay vacuously clean, as before.

## [0.52.3] - 2026-10-22

### Fixed

- **The `healthWait` smoke test stopped racing the clock.** It deploys a service that only becomes healthy 3 seconds later, then asserts the verify gate printed `3 attempts` — but the gate schedules probes on a 2s sleep, so *which* attempt goes green depends on how long this box takes to spawn a shell. Under load the first probe landed past the 3s mark and the gate reported 2 attempts (or 1, which prints no count at all): a red test describing correct behavior, and it failed 2 of 6 full runs while unrelated work landed. Readiness is now counted instead of timed — the deploy resets a counter and the probe goes green on its third call — so both halves of the test assert a fixed attempt count on any machine, and the budget is wide enough that the wait is exercised without being the thing under test. The budget-to-attempts arithmetic stays pinned by `healthRetry`'s unit test, which is where that rule actually lives.

## [0.52.2] - 2026-10-21

### Fixed

- **The `[dev-flow]` stage line printed twice per prompt.** One package reaches one runtime twice as fast as you install it — a project `git:` pin beside the global `npm:` package, or a dogfood checkout whose `.pi/extensions` pointer sits next to the installed copy — and pi dedupes extensions by **file path**, not by package, so both copies register and both answers were appended: two `[dev-flow]` lines in every prompt, in the logs and to the model. The stage-context handler now claims the run: pi builds **one ctx object per `before_agent_start`** and hands it to every registered handler, so the first pass stamps it and a rival copy answers nothing. The claim is per run rather than per process on purpose — pi-web hosts many sessions inside one Node process (dev-flow's own session map is keyed by session id for that reason), and a process-wide "only the first copy registers" rule would leave every later session without guards, without the `flow` tool and without stage context. Each copy still registers its guards, tool and command: their verdicts are identical, and pi exposes no runtime identity during load to dedupe them against.

## [0.52.1] - 2026-10-21

### Changed

- **The npm listing describes the flow instead of the pipeline.** The pi.dev package gallery builds its cards from name + description + keywords — its search box matches exactly that text, and the page renders no images — so the manifest now carries a description that says what the flow *is* (gated checkpoints, self-improvement reflections, one worktree per feature, changelog + publish as part of the release) plus thirteen keywords in the shape the other pi packages use. It also ships a banner (`banner.svg`, rasterized to `banner.png`, declared as `pi.image`): the five stages with the four checkpoint words over the gates, and the release stage pointing at "registry · image · release page" — deliberately generic, because where a release ships is the project's playbook, not dev-flow's. The package now names its resource directories explicitly under `pi` rather than relying on conventional discovery (the packed tarball was loaded against the real pi binary).

## [0.52.0] - 2026-10-21

### Added

- **The release publishes the package.** `pi-dev-flow` is on npm, and `.github/workflows/release.yml` is what puts it there: the `v*` tag `flow release` pushes triggers a job that checks the tag against the manifest version, proves the tag is on the default branch (an npm version is immutable — a tag cut from a feature branch would burn the number and ship code main never had), runs `npm ci && npm run build && npm test`, and publishes with `--provenance`. Authorization is npm **trusted publishing**: the job's OIDC identity is the credential, so there is no token in the repo to leak or rotate. Nothing publishes from a developer machine, and a failed publish is re-run on the same tag rather than re-tagged. The published manifest finally says what it ships (`files`), carries the `LICENSE` it had only claimed, states `engines.node`, and names the renamed repository; a new guard test refuses a pi-discoverable resource directory that `files` would silently drop, since that break is invisible to the author and fatal to whoever installs the package.

### Changed

- **`flow reflect` sends updates to npm.** The session-reflection protocol probed `git ls-remote` tags and recommended `pi install git:github.com/<upstream>`, because git was the only channel. It now compares the running version with `npm view pi-dev-flow version` and recommends `pi install npm:pi-dev-flow` then `/reload`, with the git probe kept as the fallback for git-installed copies (an installed fork still carries the same package name, so the probe stays correct). The README install section leads with the npm source and names the update path (`pi update --extensions`), and the publish workflow is documented for maintainers.

## [0.51.2] - 2026-10-21

### Changed

- **`release-done` proves the forge release exists instead of trusting the attempt.** A repository carried an annotated tag, published images and a **completely empty Releases page** — the playbook had the forge-release key off, `release-done` verified the registry artifact, printed `release recorded as complete`, and nobody looked at the web page. Three earlier failures (#51, #60, #63 — quoting that shipped a shell error as the body, quoting that killed `gh release create`, and a create whose failure was stamped as a note the release rode past) are the same shape: recorded, nothing published. The gate now asks the forge (`gh release view <tag>` / `glab release view <tag>`) and refuses when nothing is there, naming both ways out: create it, or say publication is manual with `release.releases = false`. Skipping stays deliberate and loud — `--no-release-create`, `release.releases = false` and `forge = self` each print that no release was created, and the proof is skipped for them. This replaces #63's advisory note: a failed create is no longer something a release can ride past, so `finish`'s "the forge release was not created" warning can only fire for flows released by an older build.

## [0.51.1] - 2026-10-21

### Changed

- **`flow verify` runs the checks it gates on.** Entering a stage — and every edit of the worktree since — clears the recorded results, so the gate answered "check `test` has not passed — run flow check" and made the agent run it and come back: three round trips to say what one could, and the operator answering **Verified?** about a state the gate had never seen that round. A check with no passing record is now run by `flow verify` itself, the PASS is recorded like `flow check` records it, and the line says `checks ran at the gate (test)`. A check that fails there refuses the gate with its output instead of a pointer. `health` is left to the post-deploy probe when there is a deploy to prove — probing twice only waits twice.

## [0.51.0] - 2026-10-21

### Added

- **`protect`/`forbid` can name a sibling set: `protect docker/.env*`.** A playbook guarded `docker/.env`, a session flipped a variable by copying the file aside to `docker/.env.bak-<date>`, and the backup went into a commit and out to a public repository. The guard never spoke: the path rule was prefix-only, so `.env*` was not expressible, and no `deny` regex could have caught it either — the commit (`git add -A`) never names the file. A glob in the **last** segment now matches the basenames in that directory (realpath'd like every other path rule, so a symlinked or `..`-reached directory cannot dodge it); a glob anywhere else in the pattern still means one literal path, and `flow init` / `flow doctor` now say so instead of letting a rule silently guard nothing.

## [0.50.0] - 2026-10-21

### Added

- **A forced push asks the operator instead of being someone's regex problem.** A secret reached a pushed branch and the only way back was a rewrite of that branch — which the guard chain refused with no authorised path: the playbook's own deny rule is unconditional, and the refusal's advice ("update it by merging main into it") is exactly the option that cannot be taken when the commits are the leak. The workaround the session found (scrub locally, push `-v2`, second PR, close the first) split one feature's audit trail and left the blob reachable on the old branch anyway. dev-flow now confirms `git push` carrying `--force`, `--force-with-lease…` or `-f` with the operator itself, and the refusal prints the one prefix that answers for it — `DEV_FLOW_ALLOW_REWRITE=1`, the same "the operator said so" contract as `DEV_FLOW_ALLOW_MAIN`, so it works headless too.

### Changed

- **Playbook guidance anchors a guard rule on the verb, not on a flag.** The documented example was `deny \bgit\b[^\n]*--force`, which also refuses `git filter-branch --force` (a purely local rewrite) and `git show -f` — and a rule that blocks unrelated commands gets routed around until it means nothing. The example now reads `\bgit\b[^\n]*\bpush\b[^\n]*--force`, and the docs say plainly that a project needs no force-push rule of its own now that dev-flow confirms it.

## [0.49.1] - 2026-10-21

### Fixed

- **A `cd ~/<worktree> && git commit` was judged from the session cwd and refused as a commit on the default branch.** The git guard took the `cd` / `git -C` target verbatim, and `path.resolve` treats `~/wt` as a relative path — it became `<session cwd>/~/wt`, where the branch probe could not answer. The probe then fell back to the session's own branch, so a legal worktree commit was blocked with "direct commits to main are forbidden": a message about a rule the command was never near. `~`, `$HOME` and `${HOME}` are now expanded where the directory is captured (any other `$VAR` stays literal — resolving it needs a shell, and guessing is how the wrong path appeared), the silent session-cwd fallback is gone (a directory git cannot answer for yields no verdict, and git itself fails there), and the commit refusal names the directory it judged so a future misjudgment reads as one.

## [0.49.0] - 2026-10-21

### Changed

- **The operator answers words; the agent runs the gates.** The stage hints injected into the model's context every minute ended with "ask the operator to run `/flow approve`" / `/flow verify`", which trained exactly the hand-off the skill forbids — the operator reading a command line instead of a question. The plan and implement hints now end with the checkpoint word and the gate the agent runs itself (`ask the operator Approve? in chat and run flow approve --confirmed`), and the every-turn rules line says outright that gates run through the flow tool, that the operator never types commands, and that `/flow` is their manual override. Same for the stage-context header's `/flow init` pointer.
- **README rewritten human-first, reference detail split into `docs/`.** It now leads with the idea (spec before code, gated phases, git hygiene, parallel worktrees) and a stage/gate diagram with what each gate refuses, one table of stage → what the agent does → the word it asks you, your checkpoint answers (`yes`/`no`/`yolo`/`no version`), what reflections are and what you do with them, and a short enforcement list. The gate table, playbook reference, full guardrail list, concurrency, headless contract and development notes moved to `docs/{gates,playbook,guardrails,concurrency,headless,development}.md` — moved, not rewritten, so nothing was lost in the move.

### Added

- **A bash segment whose head is `flow` is refused.** There is no `flow` CLI — gates live inside the session — but agents kept calling `flow status` in a shell, collecting an exit 127 with no pointer, and repeating the mistake. The refusal names the call that works (`flow {args:["status"]}`), the same shape as the `bashTimeout` hint. Matching is the head token of a masked segment: `grep flow status`, a `skills/dev-flow/SKILL.md` path and a commit message quoting a gate are arguments, not invocations; a project that really ships a `flow` binary calls it by path or through `npx` (see Limitations).

## [0.48.0] - 2026-10-21

### Changed

- **`flow verify` refuses a branch with nothing committed.** Checks describe the working tree, so an agent that committed nothing could ask **Verified?** about a state no gate had ever seen — the first hard commit wall was `flow finish`, long after the answer. The gate now counts the branch's commits over its merge base with the default branch (local refs only, so it stays offline-safe) and refuses at zero **before** build / `dev` / health spend minutes on a deploy; a branch whose merge base cannot be resolved prints `commits: unknown` and is never blocked on a measurement failure. Every verify line now names `commits: N ahead of <default>, M uncommitted path(s)` alongside what it ran, so the operator sees what they are approving — uncommitted paths are reported, not gated, so fixing something the operator spotted still costs a re-verify and not a commit ceremony. `--docs` features follow the same rule.

## [0.47.0] - 2026-10-21

### Changed

- **`release --no-version` now ships merge + changelog instead of skipping both.** The flow still cuts no version, tag or forge release, but the Release? gate refuses until the branch changes the changelog — the entry rides under `Unreleased` until the next versioned release folds it. The versioned gate grew the matching rule: it refuses while the `Unreleased` section (`## Unreleased` / `## [Unreleased]`, nested `###` sub-headings included) still holds entries — several `--no-version` flows accumulate there and a full release must gather them under its new version heading. `release.changelog` defaults to `CHANGELOG.md` (set it empty in project.md to opt out); with no changelog file at all an unversioned release is refused, since its changelog line is all it ships.

## [0.46.3] - 2026-10-21

### Fixed

- **Skill release step now forbids `gh pr merge --delete-branch`** — it aborts with "'main' is already used by worktree" whenever the default branch is checked out in the main checkout (hit in two consecutive flows), and `flow finish` deletes the merged feature branch on proof anyway.

## [0.46.2] - 2026-10-20

### Changed

- **Reflection is now part of every finish.** Before `flow finish` deletes `.dev-flow/<slug>/` and the session context with it, the agent runs the end-of-session reflection and parks real issues via `flow reflect`. With issues parked the closing question becomes **Fold? Fix? Drop?** (fold = queue them in `reflections.md`, fix = route them now via `flow doctor`, drop = discard) and its answer replaces **Finish?** — no second question; with nothing parked, Finish? stays as before.

## [0.46.1] - 2026-10-20

### Changed

- **The skill now states the rules the plugin only enforced silently.** Every shell call must pass an explicit `timeout` (the `bashTimeout = require` guard, shipped in 0.45.0, was undocumented in the skill). Checkpoint grammar is enforced: the agent asks the one-verb question (Approve?/Verified?/Release?/Finish?) in plain chat, mentions that **yolo** is an available answer, and runs the gate when the operator answers — it never routes the operator to a `/flow` command at a checkpoint. `skills/dev-flow/SKILL.md` was also compacted ~18% with every rule kept: the checkpoint/`--confirmed`/mode-grant grammar that was stated up to four times now lives once in the ground rules, and rationale prose was trimmed.

## [0.46.0] - 2026-10-20

### Fixed

- **A type error shipped in 0.45.2 because nothing typechecked.** The compaction takeover passed pi's `ProviderHeaders` (values may be `null`) into `compact()`, which takes plain string headers — `npx tsc --noEmit` failed on main and every gate stayed green, because tier-1 was only `npm test`. Null headers are dropped at the call site and `npm run build` (`tsc --noEmit`) is now a script; add `build = npm run build` under `## implement` in your playbook to gate on it.
- **Deleting flow state was not blocked; reading it was.** The state guard matched one path shape plus a loose verb list: `rm -rf .dev-flow/<slug>` (state *and* plan, gitignored, unrecoverable) and `cd .dev-flow/<slug> && mv state.json /tmp/bak` passed it, while `jq -e .stage .dev-flow/x/state.json` — a read — was refused for a `-e`. Both tamper checks now share one per-segment, target-based verdict (the same shape the playbook check learned in #53): the folder, the feature directory and `state.json` are owned, reads and backups stay free, and the block message names what was actually touched. Writing state files is now atomic (tmp + rename), so a kill mid-write no longer truncates a feature out of existence.
- **`flow init --force` overwrote the operator playbook with no confirmation and no backup** — an agent that misread a doctor finding could replace every `flow-guard` rule, checklist item and piece of guidance with a detection draft. It now needs the operator's word (`--confirmed`, or one confirm dialog for a human) and every sanctioned playbook overwrite keeps the previous file as `project.md.bak`.
- **A release could be recorded from tags that never left the laptop.** When `git ls-remote` failed (offline, no ssh agent) the tag list silently fell back to local tags, so `release-done` declared a release whose tag had not been pushed. An origin that exists but cannot be asked now refuses both release gates.
- **`mdDigest` skipped `## pre-release` entirely** — `buildDraft` writes `versionFile`/`versionTag` there, so the init dialog never showed the version rules, the tag pattern or that stage's checklist items. Pre-release now renders like release.
- **`<!-- operator notes -->` in project.md were injected as stage guidance** on every turn of every session (this repo's own `<!-- tier-3: standing guidance -->` placeholder included). HTML comments are inert again; real prose still injects.
- **`flow test` / `flow health` pointed at `.dev-flow/project.json`** — a file the plugin no longer reads and the guard refuses to create. Both messages now name `## implement` in project.md.
- **A failed `ctx.compact()` left the in-flight mark set**, switching off flow-aware self-compaction (and the takeover) for the rest of the session.

### Changed

- **Gates follow the session claim.** Passing another live session's slug to `flow approve`/`verify`/`finish` is refused with "flow use <slug> takes it over explicitly" — before, two sessions drove one feature and clobbered each other's state file, which is exactly what claims exist to prevent.
- **`deny`/`confirm` rules now see write-capable read-only heads**: `find -delete`, `find -exec …`, `sort -o FILE` and `awk 'BEGIN{system(…)}'` no longer slip past the read-only skip list, while `grep "git push --force" docs/` stays a search.
- A plan-stage session may only write inside **its own** `.dev-flow/<slug>/` — it can no longer edit another feature's plan and let that feature's approval gate accept text it never wrote.
- The bash guard parses each git segment once instead of four times, and `featureRefs` is built once per call.

### Removed

- The duplicate `StageCheck` interface in `projectmd.ts` (core's is imported) and the always-empty `findings` field of `loadProject`, which nothing read.

## [0.45.2] - 2026-10-20

### Fixed

- **A flow-bound threshold compaction deadlocked the session instead of compacting it.** The takeover awaited `ctx.compact()` from inside `session_before_compact` — but pi's `compact()` opens with `abort()` + `waitForIdle()`, and the run awaiting the hook can only go idle once the hook returns: a full cycle. The summarize request was never issued (nothing ever reached the provider), no compaction entry landed, the UI spun on "Compacting…" forever, and Stop could not free it — the takeover ignored the very abort signal compaction events carry. The unit test mocked the exact `ctx.compact` call that deadlocked, which is how a 100%-deadlocking takeover shipped. The takeover now never re-enters `compact()`: it calls the same `compact()` pi itself calls — same split-turn merge, file lists and structured prompts — with the flow-aware instructions and the event's signal, and returns the summary through the event's custom-compaction channel, which pi appends itself (no cancel dance; Stop now really cancels the summarize call). Any takeover failure returns `undefined` and pi's own compaction proceeds — a broken takeover can no longer block compaction at all. The rewritten test drives the real path through a one-line seam and asserts auth and signal forwarding, the fallback, and that a failed takeover releases the in-flight mark.

## [0.45.1] - 2026-10-20

### Fixed

- **A redirect to somewhere else is not a write to the playbook.** The playbook guard's loose fallback tested a verb list whose first term was a bare `>`, so *any* segment that merely mentioned `.dev-flow/project.md` was refused the moment it contained any redirect at all — it blocked `gh pr create --title … --body "…prose about the playbook…" 2>&1 | tail -1` during the 0.45.0 release, and would have refused `> /tmp/out.log` just as happily. The dangerous form was never the problem: a redirect whose target *is* the playbook (plain, quoted, or inside a `sh -c` payload) is caught by the dedicated check two lines earlier, so the fallback now looks for write **tools** only (`tee rm mv cp sed -i truncate dd python node`) and ignores redirection. Reads, backups and heredocs that discuss the path keep passing exactly as before; `> .dev-flow/project.md`, `>> '.dev-flow/project.md'`, `sh -c "echo x > .dev-flow/project.md"`, `tee` and `truncate` into it still refuse — and the new test fails against the old pattern, so the fix is pinned from both sides.

## [0.45.0] - 2026-10-20

### Changed

- **BREAKING: a shell call must state its own timeout** — `bashTimeout = require` is the new default. v0.43.0 started arming a deterministic class default whenever a call arrived without one, which ended the hangs but left the call line looking unarmed: the value is written into `event.input` by the `tool_call` handler *after* the transcript recorded the call, so neither operator nor model ever saw a `timeout` on it — a bare call read as "nothing will kill this". Now the call is **refused** until the model states one, and the refusal quotes the exact number the class table would have armed (`pass an explicit timeout on shell calls — the class default here is 900s …`), so the retry is a one-token fix and every shell call in the transcript shows the timer that is really running. The silent injection stays in place underneath both modes and is what protects a project that opts back — `bashTimeout = inject` in `## global` restores the 0.43.0 behaviour exactly. A session with no `.dev-flow/project.md` cannot opt out (no playbook to put the key in), so it applies to every agent loading this build; for that reason the guard is judged **after** the project's own `flow-guard` deny/confirm rules — an operator deny still answers with the operator's reason even on a call that forgot the timeout. The injected value also finally has a test asserting it lands on `input.timeout`: the smoke suite drove this handler for guard verdicts for two releases without ever checking the injection reached the call.

## [0.44.0] - 2026-10-20

### Added

- **The plan stage now teaches the mockup harness, not just the gate** (#70). Step 4 of the plan stage said "build mockups, render them, embed them" — correct as a gate, silent about the tool, and an agent mocking *stateful* UI paid for the gap: ~20 render attempts in one session, a List-view shot showing a control the real code hides, an "after" shot of a stale teardown state, renders written as bare filenames (prose, not `![]()` — broken links the operator flagged twice), a shared chromium profile leaking localStorage between shots, and below-the-fold regions coming back blank because a headless shot always captures from the page's top-left. Step 4 now carries the checklist that makes those impossible to hit blind: an embed is the image syntax and every tag is re-checked against the filesystem before Approve?; a component question gets a **static strip** against the project's real stylesheet instead of driving the app's state machine through the harness; nothing scrolls, so hide what is above the region or render a strip; one fresh profile dir per intended UI state; a shot of planned behavior must show it and be captioned as such; freeze the app's own repaint to catch a transient state (an inline editor); and when the harness fights the same shot twice, verify that state via DOM/code and move on — screenshots are a spot-check, not a test loop. Step 4's first sub-bullet, which rendered inside its sentence, is fixed on the way.

## [0.43.1] - 2026-10-20

### Fixed

- **`flow reflect` files notes where it says it does** (#69). `appendReflection` rebuilt `reflections.md` from two buckets and re-derived the bucket of **every existing line** from an inline `(plugin)` marker — which new-style items never carry, because the `## playbook` / `## plugin` heading above them is the only information. So each write re-moved the whole `## plugin` section into `## playbook` (a both-sections note then showed up twice under `## playbook`, and a checked-off plugin item wandered off too), and a file whose playbook section was empty lost its plugin items on the next reflect — while the printed `reflected (plugin)` line was the only feedback the agent got, and it was wrong. A heading is now authoritative for the lines under it, order is preserved and nothing relocates; an identical note already open in a section is not written there again (the call reports `already reflected (duplicate)` instead, and a checked-off note may be reported again when it comes back). Items above every heading keep the inline-marker reading, so the legacy flat-file migration is untouched. An unbound session also stopped signing notes `— - <date>` — no slug now means no slug, `— <date>`.

## [0.43.0] - 2026-10-20

### Added

- **Shell calls can no longer hang a session forever** (operator request). pi arms its kill timer only when the model passed a `timeout`, and it omits one in ~75% of calls — this host's session logs showed hangs of hours (`gh pr merge` waiting on a prompt, `curl` to a dead port, `git push` on a credential prompt, foreground watchers). The `tool_call` handler now injects a **deterministic class default** whenever a shell call has no timeout, and clamps explicit ones to 1,800s: 30s quick inspection (ls/grep/`git status`) · 120s local git and anything unrecognized · 180s network (`git push`, curl, gh) · 300s containers/services (docker, systemctl) · 900s builds/tests/installs · 1,200s watchers (`gh run watch`, `logs -f`, `compose up` without `-d`). Compound commands split on `&&`/`;`/`|` and the slowest class wins; wrappers (`cd`, `export`, `sudo`) don't count. The numbers come from the measured duration distribution (99% of no-timeout calls end under ~70s; real builds under ~400s), so a premature kill is rare and self-correcting — the model sees `timeout:` and reruns with an explicit value. Sensible explicit timeouts pass through untouched. The policy applies to every session that loads the package, flow-bound or not.

## [0.42.0] - 2026-10-19

### Added

- **Machine surfaces for headless orchestrators** (driving dev-flow from a remote agent via a Pi SDK session). `flow status --json` answers the prose view as stable JSON — bound slug plus per-feature stage, mode flags, branch, worktree, approvals, checks (name→ok) and the next hint — parseable in every case, an empty repo included; `flow help --json` returns the gate contract as data (the command list split from the one `GATE_HELP` source, the checkpoint questions, the flag names) so an orchestrator learns the interface without grepping prose. Both are additive: the human views are unchanged.
- **`NEEDS-OPERATOR` refusal marker.** Every no-UI refusal that needs the operator's word now starts with the stable token `NEEDS-OPERATOR <Question?> — …` (the four checkpoint gates, and a project flow-guard `confirm` rule met without UI). A remote driver routes on the token — relay the question, then re-run the gate with `--confirmed` — instead of string-matching prose that is free to drift. The human-readable sentence follows the marker unchanged.
- **README: “Driving dev-flow from an orchestrator (headless)”** — the refuse → relay → `--confirmed` loop, the honor-system trust of `--confirmed`, one-session-one-feature binding for reconnecting drivers, long-gate timeouts, check invalidation and version skew, and the read-only-safe command set.

## [0.41.0] - 2026-10-19

### Added

- **yolo works at any gate** (operator request). Until now `“you said yolo” could only be recorded at Approve? (`approve --yolo`); saying yolo later meant answering every remaining checkpoint one by one. Now **every state gate accepts `--yolo`** — `verify --yolo --confirmed`, `release --yolo --confirmed`, `finish --yolo --confirmed` answer that question and pre-confirm all later ones, so “yolo” at Verified? runs verify → release → release-done → finish to the end with no further questions. `--yolo` without `--confirmed` is refused — the flag is the operator's word, never self-granted. Guidance attached to the yolo word (“yolo, create a patch version release”) is a binding directive for the gate chain, and the YOLO stage guidance now spells the chaining rule out to the agent. Checks and guardrails stay fully enforced: tier-1 gates, version/changelog validation and flow-guard `confirm` rules are untouched by yolo.

## [0.40.0] - 2026-10-19

### Added

- **Roadmap: a flow-aware backlog of future features** (operator request). `.dev-flow/roadmap.md` is a gitignored `- [ ]` checklist of features to build later — advisory like `reflections.md`, it never gates. `flow roadmap` lists the open items numbered; `add "<feature>"` appends one; `pick <n> <slug>` stamps open item *n* with the slug and prints the `flow start` line (one verb — it starts nothing itself), and when a flow with that slug reaches `finish`, **the stamped item checks itself off** (`— done: <date>`) — a picked feature closes its backlog line with no extra ceremony; `done <n>` checks off by hand for items shipped outside a flow, `tidy` drops the checked lines. The open count is surfaced in `flow status` (including the no-features answer — a backlog is most useful before a flow exists) and in the per-turn session context, bound and unbound; direct edits of the file are equally fine.

## [0.39.2] - 2026-10-19

### Fixed

- **A failed forge release can no longer slip past the flow** (#63). `release-done` created the forge release *advisory* — a failed `gh`/`glab release create` printed `github release skipped: <error>` and the release was recorded anyway; an operator who skimmed the line finished the feature with a tag but no release page. A failed create now **stamps the flow state** (`forgeReleaseSkipped`, cleared by a successful re-run of `release-done`) and **`finish` names it in the Finish? question**, in the no-UI refusal and in the `--confirmed` output — intentional skips (`--no-release-create`, `release.releases = false`, `forge = self`) stay silent, because declining is the operator's call, a failure never is.

## [0.39.1] - 2026-10-18

### Fixed

- **Every argument that reaches `/bin/sh` is now a real shell literal** (the #51 leftover, from an open reflection). Gates built commands with `${JSON.stringify(x)}` — JavaScript quoting, which `/bin/sh` strips before expanding what is inside: an annotated tag whose body held backticks had its code spans *executed* by `gh release create` (v0.37.1), a semicolon killed it outright (v0.38.0); the #51 fix had quoted the notes on the way in, not the way out. A `sq()` helper (POSIX single quotes, `'\''` for embedded quotes) now escapes all 19 such embeddings — release commands, tag lookups, worktree and branch paths, remote refs — and the smoke round-trip runs a tag body full of backticks, `$()` and `;` through real `/bin/sh`, asserting it prints verbatim and nothing runs.

## [0.39.0] - 2026-10-18

### Fixed

- **The compaction pacing now counts the way pi counts** (operator report). The 0.35 safe-point compaction compared against the *built-in* `reserveTokens` default while pi compares against the effective one — settings and per-model overrides included. Any reserve above 16384 ate the 16 KiB margin directly; above 32768 pi's threshold sat *below* dev-flow's and always won. The trigger now reads the effective reserve through pi's own `SettingsManager`, and a `compaction.enabled = false` in settings is honored — dev-flow no longer compacts behind an operator who turned auto-compaction off. A malformed compaction setting bails the check instead of crashing every turn end.
- **Safe points at pi's frequency.** pi checks its threshold between *every* turn, after tool results land; dev-flow only checked after a gate and when a run settled — a long implement run without a `flow` call got no check, and one fat tool batch (two 50 KB-capped reads already approach 16 KiB) jumped past the margin mid-run. `turn_end` is now a safe point too.
- **A forced threshold compaction gets taken over.** The chat-only states (open tier-2 dialog, undigested plan discussion) deliberately never self-compact — but pi force-compacted that same transcript blind, and the plan dialog is the most token-hungry state there is. `session_before_compact` now redoes a threshold compaction with the flow-aware instructions (awaited before cancelling pi's, so it never races `prepareNextTurn`; if ours fails, pi's proceeds). Overflow recovery is left alone — cancelling it would drop pi's compact-and-retry.

## [0.38.0] - 2026-10-18

### Fixed

- **The guards read commands, not prose.** `bashSegments` split on `;`, `|`, `&` and newlines without respecting quotes, so every line inside a quoted argument became a segment of its own: a `gh pr create --body "…"` whose body discussed a commit was refused as a main-branch commit, and `playbookTamper` — matching a write verb anywhere in a segment against the playbook path anywhere else — refused a PR body that quoted a copy of the playbook. Both fired during the v0.37.0 release, on the text describing the fix. Splitting now respects quotes, and quoted argument contents are masked before the playbook check, so the operator's words about a command are data.
- **A wrapper cannot carry a git command past the guard.** `sh -c "git push origin main"` used to slip through: the guard only recognised `git` as the first word of a segment. Segments whose head executes its argument (`sh`, `bash`, `node`, `python`, `env`, `xargs`, `sudo`, …) are now judged on their payload, and their quoted text stays code rather than being masked. Unbalanced quoting keeps the old plain split, so a stray quote cannot be used to hide a command either.

## [0.37.1] - 2026-10-18

### Fixed

- **`flow version` says which build is running.** A session keeps the code it loaded at start while the manifest on disk moves past it after a release, so a long-lived session reported the new version while executing the old gates — twice in a row that meant shipping release notes generated by the previous session's broken code. `flow version` now names both when they disagree (`dev-flow 0.37.0 … — but this session runs 0.36.0; /reload to run 0.37.0`), `flow release-done` prints the same warning before it publishes anything, and the skill tells the agent to stop and ask for `/reload` instead of releasing from behind.
- **Release-stage checklist items are no longer uncatchable.** No gate records a `release`-stage confirmation, so a release-stage item nagged from `release-done` to `finish` with nothing able to mark it handled, and the checklist itself vanished at the last objective gate. `release-done` now lists the still-open release-stage items, and the nag says plainly that the operator's **Finish?** answer is what closes them.

## [0.37.0] - 2026-10-18

### Fixed

- **The playbook-tracking chore finally has a legal path** (#53). `flow doctor` said *`.dev-flow/project.md is not tracked in git — git add -f .dev-flow/project.md`* while every route to doing it was closed: commits on the default branch are forbidden with no flow bound, and a docs flow's worktree cannot contain a file that is untracked in the checkout it was cut from. A commit whose **only** change in that checkout is the playbook is now allowed — tracking the operator's playbook is setup, not feature work — and any other dirty path closes the lane (`--amend` never uses it: that rewrites the default branch's history). Doctor, `flow init` and the skill now print the command that works: `git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"` (the env prefix is for the installed hook only).
- **The playbook guard no longer blocks reads and backups** (#53). `playbookTamper` matched a write verb *anywhere* in the command against the path *anywhere else*, so `cp .dev-flow/project.md /tmp/project.md.bak` — the safety copy to make before a write — was refused, along with `grep -e health .dev-flow/project.md`, `git ls-files --error-unmatch .dev-flow/project.md` (a bare `-e` in the verb list), `sed -n 1,10p …` and a `cat > /tmp/issue.md` heredoc that merely mentions the path. Writes are now decided per segment and by target: redirect into the playbook, a copy/replace verb whose destination is the playbook, or a real write tool (`python -c`, `node -e`, `sed -i`) — everything else reads.

## [0.36.0] - 2026-10-18

### Fixed

- **`release-done` publishes the version the release gate approved** (#52). The `release` gate read the manifest under the feature worktree, `release-done` read it from the main checkout — so a main checkout whose default branch was still behind republished the *previous* version, its `release.artifact` probe verified the previous artifact, and the gate reported `Artifact verified.` while nothing new shipped (this happened in the wild: a `v0.9.0` release came out as `v0.8.1`). The gate now stamps its validated version into the flow state (`releaseVersion`) and `release-done` publishes exactly that; the artifact line names what it probed (`Artifact verified for 0.9.0.`).
- **Tags are judged by what origin holds, not by one clone** (#52): "already tagged" and "the tag exists" now come from `git ls-remote --tags origin` (local tags only when there is no remote), and a release older than the newest matching tag on origin is refused outright — `v9.9.9 is already tagged — refusing to release v9.9.8 behind it`.
- **Forge release bodies stopped being shell errors** (#51). `git tag -l --format=%(contents)` is a `/bin/sh` syntax error (the unquoted `(`), and `sh()` folds stderr into its output, so `/bin/sh: 1: Syntax error: "(" unexpected` became the stored release notes — on two repos, including dev-flow's own `v0.34.0` and `v0.35.0`. The format is now quoted, notes are taken only from a *successful* tag command, and a body that looks like a shell complaint is dropped and reported instead of published. When a tag carries no annotation (a lightweight tag silently produced an empty body), the body falls back to that version's `release.changelog` entry, and if there is none the gate says so: `no release notes (tag v0.9.0 carries no annotation … — tag with git tag -a)`.

## [0.35.0] - 2026-10-18

### Added

- **`healthWait` in playbook `## implement`** (#42): the seconds the post-deploy health probe may keep retrying — one immediate shot plus a retry every 2s, default 30, `healthWait = 0` restores the single shot. A service whose readiness lags its container start (a BFF answering `/readyz` only after its upstream connects) no longer needs a poll loop hand-written into the playbook, and the gate says how it tried: `health: PASS (curl … , 3 attempts)` / `gave up after 16 attempt(s), healthWait 30s`. `flow health` waits the same way; `flow check` stays single-shot — before any deploy there is nothing to wait for.

### Fixed

- **`approve` retries a setup that never succeeded** (#49). A failed `commands.setup` left the worktree behind and the next `approve` reused it in silence — "fix it and run approve again" was a no-op, and the damage (no `.env`, no `node_modules`) only surfaced later as an unrelated-looking `flow check` failure. Setup now stamps `setupAt` when it first exits 0 and reruns until it does.
- **A `--docs` feature runs no project command** (#49 #43). Docs mode's contract was always "no tier-1 checks", but `approve` still copied `.env` and installed dependencies and `verify` still built, deployed and probed. Now: `setup skipped (docs mode)`, `docs mode: project commands skipped (build/dev/health)` — and the verify prompt no longer claims a dev deploy is up for review when none ran.
- **`flow reflect "<note>" --confirmed` no longer pastes `--confirmed` into the note** (#43) — the flag belonged to the state gates and made the operator's own sentence in `reflections.md` read like a command line. A flags-only `reflect` is a bare reflect.

## [0.34.0] - 2026-10-17

### Changed

- **Status bar is emoji-only: `<stage glyph> <slug>` plus markers.** Stages render as 📝 plan, 🔨 implement, 🔍 pre-release, 🚀 release, with ⚡ patch, 📚 docs, 🎱 yolo and ⚠️ while a check fails — no `◆` anchor, no stage word, no theme stage color (color-emoji ignore `theme.fg`). `flow status` is now the spelled-out surface (`stage=implement`, the `[ui]`/`[yolo]`/`[no-version]` tags, the `flow=<ver>` stamp).

### Removed

- **The `ctrl+,` detail panel is gone** (overlay, shortcut, `STAGE_COLORS`). It needed a real terminal — `ui.custom()` is a no-op in RPC/web mode — so the footer and `flow status` are the only status surfaces now. README's Status bar line is the glyph legend.

## [0.33.3] - 2026-10-17

### Fixed

- **Stale section headers in `reflections.md` no longer duplicate.** Everything above the first item is the verbatim preamble, so empty `## playbook` / `## plugin` headers left there by an older rewrite were copied back on every append — headers multiplied with each `flow reflect "<note>"`. `appendReflection` now drops bare section headers from the preamble; the rebuilt sections below are the only headers.
- **Bare `/flow reflect` now executes instead of just rendering.** The command bar sends gate output as a display-only box with no model turn — for `reflect`, whose entire output is a work instruction for the agent, that meant the protocol printed and nothing happened. Bare `reflect` from the bar now triggers a model turn so the agent runs the protocol; every other command keeps the display-only behavior.

## [0.33.2] - 2026-10-16

### Fixed

- **`flow reflect`'s output now says so in the first line: it is a work instruction, execute it.** The protocol listed the steps but never told the agent to run them — an agent that only echoed the printed protocol looked like "the command did nothing". The preamble now opens with "this output is your work instruction: execute these steps now — do not echo the protocol and do not ask to begin."

## [0.33.1] - 2026-10-16

### Fixed

- **Release chores finally have a lane in the main checkout.** The bash guard blocked `git commit` on the default branch at **every** stage — including `release`, where the stage hint tells the agent to "commit and push the release chores in the main checkout" and pushing to the default branch is explicitly allowed: a dead allowance, since the commit to push could never be created. Commits on the default branch now carry the same stage exception as push and merge — only at stage `release` — and the release hint names the `DEV_FLOW_ALLOW_MAIN=1` prefix the installed pre-commit hook requires.

## [0.33.0] - 2026-10-16

### Added

- **`flow reflect` — the full session-reflection protocol.** Bare `flow reflect` prints what the agent must do at the end of a session and the facts it cannot guess: running plugin version, upstream repo, and the open `reflections.md` items with their routes. The protocol: review the session log in full (messages, tool calls, results); re-check every open item against the current playbook and **newer dev-flow versions** — dev-flow ships from git, so the probe is `git ls-remote --tags --sort=-v:refname <upstream> | head -1` against the running version, and a newer tag covering an item means recommending the operator update (`pi install git:github.com/<upstream>` + `/reload`) — check items off in reflections.md (gitignored, agent-editable); dedupe new findings against open items before queueing them; report playbook vs plugin items to the operator structurally; ask whether to fix now — yes: plugin items search upstream first (`gh issue list --repo <upstream> --state all --search …`, an author-addressed match is reported back, never re-filed; no match → `gh issue create` with a detailed description, session evidence and a suggested fix), playbook items go through `flow doctor` to their docs flow. The command writes nothing and runs no network calls — the protocol is the agent's, the facts are the plugin's. `pluginVersion` now also reports the manifest's upstream `owner/slug` (package.json carries a `repository` field).

### Removed

- **`flow doctor reflect "<note>"` — queue notes with `flow reflect "<note>"`** (same section routing by wording; plain `flow doctor` still reviews and routes open reflections). The old form lost its special case: `flow doctor reflect x` now prints a fresh-note investigation brief for an observation literally named "reflect x" and touches nothing.

## [0.32.0] - 2026-10-17

### Added

- **Guided setup on `flow init`.** A first init no longer writes a detection draft silently: it prints a **setup brief** — the detection report plus one question per knob detection cannot decide (git forge, version manifest and tag convention, automatic forge releases, registry artifacts like Docker Hub, the real test/build/lint/health commands, tier-2 items and prose). The agent relays the questions to the operator and applies the answers through the validated `flow init --write`; an interactive init can review the draft with one confirm dialog and write it there. Nothing touches disk before the operator confirms.
- **Forge support end-to-end.** New global key `forge = github | gitlab | self` (auto-detected from the `origin` URL at the moment of use when unset). `flow release-done` creates the forge release from the verified tag via `gh` or `glab release create` — and stays hands-off for `self`, where publication is manual. `flow finish` proves a squash-merged branch via `gh pr list`, or the GitLab API via `glab api projects/:id/merge_requests?source_branch=…&state=merged`, or ancestry alone — an unverifiable branch is still never deleted.
- **`flow doctor` reviews reflections and routes the fixes.** Bare doctor now lists every open `reflections.md` item with its section and a fix route: playbook item → a docs flow (`flow start fold-<topic> --docs --confirmed`), plugin item → an upstream issue in your repo or a patch/normal flow inside the dev-flow repo. It still never writes, never asks — CI-safe. `flow doctor "<observation>"` (new form) prints an investigation brief and a fix route for a fresh note without queueing it; `flow doctor reflect "<note>"` still parks raw notes.

### Changed

- **`.dev-flow/project.md` now lives in git** — the one tracked file under `.dev-flow/`. The self-ignoring `.gitignore` heals to `*` + `!project.md`, doctor finds an untracked playbook (tracking is `git add -f` — a root `.gitignore` may exclude `.dev-flow/` wholesale, and a tracked file outranks the ignore), and write discipline is enforced instead of conventional: the main-checkout playbook is blocked for agent edits and bash writes outright, and the worktree copy is writable only inside an operator-granted **docs or patch flow** — playbook updates go through the docs flow, with its gates as the confirmation.
- **`release.github` is renamed `release.releases`** (operator's call): the old key still parses, with a rename warning from doctor.

### Removed

- **`project.json` is gone.** It is no longer read at all (`loadConfig`/`mergeConfig` deleted); a leftover file is a doctor finding — fold the values into `project.md` and delete it. `flow init --write` was already the only sanctioned write path and stays it.

## [0.31.0] - 2026-10-15

### Added

- **`flow verify` re-probes the deploy it just made.** `flow check` records `health` PASS *before* the deploy, so a `commands.dev` that failed to restart the container, brought it back unhealthy, or left it serving the previous image used to walk through the gate on evidence about a container that no longer exists. Verify now runs the project's own probe — `commands.health`, or a `flow-check` block named `health` (`seedData` first when set) — right after a successful dev deploy, in the worktree, records it, and **refuses the gate** when it fails: `post-deploy probe FAILED (<cmd>):` plus the output tail. What "healthy and serving the expected version" means stays project knowledge, not plugin knowledge: the probe runs with the worktree as cwd, so the project's script waits for readiness and compares the served build stamp with `git rev-parse HEAD`. No new config key.
- **Success output names it**: `dev ran (bun run build:bff && docker compose -f docker/compose.yml up -d); health: PASS (./scripts/probe-dev.sh)`, or `health: none configured` — a missing probe is a notice, never a block (the gate must stay walkable for playbooks that deploy without a probe).
- **doctor finding**: `dev` deploy configured with no health check — verify cannot prove the deploy came back serving this build.

## [0.30.2] - 2026-10-15

### Fixed

- **`flow init --write` no longer claims `.dev-flow/ created` in a repo that already had it** (#39). The recursive mkdir cannot tell the two apart, so every init path — worst the agent-only `--write` path — printed a creation that never happened, and the agent went off to diff its own playbook for damage that had not been done. Creation is now reported only when the folder was really created; otherwise `--write` prints just `project.md written (operator-owned playbook)`.
- **`flow verify` says which commands it ran** (#38). `commands.dev` can rebuild an image and recreate a live container — minutes of work and a real side effect — while the only output was `verified … — entering pre-release stage.`, which read as if nothing had run. The gate now prints `build ran (<cmd>)` / `dev ran (<cmd>)`, or `dev: none configured`, on success and on the "verification needs the operator" path alike, and names the command in the Verified? prompt. Same precedent as `setup ran in the worktree (<cmd>)`; checks, guardrails and prompts are unchanged.

## [0.30.1] - 2026-10-14

### Fixed

- Documentation consistency: the extension header's stale stage/gate lists (missing `pre-release`, missing the `release` gate, "merged worktree" criterion), the skill playbook's operator-config rule now names `project.md` (legacy `project.json` noted as superseded), `flow help`/command description now show `start --force` and the `release-done` opt-out flags, the README status-bar bullet documents the mode markers (⚡/📄/🎱) and the `flow status` mode tags + `flow=<ver>` stamp; a dead v0.5.0 limitations line was dropped. No behavior change.

## [0.30.0] - 2026-10-14

### Added

- **`flow help`** (aliases `--help`, `-h`) prints the gate usage — answerable in any repo, at any stage, with no `.dev-flow/` (where `flow --help` used to fall into an unknown-subcommand error).
- **Version stamp at `flow start`.** Start prints the dev-flow build that created the feature and persists it (`state.flowVersion`); `flow status` shows `flow=<ver>` per feature — a stuck flow can now be read against the tooling that started it.
- **Unversioned release: `flow release --no-version`.** Default stays versioned (bump + tag). When the operator chooses it at the Release? step, the gate skips the manifest-bump and changelog requirements and `release-done` skips the whole version/tag/artifact machinery for that flow, recording the release with an `unversioned` note; status marks it `[no-version]`.
- **Yolo mode: `flow approve --yolo`.** The operator's word at Approve? pre-confirms every later gate question (Verified?/Release?/Finish?) so the agent drives the flow through without stopping. Tier-1 checks still block gates, and guardrails stay fully enforced — a flow-guard `confirm` rule still asks the operator. Status marks it 🎱; the stage context tells the agent not to re-ask.

### Docs

- README command table and the dev-flow skill playbook cover when "yolo" / "no version" in chat license the flags.

## [0.29.0] - 2026-10-15

### Added

- **`--docs` mode — the most relaxed release lane.** For docs-only work: no plan file (like `--patch`) **and no tier-1 checks** (build/lint/test skipped at verify and the release gate); worktree/branch discipline and the full release (version bump, changelog, tag, gate questions) stay untouched. Status marks it `📄` (patch keeps `⚡`).

### Changed

- **Relaxed modes are operator-granted, mechanically.** `flow start` refuses `--patch` or `--docs` without `--confirmed` — reusing the convention that `--confirmed` may only anchor a literal operator chat answer, self-selection is impossible: the agent proposes a mode, the operator grants it in chat, the gate enforces the grant. `--patch --docs` together is refused (exclusive). The skill playbook's checkpoint rule now names the failure it prevents: gate verbs and mode grants are plain chat only — a structured question-tool dialog is not an operator answer and never licenses `--confirmed`.
- **Clarify before drafting.** The plan stage opens with investigation, a preliminary direction presented to the operator in chat, a mode proposal with reasoning, and clarifying Q&A — only then is the plan drafted. Encoded in the skill playbook and the plan-stage hints; normal mode keeps enforcing the written `plan/*.md` at approve (it always did — this is what `--patch` used to skip, by operator grant only).

## [0.28.0] - 2026-10-14

### Changed

- **`/flow` output is a conversation message, not a popup.** Gate output (the command handler, the panel-mode hint, the no-feature notice) used to arrive as a `ui.notify` toast — easy to miss, gone on scroll, and colored severity nobody saw in time. It now goes through `pi.sendMessage({customType: "flow", display: true})`, rendering as a persistent `[flow]` box in the transcript in both the TUI and the web UI, with no model turn triggered. The gate confirmations, the `flow init` editor and the `ctrl+,` panel stay dialogs — they are operator input, not output.

## [0.27.0] - 2026-10-14

### Added

- **`flow finish` cleans the remote too.** Every release used to leave `origin/feat/<slug>` behind (a squash-merged repo accumulated one stale branch per release, each keeping the pre-squash commit line alive in every contributor's graph and making released work look unmerged). Finish now deletes the feature's remote branch — but **only on proof it was merged**: the branch is an ancestor of `origin/<default>` (merge-commit merges, repo-local), or `gh pr list --state merged` confirms a merged PR (squash merges, same advisory-gh posture as the GitHub release). Unverifiable branches are kept with the reason and the manual command in the output — never a silent delete, never a block on the release. No new config: the verification is the safety.

## [0.26.0] - 2026-10-14

### Changed

- **One release question.** The release stage asked the operator twice — `Release?` (pre-release → release) and `Ship?` (`release-done`) — but by the time `Ship?` came the PR was merged and the tag pushed: the answer ratified a fait accompli and could still only skip the advisory GitHub release. `flow release-done` is now **check-only**: it re-verifies (tag rendered from the manifest version, reachable from the default branch, present on origin, artifact check when configured), records the release and creates the GitHub release without a checkpoint; the surviving `Release?` dialog names its coverage ("Publishing starts: PR, merge, tag — release-done afterwards needs no further answer"). `--confirmed` is still accepted by `release-done` as a silent no-op; `--no-github-release` / `--no-artifact-check` stay operator-instructed-only, anchored on the chat answer. Checkpoints per release drop from five to four: Approve? / Verified? / Release? / Finish?.

## [0.25.0] - 2026-10-14

### Added

- **Session claims — auto-bind no longer silently joins a live session's feature.** A second pi session on the same checkout used to auto-bind onto the one unfinished feature and become its unwitting caretaker — a stray verification run could commit that worktree's work as its own. Every bind (`start`, `use`, auto-bind) now leaves a claim in the feature directory (`claim.json`: session key + pi pid). Auto-bind refuses a feature whose claim is held by a **live** process (pid probe; a claim from a dead process is void and gets replaced), and the unbound-session context names the blocked feature and its `flow use <slug>` takeover. An explicit `flow use` always wins and says so when it takes over from a still-running holder. Liveness is pid-only: pid reuse can at worst force an explicit `flow use` instead of an auto-bind — friction, never a wrong commit.

## [0.24.0] - 2026-10-14

### Added

- **`flow version` — which dev-flow is this session running?** Prints the plugin's own version and the directory it was loaded from, e.g. `dev-flow 0.24.0 (pi-dev-flow at /home/me/.pi/agent/npm/node_modules/pi-dev-flow)`. The number comes from the nearest `package.json` named `pi-dev-flow` above the loaded extension module, so a session dogfooding a checkout and a session on an installed release can be told apart at a glance — previously the only way was digging through pi settings. Read-only like `doctor`: no stage, no `.dev-flow/` required, nothing written. It reports the **plugin's** version, never the project's `versioning.file` version the release gates use.

## [0.23.0] - 2026-10-14

### Added

- **The `pre-release` stage — a checkpoint before anything publishes.** `flow verify` now lands in `pre-release`, where the release preparation happens as worktree work: `/ponytail-review` + fixes, docs, the version bump, the changelog. The new **`flow release`** gate — the one **Release?** question — hands over to `release` only when the tier-1 checks are re-greened after those prep edits, the manifest version parses and is **ahead of the last tag**, and the changelog (when configured) mentions the version. The operator sees the PR summary, the version and the changelog entry *before* the PR, merge and tag start; the `release` stage now only publishes.
- **`flow finish` asks Finish?** — one unconditional operator question before the cleanup, called after every safety check so it is never wasted; commits that look unmerged (squash merges) are called out inside that same question.

### Changed

- The machine is now `plan → implement → pre-release → release → done`. The guards confine `pre-release` to the feature worktree exactly like `implement`; pushing to or merging into the default branch still requires stage `release`.
- project.md gains `## pre-release` (prose, checklist items, and the `versionFile`/`versionTag` keys; existing `## release` keys keep parsing unchanged so old playbooks are untouched), and `flow init --draft` generates the new section.

## [0.22.0] - 2026-10-14

### Removed

- **`flow exempt` — there is no bypass any more.** In a repo with a `.dev-flow/`, every request goes through `flow start`/`flow use`: the command, the `◆ exempt` status marker and the write-guard hole it opened are gone. The `flow-guard` rules in project.md `## global` remain the operator's valve, and they now run **ahead of** dev-flow's own verdicts on edit paths too (they already did on bash) — so a `protect`/`forbid` rule reports the reason you wrote instead of a stage complaint.
- **The `cleanup` and `deploy` commands, and their stages.** The machine is now `plan → implement → release → done`: `flow finish` closes a released feature in one step, so the flow has one closing door instead of three that had to be walked in order. `release-done` records the release and no longer auto-removes the worktree, branch and feature dir.
- **`init --yes`** — documented as the CI fast path, never read by the code: a non-interactive session already is the CI path.
- **`commands.deployNote`** — it lived in the `## deploy` playbook section, which went with the stage. Production deployment stays manual, out of scope and never asked about.

### Added

- **`flow finish [slug]` — the closer.** It refuses until `flow release-done` has recorded a release, then requires the main checkout to be **clean and pushed** to `origin/<default>` (an uncommitted changelog or a local-only release commit is exactly what it protects against), removes the worktree and branch — asking only when commits look unmerged, e.g. after a squash merge — and deletes `.dev-flow/<slug>/`. Abandoning an unreleased feature is still `flow abort`.
- **`flow doctor reflect "<note>"` — the suggestion queue, filed by target.** `reflections.md` is now a document with up to two sections: `## playbook` (what to change in your playbook) and `## plugin` (what to change in dev-flow). The note's wording decides where it lands, a note about both goes to both, legacy flat `- [ ] (plugin) …` lines are bucketed and their inline marker dropped on the next write, and whatever the operator wrote above the first item is kept verbatim.

### Changed

- Advice is parked where it is reported: the top-level `flow reflect … [--to playbook|plugin|doctor]` is gone, `flow doctor reflect "<note>"` is the one form (`flow doctor` on its own still only reports and never writes).

## [0.21.0] - 2026-10-14

### Changed

- **This checkout now loads its own working extension, and always will.** `.pi/extensions/dev-flow.ts` is a committed one-line re-export of `extensions/dev-flow.ts` instead of an untracked hard link that a `git pull` silently left behind. A fresh clone of dev-flow needs no setup to dogfood itself, and after any merge or pull new sessions run main's current code — nothing to re-run. (A symlink cannot be used here: pi resolves a module's relative imports from the link's own directory, so the extension's `../src/core.ts` would not resolve.)

### Added

- **`flow doctor` now flags broken dogfood wiring**: in a `pi-dev-flow` checkout, a missing `.pi/extensions/dev-flow.ts` — or one that no longer re-exports `../../extensions/dev-flow.ts` — is a finding, because sessions in that checkout would silently load nothing (or stale code).

## [0.20.0] - 2026-10-14

### Added

- **`flow doctor` — the doctor as an endpoint, not a side effect of `flow init`.** Findings on demand: playbook drift and dead commands/scripts, ghost feature dirs, orphan worktrees and branches, open reflections — printed as `doctor: N finding(s)` plus one line each, or `doctor: no findings — playbook, flow state and git layout are consistent`. It writes nothing, asks nothing and deletes nothing, so an agent or a CI job can run it at any stage with no flow bound; `flow init` stays the fix path, the one that can write.

### Changed

- `flow init` **without a UI prints the findings it computed** (the `--yes`/CI path said "the doctor ran" and showed nothing).
- `flow status` runs the cheap probes even when no feature is unfinished — it used to return `no features` before reaching them — and points at `flow doctor` for the full list.
- The git consistency probe no longer flags an active feature's own branch as an orphan: `git branch --list` marks worktree-checked-out branches with `+ ` and only `* ` was stripped, so the marked name never matched the owned set.

## [0.19.1] - 2026-10-14

### Added

- **The doctor finds ghost feature dirs and offers to remove them.** A `.dev-flow/<slug>/` holding a `plan/` with no `state.json` — a feature closed by hand before auto-close existed, or an interrupted `flow start` — was invisible: `flow status`, the guards and auto-bind all key off `state.json`, so the clutter was only findable by eye. `flow status` now counts it as a doctor finding and `flow init` offers to delete exactly those directories, one confirm, with the plan files called out as unrecoverable; decline keeps them, and with no UI nothing is deleted (the finding says how to do it by hand). Live features, `cleanup`/`deploy` leftovers and `project.md` are untouched by construction.

### Changed

- The status warning reads `⚠ doctor: N finding(s) — run flow init` instead of `⚠ project.md:`, since findings now cover flow state as well as the playbook.
- Internal: `loadProject(dfDir)` dropped its never-read `root` parameter.

## [0.19.0] - 2026-10-14

### Added

- **`flow-guard` — the playbook carries the project's own safety rules**, so an adopting project can delete its own guard extension. A ` ```flow-guard ` block in `## global` of project.md holds `deny`/`confirm` rules (JS regex over one shell segment of a bash command) and `protect`/`forbid` rules (a repo-relative edit/write path; a directory covers its subtree, files that do not exist yet included). `deny`/`forbid` block outright; `confirm`/`protect` ask the operator and block when no UI is present — a hidden confirmation is not a confirmation. Every rule carries a ` :: <why>` reason that shows up verbatim in the block, and a bad regex is a hard finding so `flow init --write` refuses the file. Enforcement reuses the existing tool-call guards (rules cover `docker`/`gh`/everything, not only git), runs at every stage, and is not lifted by `flow exempt`. Read-only segments are skipped, so `grep "git push --force" docs/` searches instead of pushing.

### Fixed

- **`flow init` no longer destroys a hand-written project.md.** The doctor's refresh regenerated the file from detection + config, which silently reverted hand-set keys (`versionTag = {version}` → `v{version}`) and deleted every tier-3 prose line and extra checklist item — and its confirm could be answered by an agent driving `flow init` through the `flow` tool. The refresh is now refused outright when the current file has lines a regenerated draft cannot reproduce: it prints the findings plus the lines it would drop. `--force` stays the deliberate overwrite.
- **`commands.setup` now runs** — once, inside a freshly created worktree at `approve`, which is where `cp docker/.env` + `bun install` belong; a failing setup fails the gate instead of approving an unusable worktree. `commands.run` was documented as if executed and never is: it is now documented as advisory (the agent starts the app with it for the running-and-healthy walk).
- **Doctor stopped flagging worktree-relative paths forever**: command arguments are only probed as repo-root paths, so `cp -n ../../docker/.env` — correct relative to the worktree the check runs in — is no longer reported as a missing file.

## [0.18.0] - 2026-10-13

### Added

- **Compact-aware**: when context nears pi's auto-compaction threshold, dev-flow now compacts *itself* at a safe point — right after a gate wrote state to disk, or when a run settles — with flow-aware summary instructions (slug/stage-aware; keeps operator answers, uncommitted-change rationale and next action verbatim). It never self-compacts while chat is the state: an open tier-2 dialog or a plan discussion not yet in `plan/` blocks it. If pi force-compacts anyway (threshold/overflow while a feature is bound), a pacing note lands in `reflections.md` for the operator — advisory, never a gate.

## [0.17.0] - 2026-10-14

### Changed

- First `flow init` writes `.dev-flow/project.md` immediately — the pre-write editor/confirm dialogs are gone. The review loop moved onto the file: confirm as-is, or say what to change; the skill tells the agent to ask one short question per knob, apply answers via `flow init --write`, and re-present until confirmed

### Kept

- Doctor mode (existing playbook) still confirms before refreshing — it must never silently overwrite hand edits; `--draft` prints without writing; `--force` remains the deliberate overwrite

## [0.16.1] - 2026-10-14

### Fixed

- `flow init` confirm dialog is now human: one line per phase with real values (commands quoted, checklist items and guidance verbatim, rendered tag pattern, whether a GitHub release is created, which artifact check runs) instead of parser notation (`set: file, pattern · prose`); states plainly what Cancel does and where to read the full file first
- `flow init --draft` — referenced by the docs since v0.9 but never implemented — now prints the draft (or the current file in doctor mode) and writes nothing; tool help lists `--draft` and `--patch`

## [0.16.0] - 2026-10-14

### Added

- `flow start <slug> --patch` — chore releases with reduced paperwork: no plan document (the one-line start description is the plan); approve, worktree discipline, tier-1 checks, verify, tagged release and audit trail unchanged. Status marks patch features with an amber marker. (Folded reflection: release-patch shortcut)

## [0.15.2] - 2026-10-14

### Changed

- `flow abort` at plan stage (nothing approved) removes the feature dir outright — a kept-over plan-stage state dir stayed "unfinished" forever and the one-unfinished-feature auto-bind resurrected the ghost into every unbound session

### Fixed

- Per-segment git guard: each git command in a chain is judged by the branch of the directory it actually runs in (incl. its own `git -C`); previously the last `cd` in a compound command set the verdict for all git calls, blocking legitimate worktree commits (hit two real releases) and weakening mixed-chain checks symmetrically
- `git checkout -b feat/x` in the main checkout is now blocked like a plain checkout of a feature branch
- `flow init` reports when an existing pre-commit hook prevents installing the dev-flow hook (main commits outside Pi are then unguarded)
- `flow` tool description matches its actual subcommands (shared const with the help line)
- Docs: the `dev` command must background and exit — `flow verify` waits for it (15-min cap)

## [0.15.1] - 2026-10-14

### Changed

- One-word checkpoints: gates ask **Approve? / Verified? / Ship?** — the verb doubles as the operator's answer; dialogs carry the same verb with just enough context, cleanup still asks only when unsafe, deploy stays silent

## [0.15.0] - 2026-10-14

### Added

- `release.artifact` playbook key: `release-done` verifies the published artifact (any command — `docker manifest inspect`, registry `curl` — with `{version}`/`{tag}` placeholders) after the tag lands on origin; failure blocks the release; `--no-artifact-check` skips once (operator's call, audited). Set = every tag must show its artifact; unset = none

### Changed

- `release-done` refuses local-only tags: the tag ref must exist on `origin` (`git ls-remote`) when a remote is configured — `git push --follow-tags` silently skipping lightweight tags was producing releases that never existed upstream
- Doctor flags an implement stage whose tier-1 gates nothing (no test, no health, no `flow-check`)
- SKILL: annotated tags with explicit `git push origin v<ver>` (never `--follow-tags`); incremental worktree commits instead of a monolith at review time; plan-stage check for local-only default-branch commits that would fall out of the worktree base

## [0.14.2] - 2026-10-12

### Added

- GitHub release opt-out valves: playbook key `release.github = false` never attempts `gh release create` (self-hosted or Releases-unused repos); `flow release-done --no-github-release` skips it once, recorded in the audit line; the single release question states whether a GitHub release will be created; SKILL restricts skipping to explicit operator decisions

## [0.14.1] - 2026-10-12

### Changed

- SKILL: handling additions mid-implement — same-feature scope grows in place (plan.md amended with an "Added mid-stage:" line, stay at implement; edit invalidation makes verify re-cover it); a different problem becomes a new flow instead of a folded second feature; formal re-review of an amended plan is a chat re-approval — no reopen gate by design

## [0.14.0] - 2026-10-12

### Changed

- `flow release-done` creates the GitHub release for the verified tag (title = tag, notes = tag annotation) — advisory: missing gh, no GitHub remote or an existing release prints a note and never blocks
- A clean release now closes itself: when the worktree has no uncommitted changes and nothing unmerged, `release-done` removes worktree, branch and feature dir in one step — zero operator actions after merge; dirty or unmerged-looking worktrees still stop at `flow cleanup` and ask
- `flow cleanup`/`flow deploy` remain as the not-clean / manual path

## [0.13.0] - 2026-10-12

### Changed

- One crisp question per checkpoint: gate confirms are single-line questions (multi-line markdown blobs rendered unreadably where clients collapse newlines); plan and checklist detail live in files
- Tier-2 checklist items support a `(ui)` marker in project.md — UI-only items vanish entirely (dialog, injection, confirmation hash) for non-UI features; non-UI work is no longer asked about mockups or visual passes
- `--confirmed` operator-presence flag (approve/verify/release-done/cleanup): when the operator answered the stage question in chat, gates proceed without a second dialog and record the audit line — one checkpoint per stage
- New `dev` implement-stage command: `flow verify` deploys to dev first (recorded tier-1 check) so the operator reviews the running app; unconfigured verify says nothing about dev (the dead "no run command configured" text is gone)
- `flow release-done` asks the single release question (changelog, tag and merged PR covered by one answer)
- `flow cleanup` is silent when the worktree is safe and asks only when commits look unmerged; `flow deploy` never asks — production deploy is manual and out of scope

### Fixed

- Approve/verify dialogs no longer present UI checklist items to non-UI features

## [0.12.0] - 2026-10-12

### Added

- `reflect` — the agent's suggestion queue: `flow reflect "<note>" [--to playbook|plugin|doctor]` appends one line to `.dev-flow/reflections.md` (drifted commands, gate friction, plugin bugs), `flow reflect` lists open items. The open count surfaces in `flow status`, stage injections and the init doctor; fold-in goes through the existing validated `playbook --write` path and items are checked off with a normal edit. Advisory by design — reflections never gate anything, and `project.md` keeps its operator-only contract

## [0.11.0] - 2026-10-12

### Changed

- Push guard is now ref-aware: each push's refspec is parsed (deletes judged by source, `HEAD` = current branch, `--mirror` worst-case) and bare names resolved against `refs/tags` — only pushes that write the default branch require stage `release`; tag pushes and feature-branch pushes pass from any stage. The old substring heuristic (which blocked `git push origin v1.0` and anything mentioning `main` in a chained command) and the park-`.dev-flow` tag-push workaround are gone

### Fixed

- Draft playbooks no longer inject a placeholder health check (`curl localhost:3000/healthz`) — in repos without a server it was an always-red tier-1 gate blocking verify forever
- Doctor refresh no longer drops explicit `flow-check` blocks — every tier-1 check is carried through regeneration (previously the refreshed playbook silently lost teeth)
- `.gitignore` entry `node_modules` matches symlinked `node_modules` (trailing-slash pattern didn't)

## [0.10.0] - 2026-10-12

### Added

- **Flow by default**: in a repo with `.dev-flow/`, an unbound session can no longer touch source files — every request goes through `flow start`/`flow use` unless the operator exempts the session with `/flow exempt <reason>` (session-scoped, survives resume, `flow exempt off` clears, `◆ exempt` shown in the status bar; `project.md`/`state.json` stay protected even when exempt). Unbound sessions get the posture injected at turn start, including a flag when the main checkout isn't on the default branch
- Doctor (init) git-consistency findings: orphan worktrees, orphan feature branches, and features whose worktree vanished; `flow abort` now prints the exact commands to remove worktree + branch

### Changed

- `flow start` refuses when the main checkout is on another branch (`--force` to override) — features must base on the default branch
- Worktrees are created from `origin/<default>` explicitly (fallback `<default>`) — never from whatever HEAD the main checkout happened to sit on
- The agent cannot check feature-pattern branches out in the main checkout; feature branches are only usable inside their own worktree
- `flow use` prints the bound feature's worktree path

## [0.9.0] - 2026-10-12

### Added

- `project.md` — the operator playbook in Markdown, three tiers by notation: ` ```flow key = value ` blocks and named ` ```flow-check <name> ` blocks are tier 1 (gates run every check via `flow check`, record pass/fail, worktree edits invalidate); `- [ ]` checklist items are tier 2 (confirmed as a hashed set in gate confirms — edits reset the confirmation); stage prose is tier 3 (injected to the agent at stage entry). Unknown stages/keys warn, never fail; broken syntax rejects with line numbers. `project.json` remains as legacy base (project.md overrides; doctor flags having both)
- `flow init` v2 — advisory dialogue instead of the scripted wizard: fresh repos draft from detection and confirm once; `--draft` / `--write "<content>"` is the validated agent path (line-pointed rejection); on an existing file init becomes the **doctor** (command drift, dead script files, missing/unparseable version manifest, dual configs, missing health check — file probes only, never runs project commands) offering a refresh that keeps configured values
- Init review UX: TUI opens the draft in a multi-line editor (review *and* edit before anything is written); elsewhere a per-stage digest confirms instead of a raw markdown dump; every write prints how to change the playbook afterwards
- `flow check` runs the whole tier-1 set (auto-includes configured test/health commands) and records each result

### Changed

- Gates generalize to named checks: `flow verify` demands every tier-1 check green plus the tier-2 confirmation before asking the operator; `flow status` flags pending doctor findings
- Git ops in bash gates are judged by the branch of the directory git actually runs in (`git -C`, preceding `cd`), so worktree work no longer misjudges against the session root; cleanup unstuck for worktree-hosted releases

### Removed

- The interactive init wizard (`--step` machinery) — replaced by draft/discuss/write; `flow init --yes` and `--force` keep the scripted fast paths

## [0.8.0] - 2026-08-05

### Added

- `flow init --force`: overwrite an existing `project.json` with fresh detection (silent fast path; destructive reset for a misconfigured repo)

### Changed

- `flow init --yes` never overwrites an existing config, even headless; the "already exists" note now advertises `--force`

## [0.7.0] - 2026-08-04

### Added

- Interactive `flow init` wizard: walks the operator through every setting (default branch, commands, version manifest + tag pattern, worktree dir, main-hook) showing `value [configured|detected|default]` — keep/change/remove per item, pick manifest from candidates; nothing writes before a final diff confirm, Esc aborts unchanged
- Re-running `flow init` on an initialized project is a review-and-edit flow (existing config wins over re-detection); `flow init --yes` and headless sessions keep the silent fast path

### Fixed

- Default branch is never proposed from a feature branch (origin/HEAD → current branch only if it looks default-like → "main"), preventing a hooked-up repo from blocking its own feature branches

## [0.6.0] - 2026-08-04

### Added

- Healthy local run as implementation-complete criteria: optional `commands.seedData` (ensure pre-existing data) and `commands.health` (must exit 0 only when the app is up locally with real data); new `flow health` gate records the check; `flow verify` now requires green test AND health (when configured) checks plus build; worktree edits invalidate both checks — "running and healthy" is enforced, not honor-system
- Versioning approach: `flow init` detects the version manifest (`VERSION` → `package.json` → `Cargo.toml` → `pyproject.toml`) into `versioning.file`, with an explicit "clarify with the operator" report line when none exists; `versioning.pattern` (default `v{version}`) derives the release tag from the manifest; `flow release-done` refuses unless that tag exists and is reachable from the default branch — manifest, changelog and tag must agree

### Changed

- Release playbook and status hints now derive the tag from the version manifest (`flow next` shows the exact bump + tag to perform)

## [0.5.0]
### Added
- Session-scoped flows: a pi session binds to one feature (persisted per session branch, restored on resume/fork). `flow start` binds, new `flow use <slug>` switches; a lone unfinished feature binds automatically, ambiguous sessions must bind or pass explicit slugs. One feature per session, many sessions per repo, is now the supported concurrency model.
- Write enforcement is by path attribution: every write is judged by the stage of the feature owning that worktree, whichever session attempts it — parallel sessions cannot clobber each other or write into plan-stage features.
- Release playbook requires the project's version manifest (`package.json`/`pyproject`/`Cargo.toml`/`VERSION`) to be bumped to the exact tagged version in the same release; dev-flow's own manifest (drifting at 0.1.0) is re-synced here.

### Removed
- `.dev-flow/.current` (repo-global pointer) — superseded by session bindings; `flow init` migrates it away.

## [0.4.1]
### Fixed
- Detail panel check timestamps now show local time instead of UTC.

## [0.4.0]
### Added
- Flow status in the pi status bar: `◆ <slug> ▸ <stage>` in the footer, stage-colored, `✗` when a recorded check is failing; cleared when no feature is active. Refreshed at session start, every turn end, and after each gate.
- `ctrl+,` opens a detail panel (slug, stage, branch/worktree, approvals, checks with timestamps, next step); Esc closes. Non-TUI modes degrade to notifications.

## [0.3.0]
### Changed
- UI features now gate on **rendered mockup screenshots**: default `mockupGlobs` is `["*.png"]`, and an `--ui` plan without renders under `plan/` cannot be approved. HTML sources stay encouraged but ungated.

### Added
- The `dev-flow` skill documents the mockup workflow: HTML sources + renders in `plan/mockups/`, headless chromium probe (system chrome → playwright `chrome-headless-shell`), per-width renders embedded in plan.md (`![screen — width](mockups/x.png)`) so approval is one browsable document, and an explicit no-chromium fallback that never fakes a screenshot.

## [0.2.0]
### Added
- `flow init` analyzes the project and writes a starter `.dev-flow/project.json` — default branch from git, package manager from `packageManager`/lockfiles, `test`/`build`/`run` from npm scripts, or cargo/go/python (uv/poetry/pytest) conventions. Existing config is never overwritten; the report shows what was guessed and what was left empty.
- `.dev-flow/` now ignores itself and everything under it via a folder-local `.gitignore` containing `*`.

### Changed
- `flow init` no longer edits the tracked root `.gitignore`.

## [0.1.0]
- Initial release: stage gates (`start`/`approve`/`test`/`verify`/`release-done`/`cleanup`/`deploy`) over a per-feature state machine, tool-call guardrails (main-branch protection, worktree confinement, untouchable state), per-turn stage context, the `dev-flow` agent skill, and the main-branch `pre-commit` hook.
