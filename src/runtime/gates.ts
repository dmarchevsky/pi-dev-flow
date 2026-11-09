/** dev-flow runtime — The gate runner and the gates that do not ship anything. Moved out of extensions/dev-flow.ts as is (exports added). */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { approveGate, applicableItems, appendRoadmapItem, checklistHash, claimBlocks, doneItemCount, detectForge, gateHelpJson, healthProbe, parseMergeStyle, investigationBrief, pluginVersion, reflectProtocol, reflectUnfiledCount, reflectionNudges, reflectionRoutes, listFiles, needsOperator, newState, nextHint, openChecklistItems, releaseGate, roadmapDone, roadmapOpenCount, roadmapBriefFor, roadmapPick, roadmapTidy, statusJson, subst, sq, featureTmpDir, foreignWorktreeLinks, validSlug, verifyGate, STAGE_EMOJI, type ReflectTarget, type Config, type FlowState } from "../core.ts";
import { applyAnswers, buildDraft, doctorFindings, ghostFeatureDirs, lineDiff, loadProject, mdDigest, parseAnswers, parseProjectMd } from "../projectmd.ts";
import { linkedTag } from "../fold.ts";
import { detectProject } from "../detect.ts";
import { AGENT_MARK } from "../present.ts";
import { GATE_HELP, SELF_BUILD, type Ui, buildSkew, copyWarning, currentBranch, dfDir, featDir, featureEnv, flagValue, gateCwd, gitConsistency, initiated, loadedVersion, mergeHistoryEvidence, needState, now, originUrl, publishedVersion, readClaim, readReflections, readReflectionsText, readRoadmap, readState, roadmapFile, sh, stateFile, tail, unfinishedStates, writePlaybookMergePolicy, writeState } from "./base.ts";
import { type RunResult, type Session, ago, pendingChecks, probeHealth, readDevPorts, runChecks, stampChecks, triedNote } from "./checks.ts";
import { GIT_TRACK_NOTE, isSelfRepo, renderQuestions, setupQuestions, tagPatternEvidence } from "./setup.ts";
import { foldRows, foldView, legacyPluginRows, pluginUpstream, reflectDoneNote, reflectList, reflectMoveNote, reflectNote, reflectTidy } from "./reflect.ts";
import { gateFinish, gateRelease, gateReleaseDone, gateVerify } from "./ship.ts";

/** What a gate may need from the extension closure: finish runs the closing reflection worker itself. */
export interface FlowHooks {
	reflect?: (state: FlowState, note: string) => Promise<{ text: string; recorded: boolean; findings: number; failed: boolean }>;
}

/** Single runner for both the /flow command and the flow tool. */
export async function runFlow(args: string[], root: string, ui: Ui, sess: Session, hooks: FlowHooks = {}): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	// help and version are questions about the plugin, not the repo: answerable with no .dev-flow/ at all
	if (sub === "help" || sub === "--help" || sub === "-h") return { text: rest.includes("--json") ? gateHelpJson(GATE_HELP, loadedVersion()) : `usage: flow <sub> — ${GATE_HELP}` };
	// an uninitiated folder is dormant: every gate verb but init and version needs the operator playbook (project.md)
	if (!initiated(root) && sub !== "init" && sub !== "version") return { text: "dev-flow is not initiated here — no .dev-flow/project.md — run flow init first", isError: true };
	const cfg = loadProject(dfDir(root)).cfg;
	const flag = (name: string) => rest.includes(`--${name}`);
	// the yolo word at Verified?/Release?/Finish?: the operator said it in chat, then re-run with --confirmed; checks and guardrails stay enforced
	const takeYoloWord = (state: FlowState): string | null => {
		if (!flag("yolo")) return null;
		if (!state.yolo && !flag("confirmed")) return "yolo is the operator's word — the operator must have said it in chat, then re-run with --yolo --confirmed";
		state.yolo = true;
		return null;
	};
	const slugArg = rest.find((a) => !a.startsWith("--"));
	const o: GateCtx = { root, ui, sess, cfg, rest, flag, slugArg, takeYoloWord, hooks };

	switch (sub) {
		case "init":
			return gateInit(o);

		case "start":
			return gateStart(o);

		case "status":
			return gateStatus(o);

		case "reflect":
			return gateReflect(o);

		case "roadmap":
			return gateRoadmap(o);

		case "doctor":
			return gateDoctor(o);

		case "version":
			return gateVersion(o);

		case "approve":
			return gateApprove(o);

		case "test":
			return gateTest(o);

		case "verify":
			return gateVerify(o);

		case "check":
			return gateCheck(o);

		case "health":
			return gateHealth(o);

		case "release":
			return gateRelease(o);

		case "release-done":
			return gateReleaseDone(o);

		case "finish":
			return gateFinish(o);

		case "use":
			return gateUse(o);

		case "abort":
			return gateAbort(o);

		default:
			return { text: `unknown subcommand "${sub}" — ${GATE_HELP}`, isError: true };
	}
}
/** Records the checkpoint word a gate asked for and has not been given: the footer shows 💬 (“operator,
 *  your turn”, the legend in docs/playbook.md) while a session is parked on an answer. Presentation only —
 *  no verdict reads it — and the same gate clears it when the word arrives (or when the answer is no and the
 *  turn returns to the agent). */
export function markPendingAsk(root: string, state: FlowState, word: string): void {
	state.pendingAsk = word;
	writeState(root, state);
}

/** The main-branch guard as a hook body — installed into .git/hooks, or printed for a hook manager to carry. */
export const mainHookBody = (branch: string) =>
	`branch=$(git rev-parse --abbrev-ref HEAD)\nif [ "$branch" = "${branch}" ] && [ -z "$DEV_FLOW_ALLOW_MAIN" ]; then\n  echo "dev-flow: direct commits to ${branch} are forbidden — use a feature worktree and a PR" >&2\n  exit 1\nfi\n`;

/** Value tokens of a multi-value flag: everything after `--name` up to the next `--flag`. */
export function flagValues(rest: string[], name: string): string[] {
	const i = rest.indexOf(`--${name}`);
	if (i === -1) return [];
	const out: string[] = [];
	for (let j = i + 1; j < rest.length && !rest[j].startsWith("--"); j++) out.push(rest[j]);
	return out;
}

