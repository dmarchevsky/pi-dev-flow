/**
 * dev-flow: enforced feature-flow state machine for Pi (pi package extension).
 *
 * Stages: plan → implement → release → cleanup → deploy → done, per feature,
 * with state in <repo>/.dev-flow/<slug>/state.json (gitignored, flow-owned).
 *
 * Enforcement has three teeth:
 *  1. Gate commands (/flow approve|verify|release-done|cleanup|deploy) refuse
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
	applyAnswer,
	approveGate,
	bashFlowGuard,
	cleanupAssess,
	diffAnswers,
	getPath,
	initPlan,
	loadConfig,
	listFiles,
	newState,
	nextHint,
	releaseGate,
	parseVersion,
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
	type Stage,
} from "../src/core.ts";
import { detectProject } from "../src/detect.ts";

const execAsync = promisify(exec);

interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
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
const featDir = (root: string, slug: string) => path.join(dfDir(root), slug);
const stateFile = (root: string, slug: string) => path.join(featDir(root, slug), "state.json");

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

function unfinishedStates(root: string): FlowState[] {
	if (!existsSync(dfDir(root))) return [];
	return readdirSync(dfDir(root), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readState(root, d.name))
		.filter((s): s is FlowState => !!s && s.stage !== "done");
}

/** The session's feature: explicit binding, else the single unfinished feature (auto-bind). */
function boundFeature(root: string, key: string): FlowState | null {
	const bound = bindings.get(key);
	if (bound) {
		const s = readState(root, bound);
		if (s && s.stage !== "done") return s;
	}
	const un = unfinishedStates(root);
	return un.length === 1 ? un[0] : null;
}

function featureRefs(root: string): FeatureRef[] {
	return unfinishedStates(root).map((s) => ({ state: s, worktreeAbs: s.worktree ? path.resolve(root, s.worktree) : null }));
}

function worktreeAbs(root: string, state: FlowState): string | null {
	return state.worktree ? path.resolve(root, state.worktree) : null;
}

// ---------------------------------------------------------------- gate runner

interface RunResult {
	text: string;
	isError?: boolean;
}

interface Session {
	slug: string | null;
	bind: (slug: string | null) => void;
}

