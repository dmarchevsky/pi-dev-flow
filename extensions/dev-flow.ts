/**
 * dev-flow: enforced feature-flow state machine for Pi (pi package extension).
 *
 * Stages: plan → implement → release → done, per feature,
 * with state in <repo>/.dev-flow/<slug>/state.json (gitignored, flow-owned).
 *
 * Enforcement has three teeth:
 *  1. Gate commands (/flow approve|verify|release-done|finish) refuse
 *     to advance unless exit criteria hold (plan file, mockups, green tests,
 *     operator confirmations, merged worktree).
 *  2. tool_call guards: no commits/pushes on the main branch outside the
 *     release stage; edits confined to the plan dir or the worktree; state.json
 *     and project.json are untouchable by the agent.
 *  3. before_agent_start injects the active stage so the model always knows
 *     where it is and which gate comes next.
 *
 * The stage logic lives in src/core.ts (unit-tested); this file is pi wiring.
 * Inactive (fully pass-through) in repos without a .dev-flow/ directory.
 */
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, isToolCallEventType, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	approveGate,
	applicableItems,
	appendReflection,
	bashFlowGuard,
	checklistHash,
	checklistPending,
	checkoutTarget,
	claimBlocks,
	cleanupAssess,
	compactionReflectionLine,
	featureBranchPrefix,
	gitInvocation,
	guardBash,
	guardPath,
	parsePushRefs,
	pluginVersion,
	preReleaseGate,
	reflectSections,

	listFiles,
	newState,
	nextHint,
	openReflections,
	releaseGate,
	parseVersion,
	shouldSelfCompact,
	stateTamper,
	statusCompact,
	subst,
	validSlug,
	verifyGate,
	versionTagGate,
	writeGuard,
	type Config,
	type FeatureRef,
	type FlowState,
	type PushRef,
	type SessionClaim,
	type Stage,
} from "../src/core.ts";
import { buildDraft, doctorFindings, ghostFeatureDirs, loadProject, mdDigest, parseProjectMd } from "../src/projectmd.ts";
import { detectProject } from "../src/detect.ts";

const execAsync = promisify(exec);

interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
	/** Multi-line review/edit dialog where the client has one (TUI); undefined elsewhere. */
	editor?: (title: string, prefill?: string) => Promise<string | undefined>;
}

const now = () => new Date().toISOString();

async function sh(command: string, cwd: string): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout, stderr } = await execAsync(command, { cwd, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
		return { ok: true, out: `${stdout}\n${stderr}`.trim() };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || String(err.message) };
	}
}

const dfDir = (root: string) => path.join(root, ".dev-flow");
const GATE_HELP =
	"help | init [--force|--draft|--write <text>] | doctor [reflect <note>] | status [slug] | start <slug> [--ui] [--patch|--docs --confirmed] | use <slug> | test | check | health | approve [--yolo] | verify | release [--no-version] | release-done | finish [slug] | abort [slug] | version — state gates take [slug] and --confirmed (the operator already answered in chat); --patch/--docs likewise need --confirmed (the operator granted the mode); approve --yolo = the operator said \"yolo\": all later gate questions pre-confirmed (checks and guardrails stay); release --no-version = this flow skips the version bump and tag (default: versioned)";
const featDir = (root: string, slug: string) => path.join(dfDir(root), slug);
const stateFile = (root: string, slug: string) => path.join(featDir(root, slug), "state.json");
const claimFile = (root: string, slug: string) => path.join(featDir(root, slug), "claim.json");

function readState(root: string, slug: string): FlowState | null {
	try {
		return JSON.parse(readFileSync(stateFile(root, slug), "utf8")) as FlowState;
	} catch {
		return null;
	}
}

function writeState(root: string, state: FlowState): void {
	writeFileSync(stateFile(root, state.slug), `${JSON.stringify(state, null, "\t")}\n`);
}

/** Session bindings: one flow per pi session; persisted per session branch via appendEntry. */
const bindings = new Map<string, string | null>();
const sessionKey = (ctx: { cwd: string; sessionManager?: { getSessionId(): string } }) => ctx.sessionManager?.getSessionId() ?? ctx.cwd;
/** Sessions with a dev-flow-initiated compaction in flight (prevents stacked compactions). */
const compacting = new Set<string>();

function unfinishedStates(root: string): FlowState[] {
	if (!existsSync(dfDir(root))) return [];
	return readdirSync(dfDir(root), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readState(root, d.name))
		.filter((s): s is FlowState => !!s && s.stage !== "done");
}

/** Open items of the agent's suggestion queue (.dev-flow/reflections.md). */
const readReflections = (root: string): string[] => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? openReflections(readFileSync(f, "utf8")) : [];
};

/** The session's feature: explicit binding, else the single unfinished feature — auto-bind unless another live session claims it. */
function boundFeature(root: string, key: string): FlowState | null {
	const bound = bindings.get(key);
	if (bound) {
		const s = readState(root, bound);
		if (s && s.stage !== "done") return s;
	}
	const un = unfinishedStates(root);
	if (un.length !== 1) return null;
	const claim = readClaim(root, un[0].slug);
	// shortcut: liveness is pid-only — pid reuse can read "live" and force an explicit flow use; friction only, never a wrong commit.
	if (claimBlocks(claim, key)) return null;
	if (claim?.key !== key) writeClaim(root, un[0].slug, key);
	return un[0];
}

function readClaim(root: string, slug: string): SessionClaim | null {
	try {
		return JSON.parse(readFileSync(claimFile(root, slug), "utf8")) as SessionClaim;
	} catch {
		return null;
	}
}

const writeClaim = (root: string, slug: string, key: string) =>
	writeFileSync(claimFile(root, slug), `${JSON.stringify({ key, pid: process.pid, at: now() })}\n`);

/** The auto-bind this session was denied by another live session's claim — lets the unbound-context message name the feature. */
function claimBlocker(root: string, key: string): { state: FlowState; claim: SessionClaim } | null {
	const un = unfinishedStates(root);
	if (un.length !== 1) return null;
	const claim = readClaim(root, un[0].slug);
	return claim && claimBlocks(claim, key) ? { state: un[0], claim } : null;
}

/**
 * Flow-aware self-compaction at safe points: called after a successful gate (state just hit disk)
 * and when a run settles. Only fires within COMPACT_MARGIN of pi's own threshold and never while
 * chat-only state is pending (open dialog, undigested plan) — see shouldSelfCompact.
 */
function maybeCompactNow(ctx: ExtensionContext): void {
	if (!existsSync(dfDir(ctx.cwd))) return;
	const u = ctx.getContextUsage?.(); // minimal/fake contexts may lack usage info — treat as unknown
	if (!u || u.tokens === null) return;
	const key = sessionKey(ctx);
	const st = boundFeature(ctx.cwd, key);
	if (!st) return;
	const cfg = loadProject(dfDir(ctx.cwd)).cfg;
	const decision = {
		tokens: u.tokens,
		contextWindow: u.contextWindow,
		stage: st.stage,
		planFiles: listFiles(path.join(featDir(ctx.cwd, st.slug), "plan")).length,
		checklistPending: checklistPending(cfg, st, st.stage),
		compacting: compacting.has(key),
	};
	if (!shouldSelfCompact(decision)) return;
	compacting.add(key);
	const done = () => compacting.delete(key);
	ctx.compact({
		customInstructions: `dev-flow feature "${st.slug}", stage "${st.stage}" — flow state is persisted on disk (state.json, plan/). Preserve verbatim: operator answers not yet recorded by a gate, reasons for uncommitted changes, and the exact next action from the last exchange.`,
		onComplete: done,
		onError: done,
	});
}