export async function gateInit(o: GateCtx): Promise<RunResult> {
	const { root, ui, rest, flag } = o;
	// a recursive mkdir is silent about whether it created anything, and `flow init --write` is the
	// only sanctioned agent path to the playbook: claiming "created" when the folder was already
	// there sends the agent diffing its own config for damage that never happened (#39).
	const dfExisted = existsSync(dfDir(root));
	mkdirSync(dfDir(root), { recursive: true });
	const notes: string[] = dfExisted ? [] : [`.dev-flow/ created in ${root}`];
	// self-ignoring folder with one exception: the playbook is the only file under .dev-flow/ that lives in git
	writeFileSync(path.join(dfDir(root), ".gitignore"), "*\n!project.md\n");
	const mdFile = path.join(dfDir(root), "project.md");
	const head = await sh("git symbolic-ref refs/remotes/origin/HEAD", root);
	const curBr = await currentBranch(root);
	// never propose a feature branch (contains "/") as the default branch
	const branch = (head.ok ? head.out.match(/refs\/remotes\/origin\/(.+)/)?.[1] : undefined) || (curBr.includes("/") ? undefined : curBr) || "main";
	const det = detectProject(root, branch);
	const origin = await originUrl(root);
	det.partial.forge = origin ? detectForge(origin) : undefined; // confirmed or corrected by the operator during setup; absent = no origin to detect from
	const mergeEv = await mergeHistoryEvidence(root, branch); // "what do you actually do when a PR merges", read off the log
	det.partial.merge = mergeEv?.note;
	const tagEv = await tagPatternEvidence(root);
	if (tagEv) {
		det.partial.versionTag = tagEv.pattern;
		det.report.push(`tags: ${tagEv.note} → versionTag = ${tagEv.pattern}`);
	}
	const draftFresh = buildDraft(det);
	const questions = setupQuestions(det, { merge: mergeEv, tag: tagEv });
	if (flag("draft")) return { text: existsSync(mdFile) ? readFileSync(mdFile, "utf8") : draftFresh }; // read path: prints content, writes nothing (and offers no deletions)
	// ghosts: feature dirs whose state.json is gone — inert, invisible to status and guards, and only findable by eye
	const ghosts = ghostFeatureDirs(root);
	if (ghosts.length) {
		if (!ui.hasUI) notes.push(`${ghosts.length} ghost feature dir(s) — a plan/ with no state.json, no flow owns them (${ghosts.join(", ")}); adopt one with flow start <slug> --confirmed, delete them, or run flow init interactively`);
		else if (await ui.confirm("Remove ghost feature dirs?", `${ghosts.map((g) => `${g} — plan/ with no state.json`).join("\n")}\n\nNo flow owns these; their plan/*.md is not recoverable afterwards. To keep one as a new feature's draft, decline and run flow start <slug> --confirmed.`)) {
			for (const g of ghosts) rmSync(path.join(root, g), { recursive: true, force: true });
			notes.push(`removed ${ghosts.length} ghost feature dir(s): ${ghosts.map((g) => g.slice(".dev-flow/".length)).join(", ")}`);
		} else notes.push(`kept ${ghosts.length} ghost feature dir(s) — inert, remove them whenever you like`);
	}
	const current = existsSync(mdFile) ? readFileSync(mdFile, "utf8") : null;
	/** Validate, back up what was there (the operator's rules are not regenerable), write. */
	const writeMd = (text: string): { rej: RunResult } | { warn: string[] } => {
		const parsed = parseProjectMd(text);
		if (parsed.hard.length) return { rej: { text: `project.md REJECTED:\n- ${parsed.hard.join("\n- ")}`, isError: true } };
		if (existsSync(mdFile)) copyFileSync(mdFile, `${mdFile}.bak`);
		writeFileSync(mdFile, text.endsWith("\n") ? text : `${text}\n`);
		return { warn: parsed.warn };
	};
	/** After a write: the playbook belongs in git — commit it on the operator's word, else say how. */
	const afterWrite = async (w: { warn: string[] }, before: string | null, after: string, offer = false): Promise<void> => {
		notes.push(`changes:\n${lineDiff(before ?? "", after)}`);
		if (w.warn.length) notes.push("warnings:", ...w.warn.map((x) => `  ${x}`));
		// the dialog belongs to the human-driven first init only: an agent write (--write/--answers) follows a chat
		// confirmation and must not open a second question — it commits on --track
		const track = flag("track") || (offer && ui.hasUI && (await ui.confirm("Commit project.md?", "The playbook belongs in git. Commit .dev-flow/project.md now (only that file, as a playbook chore)?")));
		if (!track) {
			notes.push(GIT_TRACK_NOTE, AGENT_MARK + "(or re-run the same call with --track on the operator's word)");
			return;
		}
		const c = await sh(`git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -q -m ${sq(before ? "chore: update dev-flow playbook" : "chore: add dev-flow playbook")} -- .dev-flow/project.md`, root, 60_000);
		notes.push(c.ok ? "project.md committed (git add -f + playbook chore)" : `commit failed — ${c.out.split("\n").find(Boolean) ?? "?"}; ${GIT_TRACK_NOTE}`);
	};
	const answerToks = [...flagValues(rest, "answers"), ...(flag("answers-file") ? (() => { const f = flagValues(rest, "answers-file")[0]; return f && existsSync(path.resolve(root, f)) ? readFileSync(path.resolve(root, f), "utf8").split("\n") : [`<missing answers file ${f ?? ""}>`]; })() : [])];
	if (flag("answers") || flag("answers-file")) {
		// the operator's answers, applied as targeted edits onto the draft (first init) or the current file —
		// hand-written lines survive; the result is previewed until the operator's word anchors the write
		const parsed = parseAnswers(answerToks);
		if (parsed.errors.length) return { text: `answers REJECTED:\n- ${parsed.errors.join("\n- ")}`, isError: true };
		if (!parsed.answers.length) return { text: "usage: flow init --answers key=value [key=value …] | --answers-file <path> (one key=value per line)", isError: true };
		const base = current ?? draftFresh;
		const applied = applyAnswers(base, parsed.answers);
		const lint = parseProjectMd(applied.text);
		if (lint.hard.length) return { text: `project.md REJECTED:\n- ${lint.hard.join("\n- ")}`, isError: true };
		const preview = [`${current ? "playbook" : "draft"} with ${parsed.answers.length} answer(s):`, ...applied.changes.map((c) => `  ${c}`), "", mdDigest(applied.text)];
		const ok = flag("confirmed") || (ui.hasUI && (await ui.confirm("Write project.md?", preview.join("\n"))));
		if (!ok) {
			const open = questions.filter((x) => !parsed.answers.some(([k]) => k === x.key || (x.key === "check.<name>" && (k.startsWith("check.") || ["test", "build", "run"].includes(k)))));
			return { text: [...preview, "", `changes:\n${lineDiff(base, applied.text)}`, "", "not written — present this to the operator; on their confirmation re-run the same call with --confirmed", ...(open.length ? ["still unanswered:", ...renderQuestions(open)] : [])].join("\n") };
		}
		const w = writeMd(applied.text);
		if ("rej" in w) return w.rej;
		notes.push(`project.md written with ${parsed.answers.length} answer(s)`);
		await afterWrite(w, current, applied.text);
	} else if (flag("write") || flag("write-file")) {
		let content: string | undefined;
		if (flag("write-file")) {
			const f = flagValues(rest, "write-file")[0];
			if (!f || !existsSync(path.resolve(root, f))) return { text: `usage: flow init --write-file <path> — ${f ? `${f} does not exist` : "no path given"}`, isError: true };
			content = readFileSync(path.resolve(root, f), "utf8");
		} else {
			content = rest[rest.indexOf("--write") + 1];
			if (!content || content.startsWith("--")) return { text: 'usage: flow init --write "<full project.md content>" (or --write-file <path>)', isError: true };
		}
		const w = writeMd(content);
		if ("rej" in w) return w.rej;
		notes.push("project.md written (operator-owned playbook)");
		await afterWrite(w, current, content);
	} else if (!current) {
		// first init: never write silently. The questions come first — a dialog that offered the bare detection
		// draft before them wrote a playbook with the merge style, forge and versioning still unanswered.
		const brief = [
			"setup — project.md not written yet; nothing is drafted to disk until the operator confirms.",
			"detected:",
			...det.report.map((r) => `  ${r}`),
			"questions for the operator (detected value shown; `accept` is the answer that keeps it):",
			...renderQuestions(questions),
			AGENT_MARK + "ask these in chat — group the ones with an `accept` line as \"keep these?\", explain the rest in a line each. Then apply every answer in one call: flow init --answers key=value … (previews the digest and diff, writes nothing); on the operator's confirmation re-run it with --confirmed (add --track to commit the playbook). Free-text additions — checklist items, prose, flow-guard rules — go in through flow init --write-file <path> with the full file (flow init --draft prints the current draft).",
		];
		let wrote = false;
		if (ui.hasUI) {
			const accepts = questions.filter((x) => x.accept).map((x) => x.accept!);
			const withAccepts = applyAnswers(draftFresh, parseAnswers(accepts).answers).text;
			const ok = await ui.confirm("Accept the detected setup?", `${mdDigest(withAccepts)}\n\nWrite this now, keeping every detected value? ${questions.length - accepts.length} question(s) have no detected answer (${questions.filter((x) => !x.accept).map((x) => x.key).join(", ")}) — decline to answer them in chat first.`);
			if (ok) {
				const w = writeMd(withAccepts);
				if ("rej" in w) return w.rej;
				wrote = true;
				notes.push("wrote .dev-flow/project.md from detection with the detected values accepted — change any of them with flow init --answers key=value", ...det.report.map((r) => `  ${r}`));
				const open = questions.filter((x) => !x.accept);
				if (open.length) notes.push("still open (answer any time):", ...renderQuestions(open));
				await afterWrite(w, null, withAccepts, true);
			}
		}
		if (!wrote) notes.push(...brief);
	} else if (flag("force")) {
		// a destructive reset of the operator's own file needs their word: --confirmed for an agent, one dialog for a human
		const ok = flag("confirmed") || (ui.hasUI && (await ui.confirm("Overwrite project.md?", `flow init --force replaces the operator playbook with a fresh detection draft. Hand-written rules, checklist items and guidance are lost (a copy is kept as project.md.bak).`)));
		if (!ok) return { text: "flow init --force overwrites the operator playbook — that needs the operator's word: re-run with --confirmed (the current file is kept as project.md.bak)", isError: true };
		copyFileSync(mdFile, `${mdFile}.bak`);
		writeFileSync(mdFile, draftFresh);
		notes.push("project.md OVERWRITTEN (--force; previous copy kept as project.md.bak):", ...det.report.map((r) => `  ${r}`), GIT_TRACK_NOTE);
	} else {
		// re-init is the doctor's file-level check: findings are printed, the playbook is never regenerated —
		// a draft cannot reproduce hand-written prose, items and keys. Edit the file, or flow init --write.
		const loaded = loadProject(dfDir(root));
		const findings = doctorFindings(root, loaded.cfg, loaded.md);
		notes.push("project.md already exists — kept (edit it directly, flow init --answers key=value for one knob, --write-file to replace it, --force to redraft)", findings.length ? `doctor: ${findings.length} finding(s):` : "doctor: no findings", ...findings.map((x) => `  ${x}`));
	}
	const initCfg = loadProject(dfDir(root)).cfg;
	if (initCfg.mainHook) {
		// a hook manager (husky, lefthook…) points core.hooksPath elsewhere: git never runs .git/hooks then,
		// so a hook installed there would guard nothing — print the lines for the manager's own hook instead
		const hp = await sh("git config --get core.hooksPath", root, 10_000);
		const hooksPath = hp.ok ? hp.out.trim() : ""; // unset exits 1, and sh() then carries the error text
		const hookDir = path.join(root, ".git", "hooks");
		const hook = path.join(hookDir, "pre-commit");
		const body = mainHookBody(initCfg.defaultBranch);
		if (hooksPath && path.resolve(root, hooksPath) !== hookDir) {
			const theirs = path.join(hooksPath, "pre-commit");
			const has = existsSync(path.resolve(root, theirs)) && readFileSync(path.resolve(root, theirs), "utf8").includes("DEV_FLOW_ALLOW_MAIN");
			if (!has) notes.push(`core.hooksPath = ${hooksPath} — git runs hooks from there, not .git/hooks, so dev-flow installed none; to block main commits outside Pi, add to ${theirs}:\n${body}`);
		} else if (existsSync(hookDir) && !existsSync(hook)) {
			writeFileSync(hook, `#!/bin/sh\n# installed by dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden (override: DEV_FLOW_ALLOW_MAIN=1)\n${body}`, { mode: 0o755 });
			notes.push("pre-commit hook installed (blocks commits on main)");
		} else if (existsSync(hook) && !readFileSync(hook, "utf8").includes("installed by dev-flow") && !readFileSync(hook, "utf8").includes("DEV_FLOW_ALLOW_MAIN")) {
			notes.push(`existing pre-commit hook found — dev-flow did not replace it; main commits outside Pi stay unguarded until you add to .git/hooks/pre-commit:\n${body}`);
		}
	}
	return { text: notes.join("\n") };
}