/** Single runner for both the /flow command and the flow tool. */
async function runFlow(args: string[], root: string, ui: Ui, sess: Session): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	if (!existsSync(dfDir(root)) && sub !== "init") return { text: "no .dev-flow/ in this repo — run /flow init first", isError: true };
	const cfg = loadConfig(dfDir(root));
	const flag = (name: string) => rest.includes(`--${name}`);
	const slugArg = rest.find((a) => !a.startsWith("--"));

	switch (sub) {
		case "init": {
			mkdirSync(dfDir(root), { recursive: true });
			const notes: string[] = [`.dev-flow/ created in ${root}`];
			// self-ignoring folder: nothing under .dev-flow/ ever enters git, without touching tracked files
			writeFileSync(path.join(dfDir(root), ".gitignore"), "*\n");
			rmSync(path.join(dfDir(root), ".current"), { force: true }); // migrate away the legacy repo-global pointer
			const cfgFile = path.join(dfDir(root), "project.json");
			let existingRaw: Record<string, unknown> | null = null;
			if (existsSync(cfgFile)) {
				try {
					existingRaw = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
				} catch {
					notes.push("existing project.json is not valid JSON — the wizard will rewrite it");
				}
			}
			const head = await sh("git symbolic-ref refs/remotes/origin/HEAD", root);
			const curBr = await currentBranch(root);
			// never propose a feature branch (contains "/") as the default branch
			const branch = (head.ok ? head.out.match(/refs\/remotes\/origin\/(.+)/)?.[1] : undefined) || (curBr.includes("/") ? undefined : curBr) || "main";
			const det = detectProject(root, branch);
			if (flag("yes") || flag("force") || !ui.hasUI) {
				// --force overwrites existing operator config with fresh detection; --yes never does (even headless)
				if (existingRaw && !flag("force")) notes.push("project.json already exists — kept (operator-owned; --force to overwrite)");
				else {
					writeFileSync(cfgFile, `${JSON.stringify(det.partial, null, 2)}\n`);
					notes.push(`project.json ${existingRaw ? "OVERWRITTEN (--force)" : "written from detection"} — review it (operator-owned):`, ...det.report.map((r) => `  ${r}`));
					if (det.missing.length) notes.push(`  not detected (gates fall back to defaults): ${det.missing.join(", ")}`);
				}
			} else {
				// interactive wizard: confirm or change every setting, nothing is written before the final confirm
				const answers: Record<string, unknown> = structuredClone(existingRaw ?? {});
				const eff = loadConfig(dfDir(root));
				let aborted = false;
				for (const step of initPlan(existingRaw, det.partial, eff)) {
					if (step.dependsOn && getPath(answers, step.dependsOn) === undefined) continue;
					const label = `${step.title}${step.value ? ` = "${step.value}"` : " (unset)"} [${step.source}]`;
					if (step.kind === "confirm") {
						applyAnswer(answers, step.key, await ui.confirm(`flow init — ${step.title}`, `Currently: ${step.value === "true" ? "yes" : "no"}. Enable?`));
						continue;
					}
					const opts = step.options ?? (step.value ? (step.optional ? ["keep", "change", "remove"] : ["keep", "change"]) : ["set now", "leave unset"]);
					const choice = await ui.select(`flow init — ${label}`, opts);
					if (choice === undefined) {
						aborted = true;
						break;
					}
					if (choice === "keep" || choice === "leave unset") {
						// "keep" on a DETECTED value must materialize it — detection is init-only, gates read only the file
						if (choice === "keep" && step.source === "detected") applyAnswer(answers, step.key, step.value);
						continue;
					}
					if (choice === "remove" || choice === "(none)") {
						applyAnswer(answers, step.key, null);
						continue;
					}
					if (step.kind === "select" && choice !== "other…") {
						applyAnswer(answers, step.key, choice);
						continue;
					}
					const v = await ui.input(step.title, step.value || undefined);
					if (v === undefined) {
						aborted = true;
						break;
					}
					applyAnswer(answers, step.key, v);
				}
				if (aborted) return { text: "flow init cancelled — project.json unchanged" };
				const lines = diffAnswers(existingRaw ?? {}, answers);
				if (!lines.length) notes.push(existingRaw ? "reviewed project.json — nothing changed" : "no settings configured — edit project.json by hand or rerun with answers");
				else if (existingRaw === null || (await ui.confirm("flow init — write project.json?", `${lines.join("\n")}\n\n${JSON.stringify(answers, null, 2)}`))) {
					writeFileSync(cfgFile, `${JSON.stringify(answers, null, 2)}\n`);
					notes.push(`project.json ${existingRaw ? "updated" : "written"} (operator-owned):`, ...lines.map((l) => `  ${l}`));
				} else notes.push("declined — project.json unchanged");
			}
			const initCfg = loadConfig(dfDir(root));
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
				}
			}
			return { text: notes.join("\n") };
		}

		case "start": {
			if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] (slug: lowercase, dashes)", isError: true };
			if (existsSync(featDir(root, slugArg))) return { text: `feature ${slugArg} already exists`, isError: true };
			const state = newState(slugArg, flag("ui"));
			mkdirSync(path.join(featDir(root, slugArg), "plan"), { recursive: true });
			writeState(root, state);
			sess.bind(slugArg);
			return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}).\n${nextHint(state, cfg)}` };
		}

		case "status": {
			const slugs = slugArg ? [slugArg] : existsSync(dfDir(root)) ? (await listDirs(dfDir(root))).filter((s) => readState(root, s)) : [];
			if (!slugs.length) return { text: "no features — start one: flow start <slug> [--ui]" };
			const un0 = unfinishedStates(root);
			const cur = sess.slug ?? (un0.length === 1 ? un0[0].slug : null);
			const lines = slugs.flatMap((s) => {
				const st = readState(root, s);
				if (!st) return [];
				return [
					`${s === cur ? "→" : " "} ${s}: stage=${st.stage}${st.ui ? " [ui]" : ""} branch=${st.branch || "-"} worktree=${st.worktree || "-"}`,
					`  approvals: ${Object.keys(st.approvals).join(", ") || "none"} | checks: ${Object.entries(st.checks).map(([k, v]) => `${k}:${v.ok ? "ok" : "FAILED"}`).join(", ") || "none"}`,
					`  next: ${nextHint(st, cfg)}`,
				];
			});
			return { text: lines.join("\n") || "no features" };
		}

		case "approve": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = approveGate(state!, cfg, listFiles(path.join(featDir(root, state!.slug), "plan")));
			if (errs.length) return { text: `plan gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			if (!ui.hasUI) return { text: "plan approval requires the operator in an interactive session", isError: true };
			const ok = await ui.confirm("Approve plan", `Feature ${state!.slug}${state!.ui ? " (UI — mockups included)" : ""}.\nApprove the plan and create the feature worktree?`);
			if (!ok) return { text: "approval declined — keep iterating on the plan" };
			const branch = subst(cfg.branchPattern, state!.slug);
			const wtRel = subst(cfg.worktreeDir, state!.slug);
			const wt = path.resolve(root, wtRel);
			if (!existsSync(wt)) {
				const res = await sh(`git worktree add ${JSON.stringify(wt)} -b ${branch}`, root);
				if (!res.ok) return { text: `worktree creation failed:\n${res.out}`, isError: true };
			}
			state!.branch = branch;
			state!.worktree = wtRel;
			state!.stage = "implement";
			state!.approvals.plan = now();
			writeState(root, state!);
			return { text: `plan approved; worktree ${wtRel} on branch ${branch}.\n${nextHint(state!, cfg)}` };
		}

		case "test": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.test) return { text: "no commands.test configured in .dev-flow/project.json", isError: true };
			const res = await sh(cfg.commands.test, root);
			state!.checks.test = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
		}

		case "verify": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = verifyGate(state!, cfg);
			if (errs.length) return { text: `verify gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			if (cfg.commands.build) {
				const res = await sh(cfg.commands.build, root);
				state!.checks.build = { ok: res.ok, at: now() };
				writeState(root, state!);
				if (!res.ok) return { text: `build FAILED:\n${tail(res.out)}`, isError: true };
			}
			if (!ui.hasUI) return { text: "verification requires the operator to confirm interactively", isError: true };
			const ok = await ui.confirm(
				"Operator verification",
				`Build passed${cfg.commands.health ? ", health check green" : ""}. The app should be running locally with real data (${cfg.commands.run ?? "no run command configured"}).\nHas the operator tested it and confirmed it works?`,
			);
			if (!ok) return { text: "verification declined — stay in implement and fix what failed" };
			state!.approvals.verify = now();
			state!.stage = "release";
			writeState(root, state!);
			return { text: `verified — entering release stage.\n${nextHint(state!, cfg)}` };
		}

		case "health": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.health) return { text: "no commands.health configured in .dev-flow/project.json", isError: true };
			if (cfg.commands.seedData) {
				const seed = await sh(cfg.commands.seedData, root);
				state!.checks.seedData = { ok: seed.ok, at: now() };
				writeState(root, state!);
				if (!seed.ok) return { text: `seedData FAILED:\n${tail(seed.out)}`, isError: true };
			}
			const res = await sh(cfg.commands.health, root);
			state!.checks.health = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `health: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.health})\n${tail(res.out)}` };
		}

		case "release-done": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = releaseGate(state!);
			if (cfg.versioning.file) {
				const manifestPath = path.join(root, cfg.versioning.file);
				if (!existsSync(manifestPath)) errs.push(`versioning.file "${cfg.versioning.file}" does not exist — fix project.json`);
				const manifest = existsSync(manifestPath) ? parseVersion(cfg.versioning.file, readFileSync(manifestPath, "utf8")) : null;
				const tags = (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
				const verrs = versionTagGate(manifest, cfg.versioning.pattern, tags);
				errs.push(...verrs);
				if (!verrs.length) {
					const expected = cfg.versioning.pattern.replace("{version}", manifest!);
					const reach = await sh(`git merge-base --is-ancestor ${JSON.stringify(expected)} origin/${cfg.defaultBranch} 2>/dev/null || git merge-base --is-ancestor ${JSON.stringify(expected)} ${cfg.defaultBranch}`, root);
					if (!reach.ok) errs.push(`tag ${expected} is not reachable from ${cfg.defaultBranch} — tag what actually shipped on ${cfg.defaultBranch}`);
				}
			}
			if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			state!.approvals.release = now();
			state!.stage = "cleanup";
			writeState(root, state!);
			return { text: `release recorded as complete.\n${nextHint(state!, cfg)}` };
		}

		case "cleanup": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (state!.stage !== "cleanup") return { text: `stage is "${state!.stage}", cleanup only applies after release-done`, isError: true };
			const wt = worktreeAbs(root, state!);
			const status = await sh(`git -C ${JSON.stringify(wt)} status --porcelain`, root);
			const unmerged = await sh(`git -C ${JSON.stringify(wt)} log origin/${cfg.defaultBranch}..HEAD --oneline 2>/dev/null || git -C ${JSON.stringify(wt)} log ${cfg.defaultBranch}..HEAD --oneline`, root);
			const assess = cleanupAssess(status.out, unmerged.out.split("\n"));
			if (assess.errors.length) return { text: `cleanup blocked:\n- ${assess.errors.join("\n- ")}`, isError: true };
			if (!ui.hasUI) return { text: "cleanup requires operator confirmation", isError: true };
			const warn = assess.unmerged.length ? `\nWARNING — commits not on ${cfg.defaultBranch} (squash merge?):\n${assess.unmerged.slice(0, 10).join("\n")}\n` : "";
			const ok = await ui.confirm("Cleanup feature", `Remove worktree ${state!.worktree} and branch ${state!.branch}?${warn}`);
			if (!ok) return { text: "cleanup declined" };
			const rm = await sh(`git worktree remove ${JSON.stringify(wt)} && git branch -D ${state!.branch}`, root);
			if (!rm.ok) return { text: `worktree removal failed:\n${rm.out}`, isError: true };
			state!.stage = "deploy";
			writeState(root, state!);
			return { text: `worktree and branch removed.\n${nextHint(state!, cfg)}` };
		}

		case "deploy": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (state!.stage !== "deploy") return { text: `stage is "${state!.stage}", deploy only applies after cleanup`, isError: true };
			const note = cfg.commands.deployNote ?? "Manual deployment: deploy the released tag to production yourself.";
			if (!ui.hasUI) return { text: `deploy runbook:\n${note}\n(confirmation requires an interactive session)` };
			const ok = await ui.confirm("Manual production deploy", `${note}\n\nWas the deploy completed (or intentionally skipped)?`);
			if (!ok) return { text: "deploy still pending — run flow deploy again afterwards" };
			rmSync(featDir(root, state!.slug), { recursive: true, force: true });
			if (sess.slug === state!.slug) sess.bind(null);
			return { text: `feature ${state!.slug} done — .dev-flow/${state!.slug}/ removed.` };
		}

		case "use": {
			if (!slugArg) return { text: "usage: flow use <slug>", isError: true };
			const st = readState(root, slugArg);
			if (!st || st.stage === "done") return { text: `no unfinished feature ${slugArg}`, isError: true };
			sess.bind(slugArg);
			return { text: `this session is now bound to ${slugArg} (stage ${st.stage})` };
		}

		case "abort": {
			// Unbinds the session only; state and worktree stay for manual recovery.
			const target = slugArg ?? sess.slug;
			if (!target) return { text: "nothing bound — pass a slug", isError: true };
			if (sess.slug === target) sess.bind(null);
			return { text: `session unbound from ${target}; state stays at .dev-flow/${target}/ — remove any worktree/branch manually` };
		}

		default:
			return { text: `unknown subcommand "${sub}" — init | start <slug> [--ui] | use <slug> | status | approve | test | health | verify | release-done | cleanup | deploy | abort [slug]`, isError: true };
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
	release: "success",
	cleanup: "dim",
	deploy: "dim",
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


export default function devFlow(pi: ExtensionAPI) {
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const uiFrom = (ctx: ExtensionContext): Ui => ({
		hasUI: ctx.hasUI,
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
		select: async (title, options) => (ctx.hasUI ? ctx.ui.select(title, options) : Promise.resolve(undefined)),
		input: async (title, placeholder) => (ctx.hasUI ? ctx.ui.input(title, placeholder) : Promise.resolve(undefined)),
	});

	const sessFor = (ctx: ExtensionContext): Session => {
		const key = sessionKey(ctx);
		return {
			slug: bindings.get(key) ?? null,
			bind: (slug) => {
				bindings.set(key, slug);
				pi.appendEntry("dev-flow-bind", { slug });
			},
		};
	};

	/** Restore this session's binding from its branch history (survives resume/fork). */
	const rebuildBinding = (ctx: ExtensionContext) => {
		let slug: string | null = null;
		for (const e of ctx.sessionManager?.getBranch() ?? []) {
			// SAFETY: narrow structural view of the SessionEntry union; we only read entries whose type/customType match our own appendEntry writes.
			const ce = e as unknown as { type: string; customType?: string; data?: { slug?: string | null } };
			if (ce.type === "custom" && ce.customType === "dev-flow-bind") slug = ce.data?.slug ?? null;
		}
		bindings.set(sessionKey(ctx), slug);
	};

	pi.registerCommand("flow", {
		description: "dev-flow gates: init | start <slug> [--ui] | use <slug> | status | approve | test | verify | release-done | cleanup | deploy | abort",
		handler: async (args, ctx) => {
			const res = await runFlow(parse(args), ctx.cwd, uiFrom(ctx), sessFor(ctx));
			ctx.ui.notify(res.text, res.isError ? "error" : "info");
			refreshStatus(ctx);
		},
	});

	const flowTool = defineTool({
		name: "flow",
		label: "Flow",
		description:
			"Drive the dev-flow stage gates for the active feature (plan → implement → release → cleanup → deploy). Never edit .dev-flow state directly; gates enforce plan/mockup/test/verification criteria and confirm with the operator.",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: 'Gate invocation, e.g. ["status"] or ["start", "my-slug", "--ui"]' }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const res = await runFlow(params.args, ctx.cwd, uiFrom(ctx), sessFor(ctx));
			return { content: [{ type: "text", text: res.text }], details: undefined, isError: res.isError };
		},
	});
	pi.registerTool(flowTool);

	// Agent-run gates refresh at turn_end (tool ctx lacks setStatus; turn_end catches them).
	pi.on("session_start", async (_event, ctx) => {
		rebuildBinding(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => rebuildBinding(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshStatus(ctx));

	pi.registerShortcut("ctrl+,", {
		description: "Show the dev-flow detail panel (stage, approvals, checks, next step)",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("flow panel requires interactive mode", "warning");
				return;
			}
			const st = existsSync(dfDir(ctx.cwd)) ? boundFeature(ctx.cwd, sessionKey(ctx)) : null;
			if (!st || st.stage === "done") {
				ctx.ui.notify("dev-flow: no active feature", "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new FlowPanel(st, loadConfig(dfDir(ctx.cwd)), theme, () => done()));
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const cfg = loadConfig(dfDir(ctx.cwd));
		const key = sessionKey(ctx);

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const abs = path.resolve(ctx.cwd, String(event.input.path ?? ""));
			const feats = featureRefs(ctx.cwd);
			const bound = boundFeature(ctx.cwd, key);
			const reason = writeGuard({ abs, dfDir: dfDir(ctx.cwd), features: feats, boundSlug: bound?.slug ?? null });
			if (reason) return { block: true, reason };
			// Editing a worktree invalidates that feature's test/health checks until they rerun.
			const owner = feats.find((f) => f.worktreeAbs && abs.startsWith(f.worktreeAbs + path.sep));
			if (owner && owner.state.stage === "implement") {
				let dirty = false;
				if (owner.state.checks.test?.ok) {
					delete owner.state.checks.test;
					dirty = true;
				}
				if (owner.state.checks.health?.ok) {
					delete owner.state.checks.health;
					dirty = true;
				}
				if (dirty) writeState(ctx.cwd, owner.state);
			}
			return undefined;
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (stateTamper(command)) return { block: true, reason: "state.json is dev-flow-owned — advance stages with the flow tool only" };
			if (!/\bgit\b/.test(command)) return undefined;
			const branch = (await sh("git branch --show-current", ctx.cwd)).out.trim().split("\n")[0] ?? "";
			const bound = boundFeature(ctx.cwd, key);
			const reason = bashFlowGuard({ command, branch, stage: bound?.stage ?? null, defaultBranch: cfg.defaultBranch });
			if (reason) return { block: true, reason };
		}
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const state = boundFeature(ctx.cwd, sessionKey(ctx));
		if (!state || state.stage === "done") return undefined;
		const cfg = loadConfig(dfDir(ctx.cwd));
		return {
			message: {
				customType: "dev-flow-context",
				display: false,
				content: `[dev-flow] this session is bound to: ${state.slug} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
Rules: follow the dev-flow skill playbook; drive gates with the flow tool (/flow as user); stage guards block out-of-stage edits and main-branch git ops — do not work around them.`,
			},
		};
	});
}