function featureRefs(root: string): FeatureRef[] {
	return unfinishedStates(root).map((s) => ({ state: s, worktreeAbs: s.worktree ? path.resolve(root, s.worktree) : null }));
}

function worktreeAbs(root: string, state: FlowState): string | null {
	return state.worktree ? path.resolve(root, state.worktree) : null;
}

/** Git-level consistency probes for the doctor: orphan worktrees/branches, features missing their worktree. */
async function gitConsistency(root: string, cfg: Config): Promise<string[]> {
	const feats = unfinishedStates(root);
	const out: string[] = [];
	const wtRoot = path.resolve(root, cfg.worktreeDir.split("{")[0]);
	const owned = new Set(feats.map((f) => (f.worktree ? path.resolve(root, f.worktree) : "")));
	const wtRaw = await sh("git worktree list --porcelain", root);
	if (wtRaw.ok)
		for (const line of wtRaw.out.split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const abs = path.resolve(line.slice(9).trim());
			if (abs !== path.resolve(root) && abs.startsWith(wtRoot) && !owned.has(abs)) out.push(`orphan worktree ${path.relative(root, abs)} — no feature owns it (git worktree remove)`);
		}
	const ownedBr = new Set(feats.map((f) => f.branch));
	const brRaw = await sh(`git branch --list ${JSON.stringify(`${featureBranchPrefix(cfg)}*`)}`, root);
	if (brRaw.ok)
		// git marks the current branch with "* " and a worktree-checked-out one with "+ " — strip both, or an active feature's own branch never matches ownedBr
		for (const b of brRaw.out.split("\n").map((x) => x.replace(/^[*+]?\s+/, "").trim()).filter(Boolean)) {
			if (!ownedBr.has(b)) out.push(`orphan branch ${b} — no unfinished feature owns it (git branch -D ${b})`);
		}
	for (const f of feats) if (f.worktree && !existsSync(path.resolve(root, f.worktree))) out.push(`feature ${f.slug} (${f.stage}) has no worktree at ${f.worktree}`);
	return out;
}

/** Where feature commands run: the feature worktree once it exists (that is where the
 *  code under test lives), else the main checkout. Keeps gates off the main branch. */

/** Lines the current project.md has that a regenerated draft cannot reproduce. */
function droppableLines(current: string, draft: string): string[] {
	const keep = new Set(draft.split("\n").map((l) => l.trim()).filter(Boolean));
	return current.split("\n").map((l) => l.trim()).filter((l) => l && !keep.has(l));
}

function gateCwd(root: string, state: FlowState): string {
	const wt = worktreeAbs(root, state);
	return wt && existsSync(wt) ? wt : root;
}

// ---------------------------------------------------------------- gate runner

interface RunResult {
	text: string;
	isError?: boolean;
}

interface Session {
	slug: string | null;
	key: string;
	bind: (slug: string | null) => void;
}

/** `flow doctor reflect <note>` — advisory queue, operator decides. The note lands in the
 *  playbook and/or plugin section of reflections.md, chosen from its wording. */
function reflectNote(root: string, sess: Session, note: string[]): RunResult {
	const file = path.join(dfDir(root), "reflections.md");
	if (!note.length) {
		const open = readReflections(root);
		return { text: open.length ? `open reflections:\n${open.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}` : 'no open reflections — flow doctor reflect "<note>" parks a suggestion for the operator' };
	}
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const sections = reflectSections(note.join(" "));
	const line = `- [ ] ${note.join(" ")} — ${sess.slug ?? "-"} ${now().slice(0, 10)}`;
	writeFileSync(file, appendReflection(text, sections, line));
	return { text: `reflected (${sections.join(" + ")}): ${line}` };
}