export async function gateStart(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, rest, flag, slugArg } = o;
	if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] [--patch|--docs] [--merge=squash|merge|rebase|any] (slug: lowercase, dashes); --ui/--patch/--docs are operator-granted — ask the operator in chat, then add --confirmed", isError: true };
	// a ghost (plan/ but no state.json — typically a spin-off someone wrote by hand) is adopted, never a dead end:
	// "already exists, flow use it" sent the agent to use, which found no state, and doctor offered to delete it
	const ghost = existsSync(featDir(root, slugArg)) && !existsSync(stateFile(root, slugArg)) && existsSync(path.join(featDir(root, slugArg), "plan"));
	if (ghost && !flag("confirmed")) {
		const files = listFiles(path.join(featDir(root, slugArg), "plan"));
		return { text: `.dev-flow/${slugArg}/ is a ghost — plan/ (${files.join(", ") || "empty"}) but no state.json, so no flow owns it. Adopt it as this feature's draft plan: flow start ${slugArg} --confirmed (the operator agrees in chat), or delete the dir to start clean`, isError: true };
	}
	if (existsSync(featDir(root, slugArg)) && !ghost) {
		// --ui on the plan-stage feature this session drives: the operator asked for mockups after the start,
		// so turn the mockup gate on instead of refusing — a UI feature left at ui=false skips the mockup
		// proof at approve and every (ui) checklist item (lettuce rail-ui-fixes shipped 20 ungated mockups)
		const existing = readState(root, slugArg);
		if (flag("ui") && existing && sess.slug === slugArg) {
			if (!flag("confirmed")) return { text: "--ui is operator-granted — it adds a rendered-mockup requirement to the plan gate; ask the operator, then re-run with --confirmed", isError: true };
			if (existing.ui) return { text: `feature ${slugArg} already has the ui flag` };
			if (existing.stage !== "plan") return { text: `feature ${slugArg} is at ${existing.stage} — the ui flag can be set only at plan (the mockup gate is approve's); render the screens anyway and say so in the verify report`, isError: true };
			writeState(root, { ...existing, ui: true });
			return { text: `ui flag set on existing feature ${slugArg} (plan stage): the approve gate now requires rendered mockups under plan/mockups/ (${cfg.mockupGlobs.join(", ")}), each embedded in plan.md, and the (ui) checklist items apply` };
		}
		return { text: `feature ${slugArg} already exists — flow use ${slugArg} to resume it${existing?.stage === "plan" ? `; to add the mockup gate at plan, run flow start ${slugArg} --ui --confirmed from the session bound to it` : ""}`, isError: true };
	}
	// relaxed modes are operator-granted: --confirmed anchors a literal chat grant, same convention as the gate verbs
	if (flag("patch") && flag("docs")) return { text: "--patch and --docs are exclusive — ask the operator which mode they grant", isError: true };
	const mode = flag("patch") ? "patch" : flag("docs") ? "docs" : null;
	// every grant start needs goes into one question: a refusal for one names the others still open, so
	// the operator answers mode, mockups and merge policy in a single message
	const alsoMerge = !cfg.release.merge && flagValue(rest, "merge") === null ? `\n${AGENT_MARK}the playbook also has no merge policy — put it in the same question (squash | merge | rebase | any) and pass --merge=<style> on the same re-run` : "";
	if (mode && !flag("confirmed")) return { text: `${mode} mode is operator-granted — the operator must grant it in chat, then re-run with --confirmed${alsoMerge}`, isError: true };
	// --ui adds the rendered-mockup gate to plan: worth it only when screens change, and the operator says so
	if (flag("ui") && !flag("confirmed")) return { text: `--ui is operator-granted — it adds a rendered-mockup requirement to the plan gate, so use it only when the feature changes screens; ask the operator, then re-run with --confirmed${alsoMerge}`, isError: true };
	// branch discipline: features branch off the default branch — starting from a stale checkout poisons the base
	const curBr = await currentBranch(root);
	if (curBr !== cfg.defaultBranch && !flag("force")) return { text: `main checkout is on ${curBr}, not ${cfg.defaultBranch} — check out ${cfg.defaultBranch} first (git checkout ${cfg.defaultBranch} && git pull) or flow use an unfinished feature; --force to override`, isError: true };
	// --- preflight: is this session running the current build, and is the playbook complete? ---
	const notes: string[] = [];
	const skew = buildSkew(root);
	if (skew.line) notes.push(`warning: ${skew.line}`);
	const dupStart = copyWarning();
	if (dupStart) notes.push(dupStart);
	if (flag("check-upstream")) {
		const newest = await publishedVersion(root);
		notes.push(newest ? `published dev-flow: ${newest} (this build: ${loadedVersion() ?? "?"})${loadedVersion() && newest !== loadedVersion() ? " — an update is available" : ""}` : "could not read the published dev-flow version (offline?)");
	}
	// missing playbook parameters are printed at the moment they start to matter, not promised to a later doctor run
	const gaps = doctorFindings(root, cfg, loadProject(dfDir(root)).md).filter((x) => !x.startsWith("no merge policy"));
	if (gaps.length) notes.push(`playbook gaps (${gaps.length}) — advisory, flow doctor reviews and routes them:\n${gaps.slice(0, 5).map((g) => `  ${g}`).join("\n")}`);
	// the merge policy is the one blocking gap: it decides the shape of the default branch and nobody can
	// reconstruct it afterwards. Ask once in chat (a checkpoint word like any other), write the answer, continue.
	const styleArg = flagValue(rest, "merge");
	const style = styleArg === null ? null : parseMergeStyle(styleArg);
	if (styleArg !== null && !style) return { text: `--merge=${styleArg} is not a policy — use squash, merge, rebase or any`, isError: true };
	if (!cfg.release.merge || (style && style !== cfg.release.merge)) {
		if (!style) {
			const ev = await mergeHistoryEvidence(root, cfg.defaultBranch);
			return {
				text: needsOperator(
					`how should a merged PR land on ${cfg.defaultBranch}: squash, merge (a merge commit), rebase, or any (no policy)?${ev ? ` ${ev.note}${ev.recent ? ` Detected suggestion: ${ev.recent}.` : ""}` : ""} The answer is written into the playbook once.`,
					"Merge policy?",
					`ask the operator — in the same message as any mode or --ui grant you propose — then re-run once with everything: flow start ${slugArg} --merge=<style> [--ui] [--patch|--docs] --confirmed`,
				),
				isError: true,
			};
		}
		if (!flag("confirmed")) return { text: `writing merge = ${style} changes the operator playbook — the operator must answer it in chat first, then re-run with --confirmed`, isError: true };
		const written = await writePlaybookMergePolicy(root, style);
		if ("err" in written) return { text: written.err, isError: true };
		// the flow that just wrote the policy must see it: nextHint and the merge guard read this config
		cfg.release.merge = style;
		notes.push(written.note);
	}
	// stamp the dev-flow build that started this feature — a stuck flow can later be read against its tooling.
	// the stamp is what ran, not what the disk claims (that mismatch is the warning above).
	const state = newState(slugArg, flag("ui"), flag("patch"), flag("docs"), loadedVersion() ?? undefined);
	const planDir = path.join(featDir(root, slugArg), "plan");
	if (ghost) notes.push(`adopted ghost .dev-flow/${slugArg}/ — its plan/ (${listFiles(planDir).join(", ") || "empty"}) is this feature's draft`);
	mkdirSync(planDir, { recursive: true });
	// a roadmap item stamped for this slug carries its brief into the plan: the spin-off's context outlives the session that split it
	const picked = roadmapBriefFor(readRoadmap(root), slugArg);
	if (picked) {
		const planMd = path.join(planDir, "plan.md");
		const carried = `> Carried over from the roadmap: ${picked.item}${picked.brief ? `\n>\n${picked.brief.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n")}` : ""}\n`;
		if (!existsSync(planMd)) {
			writeFileSync(planMd, `# ${slugArg} — plan (draft)\n\n${carried}`);
			notes.push(`roadmap item "${picked.item}" seeded plan/plan.md${picked.brief ? " with its brief" : ""} — a draft: plan it out and approve as usual`);
		} else notes.push(`roadmap item "${picked.item}"${picked.brief ? ` — brief:\n${picked.brief}` : ""}`);
	}
	writeState(root, state);
	sess.bind(slugArg);
	sess.rename(slugArg);
	return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}${state.patch ? ", patch" : state.docs ? ", docs" : ""}${state.flowVersion ? `, dev-flow ${state.flowVersion}` : ""}); session renamed to ${slugArg}.${notes.length ? `\n${notes.join("\n")}` : ""}\n${AGENT_MARK}next: ${nextHint(state, cfg)}` };
}

export async function gateApprove(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const planDir = path.join(featDir(root, state!.slug), "plan");
	// the embed proofs read the plan document itself: a render that exists on disk but is not
	// embedded in plan.md is one the operator would never be shown
	const planMd = path.join(planDir, "plan.md");
	const planFiles = listFiles(planDir);
	const mockupHtml = planFiles.filter((f) => /^mockups\/.+\.html?$/i.test(f)).map((f) => ({ file: f, html: readFileSync(path.join(planDir, f), "utf8") }));
	const errs = approveGate(state!, cfg, planFiles, existsSync(planMd) ? readFileSync(planMd, "utf8") : undefined, foreignWorktreeLinks(dfDir(root), state!.slug, mockupHtml));
	if (errs.length) return { text: `plan gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
	const planItems = applicableItems(cfg, state!, "plan");
	let audit = flag("confirmed") ? " (confirmed by operator instruction)" : "";
	const askPending = !flag("confirmed");
	if (askPending) {
		markPendingAsk(root, state!, "Approve?");
		if (!ui.hasUI) {
			return { text: needsOperator("the plan is waiting for your approval", "Approve?", "re-run with --confirmed once the operator answered in chat"), isError: true };
		}
		const ok = await ui.confirm("Approve plan", `Approve ${state!.slug}${state!.ui ? " (UI)" : ""}${state!.patch ? " (patch)" : state!.docs ? " (docs)" : ""}? Creates the worktree.${flag("yolo") ? " YOLO: all later gate questions (Verified?/Release?/Finish?) are pre-confirmed — checks and guardrails stay in place." : ""}`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "approval declined — keep iterating on the plan" };
		}
		audit = " (confirmed in dialog)";
	}
	// the operator's word at Approve?, recorded only once given: every later gate question is pre-confirmed; checks and guardrails stay
	if (flag("yolo")) state!.yolo = true;
	if (planItems.length) state!.confirmations = { ...state!.confirmations, plan: { hash: checklistHash(planItems), at: now() } };
	const branch = subst(cfg.branchPattern, state!.slug);
	const wtRel = subst(cfg.worktreeDir, state!.slug);
	const wt = path.resolve(root, wtRel);
	let setupNote = "";
	if (!existsSync(wt)) {
		// branch discipline: features branch off the default branch — never from a stale checkout HEAD
		const base = (await sh(`git rev-parse --verify -q origin/${cfg.defaultBranch}`, root)).ok ? `origin/${cfg.defaultBranch}` : cfg.defaultBranch;
		const res = await sh(`git worktree add ${sq(wt)} -b ${branch} ${base}`, root);
		if (!res.ok) return { text: `worktree creation failed:\n${res.out}`, isError: true };
	}
	// setup is worktree work of a normal feature: a docs flow runs no project command at all (#49),
	// and a worktree left behind by a setup that never succeeded must be retried — "fix it and run
	// approve again" was a silent no-op on the reused directory (#49). setup is expected to be idempotent.
	const setupCmd = state!.docs ? undefined : cfg.commands.setup;
	if (setupCmd && !state!.setupAt) {
		const s = await sh(setupCmd, wt);
		if (!s.ok) return { text: `setup failed in ${wtRel} — fix commands.setup, then run flow approve again (the worktree is kept and setup retried):\n${tail(s.out)}`, isError: true };
		state!.setupAt = now();
		setupNote = `\nsetup ran in the worktree (${setupCmd}).`;
	} else if (state!.docs && cfg.commands.setup) {
		setupNote = "\nsetup skipped (docs mode — no project commands run).";
	}
	state!.branch = branch;
	state!.worktree = wtRel;
	state!.stage = "implement";
	state!.approvals.plan = now();
	delete state!.pendingAsk;
	writeState(root, state!);
	return { text: `plan approved${audit}${state!.yolo ? " — yolo: later gate questions pre-confirmed" : ""}; worktree ${wtRel} on branch ${branch}.${setupNote}\n${AGENT_MARK}next: ${nextHint(state!, cfg)}` };
}

