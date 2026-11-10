/** dev-flow runtime — The gates that ship: verify, release, release-done, finish. Moved out of extensions/dev-flow.ts as is (exports added). */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applicableItems, changelogVersionsBetween, normalizeReleaseBody, pendingEntryLines, pickReleaseNotes, checklistHash, checklistPending, cmpVersions, freshenChecks, healthProbe, mergeShapeProof, preReleaseGate, reflectionNudges, conflictMarkerLines, isReleaseOnly, looksLikeShellError, needsOperator, newestTaggedVersion, nextHint, releaseGate, parseVersion, roadmapDoneForSlug, sq, tagNotesCommand, verifyGate, versionTagGate, servedBuildMatches, versionArg, playbookVersionChoice, describeVersionChoice, majorBump, bumpVersion, isBumpKind } from "../core.ts";
import type { Config, FlowState } from "../core.ts";
import { AGENT_MARK } from "../present.ts";
import { buildSkew, copyWarning, currentBranch, featDir, flagValue, forgeMergeStyle, forgeOf, gateCwd, mergeBase, needState, now, originUrl, readReflectionsText, readRoadmap, readState, releaseTags, roadmapFile, sh, tail, worktreeAbs, writeState } from "./base.ts";
import { type RunResult, branchState, catchUp, describeBranchState, devEnv, devPortOf, devSlotCheck, healthRerunsAfterDeploy, pendingChecks, probeHealth, readDevPorts, runChecks, slotKey, triedNote, unreleasedOnMain, worktreeFingerprint, writeDevPorts } from "./checks.ts";
import { type GateCtx, markPendingAsk } from "./gates.ts";

/** gh#198: the version question asked with Verified? — null when it is not the operator's to answer here
 *  (no manifest to version, the playbook decides, or an earlier Verified? already recorded the call). */
function versionQuestion(root: string, state: FlowState, cfg: Config): { ask: string; flags: string } | null {
	if (!cfg.versioning.file || playbookVersionChoice(cfg) || state.versionChoice) return null;
	const file = path.join(gateCwd(root, state), cfg.versioning.file);
	const now = existsSync(file) ? parseVersion(cfg.versioning.file, readFileSync(file, "utf8")) : null;
	const kinds = (["patch", "minor", "major"] as const).map((k) => `${k}${bumpVersion(now, k) ? ` (→ ${bumpVersion(now, k)})` : ""}`).join(", ");
	return {
		ask: `also ask the release call: a ${kinds} release — propose one by the playbook's versioning rule${now ? ` (${cfg.versioning.file} is at ${now})` : ""} — or merge unreleased (no bump, no tag)${state.docs ? "; a docs flow usually merges unreleased" : ""}`,
		flags: "--version=patch|minor|major (or the exact version they named) or --no-version (merge unreleased)",
	};
}