/** Single runner for both the /flow command and the flow tool. */
async function runFlow(args: string[], root: string, ui: Ui, sess: Session): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	// help and version are questions about the plugin, not the repo: answerable with no .dev-flow/ at all
	if (sub === "help" || sub === "--help" || sub === "-h") return { text: `usage: flow <sub> — ${GATE_HELP}` };
	if (!existsSync(dfDir(root)) && sub !== "init" && sub !== "version") return { text: "no .dev-flow/ in this repo — run /flow init first", isError: true };
	const cfg = loadProject(dfDir(root)).cfg;
	const flag = (name: string) => rest.includes(`--${name}`);
	const slugArg = rest.find((a) => !a.startsWith("--"));

	switch (sub) {
		case "init": {
			mkdirSync(dfDir(root), { recursive: true });
			const notes: string[] = [`.dev-flow/ created in ${root}`];
			// self-ignoring folder: nothing under .dev-flow/ ever enters git, without touching tracked files
			writeFileSync(path.join(dfDir(root), ".gitignore"), "*\n");
			rmSync(path.join(dfDir(root), ".current"), { force: true }); // migrate away the legacy repo-global pointer
			const mdFile = path.join(dfDir(root), "project.md");
			const jsonFile = path.join(dfDir(root), "project.json");
			const head = await sh("git symbolic-ref refs/remotes/origin/HEAD", root);
			const curBr = await currentBranch(root);
			// never propose a feature branch (contains "/") as the default branch
			const branch = (head.ok ? head.out.match(/refs\/remotes\/origin\/(.+)/)?.[1] : undefined) || (curBr.includes("/") ? undefined : curBr) || "main";
			const det = detectProject(root, branch);
			const loaded = loadProject(dfDir(root));
			const draftFresh = buildDraft(det);
			const draftRefresh = buildDraft(det, loaded.cfg);
			const editHint = "to change anything: edit .dev-flow/project.md directly (flow init = doctor revalidates), or from an agent session: flow init --draft → discuss → --write";
			if (flag("draft")) return { text: existsSync(mdFile) ? readFileSync(mdFile, "utf8") : draftFresh }; // read path: prints content, writes nothing (and offers no deletions)
			// ghosts: feature dirs whose state.json is gone — inert, invisible to status and guards, and only findable by eye
			const ghosts = ghostFeatureDirs(root);
			if (ghosts.length) {
				if (!ui.hasUI) notes.push(`${ghosts.length} ghost feature dir(s) — a plan/ with no state.json, no flow owns them (${ghosts.join(", ")}); delete them or run flow init interactively`);
				else if (await ui.confirm("Remove ghost feature dirs?", `${ghosts.map((g) => `${g} — plan/ with no state.json`).join("\n")}\n\nNo flow owns these; their plan/*.md is not recoverable afterwards.`)) {
					for (const g of ghosts) rmSync(path.join(root, g), { recursive: true, force: true });
					notes.push(`removed ${ghosts.length} ghost feature dir(s): ${ghosts.map((g) => g.slice(".dev-flow/".length)).join(", ")}`);
				} else notes.push(`kept ${ghosts.length} ghost feature dir(s) — inert, remove them whenever you like`);
			}
			const writeMd = (text: string): RunResult | null => {
				const parsed = parseProjectMd(text);
				if (parsed.hard.length) return { text: `project.md REJECTED:\n- ${parsed.hard.join("\n- ")}`, isError: true };
				writeFileSync(mdFile, text.endsWith("\n") ? text : `${text}\n`);
				return null;
			};
			if (flag("write")) {
				const content = rest[rest.indexOf("--write") + 1];
				if (!content || content.startsWith("--")) return { text: 'usage: flow init --write "<full project.md content>"', isError: true };
				const parsed = parseProjectMd(content);
				const rej = writeMd(content);
				if (rej) return rej;
				notes.push("project.md written (operator-owned playbook)");
				if (parsed.warn.length) notes.push("warnings:", ...parsed.warn.map((w) => `  ${w}`));
			} else if (!existsSync(mdFile)) {
				// first init: write immediately — the review happens on the file, not in a dialog
				writeFileSync(mdFile, draftFresh);
				notes.push("wrote .dev-flow/project.md from detection:", ...det.report.map((r) => `  ${r}`), "review `.dev-flow/project.md` — confirm as-is, or edit it; agent: if the operator wants changes, ask one short question per unclear knob, apply answers with flow init --write, re-present until confirmed");
			} else if (flag("force")) {
				writeFileSync(mdFile, draftFresh);
				notes.push("project.md OVERWRITTEN (--force):", ...det.report.map((r) => `  ${r}`));
			} else if (!ui.hasUI) {
				// the CI/agent path: the doctor's findings have to be printed, not just promised
				const findings = doctorFindings(root, loaded.cfg, loaded.md, existsSync(jsonFile), true);
				notes.push("project.md already exists — kept (flow init --force to overwrite, --write to edit)", findings.length ? `doctor: ${findings.length} finding(s):` : "doctor: no findings", ...findings.map((x) => `  ${x}`));
			} else if (existsSync(mdFile)) {
				// doctor mode: cheap consistency probes only — never runs project commands
				const findings = doctorFindings(root, loaded.cfg, loaded.md, existsSync(jsonFile), true);
				findings.push(...(await gitConsistency(root, loaded.cfg)));
				for (const l of readReflections(root)) findings.push(`open reflection: ${l.slice(6)}`);
				if (!findings.length) notes.push("doctor: project.md OK — no drift, no inconsistencies");
				else {
					// a refresh is regenerated from detection + config: lines it cannot reproduce are
					// hand-written (prose, checklist items, hand-set keys) and would vanish silently.
					const dropped = droppableLines(readFileSync(mdFile, "utf8"), draftRefresh);
					let edited: string | undefined;
					if (dropped.length)
						notes.push(`doctor: refresh refused — a regenerated draft would drop ${dropped.length} hand-written line(s):`, ...dropped.slice(0, 8).map((l) => `  ${l}`), ...(dropped.length > 8 ? [`  …(${dropped.length - 8} more)`] : []));
					else
						edited = ui.editor
							? await ui.editor(`flow init — doctor: ${findings.length} finding(s) — edit & save to apply, Esc skips`, draftRefresh)
							: (await ui.confirm(`flow init — doctor: ${findings.length} finding(s)`, `${findings.join("\n")}

Write refreshed project.md? Your file; cancel writes nothing.
${mdDigest(draftRefresh)}`))
								? draftRefresh
								: undefined;
					if (edited === undefined) notes.push(dropped.length ? "findings — fix them by editing the file:" : "declined — project.md unchanged", ...findings.map((f) => `  ${f}`));
					else {
						const rej = writeMd(edited);
						if (rej) return rej;
						notes.push("project.md refreshed — findings addressed:", ...findings.map((f) => `  ${f}`), editHint);
					}
				}
			}
			const initCfg = loadProject(dfDir(root)).cfg;
			if (initCfg.mainHook) {
				const hookDir = path.join(root, ".git", "hooks");
				const hook = path.join(hookDir, "pre-commit");
				if (existsSync(hookDir) && !existsSync(hook)) {
					writeFileSync(
						hook,
						`#!/bin/sh\n# installed by dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden (override: DEV_FLOW_ALLOW_MAIN=1)\nbranch=$(git rev-parse --abbrev-ref HEAD)\nif [ "$branch" = "${initCfg.defaultBranch}" ] && [ -z "$DEV_FLOW_ALLOW_MAIN" ]; then\n  echo "dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden — use a feature worktree and a PR" >&2\n  exit 1\nfi\n`,
						{ mode: 0o755 },
					);
					notes.push("pre-commit hook installed (blocks commits on main)");
				} else if (existsSync(hook) && !readFileSync(hook, "utf8").includes("installed by dev-flow")) {
					notes.push("existing pre-commit hook found — dev-flow hook NOT installed; main commits outside Pi are unguarded");
				}
			}
			return { text: notes.join("\n") };
		}

		case "start": {
			if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] [--patch|--docs] (slug: lowercase, dashes); --patch/--docs are operator-granted modes — ask the operator in chat, then add --confirmed", isError: true };
			if (existsSync(featDir(root, slugArg))) return { text: `feature ${slugArg} already exists`, isError: true };
			// relaxed modes are operator-granted: --confirmed anchors a literal chat grant, same convention as the gate verbs
			if (flag("patch") && flag("docs")) return { text: "--patch and --docs are exclusive — ask the operator which mode they grant", isError: true };
			const mode = flag("patch") ? "patch" : flag("docs") ? "docs" : null;
			if (mode && !flag("confirmed")) return { text: `${mode} mode is operator-granted — the operator must grant it in chat, then re-run with --confirmed`, isError: true };
			// branch discipline: features branch off the default branch — starting from a stale checkout poisons the base
			const curBr = await currentBranch(root);
			if (curBr !== cfg.defaultBranch && !flag("force")) return { text: `main checkout is on ${curBr}, not ${cfg.defaultBranch} — check out ${cfg.defaultBranch} first (git checkout ${cfg.defaultBranch} && git pull) or flow use an unfinished feature; --force to override`, isError: true };
			// stamp the dev-flow build that started this feature — a stuck flow can later be read against its tooling
			const self = pluginVersion(import.meta.dirname);
			const state = newState(slugArg, flag("ui"), flag("patch"), flag("docs"), self.version ?? undefined);
			mkdirSync(path.join(featDir(root, slugArg), "plan"), { recursive: true });
			writeState(root, state);
			sess.bind(slugArg);
			return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}${state.patch ? ", patch" : state.docs ? ", docs" : ""}${self.version ? `, dev-flow ${self.version}` : ""}).\n${nextHint(state, cfg)}` };
		}

		case "status": {
			const df = dfDir(root);
			const { md } = loadProject(df);
			// cheap fs probes only (no git subprocesses) — status is a glance, `flow doctor` is the full list
			const findings = md ? doctorFindings(root, cfg, md, existsSync(path.join(df, "project.json")), true) : [];
			const warn = findings.length ? [`⚠ doctor: ${findings.length} finding(s) — run flow doctor`] : [];
			const slugs = slugArg ? [slugArg] : existsSync(df) ? (await listDirs(df)).filter((s) => readState(root, s)) : [];
			if (!slugs.length) return { text: ["no features — start one: flow start <slug> [--ui] [--patch|--docs --confirmed]", ...warn].join("\n") };
			const un0 = unfinishedStates(root);
			const cur = sess.slug ?? (un0.length === 1 ? un0[0].slug : null);
			const lines = slugs.flatMap((s) => {
				const st = readState(root, s);
				if (!st) return [];
				return [
					`${s === cur ? "→" : " "} ${s}: stage=${st.stage}${st.ui ? " [ui]" : ""}${st.yolo ? " [yolo]" : ""}${st.noVersion ? " [no-version]" : ""} branch=${st.branch || "-"} worktree=${st.worktree || "-"}${st.flowVersion ? ` flow=${st.flowVersion}` : ""}`,
					`  approvals: ${Object.keys(st.approvals).join(", ") || "none"} | checks: ${Object.entries(st.checks).map(([k, v]) => `${k}:${v.ok ? "ok" : "FAILED"}`).join(", ") || "none"}${st.confirmations?.implement ? " | checklist: confirmed" : ""}`,
					`  next: ${nextHint(st, cfg)}`,
				];
			});
			if (warn.length) lines.push(...warn);
			const refl = readReflections(root);
			if (refl.length) lines.push(`↻ ${refl.length} reflection(s) open — flow doctor reflect`);
			return { text: lines.join("\n") || "no features" };
		}

		case "doctor": {
			if (rest[0] === "reflect") return reflectNote(root, sess, rest.slice(1));
			// read-only findings on demand — never writes, never asks, safe for agents and CI at any stage
			const df = dfDir(root);
			const loaded = loadProject(df);
			const findings = doctorFindings(root, loaded.cfg, loaded.md, existsSync(path.join(df, "project.json")), existsSync(path.join(df, "project.md")));
			findings.push(...(await gitConsistency(root, loaded.cfg)));
			for (const l of readReflections(root)) findings.push(`open reflection: ${l.slice(6)}`);
			return { text: findings.length ? `doctor: ${findings.length} finding(s)\n${findings.map((f) => `  ${f}`).join("\n")}` : "doctor: no findings — playbook, flow state and git layout are consistent" };
		}

		case "version": {
			// the plugin's own version — separate from the project's versioning.file version the release gates use
			const self = pluginVersion(import.meta.dirname);
			return { text: self.version ? `dev-flow ${self.version} (pi-dev-flow at ${self.dir})` : `dev-flow version unknown — no pi-dev-flow package.json above ${self.dir}` };
		}

		case "approve": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = approveGate(state!, cfg, listFiles(path.join(featDir(root, state!.slug), "plan")));
			if (errs.length) return { text: `plan gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			const planItems = applicableItems(cfg, state!, "plan");
			if (flag("yolo")) state!.yolo = true; // operator's word at Approve? — every later gate question is pre-confirmed; checks and guardrails stay
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : "";
			if (!flag("confirmed")) {
				if (!ui.hasUI) return { text: "plan approval needs the operator: approve interactively, or re-run with --confirmed once the operator answered in chat", isError: true };
				const ok = await ui.confirm("Approve plan", `Approve ${state!.slug}${state!.ui ? " (UI)" : ""}${state!.patch ? " (patch)" : state!.docs ? " (docs)" : ""}? Creates the worktree.${flag("yolo") ? " YOLO: all later gate questions (Verified?/Release?/Finish?) are pre-confirmed — checks and guardrails stay in place." : ""}`);
				if (!ok) return { text: "approval declined — keep iterating on the plan" };
			}
			if (planItems.length) state!.confirmations = { ...state!.confirmations, plan: { hash: checklistHash(planItems), at: now() } };
			const branch = subst(cfg.branchPattern, state!.slug);
			const wtRel = subst(cfg.worktreeDir, state!.slug);
			const wt = path.resolve(root, wtRel);
			let setupNote = "";
			if (!existsSync(wt)) {
				// branch discipline: features branch off the default branch — never from a stale checkout HEAD
				const base = (await sh(`git rev-parse --verify -q origin/${cfg.defaultBranch}`, root)).ok ? `origin/${cfg.defaultBranch}` : cfg.defaultBranch;
				const res = await sh(`git worktree add ${JSON.stringify(wt)} -b ${branch} ${base}`, root);
				if (!res.ok) return { text: `worktree creation failed:\n${res.out}`, isError: true };
				if (cfg.commands.setup) {
					// a fresh worktree is not the checkout: this is where `cp .env` + `npm install` belong
					const s = await sh(cfg.commands.setup, wt);
					if (!s.ok) return { text: `worktree ${wtRel} created but setup failed — fix commands.setup, then run flow approve again (the worktree is reused):\n${tail(s.out)}`, isError: true };
					setupNote = `\nsetup ran in the worktree (${cfg.commands.setup}).`;
				}
			}
			state!.branch = branch;
			state!.worktree = wtRel;
			state!.stage = "implement";
			state!.approvals.plan = now();
			writeState(root, state!);
			return { text: `plan approved${audit}${state!.yolo ? " — yolo: later gate questions pre-confirmed" : ""}; worktree ${wtRel} on branch ${branch}.${setupNote}\n${nextHint(state!, cfg)}` };
		}

		case "test": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.test) return { text: "no commands.test configured in .dev-flow/project.json", isError: true };
			const res = await sh(cfg.commands.test, gateCwd(root, state!));
			state!.checks.test = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
		}

		case "verify": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const items = applicableItems(cfg, state!, "implement");
			// tier-1 gate first (tier-2 confirmation is recorded by this very command, so it is excluded here)
			const preGate = verifyGate({ ...state!, confirmations: { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } } }, cfg);
			if (preGate.length) return { text: `verify gate FAILED:\n- ${preGate.join("\n- ")}`, isError: true };
			if (cfg.commands.build) {
				const res = await sh(cfg.commands.build, gateCwd(root, state!));
				state!.checks.build = { ok: res.ok, at: now() };
				writeState(root, state!);
				if (!res.ok) return { text: `build FAILED:\n${tail(res.out)}`, isError: true };
			}
			// deploy to dev before asking — the operator reviews the running dev app, not a promise
			if (cfg.commands.dev) {
				const res = await sh(cfg.commands.dev, gateCwd(root, state!));
				state!.checks.dev = { ok: res.ok, at: now() };
				writeState(root, state!);
				if (!res.ok) return { text: `dev deploy FAILED:\n${tail(res.out)}`, isError: true };
			}
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
			if (!flag("confirmed") && !state!.yolo) {
				if (!ui.hasUI) return { text: "verification needs the operator: confirm interactively, or re-run with --confirmed once the operator answered in chat", isError: true };
				const ok = await ui.confirm("Operator verification", `Verified? All checks green${cfg.commands.dev ? "; dev deploy is up for review" : ""} \u2014 does it work?`);
				if (!ok) return { text: "verification declined — stay in implement and fix what failed" };
			}
			state!.confirmations = { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } };
			const final = verifyGate(state!, cfg);
			if (final.length) return { text: `verify gate FAILED:\n- ${final.join("\n- ")}`, isError: true };
			state!.approvals.verify = now();
			state!.stage = "pre-release";
			writeState(root, state!);
			return { text: `verified${audit} — entering pre-release stage.\n${nextHint(state!, cfg)}` };
		}

		case "check": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.checkList.length) return { text: 'no tier-1 checks configured — add ```flow blocks / flow-check blocks to ## implement in project.md', isError: true };
			const lines: string[] = [];
			let failed = false;
			for (const c of cfg.checkList) {
				if (c.name === "health" && cfg.commands.seedData) {
					const seed = await sh(cfg.commands.seedData, gateCwd(root, state!));
					if (!seed.ok) {
						lines.push(`seedData FAILED:\n${tail(seed.out)}`);
						failed = true;
						break;
					}
				}
				const res = await sh(c.cmd, gateCwd(root, state!));
				state!.checks[c.name] = { ok: res.ok, at: now() };
				lines.push(`${c.name}: ${res.ok ? "PASS" : "FAIL"} (${c.cmd})${res.ok ? "" : `\n${tail(res.out)}`}`);
				if (!res.ok) failed = true;
			}
			writeState(root, state!);
			return { text: `tier-1 checks:\n${lines.join("\n")}`, isError: failed };
		}

		case "health": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.health) return { text: "no commands.health configured in .dev-flow/project.json", isError: true };
			if (cfg.commands.seedData) {
				const seed = await sh(cfg.commands.seedData, gateCwd(root, state!));
				state!.checks.seedData = { ok: seed.ok, at: now() };
				writeState(root, state!);
				if (!seed.ok) return { text: `seedData FAILED:\n${tail(seed.out)}`, isError: true };
			}
			const res = await sh(cfg.commands.health, gateCwd(root, state!));
			state!.checks.health = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `health: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.health})\n${tail(res.out)}` };
		}

		case "release": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const items = applicableItems(cfg, state!, "pre-release");
			if (flag("no-version")) state!.noVersion = true; // operator's word at Release?: this flow ships without a version bump or tag
			// prep evidence is read from the worktree: the bump and changelog entry exist on the branch before the PR merges
			const wtCwd = gateCwd(root, state!);
			const manifestVer = cfg.versioning.file && existsSync(path.join(wtCwd, cfg.versioning.file))
				? parseVersion(cfg.versioning.file, readFileSync(path.join(wtCwd, cfg.versioning.file), "utf8"))
				: null;
			const localTags = (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
			const changelog =
				cfg.release.changelog && existsSync(path.join(wtCwd, cfg.release.changelog))
					? { file: cfg.release.changelog, content: readFileSync(path.join(wtCwd, cfg.release.changelog), "utf8") }
					: null;
			const prep = { manifestVersion: manifestVer, localTags, changelog };
			// tier-2 pre-release confirmation is recorded by this very command, so it is excluded here
			const preGate = preReleaseGate({ ...state!, confirmations: { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } } }, cfg, prep);
			if (preGate.length) return { text: `release gate FAILED:\n- ${preGate.join("\n- ")}`, isError: true };
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
			if (!flag("confirmed") && !state!.yolo) {
				if (!ui.hasUI) return { text: "release confirmation needs the operator: confirm interactively, or re-run with --confirmed once the operator answered 'Release?' in chat", isError: true };
				const ok = await ui.confirm("Enter release", `Release ${state!.slug}${manifestVer ? ` v${manifestVer}` : ""}${state!.noVersion ? " (unversioned — no version bump or tag for this flow)" : ""}? Publishing starts: PR, merge, tag — release-done afterwards needs no further answer.`);
				if (!ok) return { text: "release declined — keep preparing in pre-release" };
			}
			state!.confirmations = { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } };
			state!.approvals["pre-release"] = now();
			state!.stage = "release";
			writeState(root, state!);
			return { text: `release approved${audit}${state!.noVersion ? " — unversioned: this flow creates no version bump or tag" : ""} — entering release stage.${manifestVer ? ` Version ${manifestVer}.` : ""}\n${nextHint(state!, cfg)}` };
		}

		case "release-done": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = releaseGate(state!);
			let manifestVer: string | null = null;
			if (cfg.versioning.file && !state!.noVersion) {
				const manifestPath = path.join(root, cfg.versioning.file);
				if (!existsSync(manifestPath)) errs.push(`versioning.file "${cfg.versioning.file}" does not exist — fix project.json`);
				const manifest = existsSync(manifestPath) ? parseVersion(cfg.versioning.file, readFileSync(manifestPath, "utf8")) : null;
				if (manifest) manifestVer = manifest;
				const tags = (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
				const verrs = versionTagGate(manifest, cfg.versioning.pattern, tags);
				errs.push(...verrs);
				if (!verrs.length) {
					const expected = cfg.versioning.pattern.replace("{version}", manifest!);
					const reach = await sh(`git merge-base --is-ancestor ${JSON.stringify(expected)} origin/${cfg.defaultBranch} 2>/dev/null || git merge-base --is-ancestor ${JSON.stringify(expected)} ${cfg.defaultBranch}`, root);
					if (!reach.ok) errs.push(`tag ${expected} is not reachable from ${cfg.defaultBranch} — tag what actually shipped on ${cfg.defaultBranch}`);
				}
			}
			const expectedTag = manifestVer ? cfg.versioning.pattern.replace("{version}", manifestVer) : null;
			let artNote = "";
			if (expectedTag && (await sh("git remote get-url origin", root)).ok) {
				// a release must have LEFT this laptop: CI publishes from the tag on the remote
				if (!(await sh(`git ls-remote --tags origin "refs/tags/${expectedTag}"`, root)).out.trim()) errs.push(`tag ${expectedTag} is local-only — git push origin ${expectedTag} (git push --follow-tags silently skips lightweight tags; tag with git tag -a and push the ref explicitly)`);
			}
			if (expectedTag && cfg.release.artifact) {
				if (flag("no-artifact-check")) artNote = "Artifact check skipped (--no-artifact-check).";
				else {
					const cmd = cfg.release.artifact.replaceAll("{version}", manifestVer!).replaceAll("{tag}", expectedTag);
					const art = await sh(cmd, root);
					if (art.ok) artNote = "Artifact verified.";
					else errs.push(`artifact not published — release.artifact check failed (${cmd}):\n${tail(art.out)}`);
				}
			}
			if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			// no checkpoint here — the operator's Release? answer covered the whole publication; everything left is objective checks
			const ghWanted = !!manifestVer && !flag("no-github-release") && cfg.release.githubRelease !== false;
			state!.approvals.release = now();
			let ghNote = "";
			if (manifestVer && flag("no-github-release")) ghNote = "GitHub release skipped (--no-github-release).";
			else if (manifestVer && ghWanted) {
				// advisory: GitHub release for the verified tag — a note on failure, never a block
				const tag = expectedTag!;
				const notes = (await sh(`git tag -l --format=%(contents) ${JSON.stringify(tag)}`, root)).out.trim();
				const gr = await sh(`gh release create ${JSON.stringify(tag)} --title ${JSON.stringify(tag)}${notes ? ` --notes ${JSON.stringify(notes)}` : ""}`, root);
				ghNote = gr.ok ? `GitHub release ${tag} created.` : `GitHub release skipped: ${tail(gr.out)}`;
			}
			const tailNote = [ghNote, artNote].filter(Boolean).join(" ");
			writeState(root, state!);
			return { text: `release recorded as complete${state!.noVersion ? " (unversioned — this flow created no version or tag)" : ""}.${tailNote ? ` ${tailNote}` : ""}\n${nextHint(state!, cfg)}` };
		}

		case "finish": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!state!.approvals.release)
				return { text: `finish closes a released feature — stage is "${state!.stage}" and no release is recorded; run flow release-done first (to abandon an unfinished feature, run flow abort)`, isError: true };
			// after this the flow state is gone: nothing may sit uncommitted or unpushed
			const dirty = await sh("git status --porcelain", root);
			if (dirty.ok && dirty.out.trim()) return { text: `main checkout has uncommitted changes — commit them first (finish deletes .dev-flow/${state!.slug}/):\n${tail(dirty.out)}`, isError: true };
			if ((await sh("git remote get-url origin", root)).ok) {
				const pushed = await sh(`git merge-base --is-ancestor HEAD ${JSON.stringify(`origin/${cfg.defaultBranch}`)}`, root);
				if (!pushed.ok) return { text: `HEAD is not on origin/${cfg.defaultBranch} — push the release (git push origin ${cfg.defaultBranch}) before finish`, isError: true };
			}
			// the cleanup part of closing out: drop the worktree and branch the release consumed
			const wt = worktreeAbs(root, state!);
			let closeNote: string;
			let unmergedNote = "";
			if (wt && existsSync(wt)) {
				const status = await sh(`git -C ${JSON.stringify(wt)} status --porcelain`, root);
				const unmerged = await sh(`git -C ${JSON.stringify(wt)} log origin/${cfg.defaultBranch}..HEAD --oneline 2>/dev/null || git -C ${JSON.stringify(wt)} log ${cfg.defaultBranch}..HEAD --oneline`, root);
				const assess = cleanupAssess(status.out, unmerged.out.split("\n"));
				if (assess.errors.length) return { text: `finish blocked:\n- ${assess.errors.join("\n- ")}`, isError: true };
				if (assess.unmerged.length) unmergedNote = ` ${assess.unmerged.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} (squash merge?).`;
			}
			// the one finish question — asked after the safety checks so it can never be a wasted question
			if (!flag("confirmed") && !state!.yolo) {
				if (!ui.hasUI) return { text: `finish needs the operator: ask them Finish? in chat, then re-run with --confirmed (or run /flow finish interactively)`, isError: true };
				const ok = await ui.confirm("Finish feature", `Finish ${state!.slug}?${unmergedNote} Removes worktree, branch ${state!.branch || "-"} and .dev-flow/${state!.slug}/.`);
				if (!ok) return { text: "finish declined" };
			}
			if (wt && existsSync(wt)) {
				const rm = await sh(`git worktree remove ${JSON.stringify(wt)} && git branch -D ${JSON.stringify(state!.branch)}`, root);
				if (!rm.ok) return { text: `worktree removal failed:\n${rm.out}\nif files are owned by another user (e.g. root-owned docker build output), remove ${state!.worktree} manually and rerun flow finish`, isError: true };
				closeNote = `worktree and branch ${state!.branch} removed`;
			} else {
				await sh("git worktree prune", root);
				closeNote = "worktree already gone";
				if (state!.branch && (await sh(`git rev-parse --verify --quiet refs/heads/${state!.branch}`, root)).ok) {
					const del = await sh(`git branch -d ${JSON.stringify(state!.branch)}`, root);
					closeNote = del.ok ? `branch ${state!.branch} deleted` : `branch ${state!.branch} kept (not fully merged — git branch -D if sure)`;
				}
			}
			// remote cleanup: origin/<branch> is deleted only on proof it was released — being an ancestor of
			// origin/<default> (merge-commit merges) or a merged PR via gh (squash merges); else it stays.
			let remoteNote = "";
			if (state!.branch && (await sh("git remote get-url origin", root)).ok) {
				const br = state!.branch;
				const onRemote = await sh("git ls-remote --heads origin", root);
				if (onRemote.out.split("\n").some((l) => l.endsWith(`\trefs/heads/${br}`))) {
					await sh(`git fetch -q origin ${JSON.stringify(br)}`, root);
					let merged = (await sh(`git merge-base --is-ancestor origin/${JSON.stringify(br)} origin/${JSON.stringify(cfg.defaultBranch)}`, root)).ok;
					if (!merged) {
						const pr = await sh(`gh pr list --state merged --head ${JSON.stringify(br)} --json number --jq length`, root);
						merged = pr.ok && pr.out.trim() !== "0";
					}
					if (merged) remoteNote = (await sh(`git push origin --delete ${JSON.stringify(`refs/heads/${br}`)}`, root)).ok
						? ` origin/${br} deleted (verified merged)`
						: ` origin/${br} delete failed — git push origin --delete ${br}`;
					else remoteNote = ` origin/${br} kept — merged state not verifiable from here (git push origin --delete ${br} when sure)`;
				}
			}
			rmSync(featDir(root, state!.slug), { recursive: true, force: true });
			if (sess.slug === state!.slug) sess.bind(null);
			return { text: `feature ${state!.slug} done — ${closeNote}${remoteNote}; .dev-flow/${state!.slug}/ removed.` };
		}

		case "use": {
			if (!slugArg) return { text: "usage: flow use <slug>", isError: true };
			const st = readState(root, slugArg);
			if (!st || st.stage === "done") return { text: `no unfinished feature ${slugArg}`, isError: true };
			const prior = readClaim(root, slugArg);
			const takeover = claimBlocks(prior, sess.key) ? ` — taken over from live session (pid ${prior!.pid})` : "";
			sess.bind(slugArg);
			return { text: `this session is now bound to ${slugArg} (stage ${st.stage})${st.worktree ? ` — work in its worktree: ${st.worktree} (branch ${st.branch})` : ""}${takeover}` };
		}

		case "abort": {
			// Unbinds the session only; state and worktree stay for manual recovery.
			const target = slugArg ?? sess.slug;
			if (!target) return { text: "nothing bound — pass a slug", isError: true };
			const st = readState(root, target);
			if (sess.slug === target) sess.bind(null);
			if (st && !st.worktree) {
				// plan-stage abort = drop: no worktree/branch exists, so the state dir is a ghost that
				// the one-unfinished-feature auto-bind would resurrect into every unbound session
				rmSync(featDir(root, target), { recursive: true, force: true });
				return { text: `aborted ${target} — feature removed (nothing approved, nothing to recover)` };
			}
			return { text: `session unbound from ${target}; state stays at .dev-flow/${target}/` + (st?.worktree ? `\nto remove the worktree and branch:\n  git worktree remove ${st.worktree}\n  git branch -D ${st.branch}` : "") };
		}

		default:
			return { text: `unknown subcommand "${sub}" — ${GATE_HELP}`, isError: true };
	}
}