export async function gateStatus(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, flag, slugArg } = o;
	const df = dfDir(root);
	const { md } = loadProject(df);
	// cheap fs probes only (no git subprocesses) — status is a glance, `flow doctor` is the full list
	const findings = md ? doctorFindings(root, cfg, md) : [];
	// a session running an older build than the disk ships is the one thing a glance must say: every
	// gate proof printed since the drift began belongs to the older code.
	const skew = buildSkew(root);
	// hints read as something the operator could say; the agent's command for each rides an agent-only line
	const warn = [
		...(findings.length ? [`⚠ ${findings.length} playbook finding(s) — say "check the playbook" to go through them`, `${AGENT_MARK}playbook findings: run flow doctor`] : []),
		...(skew.line ? [`⚠ ${skew.line}`] : []),
		...(copyWarning() ? [copyWarning()!] : []),
	];
	// the backlog nudge belongs to the no-features answer too — that is when a pick is most useful
	const rmap = roadmapOpenCount(readRoadmap(root));
	const rmapLine = rmap ? [`◇ ${rmap} roadmap item(s) open — say "show the roadmap"`, `${AGENT_MARK}roadmap: flow roadmap lists them`] : [];
	const slugs = slugArg ? [slugArg] : unfinishedStates(root).map((s) => s.slug);
	const cur = sess.slug; // only a bound session has a current feature — the lone-unfinished hint would pose unbound sessions as owning it
	if (flag("json")) {
		const sts = slugs.map((s) => readState(root, s)).filter((s): s is FlowState => s !== null);
		return { text: statusJson(sts, cur, cfg) }; // before the prose "no features" answer — an orchestrator must be able to parse the empty case too
	}
	if (!slugs.length) return { text: ["no features in flight — describe what you want built to start one", `${AGENT_MARK}start one: flow start <slug> [--ui] [--patch|--docs --confirmed]`, ...warn, ...rmapLine].join("\n") };
	// one readable row per feature for the operator; the identifiers an agent needs stay on agent-only lines
	const lines = slugs.flatMap((s) => {
		const st = readState(root, s);
		if (!st) return [];
		const checks = Object.entries(st.checks).map(([k, v]) => `${k} ${v.ok ? "✓" : "✗"}`).join(" ");
		const tags = [st.ui ? "ui" : "", st.patch ? "patch" : st.docs ? "docs" : "", st.yolo ? "yolo" : "", st.noVersion ? "no-version" : ""].filter(Boolean);
		const row = [
			`${STAGE_EMOJI[st.stage]} ${st.stage}`,
			...(tags.length ? [tags.join(", ")] : []),
			...(checks ? [`checks ${checks}`] : []),
			...(st.confirmations?.implement ? ["checklist ✓"] : []),
			...(st.pendingAsk ? [`💬 waiting on you: ${st.pendingAsk}`] : []),
		];
		return [
			`${s === cur ? "→" : "-"} **${s}**${s === cur ? " (this session)" : ""} — ${row.join(" · ")}`,
			`${AGENT_MARK}${s}: stage=${st.stage} branch=${st.branch || "-"} worktree=${st.worktree || "-"}${st.flowVersion ? ` flow=${st.flowVersion}` : ""} approvals: ${Object.keys(st.approvals).join(", ") || "none"}`,
			`${AGENT_MARK}${s} next: ${nextHint(st, cfg)}`,
		];
	});
	// who holds the dev stack: the one thing two parallel flows on one machine must not guess
	for (const [k, v] of Object.entries(readDevPorts(root))) lines.push(`dev ${k === "default" ? "stack" : `port ${k}`} → ${v.slug} @ ${v.head.slice(0, 7)}, deployed ${ago(v.at)}`);
	if (warn.length) lines.push(...warn);
	// which identity this session's state is keyed by: a claim fight is undiagnosable when the key
	// could be a session id or a shared directory and the output does not say which
	lines.push(`${AGENT_MARK}session: ${sess.key}${sess.key.startsWith("cwd:") ? " — no session id from pi, so every pi session in this directory shares one dev-flow binding (pass flow use <slug> in each)" : ""}`);
	const refl = readReflections(root);
	if (refl.length) lines.push(`↻ ${refl.length} reflection(s) open — say "review the reflections" to go through them`, `${AGENT_MARK}reflections: run flow doctor (it reviews and routes them)`);
	lines.push(...rmapLine);
	return { text: lines.join("\n") || "no features" };
}