export async function gateVerify(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const items = applicableItems(cfg, state!, "implement");
	// gh#198: the release call (versioned vs unreleased) rides on the Verified? answer — the prep that follows depends on it
	const verArg = versionArg(flagValue(o.rest, "version"), flag("no-version"));
	if ("error" in verArg) return { text: `verify gate FAILED:\n- ${verArg.error}`, isError: true };
	// the operator reviews the tree that ships: catch up with the default branch before anything runs
	const caught = state!.stage === "implement" ? await catchUp(root, state!, cfg, flag("confirmed")) : { note: "" };
	if ("text" in caught) return caught;
	const branch = await branchState(gateCwd(root, state!), cfg.defaultBranch);
	if (branch.commitsAhead === 0 && cfg.versioning.file) branch.unreleased = await unreleasedOnMain(gateCwd(root, state!), cfg.versioning.pattern);
	const branchLine = describeBranchState(branch, cfg.defaultBranch);
	// A green record belongs to the tree it ran against. A worktree change made through bash (sed,
	// a formatter, codegen) fires no edit-tool invalidation — the fingerprint is what notices the
	// tree moved, and the dropped records become pending so the gate itself reruns them (#84 path).
	const staleAtGate = freshenChecks(state!, await worktreeFingerprint(gateCwd(root, state!)), (n) => n === "health" && healthRerunsAfterDeploy(cfg));
	if (staleAtGate.length) writeState(root, state!);
	const pending = pendingChecks(state!, cfg);
	const gateRun = pending.length ? await runChecks(root, state!, cfg, pending) : null;
	if (gateRun?.failed) return { text: `verify gate FAILED — a check run at the gate failed:\n${gateRun.lines.join("\n")}\n${branchLine}`, isError: true };
	// tier-1 gate first (tier-2 confirmation is recorded by this very command, so it is excluded here)
	const preGate = verifyGate({ ...state!, confirmations: { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } } }, cfg, branch);
	if (preGate.length) return { text: `verify gate FAILED:\n- ${preGate.join("\n- ")}\n${branchLine}`, isError: true };
	// a stack another flow is reviewing or releasing on is not this gate's to take — ask before deploying
	const slotted = cfg.commands.dev && !state!.docs ? await devSlotCheck(o, state!) : { note: "" };
	if ("text" in slotted) return slotted;
	// commands that take minutes and touch live services must say so (#38): a terse gate let the
	// agent tell the operator the dev deploy had never run, right after it recreated a container.
	const did: string[] = [];
	if (caught.note) did.push(caught.note);
	if (slotted.note) did.push(slotted.note);
	if (gateRun) did.push(`checks ran at the gate (${pending.map((c) => c.name).join(", ")})`);
	if (staleAtGate.length) did.push(`stale record(s) rerun after a worktree change: ${staleAtGate.join(", ")}`);
	if (state!.docs) {
		// docs mode's contract: no tier-1 work happens, so a docs flow neither builds, deploys nor probes (#43 #49)
		did.push("docs mode: project commands skipped (build/dev/health)");
	} else {
		if (cfg.commands.build) {
			const res = await sh(cfg.commands.build, gateCwd(root, state!), undefined, devEnv(root, state!, cfg));
			state!.checks.build = { ok: res.ok, at: now() };
			writeState(root, state!);
			if (!res.ok) return { text: `build FAILED (${cfg.commands.build}):\n${tail(res.out)}`, isError: true };
			did.push(`build ran (${cfg.commands.build})`);
		}
		// deploy to dev before asking — the operator reviews the running dev app, not a promise
		const probe = healthProbe(cfg);
		if (cfg.commands.dev) {
			const res = await sh(cfg.commands.dev, gateCwd(root, state!), undefined, devEnv(root, state!, cfg));
			state!.checks.dev = { ok: res.ok, at: now() };
			writeState(root, state!);
			if (!res.ok) return { text: `dev deploy FAILED (${cfg.commands.dev}):\n${tail(res.out)}`, isError: true };
			did.push(`dev ran (${cfg.commands.dev})${devPortOf(state!, cfg) !== undefined ? ` on port ${devPortOf(state!, cfg)}` : ""}`);
			// the deploy is what must be proven, not just run: a container that came back unhealthy, or
			// still serves the previous build, must not pass on a health PASS recorded before it was
			// recreated. What "the expected version" means is the project's business — the probe runs in
			// the worktree cwd, so it can compare the served build stamp with `git rev-parse HEAD`.
			if (!probe) did.push("health: none configured");
			else {
				const probed = await probeHealth(root, state!, cfg, probe);
				if ("seedFail" in probed) return probed.seedFail;
				if (!probed.ok) return { text: `post-deploy probe FAILED (${probe}) — the deploy is not healthy / not serving this build (gave up after ${probed.attempts} attempt(s), healthWait ${cfg.healthWait}s):\n${tail(probed.out)}`, isError: true };
				did.push(`health: PASS (${probe}${triedNote(probed.attempts)})`);
			}
		} else if (!probe) did.push("dev: none configured");
		else {
			// no deploy to prove, but the operator still reviews a live app — and a green health record
			// survives a killed server (process death dirties no worktree fingerprint), so the record
			// cannot stand for liveness: re-probe, before anyone is asked.
			const probed = await probeHealth(root, state!, cfg, probe);
			if ("seedFail" in probed) return probed.seedFail;
			if (!probed.ok)
				return { text: `live probe FAILED (${probe}) — nothing is answering and no dev deploy is configured: the app the operator must review has to be running before verify — start it and rerun (gave up after ${probed.attempts} attempt(s), healthWait ${cfg.healthWait}s):\n${tail(probed.out)}`, isError: true };
			did.push(`health: live re-probe PASS (${probe}${triedNote(probed.attempts)})`);
		}
	}
	if (!state!.docs && cfg.commands.servedBuild) {
		// "something answers" is not "this branch answers": the served commit must be the worktree's HEAD
		const head = (await sh("git rev-parse HEAD", gateCwd(root, state!))).out.trim();
		const sb = await sh(cfg.commands.servedBuild, gateCwd(root, state!), 60_000, devEnv(root, state!, cfg));
		if (!sb.ok || !servedBuildMatches(sb.out, head))
			return { text: `served-build check FAILED (${cfg.commands.servedBuild}) — the app is up but does not serve this branch's HEAD ${head.slice(0, 12)}:\n${tail(sb.out)}`, isError: true };
		did.push(`serves ${head.slice(0, 7)} (HEAD)`);
	}
	if (!state!.docs && cfg.commands.dev) {
		const head = (await sh("git rev-parse HEAD", gateCwd(root, state!))).out.trim();
		writeDevPorts(root, { ...readDevPorts(root), [slotKey(devPortOf(state!, cfg))]: { slug: state!.slug, head, at: now() } });
	}
	const ran = [branchLine, ...did].join("; ");
	// yolo is the operator's word at Verified? — answers this question and pre-confirms the later ones.
	// A re-verify at pre-release (gh#187) exists to put the new tree in front of the operator: a yolo given
	// before those commits existed never answers it.
	const reverify = state!.stage === "pre-release";
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	let audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo && !reverify ? " (yolo: pre-confirmed)" : "";
	const askPending = !flag("confirmed") && (!state!.yolo || reverify);
	if (askPending) {
		markPendingAsk(root, state!, "Verified?"); // pending however it is asked — a chat question or a dialog
		// the agent's call never opens a dialog (#181): this is the review deploy — the app is up for the
		// operator, and the answer comes back in chat as flow verify --confirmed
		if (!ui.hasUI) {
			const port = devPortOf(state!, cfg);
			const what = state!.docs ? "ready for review" : cfg.commands.dev ? `deployed for review${port !== undefined ? ` on port ${port}` : ""}` : "live app re-probed for review";
			const vq = versionQuestion(root, state!, cfg);
			return { text: `${needsOperator(`${what}${reverify ? ` — a re-verify over the review fixes since ${state!.verifiedHead?.slice(0, 7) ?? "the last Verified?"}` : ""} — the app stays up until you answer${vq ? ` — ${vq.ask}` : ""}`, "Verified?", `look at the change in the running app yourself first (the playbook's self-check), then ask the operator Verified? in chat and run flow verify --confirmed${vq ? ` ${vq.flags}` : ""} once they answer. Keep it running until they answer.`)}\n${ran}` };
		}
		const ok = await ui.confirm("Operator verification", `Verified? All checks green${cfg.commands.dev && !state!.docs ? `; dev deploy is up for review (${cfg.commands.dev})` : ""} \u2014 does it work?`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: `verification declined — stay in ${reverify ? "pre-release" : "implement"} and fix what failed` };
		}
		audit = " (confirmed in dialog)";
	}
	state!.confirmations = { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } };
	const final = verifyGate(state!, cfg, branch);
	if (final.length) return { text: `verify gate FAILED:\n- ${final.join("\n- ")}`, isError: true };
	state!.approvals.verify = now();
	if (isReleaseOnly(cfg, branch)) state!.releaseOnly = true;
	else delete state!.releaseOnly;
	// the tree the word was given over (#162) — a git that cannot answer leaves it unset, never a refusal
	const vHead = await sh("git rev-parse HEAD", gateCwd(root, state!));
	if (vHead.ok && vHead.out.trim()) state!.verifiedHead = vHead.out.trim();
	else delete state!.verifiedHead;
	// gh#198: the operator's call, else the playbook's, else whatever an earlier Verified? recorded
	const choice = verArg.choice ?? state!.versionChoice ?? playbookVersionChoice(cfg);
	if (choice) {
		if (choice !== state!.versionChoice || !state!.versionFrom) {
			const mf = cfg.versioning.file ? path.join(gateCwd(root, state!), cfg.versioning.file) : "";
			const from = mf && existsSync(mf) ? parseVersion(cfg.versioning.file!, readFileSync(mf, "utf8")) : null;
			if (from) state!.versionFrom = from;
		}
		state!.versionChoice = choice;
		if (choice === "unreleased") state!.noVersion = true;
		else delete state!.noVersion;
	}
	const choiceNote = choice ? `\nrelease call: ${describeVersionChoice(choice, state!.versionFrom)}` : "";
	const before = state!.stage;
	state!.stage = "pre-release";
	delete state!.pendingAsk;
	writeState(root, state!);
	if (before === "pre-release")
		return { text: `re-verified${audit} over ${state!.verifiedHead?.slice(0, 7) ?? "the current tree"} — the Verified? word now covers the review fixes; still in pre-release.${choiceNote}\n${ran}\n${AGENT_MARK}next: ${nextHint(state!, cfg)}` };
	return { text: `verified${audit} — entering pre-release stage.${choiceNote}\n${ran}\n${AGENT_MARK}next: ${nextHint(state!, cfg)}` };
}