async function currentBranch(root: string): Promise<string> {
	const r = await sh("git branch --show-current", root);
	return r.ok ? r.out.split("\n")[0] : "";
}

function needState(root: string, sess: Session, slugArg?: string): { state: FlowState | null; err?: RunResult } {
	let slug = slugArg ?? sess.slug;
	if (!slug) {
		const un = unfinishedStates(root);
		if (un.length === 1) slug = un[0].slug;
		else if (!un.length) return { state: null, err: { text: "no unfinished features — flow start <slug> [--ui]", isError: true } };
		else return { state: null, err: { text: `multiple unfinished features (${un.map((s) => s.slug).join(", ")}) — flow use <slug> or pass an explicit slug`, isError: true } };
	}
	const state = readState(root, slug);
	if (!state) return { state: null, err: { text: `no state for feature ${slug}`, isError: true } };
	return { state };
}

async function listDirs(dir: string): Promise<string[]> {
	const { readdirSync } = await import("node:fs");
	return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function tail(out: string, n = 15): string {
	const lines = out.split("\n").filter(Boolean);
	return lines.length > n ? `…(${lines.length - n} lines)…\n${lines.slice(-n).join("\n")}` : out;
}

// ------------------------------------------------------------------ extension

const STAGE_COLORS: Partial<Record<Stage, "warning" | "accent" | "success" | "dim">> = {
	plan: "warning",
	implement: "accent",
	"pre-release": "dim",
	release: "success",
};

/** Expand overlay: full flow state, Esc-closable (pi todo-example pattern). */
class FlowPanel {
	private state: FlowState;
	private cfg: Config;
	private theme: Theme;
	private onClose: () => void;
	constructor(state: FlowState, cfg: Config, theme: Theme, onClose: () => void) {
		this.state = state;
		this.cfg = cfg;
		this.theme = theme;
		this.onClose = onClose;
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}
	invalidate(): void {
		// state is read fresh at render time; nothing cached to invalidate
	}
	render(width: number): string[] {
		const th = this.theme;
		const s = this.state;
		const at = (iso: string) => new Date(iso).toTimeString().slice(0, 5); // local wall-clock HH:MM
		const checks = Object.entries(s.checks).map(([k, c]) => (c.ok ? th.fg("success", `${k} ok ${at(c.at)}`) : th.fg("error", `${k} FAILED ${at(c.at)}`)));
		return [
			"",
			truncateToWidth(`  ${th.fg("accent", `dev-flow — ${s.slug}${s.ui ? " (UI)" : ""}`)} ${th.fg(STAGE_COLORS[s.stage] ?? "muted", s.stage)}`, width),
			truncateToWidth(`  ${th.fg("muted", `branch ${s.branch || "-"}  ·  worktree ${s.worktree || "-"}`)}`, width),
			truncateToWidth(`  ${th.fg("muted", `approvals: ${Object.keys(s.approvals).join(", ") || "none"}`)}  ${checks.join(" ")}`, width),
			truncateToWidth(`  ${th.fg("dim", `next: ${nextHint(s, this.cfg)}`)}`, width),
			truncateToWidth(`  ${th.fg("dim", "Esc to close")}`, width),
			"",
		];
	}
}

/** Compact footer status: slug ▸ stage, ✗ on failing checks, cleared when no active feature. */
function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const st = existsSync(dfDir(ctx.cwd)) ? boundFeature(ctx.cwd, sessionKey(ctx)) : null;
	if (!st || st.stage === "done") {
		ctx.ui.setStatus("dev-flow", undefined);
		return;
	}
	const { text, failed } = statusCompact(st);
	ctx.ui.setStatus("dev-flow", ctx.ui.theme.fg(STAGE_COLORS[st.stage] ?? "muted", `◆ ${text}`) + (failed ? ctx.ui.theme.fg("error", " ✗") : ""));
}