export async function gateReflect(o: GateCtx): Promise<RunResult> {
	const { root, sess, rest, flag } = o;
	// gate flags belong to the state verbs — pasted into the note they read as part of the operator's
	// own sentence in reflections.md (#43). --plugin/--playbook/--both are reflect's own: they state
	// the filing instead of leaving it to a keyword guess.
	const words = rest.filter((a) => !a.startsWith("--"));
	const forced: ReflectTarget | null = flag("plugin") ? "plugin" : flag("code") ? "code" : flag("playbook") || flag("docs") ? "playbook" : null;
	// single words are verbs (roadmap-style); a note merely starting with one stays a note
	if (words.length === 1 && words[0] === "tidy") return reflectTidy(root);
	if (words.length === 1 && words[0] === "list") return await reflectList(root);
	if (words[0] === "move") return reflectMoveNote(root, words.slice(1), forced);
	if (words[0] === "done") return reflectDoneNote(root, sess, words.slice(1));
	if (words.length) return await reflectNote(root, sess, words, forced);
	const self = pluginVersion(import.meta.dirname);
	const upstream = await pluginUpstream(root);
	const refl = readReflections(root);
	const fold = await foldView(root, refl);
	const nudges = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { between: !sess.slug });
	return {
		text: reflectProtocol(refl, isSelfRepo(root), {
			version: self.version,
			upstream,
			bound: !!sess.slug,
			fix: nudges.fix,
			tidy: nudges.tidy,
			ghFold: fold.state === "ok" && fold.open ? { repo: fold.slug, open: fold.open, similar: fold.result.similar.length } : undefined,
		}).join("\n"),
	};
}