export async function gateRelease(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// operator's word at Release?: this flow ships without a version bump or tag — recorded only once Release? is answered.
	// gh#198: --version=<v> / --no-version here re-make the call recorded with Verified? (the operator changed their mind)
	const relArg = versionArg(flagValue(o.rest, "version"), flag("no-version"));
	if ("error" in relArg) return { text: `release gate FAILED:\n- ${relArg.error}`, isError: true };
	const choice = relArg.choice ?? state!.versionChoice ?? playbookVersionChoice(cfg);
	const noVersion = choice === "unreleased" || (!relArg.choice && !!state!.noVersion);
	// (versioned) items stand down on an unversioned flow — the set confirmed here is the one that applies to it
	const items = applicableItems(cfg, { ...state!, noVersion }, "pre-release");
	// yolo is the operator's word at Release? — pre-confirms Finish?; publishing guardrails stay enforced
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	// prep evidence is read from the worktree: the bump and changelog entry exist on the branch before the PR merges
	const wtCwd = gateCwd(root, state!);
	// gh#131: a merge ships the branch, not the working tree — an uncommitted fix at this gate is a fix
	// that never ships. verify shows the operator uncommitted paths; release proves them away. A git
	// that cannot answer is a measurement failure, never a refusal — same stance as the merge-base probes.
	const dirtyWt = await sh("git status --porcelain", wtCwd);
	if (dirtyWt.ok && dirtyWt.out.trim()) {
		const n = dirtyWt.out.split("\n").filter((l) => l.trim()).length;
		return { text: `release gate FAILED:\n- ${n} uncommitted path(s) in ${state!.worktree} — a merge ships the branch, not your working tree: commit or discard them, then re-run\n${tail(dirtyWt.out)}`, isError: true };
	}
	const branchProof = await branchState(wtCwd, cfg.defaultBranch);
	const manifestVer = cfg.versioning.file && existsSync(path.join(wtCwd, cfg.versioning.file))
		? parseVersion(cfg.versioning.file, readFileSync(path.join(wtCwd, cfg.versioning.file), "utf8"))
		: null;
	// tags are only needed on the versioned path; a project without versioning must not be held up by an offline origin
	const remoteTags = cfg.versioning.file && !noVersion ? await releaseTags(root) : [];
	if (remoteTags === null) return { text: "release gate FAILED:\n- cannot list tags on origin (offline?) — retry; local tags do not decide what is already released", isError: true };
	const changelog =
		cfg.release.changelog && existsSync(path.join(wtCwd, cfg.release.changelog))
			? { file: cfg.release.changelog, content: readFileSync(path.join(wtCwd, cfg.release.changelog), "utf8") }
			: null;
	// The changelog's baseline is what was pending before this release. The newest tag wins over the
	// merge base: it is what actually shipped, and a rebase or squash merge can leave the merge base
	// unreachable — a git-topology accident must not refuse a legal release (#97).
	let changelogChanged: boolean | null = null;
	const changelogBase: { pending: string[]; source: "tag" | "merge-base" | "none" } = { pending: [], source: "none" };
	if (changelog) {
		const p = sq(cfg.release.changelog!);
		const mbRef = await mergeBase(wtCwd, cfg.defaultBranch);
		// proof the branch touched the changelog: local refs only, so the check stays offline-safe
		if (mbRef) {
			const changes = await sh(`git diff --name-only ${sq(mbRef)} -- ${p} 2>/dev/null; git ls-files --others --exclude-standard -- ${p}`, wtCwd);
			changelogChanged = changes.out.split("\n").some((l) => l.trim());
		}
		const newest = !noVersion && cfg.versioning.file ? newestTaggedVersion(cfg.versioning.pattern, remoteTags) : null;
		// tag first, merge base as the understudy: `releaseTags` asks origin, so a clone that has not
		// fetched the tag yet must still get a baseline instead of losing the fold proof
		const bases: { ref: string; source: "tag" | "merge-base" }[] = [];
		if (newest) bases.push({ ref: cfg.versioning.pattern.replace("{version}", newest), source: "tag" });
		if (mbRef) bases.push({ ref: mbRef, source: "merge-base" });
		for (const b of bases) {
			const base = await sh(`git show ${sq(b.ref)}:${p} 2>/dev/null || true`, wtCwd);
			if (base.out.trim()) {
				changelogBase.pending = pendingEntryLines(base.out);
				changelogBase.source = b.source;
				break;
			}
		}
	}
	// #164: a hand-resolved merge can commit a leftover marker — content to git, so nothing else catches it
	const markerBase = await mergeBase(wtCwd, cfg.defaultBranch);
	const markerDiff = markerBase ? await sh(`git diff -U0 --no-color --no-ext-diff ${sq(markerBase)} HEAD`, wtCwd) : null;
	const conflictMarkers = markerDiff?.ok ? conflictMarkerLines(markerDiff.out) : undefined;
	const prep = { manifestVersion: manifestVer, remoteTags, changelog, changelogChanged, changelogBase, noFoldCheck: flag("no-fold-check"), conflictMarkers, noMarkerCheck: flag("no-marker-check") };
	// same freshness rule as verify: a green predating a worktree write may not stand for the tree this gate blesses
	if (freshenChecks(state!, await worktreeFingerprint(wtCwd)).length) writeState(root, state!);
	// gh#198: the branch must carry the call the operator made — a bump they did not choose, or a bump on a flow
	// they said merges unreleased, is prep that contradicts the word Release? would stand on. It runs before the
	// generic proofs: when a parallel flow released first, "already tagged" alone would send the agent round a loop.
	const tagOf = (v: string) => cfg.versioning.pattern.replace("{version}", v);
	const newest = cfg.versioning.file && !noVersion ? newestTaggedVersion(cfg.versioning.pattern, remoteTags) : null;
	if (cfg.versioning.file && choice && choice !== "next") {
		const re = "ask the operator, then re-run with --version=<their call> or --no-version and --confirmed on their answer";
		let baseVer: string | null = null;
		if (markerBase) {
			const was = await sh(`git show ${sq(`${markerBase}:${cfg.versioning.file}`)} 2>/dev/null`, wtCwd);
			baseVer = was.ok && was.out.trim() ? parseVersion(cfg.versioning.file, was.out) : null;
		}
		if (isBumpKind(choice)) {
			// counted from what actually shipped last, so a flow that took the number first moves this one along
			const from = newest ?? baseVer ?? state!.versionFrom ?? null;
			const want = bumpVersion(from, choice);
			const moved = from && state!.versionFrom && from !== state!.versionFrom ? ` — ${tagOf(from)} was released since Verified? (the call was counted from ${state!.versionFrom} then)` : "";
			if (want && manifestVer !== want)
				return { text: `release gate FAILED:\n- the operator's call is a ${choice} release: bump ${cfg.versioning.file} to ${want} (${choice} past ${from})${moved}, and head its changelog entry ${want} — it says ${manifestVer ?? "no version"}`, isError: true };
		} else if (choice !== "unreleased") {
			if (remoteTags.includes(tagOf(choice)))
				return { text: `release gate FAILED:\n- ${choice}, the operator's call at Verified?, is taken: ${tagOf(choice)} was released since (another flow got there first) — ${re}; propose the same kind of step past ${newest ?? choice}, never pick the number yourself`, isError: true };
			if (manifestVer && manifestVer !== choice)
				return { text: `release gate FAILED:\n- the operator's release call is ${choice}, but ${cfg.versioning.file} says ${manifestVer} — bump it to ${choice}, or, if the call changed, ${re}`, isError: true };
		} else if (manifestVer && baseVer && baseVer !== manifestVer)
			return { text: `release gate FAILED:\n- the operator's call is to merge unreleased, but the branch bumps ${cfg.versioning.file} ${baseVer} → ${manifestVer} — revert the bump (the entry goes under Unreleased), or, if the call changed, ${re}`, isError: true };
	}
	// tier-2 pre-release confirmation is recorded by this very command, so it is excluded here
	const preGate = preReleaseGate({ ...state!, noVersion, confirmations: { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } } }, cfg, prep);
	if (preGate.length) return { text: `release gate FAILED:\n- ${preGate.join("\n- ")}`, isError: true };
	// the build the tag will trigger, proven before anything ships: a broken artifact build found after the
	// tag costs follow-up PRs and a re-cut tag
	if (cfg.release.preflight) {
		const pf = await sh(cfg.release.preflight, wtCwd);
		if (!pf.ok) return { text: `release gate FAILED:\n- release.preflight failed in ${state!.worktree} (${cfg.release.preflight}) — fix it on the branch before anything ships:\n${tail(pf.out)}`, isError: true };
	}
	// a stale session build is the operator's decision, never a block: publishing under an older gate is a
	// legitimate choice (hotfix, offline reload), and refusing would close exactly the emergency the relaxed
	// modes exist for. The gate names both builds, lists what the running code is missing, and folds the
	// update-or-proceed question into the Release? checkpoint — the operator's word, recorded in state.
	const { disk: selfBuild, behind } = buildSkew(root);
	// truly behind, not merely different: a session whose loaded build is NEWER than the checkout's manifest
	// has every proof the checkout would run, and asking about it would be noise.
	const stale = !!behind && !!selfBuild.version && cmpVersions(behind, selfBuild.version) < 0;
	let staleAsk = "";
	let staleNote = "";
	if (stale) {
		const clPath = path.join(selfBuild.dir, "CHANGELOG.md");
		const missing = existsSync(clPath) && selfBuild.version ? changelogVersionsBetween(readFileSync(clPath, "utf8"), behind, selfBuild.version) : [];
		staleAsk =
			` This session runs dev-flow ${behind}, ${selfBuild.label} ships ${selfBuild.version ?? "?"} — gate proofs shipped between the two will NOT run. ` +
			(missing.length
				? `Shipped since ${behind}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` …(${missing.length} total)` : ""} — see ${clPath}. `
				: `What shipped between them is not readable from the checkout's CHANGELOG.md — read it before deciding. `) +
			`Update (/reload, then re-run flow release on the current build) or proceed with the old release?`;
		staleNote = `released under dev-flow ${behind} (${selfBuild.label} ${selfBuild.version ?? "?"}) by operator choice — proofs newer than ${behind} did not run`;
	}
	// #162: Verified? was answered over one tree; commits after it ship under that word unless someone says
	// so. A warning, never a refusal — doc-only moves after verify are normal; the operator decides.
	let postVerify = "";
	let unverifiedChange = false;
	if (state!.verifiedHead) {
		// gh#180: upstream work merged in after the verdict was approved on its own branch — only the branch's
		// own commits are news to the operator; the merged-in ones are a count, not a list to wade through
		const d = cfg.defaultBranch;
		const upstream = (await sh(`git rev-parse --verify -q ${sq(`refs/remotes/origin/${d}`)}`, wtCwd)).ok ? `origin/${d}` : (await sh(`git rev-parse --verify -q ${sq(`refs/heads/${d}`)}`, wtCwd)).ok ? d : "";
		const range = `${sq(state!.verifiedHead)}..HEAD${upstream ? ` --not ${sq(upstream)}` : ""}`;
		// one record per commit: "<sha> <subject>" then the files it touched (\x1e starts a record)
		const since = await sh(`git log --no-decorate --name-only --format=%x1e%h%x20%s ${upstream ? "--no-merges " : ""}${range}`, wtCwd);
		const commits = since.ok
			? since.out.split("\x1e").map((rec) => rec.split("\n").map((l) => l.trim()).filter(Boolean)).filter((r) => r.length).map(([line, ...files]) => ({ line, files }))
			: [];
		const all = upstream ? await sh(`git rev-list --count ${sq(state!.verifiedHead)}..HEAD`, wtCwd) : null;
		const mergedIn = all?.ok ? Math.max(0, Number.parseInt(all.out.trim(), 10) - commits.length) : 0;
		// gh#187: the release-prep commit (the bump, the changelog entry, whatever else the bump rewrites — an
		// image tag in a compose file) lands after Verified? by design and no container verdict could cover
		// it. It is the commit that touches the version file, or one that touches nothing but prep files.
		const prepFiles = new Set([cfg.versioning.file, cfg.release.changelog, cfg.versioning.file === "package.json" ? "package-lock.json" : ""].filter(Boolean) as string[]);
		const isPrep = (c: { files: string[] }) => (!!cfg.versioning.file && c.files.includes(cfg.versioning.file)) || (c.files.length > 0 && c.files.every((f) => prepFiles.has(f)));
		const prep = commits.filter(isPrep);
		const changed = commits.filter((c) => !isPrep(c));
		// changed code shipping under an earlier word is friction the closing reflection should look at
		unverifiedChange = changed.length > 0;
		if (changed.length)
			postVerify = `${changed.length} commit(s) landed after the operator's Verified? (given over ${state!.verifiedHead.slice(0, 7)}): ${changed.slice(0, 6).map((c) => c.line).join(" | ")}${changed.length > 6 ? ` …(${changed.length - 6} more)` : ""}${prep.length ? ` (release prep ${prep.map((c) => c.line.split(" ")[0]).join(", ")} not counted)` : ""}${mergedIn ? ` (+${mergedIn} merged in from ${upstream}, not listed)` : ""} — the verify verdict does not cover them: if behaviour changed, re-run flow verify (at pre-release it redeploys and re-asks Verified? over the current tree) before Release?, and either way say in the PR body which commit the verdict was given over`;
	}
	// a standing yolo (given at an earlier checkpoint) stops short of Release? when the playbook says so, or
	// when commits landed after Verified? — the word was given before those commits existed (gh#176).
	// --confirmed is the operator's own answer at this checkpoint, yolo-at-Release? included: it always stands.
	const yoloHeld = !state!.yolo || flag("confirmed")
		? ""
		: cfg.release.yolo === "until-release"
			? "the playbook sets yolo = until-release: a yolo given earlier never answers Release? — ask it"
			: postVerify
				? "a yolo given earlier does not cover commits that landed after Verified? — ask Release? with them named"
				: "";
	// gh#198: release.ask = on-change — Release? answers itself when it would only re-confirm Verified?: the call
	// is on record, nothing but release prep landed since, and no other question (stale build, a major bump) is open
	const onChange = cfg.release.ask === "on-change" && !flag("confirmed") && !state!.yolo;
	const askWhy = !onChange
		? ""
		: !state!.verifiedHead
			? "no Verified? tree on record to compare against"
			: cfg.versioning.file && !choice
				? "no release call on record — ask it with Release?: patch, minor, major, or merge unreleased"
				: relArg.choice && relArg.choice !== state!.versionChoice
					? `the release call changed since Verified? (${state!.versionChoice ?? "none"} → ${relArg.choice}) — the operator makes that call`
				: postVerify
					? "commits beyond release prep landed after Verified?"
					: stale
						? "the session build is behind the checkout"
						: cfg.release.yolo === "until-release"
							? "the playbook sets yolo = until-release"
							: choice === "next" && newest && manifestVer && majorBump(newest, manifestVer)
								? `${newest} → ${manifestVer} is a major bump — the playbook's versioned call does not choose that`
								: "";
	const auto = onChange && !askWhy;
	let audit = flag("confirmed") ? " (confirmed by operator instruction)" : auto ? ` (auto-answered: release.ask = on-change — ${describeVersionChoice(choice ?? "next", state!.versionFrom)} was the call at Verified?, and only release prep landed since)` : state!.yolo ? " (yolo: pre-confirmed)" : "";
	const askPending = !auto && !flag("confirmed") && (!state!.yolo || !!yoloHeld);
	if (askPending) {
		markPendingAsk(root, state!, "Release?");
		if (!ui.hasUI) {
			const callAsk = cfg.versioning.file && !choice ? " — also ask the release call: a patch, minor or major release, or merge unreleased (no bump, no tag)?" : "";
			return { text: needsOperator(`ready to publish${yoloHeld ? ` (${yoloHeld})` : ""}${askWhy ? ` (asked: ${askWhy})` : ""}${stale ? ` — also: ${staleAsk}` : ""}${postVerify ? ` — ${postVerify}` : ""}${callAsk}`, "Release?", `re-run with --confirmed once the operator answered 'Release?' in chat${stale ? " (and the stale-build question)" : ""}${callAsk ? " (add --version=patch|minor|major, an exact version, or --no-version for their release call)" : ""}`), isError: true };
		}
		const ok = await ui.confirm("Enter release", `Release ${state!.slug}${manifestVer ? ` v${manifestVer}` : ""}${noVersion ? " (unversioned — merge + changelog entry only: no bump, no tag for this flow)" : ""}? Publishing starts: PR, merge${noVersion ? "" : ", tag"} — release-done afterwards needs no further answer.${staleAsk ? `\n\n${staleAsk}` : ""}${postVerify ? `\n\n${postVerify}` : ""}${yoloHeld ? `\n\n(${yoloHeld})` : ""}`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "release declined — keep preparing in pre-release" };
		}
		audit = " (confirmed in dialog)";
	}
	if (noVersion) state!.noVersion = true;
	else delete state!.noVersion;
	if (choice) state!.versionChoice = choice;
	if (unverifiedChange) state!.friction = (state!.friction ?? 0) + 1;
	state!.confirmations = { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } };
	state!.approvals["pre-release"] = now();
	state!.stage = "release";
	// a skipped proof is never silent: the gate says which one and why (#97)
	const foldNote = !changelog
		? ""
		: flag("no-fold-check")
			? " Warning: the changelog fold proofs were skipped (--no-fold-check) — check that the entry carries what was pending."
			: changelogBase.source === "none"
				? " Warning: no tag or merge base to compare against, so the changelog fold was not proven — check the entry by hand."
			: "";
	// the version of record is fixed here, from the manifest this gate validated: release-done must not
	// re-read a checkout that may still be behind (#52)
	if (!state!.noVersion && manifestVer) state!.releaseVersion = manifestVer;
	if (stale) state!.staleBuild = `${behind} (${selfBuild.label} ${selfBuild.version ?? "?"})`;
	delete state!.pendingAsk;
	writeState(root, state!);
	return { text: `release approved${audit}${state!.noVersion ? " — unversioned: no bump or tag; your changelog entry rides under Unreleased until the next versioned release folds it" : ""} — entering release stage.${manifestVer ? ` Version ${manifestVer}.` : ""}${foldNote}${staleNote ? ` ${staleNote}.` : ""}${postVerify ? ` Warning: ${postVerify}.` : ""}\n${describeBranchState(branchProof, cfg.defaultBranch)}\n${AGENT_MARK}next: ${nextHint(state!, cfg)}` };
}