/** A project confirm rule with no operator present is a block — a hidden confirmation is not a confirmation. */
async function askOperator(ctx: ExtensionContext, what: string, why: string): Promise<string | null> {
	if (!ctx.hasUI) return `${why} — this needs an operator confirmation and no UI is available: ask them, or run it yourself outside Pi`;
	const ok = await ctx.ui.confirm("dev-flow project rule", `${what}\n\n${why}\n\nProceed?`);
	return ok ? null : `operator declined — ${why}`;
}

export default function devFlow(pi: ExtensionAPI) {
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const uiFrom = (ctx: ExtensionContext): Ui => ({
		hasUI: ctx.hasUI,
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
		editor: ctx.mode === "tui" ? (title: string, prefill?: string) => ctx.ui.editor(title, prefill) : undefined,
	});

	const sessFor = (ctx: ExtensionContext): Session => {
		const key = sessionKey(ctx);
		return {
			key,
			slug: bindings.get(key) ?? null,
			bind: (slug) => {
				const prev = bindings.get(key);
				bindings.set(key, slug);
				pi.appendEntry("dev-flow-bind", { slug });
				// claims track the binding: claim what you bind, release what you drop.
				if (prev && prev !== slug && readClaim(ctx.cwd, prev)?.key === key) rmSync(claimFile(ctx.cwd, prev), { force: true });
				if (slug) writeClaim(ctx.cwd, slug, key);
			},
		};
	};

	/** Restore this session's binding from its branch history (survives resume/fork). */
	const rebuildSession = (ctx: ExtensionContext) => {
		let slug: string | null = null;
		for (const e of ctx.sessionManager?.getBranch() ?? []) {
			// SAFETY: narrow structural view of the SessionEntry union; we only read entries whose type/customType match our own appendEntry writes.
			const ce = e as unknown as { type: string; customType?: string; data?: { slug?: string | null } };
			if (ce.type === "custom" && ce.customType === "dev-flow-bind") slug = ce.data?.slug ?? null;
		}
		bindings.set(sessionKey(ctx), slug);
	};

	pi.registerCommand("flow", {
		description: `dev-flow gates: ${GATE_HELP}`,
		handler: async (args, ctx) => {
			const res = await runFlow(parse(args), ctx.cwd, uiFrom(ctx), sessFor(ctx));
			// gate output belongs to the conversation, not a toast: display:true renders a [flow] box (TUI + web), no triggerTurn so no model turn fires
			pi.sendMessage({ customType: "flow", content: res.text, display: true });
			refreshStatus(ctx);
			if (!res.isError) maybeCompactNow(ctx);
		},
	});

	const flowTool = defineTool({
		name: "flow",
		label: "Flow",
		description:
			"Drive the dev-flow stage gates for the active feature (plan → implement → pre-release → release → done). Never edit .dev-flow state directly; gates enforce plan/mockup/test/verification criteria and confirm with the operator.",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: 'Gate invocation, e.g. ["status"] or ["start", "my-slug", "--ui"]' }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const res = await runFlow(params.args, ctx.cwd, uiFrom(ctx), sessFor(ctx));
			if (!res.isError) maybeCompactNow(ctx);
			return { content: [{ type: "text", text: res.text }], details: undefined, isError: res.isError };
		},
	});
	pi.registerTool(flowTool);

	// Agent-run gates refresh at turn_end (tool ctx lacks setStatus; turn_end catches them).
	pi.on("session_start", async (_event, ctx) => {
		rebuildSession(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => rebuildSession(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshStatus(ctx));
	// Idle backstop: long between-gate runs compact here instead of letting pi hit the threshold mid-work.
	pi.on("agent_settled", async (_event, ctx) => maybeCompactNow(ctx));
	// pi forcing its own compaction while a flow is bound means the pacing was wrong — park a note for the operator.
	pi.on("session_compact", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd)) || event.reason === "manual") return;
		const st = boundFeature(ctx.cwd, sessionKey(ctx));
		if (!st) return;
		const f = path.join(dfDir(ctx.cwd), "reflections.md");
		const text = existsSync(f) ? readFileSync(f, "utf8") : "";
		const line = compactionReflectionLine(st.slug, st.stage, event.reason, new Date().toISOString().slice(0, 10));
		writeFileSync(f, appendReflection(text, ["plugin"], line));
	});

	pi.registerShortcut("ctrl+,", {
		description: "Show the dev-flow detail panel (stage, approvals, checks, next step)",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) pi.sendMessage({ customType: "flow", content: "flow panel requires interactive mode", display: true });
				return;
			}
			const st = existsSync(dfDir(ctx.cwd)) ? boundFeature(ctx.cwd, sessionKey(ctx)) : null;
			if (!st || st.stage === "done") {
				pi.sendMessage({ customType: "flow", content: "dev-flow: no active feature", display: true });
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new FlowPanel(st, loadProject(dfDir(ctx.cwd)).cfg, theme, () => done()));
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const cfg = loadProject(dfDir(ctx.cwd)).cfg;
		const key = sessionKey(ctx);

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const abs = path.resolve(ctx.cwd, String(event.input.path ?? ""));
			const feats = featureRefs(ctx.cwd);
			const bound = boundFeature(ctx.cwd, key);
			// operator safety rules from project.md run first — as in the bash guard, the operator's deny outranks flow discipline
			const pv = guardPath(abs, ctx.cwd, cfg.guard);
			if (pv.block) return { block: true, reason: pv.block };
			if (pv.confirm) {
				const why = await askOperator(ctx, `Editing ${path.relative(ctx.cwd, abs) || abs}`, pv.confirm);
				if (why) return { block: true, reason: why };
			}
			const reason = writeGuard({ abs, dfDir: dfDir(ctx.cwd), features: feats, boundSlug: bound?.slug ?? null });
			if (reason) return { block: true, reason };
			// Editing a worktree invalidates that feature's tier-1 checks and tier-2 confirmation until they rerun.
			const owner = feats.find((f) => f.worktreeAbs && abs.startsWith(f.worktreeAbs + path.sep));
			if (owner && (owner.state.stage === "implement" || owner.state.stage === "pre-release") && (Object.keys(owner.state.checks).length || owner.state.confirmations?.implement)) {
				owner.state.checks = {};
				delete owner.state.confirmations?.implement;
				writeState(ctx.cwd, owner.state);
			}
			return undefined;
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (stateTamper(command)) return { block: true, reason: "state.json is dev-flow-owned — advance stages with the flow tool only" };
			// project safety rules first: they cover docker/gh/npm and everything else, not only git,
			// and the operator's deny outranks dev-flow's own stage verdicts
			const gv = guardBash(command, cfg.guard);
			if (gv.block) return { block: true, reason: gv.block };
			for (const r of gv.confirms) {
				const why = await askOperator(ctx, command, r.why || `project rule ${r.pattern}`);
				if (why) return { block: true, reason: why };
			}
			const inv = gitInvocation(command);
			if (!inv.subs.length) return undefined; // git is not invoked as a command — nothing to guard
			const bound = boundFeature(ctx.cwd, key);
			// judge EACH git segment by the branch of the directory it runs in — a chain may cd across
			// directories; one last-cd-wins verdict misattributed mixed-dir chains and blocked legit worktree commits
			const branchCache = new Map<string, string>();
			const branchOf = async (dir: string | null): Promise<string> => {
				const at = dir ? path.resolve(ctx.cwd, dir) : ctx.cwd;
				if (!branchCache.has(at)) {
					const br = await sh(`git -C ${JSON.stringify(at)} branch --show-current`, ctx.cwd);
					let b = (br.ok ? br.out : "").trim().split("\n")[0];
					if (!b) b = (await sh("git branch --show-current", ctx.cwd)).out.trim().split("\n")[0] || "";
					branchCache.set(at, b);
				}
				return branchCache.get(at)!;
			};
			for (const g of inv.gitSegs) {
				const gitDir = g.dir ? path.resolve(ctx.cwd, g.dir) : ctx.cwd;
				let pushRefs: PushRef[] | undefined;
				const gp = gitInvocation(g.seg).pushes;
				if (gp.length) {
					// push targets are judged by ref; bare names disambiguated against that repo's own tags (read-only probe)
					pushRefs = await Promise.all(
						parsePushRefs(gp).map(async (r) => {
							if (r.kind !== "branch" || !r.name || r.name === "*") return r;
							const tag = await sh(`git rev-parse --verify -q refs/tags/${JSON.stringify(r.name)}`, gitDir);
							return tag.ok ? { kind: "tag" as const, name: r.name } : r;
						}),
					);
				}
				const reason = bashFlowGuard({ command: g.seg, branch: await branchOf(g.dir), stage: bound?.stage ?? null, defaultBranch: cfg.defaultBranch, pushRefs });
				if (reason) return { block: true, reason };
				// Branch discipline: feature branches live in their worktree — never checked out or created (-b) in the main checkout
				const target = checkoutTarget(g.seg);
				if (target && target.startsWith(featureBranchPrefix(cfg))) {
					const inWorktree = featureRefs(ctx.cwd).some((f) => f.worktreeAbs && (gitDir === f.worktreeAbs || gitDir.startsWith(f.worktreeAbs + path.sep)));
					if (!inWorktree) return { block: true, reason: `branch ${target} belongs to a feature worktree, not the main checkout — flow use <slug> and run git inside ${featureBranchPrefix(cfg)}…'s worktree` };
				}
			}
		}
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const cfg = loadProject(dfDir(ctx.cwd)).cfg;
		const state = boundFeature(ctx.cwd, sessionKey(ctx));
		if (!state || state.stage === "done") {
			// Default posture for an unbound session in a dev-flow repo (guards make it stick; this makes it understood).
			let content = "[dev-flow] no flow bound. Every request goes through flow. New work: flow start <slug>; unfinished feature: flow use <slug>.";
			const cb = claimBlocker(ctx.cwd, sessionKey(ctx));
			if (cb) content += ` Also: ${cb.state.slug} is claimed by another live session (pid ${cb.claim.pid}) — flow use ${cb.state.slug} takes it over explicitly.`;
			const curBr = await currentBranch(ctx.cwd);
			if (curBr && curBr !== cfg.defaultBranch) content += ` Also: main checkout is on ${curBr}, not ${cfg.defaultBranch} — surface this to the operator before starting work.`;
			const refl0 = readReflections(ctx.cwd);
			if (refl0.length) content += ` Also: ${refl0.length} reflection(s) open (flow doctor reflect).`;
			return { message: { customType: "dev-flow-context", display: false, content } };
		}
		const guidance: string[] = [];
		if (state.yolo) guidance.push("YOLO mode: the operator pre-confirmed every later gate question (Verified?/Release?/Finish?) — run the gates without asking; checks and guardrails stay fully enforced.");
		if (cfg.prose[state.stage]) guidance.push(`Stage guidance (project.md): ${cfg.prose[state.stage]}`);
		const pend = checklistPending(cfg, state, state.stage);
		if (pend) guidance.push(`Tier-2 checklist NOT yet confirmed (${pend} item(s)): ${applicableItems(cfg, state, state.stage).map((i) => i.text).join(" | ")}`);
		const refl = readReflections(ctx.cwd);
		if (refl.length) guidance.push(`↻ ${refl.length} reflection(s) open — mention to the operator; fold in only on request.`);
		return {
			message: {
				customType: "dev-flow-context",
				display: false,
				content: `[dev-flow] this session is bound to: ${state.slug}${state.patch ? " (patch)" : state.docs ? " (docs)" : ""} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
${guidance.length ? guidance.join("\n") + "\n" : ""}Rules: follow the dev-flow skill playbook; drive gates with the flow tool (/flow as user); stage guards block out-of-stage edits and main-branch git ops — do not work around them.`,
			},
		};
	});
}