export async function gateRoadmap(o: GateCtx): Promise<RunResult> {
	const { root, sess, rest } = o;
	// the backlog is advisory — no state, no gating; direct file edits stay allowed like reflections.md
	const words = rest.filter((a) => !a.startsWith("--")); // gate flags are not backlog prose (#43 applies here too)
	const [verb = "list", ...args] = words;
	const text = readRoadmap(root);
	const open = roadmapOpenCount(text);
	const done = doneItemCount(text);
	const save = (next: string) => writeFileSync(roadmapFile(root), next); // .dev-flow/ existence is runFlow's precondition
	const idx = Number(args[0]);
	const validIdx = Number.isInteger(idx) && idx >= 1 && idx <= open;
	switch (verb) {
		case "list": {
			if (!open) return { text: done ? `roadmap: nothing open (${done} done — flow roadmap tidy drops them)` : "roadmap: empty — flow roadmap add \"<future feature>\"" };
			return { text: [`roadmap — ${open} open (${done} done):`, ...openChecklistItems(text).map((l, i) => `  ${i + 1}. ${l.slice(6)}`)].join("\n") };
		}
		case "add": {
			if (!args.length) return { text: 'usage: flow roadmap add "<future feature>" [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]', isError: true };
			// a spin-off: --slug stamps it like pick (flow start finds it), the brief carries what was worked
			// out in chat into the new feature's plan, and a bound session records where it was split from
			const slug = flagValue(rest, "slug");
			if (slug !== null && !validSlug(slug)) return { text: `--slug=${slug} is not a slug (lowercase, dashes)`, isError: true };
			const briefFile = flagValue(rest, "brief-file");
			if (briefFile !== null && !existsSync(path.resolve(root, briefFile))) return { text: `--brief-file=${briefFile} does not exist`, isError: true };
			const brief = briefFile !== null ? readFileSync(path.resolve(root, briefFile), "utf8") : (flagValue(rest, "brief") ?? "");
			const item = [args.join(" "), sess.slug && sess.slug !== slug ? `— split from ${sess.slug}` : "", slug ? `(${slug})` : ""].filter(Boolean).join(" ");
			save(appendRoadmapItem(text, item, brief));
			return { text: `roadmap: added — ${open + 1} open${slug ? `; stamped for ${slug}${brief.trim() ? " with a brief" : ""} — flow start ${slug} seeds its plan from it${sess.slug ? ` (after ${sess.slug} ships)` : ""}` : ""}` };
		}
		case "pick": {
			const slug = args[1] ?? "";
			if (!validIdx) return { text: `pick: open item 1–${open} required — flow roadmap lists them`, isError: true };
			if (!slug || !validSlug(slug)) return { text: `usage: flow roadmap pick <n> <slug> — the slug flow start will use (lowercase, dashes)`, isError: true };
			save(roadmapPick(text, idx, slug)!);
			return { text: `roadmap: item ${idx} picked for ${slug} — now: flow start ${slug} (flow finish checks the item off when it ships)` };
		}
		case "done": {
			if (!validIdx) return { text: `done: open item 1–${open} required — flow roadmap lists them`, isError: true };
			// stamped with date + bound slug, so history says what shipped it
			save(roadmapDone(text, idx, [new Date().toISOString().slice(0, 10), sess.slug].filter(Boolean).join(" "))!);
			return { text: `roadmap: item ${idx} marked done (${open - 1} open)` };
		}
		case "tidy": {
			if (!done) return { text: `roadmap: nothing to tidy (${open} open, 0 done)` };
			save(roadmapTidy(text));
			return { text: `roadmap: dropped ${done} done item(s) — ${open} open` };
		}
		default:
			return { text: "usage: flow roadmap [list|add <text> [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]|pick <n> <slug>|done <n>|tidy]", isError: true };
		}
}