/** How long release-done waits on the publish CI a tag push started; a seam so tests run in milliseconds. */
export const artifactWait = {
	budgetMs: 15 * 60_000,
	pollMs: 20_000,
	/** a tag pushed seconds ago may not have a run yet: look this long before deciding there is none */
	appearMs: 60_000,
	sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
	clock: () => Date.now(),
	runs: (tag: string, root: string): Promise<TagRun[] | null> => tagRuns(tag, root),
};

export interface TagRun { status: string; conclusion: string; url: string; workflowName: string }

/** The workflow runs a tag push started (GitHub names the tag as the run's branch); null when gh cannot say. */
async function tagRuns(tag: string, root: string): Promise<TagRun[] | null> {
	const r = await sh(`gh run list --branch ${sq(tag)} --event push --limit 20 --json status,conclusion,url,workflowName`, root, 30_000);
	if (!r.ok) return null;
	try {
		const rows = JSON.parse(r.out) as TagRun[];
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

/** Probe the release artifact; when it is missing and the tag's CI is still running, wait for that CI
 *  (bounded) and probe again. `waited` says what the wait saw, for the gate's note or its refusal. */
export async function awaitArtifact(cmd: string, tag: string, root: string): Promise<{ ok: boolean; out: string; waited: string }> {
	const start = artifactWait.clock();
	const mins = () => `${Math.max(1, Math.round((artifactWait.clock() - start) / 60_000))} min`;
	let greenAt: number | null = null; // a registry can answer "not found" for a minute after the run that pushed to it went green
	for (let round = 0; ; round++) {
		const art = await sh(cmd, root);
		if (art.ok) return { ...art, waited: round ? `after waiting ${mins()} for the publish CI ${tag} started` : "" };
		const runs = await artifactWait.runs(tag, root);
		if (runs === null) return { ...art, waited: "" }; // gh cannot say: the plain probe result stands
		const elapsed = artifactWait.clock() - start;
		const pending = runs.filter((r) => r.status !== "completed");
		if (!runs.length && elapsed >= artifactWait.appearMs)
			return { ...art, waited: `no CI run was started by ${tag} — publish by hand, or check that the publish workflow triggers on tags` };
		if (runs.length && !pending.length) {
			const failed = runs.filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral");
			if (!failed.length && greenAt === null) greenAt = artifactWait.clock();
			if (!failed.length && artifactWait.clock() - (greenAt ?? 0) < artifactWait.appearMs) {
				await artifactWait.sleep(artifactWait.pollMs);
				continue;
			}
			return {
				...art,
				waited: failed.length
					? `the CI ${tag} started did not pass — ${failed.map((r) => `${r.workflowName}: ${r.conclusion || "?"} (${r.url})`).join(", ")}; fix and re-publish, then re-run release-done`
					: `every CI run ${tag} started finished green, yet the artifact is missing — check where the publish workflow pushes`,
			};
		}
		if (elapsed >= artifactWait.budgetMs)
			return { ...art, waited: `the publish CI is still running after ${mins()} (${pending.map((r) => `${r.workflowName}: ${r.url}`).join(", ")}) — re-run release-done once it finishes` };
		await artifactWait.sleep(artifactWait.pollMs);
	}
}

export async function gateReleaseDone(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, flag, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const errs = releaseGate(state!);
	// the version of record is what flow release approved (#52) — never a re-read of a checkout that may be behind
	const manifestVer: string | null = state!.releaseVersion ?? null;
	if (cfg.versioning.file && !state!.noVersion && !manifestVer) errs.push(`flow release approved no version (versioning.file "${cfg.versioning.file}" was set after it?) — fix the playbook, or ship this flow unversioned`);
	const expectedTag = manifestVer ? cfg.versioning.pattern.replace("{version}", manifestVer) : null;
	const origin = await originUrl(root);
	const hasOrigin = origin !== null;
	const forgeName = forgeOf(cfg, origin);
	// one round-trip answers both questions about the tag: is it there, and did it leave this laptop (#52)
	const tags = expectedTag ? await releaseTags(root) : [];
	if (tags === null) errs.push("cannot list tags on origin (offline?) — retry: local tags must not decide what is already released");
	else if (expectedTag && manifestVer) {
		const verrs = versionTagGate(manifestVer, cfg.versioning.pattern, tags);
		if (verrs.length) {
			// the actionable version of "not on the forge": the tag exists but never got pushed
			const local = hasOrigin ? (await sh(`git tag --list ${sq(expectedTag)}`, root)).out.trim() : "";
			if (local) errs.push(`tag ${expectedTag} is local-only — git push origin ${expectedTag} (git push --follow-tags silently skips lightweight tags; tag with git tag -a and push the ref explicitly)`);
			else errs.push(...verrs);
		}
		// never publish behind what the forge already has — that is how a stale manifest republished
		// the previous version and its artifact probe passed (#52)
		const newest = newestTaggedVersion(cfg.versioning.pattern, tags);
		if (newest && cmpVersions(newest, manifestVer) > 0) errs.push(`${cfg.versioning.pattern.replace("{version}", newest)} is already tagged — refusing to release ${expectedTag} behind it`);
		if (!verrs.length) {
			const reach = await sh(`git merge-base --is-ancestor ${sq(expectedTag)} origin/${cfg.defaultBranch} 2>/dev/null || git merge-base --is-ancestor ${sq(expectedTag)} ${cfg.defaultBranch}`, root);
			if (!reach.ok) errs.push(`tag ${expectedTag} is not reachable from ${cfg.defaultBranch} — tag what actually shipped on ${cfg.defaultBranch}`);
		}
	}
	let artNote = "";
	if (expectedTag && cfg.release.artifact) {
		if (flag("no-artifact-check")) artNote = "Artifact check skipped (--no-artifact-check).";
		else {
			const cmd = cfg.release.artifact.replaceAll("{version}", manifestVer!).replaceAll("{tag}", expectedTag);
			// the tag push is what starts the publish CI: a miss right after it is usually "not yet" — only a
			// tag that is really on the forge has a run worth waiting for (gh#179)
			const art = forgeName === "github" && !errs.length ? await awaitArtifact(cmd, expectedTag, root) : { ...(await sh(cmd, root)), waited: "" };
			if (art.ok) artNote = `Artifact verified for ${manifestVer}${art.waited ? ` ${art.waited}` : ""}.`;
			else errs.push(`artifact not published — release.artifact check failed (${cmd}):\n${tail(art.out)}${art.waited ? `\n${art.waited}` : ""}`);
		}
	}
	// merge policy: did what actually landed agree with what the playbook says? A measured contradiction
	// refuses the release record; what dev-flow cannot see stays an advisory — the split the changelog
	// proofs learned (#97): an invisible topology never blocks a legal release.
	let mergeNote = "";
	if (cfg.release.merge && cfg.release.merge !== "any" && state!.branch) {
		const br = state!.branch;
		await sh(`git fetch -q origin ${sq(br)} 2>/dev/null; git fetch -q origin ${sq(cfg.defaultBranch)} 2>/dev/null`, root);
		const refsOk = hasOrigin && (await sh(`git show-ref --quiet --verify ${sq(`refs/remotes/origin/${br}`)} ${sq(`refs/remotes/origin/${cfg.defaultBranch}`)}`, root)).ok;
		// ancestry proves "not squashed, not rebased"; a squash and a rebase look identical here, so when it
		// fails the forge itself is asked which one it was (gh/glab; self-hosted stays an advisory)
		const ancestor = refsOk ? (await sh(`git merge-base --is-ancestor origin/${sq(br)} origin/${sq(cfg.defaultBranch)}`, root)).ok : null;
		const proof = mergeShapeProof(cfg.release.merge, { ancestor, forgeStyle: ancestor === false ? await forgeMergeStyle(gateCwd(root, state!), forgeName, br) : null, branch: br, defaultBranch: cfg.defaultBranch });
		if (proof.errors.length) errs.push(...proof.errors);
		else mergeNote = proof.note;
	}
	if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
	// no checkpoint here — the operator's Release? answer covered the whole publication; everything left is objective checks
	const releasesWanted = !!manifestVer && !flag("no-release-create") && cfg.release.releases !== false;
	let ghNote = "";
	let bodyOfRecord: string | null = null; // the changelog entry the forge body must match (#97)
	let bodyNote = "";
	if (manifestVer && flag("no-release-create")) ghNote = "Forge release skipped (--no-release-create).";
	else if (manifestVer && !releasesWanted) ghNote = "no forge release created (release.releases = false — the playbook says publication is manual; a stale key is how a repo ends up with tags and an empty Releases page #85).";
	else if (manifestVer && releasesWanted) {
		// forge release for the verified tag — gh for GitHub, glab for GitLab. A failed create is no
		// longer the end of the story: the proof below asks the forge whether anything is there (#63, #85)
		const tag = expectedTag!;
		if (forgeName === "self") ghNote = "Forge release skipped (forge=self — publication stays manual).";
		else {
			// the body is the changelog entry for this version (#97); the tag annotation only stands in
			// when the changelog has no entry for it — and never the output of a failed command, which
			// is how a shell error became a release body (#51)
			const notesRes = await sh(tagNotesCommand(tag), root);
			const annotation = notesRes.ok ? notesRes.out.trim() : "";
			let changelogText: string | null = null;
			if (cfg.release.changelog) {
				const cl = path.join(gateCwd(root, state!), cfg.release.changelog);
				if (existsSync(cl)) changelogText = readFileSync(cl, "utf8");
			}
			const picked = pickReleaseNotes({ changelog: changelogText, version: manifestVer, annotation });
			const notes = picked.notes;
			if (picked.source === "changelog") bodyOfRecord = notes;
			let notesNote = "";
			if (picked.source === "changelog") notesNote = `notes from ${cfg.release.changelog}. `;
			else if (picked.source === "annotation") notesNote = `notes from the ${tag} tag annotation — ${cfg.release.changelog ?? "no changelog"} has no ${manifestVer} entry, so the release page does not read like the changelog. `;
			else if (!notesRes.ok) notesNote = `no release notes (the tag command failed: ${tail(notesRes.out)}). `;
			else if (annotation && looksLikeShellError(annotation)) notesNote = "no release notes (the tag command returned a shell error, not a body). ";
			else notesNote = `no release notes (tag ${tag} carries no annotation${cfg.release.changelog ? ` and ${cfg.release.changelog} has no ${manifestVer} entry` : ""} — tag with git tag -a). `;
			const cmd = forgeName === "gitlab"
				? `glab release create ${sq(tag)} --name ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`
				: `gh release create ${sq(tag)} --title ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`;
			const gr = await sh(cmd, root);
			// a failed create is the operator's call to decline, never a choice we make for them — stamp it so finish names it (#63)
			if (gr.ok) delete state!.forgeReleaseSkipped; // a successful retry lifts the stamp
			else state!.forgeReleaseSkipped = tail(gr.out);
			ghNote = gr.ok ? `${forgeName} release ${tag} created. ${notesNote}`.trim() : `${forgeName} release skipped: ${tail(gr.out)}`;
		}
	}
	const skew = buildSkew(root);
	const openRelease = checklistPending(cfg, state!, "release");
	// release-stage items have no gate of their own: the operator's Finish? answer is what closes them, so
	// name them at the last objective gate — on the way out too, or the refusal hides half the story
	const openNote = openRelease ? `release-stage checklist still open (${openRelease}): ${applicableItems(cfg, state!, "release").map((i) => i.text).join(" | ")} — close these with the operator before finishing.` : "";
	// #85: ask the forge whether the release exists instead of trusting the attempt. #51, #60 and #63
	// were three ways of recording a release nothing published, and the artifact probe saw none of them
	if (releasesWanted && expectedTag && forgeName !== "self") {
		const view = forgeName === "gitlab" ? `glab release view ${sq(expectedTag)}` : `gh release view ${sq(expectedTag)}`;
		if (!(await sh(view, root)).ok) {
			return { text: `release gate FAILED:\n- no ${forgeName} release exists for ${expectedTag} — create it (${view.split(" ")[0]} release create ${expectedTag}) or, if publication is deliberately manual, say so with release.releases = false in project.md${ghNote ? `. ${ghNote}` : ""}${openNote ? ` ${openNote}` : ""}`, isError: true };
		}
		delete state!.forgeReleaseSkipped; // the forge has it, whatever the create call reported
		ghNote += `${ghNote ? " " : ""}Release ${expectedTag} verified on ${forgeName}.`;
		// #97: the changelog entry is the release body — prove the forge kept it. gh normalizes the
		// markdown it stored, so the comparison normalizes too; on another forge say it was skipped
		// rather than guess at a JSON shape nobody pinned.
		if (bodyOfRecord !== null) {
			if (forgeName !== "github") bodyNote = `Release body proof skipped (forge=${forgeName}).`;
			else {
				const got = await sh(`gh release view ${sq(expectedTag)} --json body --jq .body`, root);
				if (!got.ok) bodyNote = `warning: could not read back the ${expectedTag} release body — compare it with ${cfg.release.changelog} by hand.`;
				else if (normalizeReleaseBody(got.out) !== normalizeReleaseBody(bodyOfRecord))
					return {
						text: `release gate FAILED:\n- the ${expectedTag} release body is not the ${cfg.release.changelog} entry for ${manifestVer} — publish the entry as the body: gh release edit ${expectedTag} --title ${expectedTag} --notes-file <(the entry)\n  forge body starts: ${tail(normalizeReleaseBody(got.out), 4)}\n  changelog entry starts: ${tail(normalizeReleaseBody(bodyOfRecord), 4)}`,
						isError: true,
					};
				else bodyNote = `Release ${expectedTag} body matches ${cfg.release.changelog}.`;
			}
		}
	}
	state!.approvals.release = now();
	const tailNote = [
		// a session that shipped from behind: the code it runs is not the code the checkout just released
		state!.staleBuild
			? `stale build acknowledged at release gate: this session ran dev-flow ${state!.staleBuild} — proofs newer than it did not run.`
			: skew.behind
				// #117: the pair (session vs what the disk ships) makes the warning actionable where it prints;
				// a second registered copy is what made the skew confusing on the report — name it too
				? `warning: ${skew.line}.${copyWarning() ? ` ${copyWarning()}` : ""}`
			: "",
		mergeNote,
		openNote,
		ghNote,
		bodyNote,
		artNote,
	].filter(Boolean).join(" ");
	writeState(root, state!);
	return { text: `release recorded as complete${state!.noVersion ? " (unversioned — the changelog entry ships under Unreleased; the next versioned release folds it)" : ""}.${tailNote ? ` ${tailNote}` : ""}\n${AGENT_MARK}next: ${nextHint(state!, cfg)}` };
}

/** finish, with the release record folded in: published but not yet recorded, finish runs release-done's
 *  proofs itself — that gate asks nothing, so a separate call was a round trip with no decision in it.
 *  Its refusal is finish's refusal; its report heads finish's. */
export async function gateFinish(o: GateCtx): Promise<RunResult> {
	const { state, err } = needState(o.root, o.sess, o.slugArg);
	if (err || !state || state.approvals.release || state.stage !== "release" || !state.approvals["pre-release"]) return gateFinishCore(o);
	const rec = await gateReleaseDone({ ...o, rest: o.rest.filter((a) => a !== "--confirmed" && a !== "--yolo") });
	if (rec.isError) return rec;
	const fin = await gateFinishCore(o);
	const recorded = rec.text.split("\n").filter((l) => !l.startsWith(AGENT_MARK)).join("\n");
	return { ...fin, text: `${recorded}\n\n${fin.text}` };
}

export async function gateFinishCore(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	if (!state!.approvals.release)
		return { text: `finish closes a released feature — stage is "${state!.stage}" and no release is recorded; run flow release-done first (to abandon an unfinished feature, run flow abort)`, isError: true };
	// after this the flow state is gone: nothing may sit uncommitted or unpushed
	const dirty = await sh("git status --porcelain", root);
	if (dirty.ok && dirty.out.trim()) return { text: `main checkout has uncommitted changes — commit them first (finish deletes .dev-flow/${state!.slug}/):\n${tail(dirty.out)}`, isError: true };
	const origin = await originUrl(root);
	const hasOriginF = origin !== null;
	if (hasOriginF) {
		const pushed = await sh(`git merge-base --is-ancestor HEAD ${sq(`origin/${cfg.defaultBranch}`)}`, root);
		if (!pushed.ok) return { text: `HEAD is not on origin/${cfg.defaultBranch} — push the release (git push origin ${cfg.defaultBranch}) before finish`, isError: true };
	}
	// close-out also syncs the main checkout: a released flow must never leave local
	// <default> trailing origin — the push check above proved nothing local-only remains, so a
	// differing sha means local trails and the fast-forward is safe. never a merge: a diverged
	// or not-checked-out main prints the operator's exact command instead of touching anything
	let syncNote = "";
	if (hasOriginF) {
		const headSha = await sh("git rev-parse HEAD", root);
		const originSha = await sh(`git rev-parse ${sq(`origin/${cfg.defaultBranch}`)}`, root);
		if (headSha.ok && originSha.ok && headSha.out.trim() !== originSha.out.trim()) {
			const onDefault = (await currentBranch(root)) === cfg.defaultBranch;
			const ff = onDefault ? await sh(`git merge --ff-only ${sq(`origin/${cfg.defaultBranch}`)}`, root) : { ok: false, out: "" };
			syncNote = ff.ok
				? ` local ${cfg.defaultBranch} fast-forwarded to origin/${cfg.defaultBranch}.`
				: ` local ${cfg.defaultBranch} trails origin/${cfg.defaultBranch} and did not fast-forward cleanly — sync by hand: git -C ${sq(root)} pull --ff-only`;
		}
	}
	// the cleanup part of closing out: drop the worktree and branch the release consumed
	const wt = worktreeAbs(root, state!);
	let closeNote: string;
	let unmergedNote = "";
	if (wt && existsSync(wt)) {
		const status = await sh(`git -C ${sq(wt)} status --porcelain`, root);
		const unmerged = await sh(`git -C ${sq(wt)} log origin/${cfg.defaultBranch}..HEAD --oneline 2>/dev/null || git -C ${sq(wt)} log ${cfg.defaultBranch}..HEAD --oneline`, root);
		const unmergedLines = unmerged.out.split("\n").filter(Boolean);
		// the refusal names the paths, not just the count — same proof verify and release print (gh#131)
		if (status.out.trim()) return { text: `finish blocked:\n- worktree has uncommitted changes — commit or discard them first:\n${tail(status.out)}`, isError: true };
		if (unmergedLines.length) {
			const policy = cfg.release.merge;
			// "not on the default branch" is only a violation when the ancestry is measurable: with no origin,
			// or a branch that was never pushed, the same count describes a local-only repo, not a squash
			const measurable = hasOriginF && !!state!.branch && (await sh(`git show-ref --quiet --verify ${sq(`refs/remotes/origin/${state!.branch}`)} ${sq(`refs/remotes/origin/${cfg.defaultBranch}`)}`, root)).ok;
			unmergedNote =
				policy && policy !== "merge" && policy !== "any"
					? ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} — expected, the playbook merges with ${policy}.`
					: policy === "merge" && measurable
						? ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} although the playbook says merge = merge — that PR did not land as a merge commit`
						: ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} (squash merge?)`;
			// under a merge-commit policy this is a violation, not a routine cleanup note: yolo does not
			// answer it, only the operator does
			if (policy === "merge" && measurable && !flag("confirmed")) {
				markPendingAsk(root, state!, "Merge policy violation?");
				return { text: needsOperator(`the playbook says merge = merge, but ${unmergedLines.length} commit(s) of ${state!.slug} are not on ${cfg.defaultBranch} — the PR landed as a squash or a rebase`, "Merge policy violation?", "ask the operator how to proceed, then re-run with --confirmed"), isError: true };
			}
		}
	}
	// a forge release that failed at release-done is still the operator's call — but they must see it before the state vanishes (#63)
	const forgeSkipNote = state!.forgeReleaseSkipped ? ` WARNING: the forge release was not created (${state!.forgeReleaseSkipped}) — recreate it manually or re-run release-done before finishing.` : "";
	// the one finish question — asked after the safety checks so it can never be a wasted question
	// yolo works uniformly at every gate: at Finish? nothing later remains to pre-confirm, the flag just answers this one
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	// The closing reflection runs here, before anything is removed: the worker reads this session's
	// transcripts and .dev-flow/<slug>/tmp, and finish is about to drop that folder and the binding — a
	// reflection asked for after finish has nothing bound to run against. Only the operator's explicit
	// --no-reflect skips it; yolo never does (it answers checkpoints, it does not waive the review).
	const skipReflect = flag("no-reflect");
	if (skipReflect && !flag("confirmed")) return { text: "--no-reflect is the operator's word — ask them whether to skip the closing reflection, then re-run with --no-reflect --confirmed", isError: true };
	// a flow that never hit a refusal, a guard block or a change shipped after Verified?, with no friction note
	// from the operator, has nothing
	// for the reflection worker to find — skip the worker run unless the playbook says reflect = always
	const note = flagValue(o.rest, "note") ?? "";
	const quiet = !state!.reflectedAt && !skipReflect && cfg.release.reflect !== "always" && !(state!.friction ?? 0) && !note.trim();
	if (quiet) {
		state!.reflectedAt = now();
		writeState(root, state!);
	}
	const quietNote = quiet ? " closing reflection skipped: no refusals, guard blocks or unverified changes this flow (playbook reflect = always runs it anyway)." : "";
	if (!state!.reflectedAt && !skipReflect) {
		const skipHint = "or — only on the operator's explicit word — flow finish --no-reflect --confirmed";
		if (!o.hooks.reflect) return { text: `finish: no reflection recorded for ${state!.slug} and no reflect worker available here — run flow_stage(op: "reflect") first, ${skipHint}`, isError: true };
		const r = await o.hooks.reflect(state!, flagValue(o.rest, "note") ?? "");
		const cur = readState(root, state!.slug) ?? state!; // the worker stamped reflectedAt on disk
		if (!r.recorded)
			return { text: `finish: the closing reflection did not report — nothing was removed.\n\n${r.text}\n\nNext: re-run flow finish to retry, or review inline (bare flow reflect prints the protocol) and then flow_stage(op: "reflect"), ${skipHint}.`, isError: true };
		if (!r.findings) {
			markPendingAsk(root, cur, "Finish?");
			return { text: needsOperator(`the closing reflection found nothing new to fold — nothing was removed yet; on your word the worktree, branch and .dev-flow/${state!.slug}/ go.\n\n${r.text}`, "Finish?", "ask the operator Finish? and run flow finish --confirmed when they answer"), isError: true };
		}
		markPendingAsk(root, cur, "Fold or drop?");
		return { text: needsOperator(`the closing reflection has findings — nothing was removed yet; your fold/drop answer also finishes the feature.\n\n${r.text}`, "Fold or drop?", `the fold/drop answer is the Finish? answer: apply it, then run flow finish --confirmed without asking again — the worktree, branch and .dev-flow/${state!.slug}/ go on that run`), isError: true };
	}
	const reflectSkipNote = skipReflect && !state!.reflectedAt ? ` Reflection skipped on the operator's word — nothing re-checked this session or the open reflections.` : "";
	const askPending = !flag("confirmed") && !state!.yolo;
	if (askPending) {
		markPendingAsk(root, state!, "Finish?");
		if (!ui.hasUI) {
			return { text: needsOperator(`cleanup removes the worktree, branch and feature folder.${quietNote}${forgeSkipNote}`, "Finish?", "ask the operator Finish? in chat, then re-run with --confirmed"), isError: true };
		}
		const ok = await ui.confirm("Finish feature", `Finish ${state!.slug}?${unmergedNote}${forgeSkipNote} Removes worktree, branch ${state!.branch || "-"} and .dev-flow/${state!.slug}/.`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "finish declined" };
		}
	}
	// a side-by-side dev instance (a port the operator picked at verify) is this flow's to stop; the default
	// port's stack stays up — it is the machine's shared app, and the next flow redeploys over it
	let devDownNote = "";
	if (state!.devPort !== undefined && state!.devPort !== cfg.devPort) {
		if (cfg.commands.devDown) {
			const down = await sh(cfg.commands.devDown, gateCwd(root, state!), 5 * 60_000, devEnv(root, state!, cfg));
			devDownNote = down.ok ? ` dev instance on port ${state!.devPort} stopped (${cfg.commands.devDown}).` : ` dev instance on port ${state!.devPort} did NOT stop (${cfg.commands.devDown}) — stop it by hand:\n${tail(down.out)}\n`;
		} else devDownNote = ` dev instance on port ${state!.devPort} is still running — the playbook has no devDown to stop it; stop it by hand.`;
	}
	const reg = readDevPorts(root);
	const mine = Object.keys(reg).filter((k) => reg[k].slug === state!.slug);
	if (mine.length) {
		for (const k of mine) delete reg[k];
		writeDevPorts(root, reg);
	}
	if (wt && existsSync(wt)) {
		const rm = await sh(`git worktree remove ${sq(wt)} && git branch -D ${sq(state!.branch)}`, root);
		if (!rm.ok) return { text: `worktree removal failed:\n${rm.out}\nif files are owned by another user (e.g. root-owned docker build output), remove ${state!.worktree} manually and rerun flow finish`, isError: true };
		closeNote = `worktree and branch ${state!.branch} removed`;
	} else {
		await sh("git worktree prune", root);
		closeNote = "worktree already gone";
		if (state!.branch && (await sh(`git rev-parse --verify --quiet refs/heads/${state!.branch}`, root)).ok) {
			const del = await sh(`git branch -d ${sq(state!.branch)}`, root);
			closeNote = del.ok ? `branch ${state!.branch} deleted` : `branch ${state!.branch} kept (not fully merged — git branch -D if sure)`;
		}
	}
	// remote cleanup: origin/<branch> is deleted only on proof it was released — being an ancestor of
	// origin/<default> (merge-commit merges) or a merged PR via gh (squash merges); else it stays.
	let remoteNote = "";
	if (state!.branch && hasOriginF) {
		const br = state!.branch;
		const onRemote = await sh("git ls-remote --heads origin", root);
		if (onRemote.out.split("\n").some((l) => l.endsWith(`\trefs/heads/${br}`))) {
			await sh(`git fetch -q origin ${sq(br)}`, root);
			let merged = (await sh(`git merge-base --is-ancestor origin/${sq(br)} origin/${sq(cfg.defaultBranch)}`, root)).ok;
			// squash merges leave no ancestry — ask the forge (gh/glab); self-hosted stays on ancestry proof
			if (!merged) merged = (await forgeMergeStyle(root, forgeOf(cfg, origin), br)) !== null;
			if (merged) remoteNote = (await sh(`git push origin --delete ${sq(`refs/heads/${br}`)}`, root)).ok
				? ` origin/${br} deleted (verified merged)`
				: ` origin/${br} delete failed — git push origin --delete ${br}`;
			else remoteNote = ` origin/${br} kept — merged state not verifiable from here (git push origin --delete ${br} when sure)`;
		}
	}
	rmSync(featDir(root, state!.slug), { recursive: true, force: true });
	if (sess.slug === state!.slug) sess.bind(null);
	// a feature picked from the backlog closes its own item: check off what `roadmap pick` stamped (slug)
	let roadmapNote = "";
	if (existsSync(roadmapFile(root))) {
		const r = roadmapDoneForSlug(readRoadmap(root), state!.slug, new Date().toISOString().slice(0, 10));
		if (r.count) {
			writeFileSync(roadmapFile(root), r.text);
			roadmapNote = ` roadmap: ${r.count} item(s) marked done.`;
		}
	}
	// finish is the moment between flows: name the fix / tidy suggestion when a rule fires, nothing otherwise
	const nudge = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { between: true });
	const nudgeNote = [nudge.fix, nudge.tidy].filter(Boolean).map((n) => ` ${n} — offer it to the operator.`).join("");
	return { text: `feature ${state!.slug} done — ${closeNote}${remoteNote}; .dev-flow/${state!.slug}/ removed.${devDownNote}${roadmapNote}${forgeSkipNote}${reflectSkipNote}${quietNote}${syncNote}${nudgeNote} Re-read flow status before reporting open flows — a sibling feature may have finished while this session ran.` };
}