export async function gateDoctor(o: GateCtx): Promise<RunResult> {
	const { root, rest } = o;
	// read-only findings on demand — never writes, never asks, safe for agents and CI at any stage
	const df = dfDir(root);
	const loaded = loadProject(df);
	const findings = doctorFindings(root, loaded.cfg, loaded.md);
	findings.push(...(await gitConsistency(root, loaded.cfg)));
	const refl = readReflections(root);
	const fold = await foldView(root, refl);
	if (refl.length) {
		findings.push(`reflection review — ${refl.length} open item(s); doctor never implements: investigate each, present the fix, the operator confirms, then the routed flow implements it:`);
		// labelled from the heading each item sits under — the file is the record, re-guessing from the
		// note text made doctor's table disagree with where the note was actually filed
		reflectionRoutes(refl, isSelfRepo(root)).forEach((r, i) => {
			const link = fold.state === "ok" ? fold.result.linked.find((l) => l.item === i) : undefined;
			findings.push(`  [${r.sections.join("+")}] ${r.text}${link ? linkedTag(link.issue) : ""}\n      → ${r.route}${link ? ` — already upstream (gh#${link.issue}); check off with — filed: gh#${link.issue} once it lands` : ""}`);
		});
	}
	findings.push(...foldRows(fold, isSelfRepo(root)));
	const reflText = readReflectionsText(root);
	const unfiled = reflectUnfiledCount(reflText);
	if (unfiled) findings.push(`  reflections: ${unfiled} open item(s) sit outside ## playbook / ## code — flow reflect list shows them, flow reflect move <n> --playbook|--code files them`);
	findings.push(...legacyPluginRows(reflText, isSelfRepo(root)).map((r) => `  ${r}`));
	const nudges = reflectionNudges(reflText, now().slice(0, 10), { between: !o.sess.slug });
	if (nudges.fix) findings.push(nudges.fix);
	if (nudges.tidy) findings.push(nudges.tidy);
	if (!rest.length) return { text: findings.length ? `doctor: ${findings.length} finding(s)\n${findings.map((f) => `  ${f}`).join("\n")}` : "doctor: no findings — playbook, flow state and git layout are consistent" };
	// flow doctor <note>: a fresh observation gets an investigation brief and a fix route
	return { text: investigationBrief(rest.filter((a) => !a.startsWith("--")).join(" "), isSelfRepo(root)).join("\n") };
}

/** What a gate handler needs from the runFlow preamble. */
export interface GateCtx {
	root: string;
	ui: Ui;
	sess: Session;
	cfg: Config;
	rest: string[];
	flag: (name: string) => boolean;
	slugArg?: string;
	takeYoloWord: (state: FlowState) => string | null;
	hooks: FlowHooks;
}

export async function gateVersion(o: GateCtx): Promise<RunResult> {
	const { root, flag } = o;
	// the plugin's own version — separate from the project's versioning.file version the release gates use
	const { disk: self, behind } = buildSkew(root);
	const head = self.version ? `dev-flow ${self.version} (pi-dev-flow at ${self.dir})` : `dev-flow version unknown — no pi-dev-flow package.json above ${self.dir}`;
	// in the dev-flow repo head names the checkout, so name where the stale code actually lives
	const from = SELF_BUILD.dir !== self.dir ? ` (from ${SELF_BUILD.dir})` : "";
	const dupNote = copyWarning();
	// --check-upstream is the one that asks the registry; plain flow version stays offline and instant
	if (flag("check-upstream")) {
		const newest = await publishedVersion(root);
		return { text: newest ? `${head} — published: ${newest}${self.version && newest !== self.version ? " (update available)" : ""}` : `${head} — could not read the published version (offline?)` };
	}
	return { text: `${behind ? `${head} — but this session runs ${behind}${from}; /reload to run ${self.version} \u2014 in a shared-process host (pi-web) reload cannot swap loaded code: only a host restart does` : head}${dupNote ? `\n${dupNote}` : ""}` };
}

export async function gateTest(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	if (!cfg.commands.test) return { text: "no commands.test configured — add `test = <command>` under ## implement in .dev-flow/project.md", isError: true };
	const res = await sh(cfg.commands.test, gateCwd(root, state!), undefined, featureEnv(root, state!));
	state!.checks.test = { ok: res.ok, at: now() };
	await stampChecks(root, state!, ["test"]);
	writeState(root, state!);
	return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
}

export async function gateCheck(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// a docs flow runs no project command anywhere else — pendingChecks, verifyGate and releaseGate all skip
	// it — so running tier-1 here only produced a FAIL that read like a broken deploy in a checkout that
	// never built the binary (#96)
	// shortcut: --docs is the operator's word, nothing checks the changeset is docs-only, so a mislabelled
	// flow now gets no test run at all; the mechanical fix is a diff-scope guard at verify if it ever bites
	if (state!.docs) return { text: "docs mode: project commands skipped — a docs flow runs no tier-1 checks (CI on the tag and the artifact proof still do)" };
	if (!cfg.checkList.length) return { text: 'no tier-1 checks configured — add ```flow blocks / flow-check blocks to ## implement in project.md', isError: true };
	const ran = await runChecks(root, state!, cfg, cfg.checkList);
	return { text: `tier-1 checks:\n${ran.lines.join("\n")}`, isError: ran.failed };
}

export async function gateHealth(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// commands.health and a flow-check named health are the same probe (healthProbe reads both)
	const probe = healthProbe(cfg);
	if (!probe) return { text: "no health check configured — add `health = <command>` (or a flow-check health block) under ## implement in .dev-flow/project.md", isError: true };
	const res = await probeHealth(root, state!, cfg, probe);
	if ("seedFail" in res) return res.seedFail;
	return { text: `health: ${res.ok ? "PASS" : "FAIL"} (${probe}${triedNote(res.attempts)})\n${tail(res.out)}` };
}

export async function gateUse(o: GateCtx): Promise<RunResult> {
	const { root, sess, slugArg } = o;
	if (!slugArg) return { text: "usage: flow use <slug>", isError: true };
	const st = readState(root, slugArg);
	if (!st) {
		const ghost = existsSync(path.join(featDir(root, slugArg), "plan"));
		return { text: ghost ? `.dev-flow/${slugArg}/ is a ghost — plan/ but no state.json, so there is nothing to resume: flow start ${slugArg} --confirmed adopts its plan as a new feature` : `no unfinished feature ${slugArg}`, isError: true };
	}
	const prior = readClaim(root, slugArg);
	const takeover = claimBlocks(prior, sess.key) ? ` — taken over from live session (pid ${prior!.pid})` : "";
	sess.bind(slugArg);
	sess.rename(slugArg);
	// a checkpoint that was still unanswered belongs to whoever asked; a session taking the feature over
	// must not inherit a 💬 for a question it never posed
	if (st.pendingAsk) {
		delete st.pendingAsk;
		writeState(root, st);
	}
	return { text: `this session is now bound to ${slugArg} (stage ${st.stage})${st.worktree ? ` — work in its worktree: ${st.worktree} (branch ${st.branch})` : ""}; session renamed to ${slugArg}${takeover}` };
}

export async function gateAbort(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, flag, slugArg } = o;
	// Unbinds the session only; state and worktree stay for manual recovery.
	const target = slugArg ?? sess.slug;
	if (!target) return { text: "nothing bound — pass a slug", isError: true };
	const st = readState(root, target);
	// a live claim locks the whole feature, not only its gates: aborting it out from under the session
	// that works it erases the plan that session is still writing (same rule needState applies)
	const claim = readClaim(root, target);
	if (claimBlocks(claim, sess.key)) return { text: `${target} is claimed by another live session (pid ${claim!.pid}) — flow use ${target} takes it over explicitly`, isError: true };
	if (st && !st.worktree) {
		// plan-stage abort = drop: no worktree/branch exists, so the state dir would linger
		// as a ghost the doctor flags (a plan/ whose state.json is gone). A written plan is the
		// operator's work too — it is not dropped without their word.
		const written = listFiles(path.join(featDir(root, target), "plan"));
		if (written.length && !flag("confirmed")) {
			const ok = ui.hasUI && (await ui.confirm("Drop plan?", `Abort ${target}? Its plan/ (${written.join(", ")}) is deleted for good.`));
			if (!ok) return { text: needsOperator(`aborting ${target} deletes its written plan (${written.join(", ")})`, "Drop plan?", "ask the operator, then re-run with --confirmed"), isError: true };
		}
		if (sess.slug === target) sess.bind(null);
		rmSync(featDir(root, target), { recursive: true, force: true });
		return { text: `aborted ${target} — feature removed (nothing approved, nothing to recover)` };
	}
	if (sess.slug === target) sess.bind(null);
	// the scratch dir is the bound session's working junk — it does not outlive the binding
	rmSync(featureTmpDir(dfDir(root), target), { recursive: true, force: true });
	if (st?.worktree) { st.aborted = now(); writeState(root, st); } // the doctor skips the removed worktree for stamped states (gh#138)
	return { text: `session unbound from ${target}; state stays at .dev-flow/${target}/` + (st?.aborted ? " (marked aborted — the doctor leaves it alone once you clean the worktree up)" : "") + (st?.worktree ? `\nto remove the worktree and branch:\n  git worktree remove ${st.worktree}\n  git branch -D ${st.branch}` : "") };
}
