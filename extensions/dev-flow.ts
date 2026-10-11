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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, isToolCallEventType, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	approveGate,
	bashFlowGuard,
	cleanupAssess,
	loadConfig,
	listFiles,
	newState,
	nextHint,
	pathFlowGuard,
	releaseGate,
	stateTamper,
	subst,
	validSlug,
	verifyGate,
	type Config,
	type FlowState,
} from "../src/core.ts";

const execAsync = promisify(exec);

interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
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
const currentFile = (root: string) => path.join(dfDir(root), ".current");

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

function currentSlug(root: string): string | null {
	try {
		return readFileSync(currentFile(root), "utf8").trim() || null;
	} catch {
		return null;
	}
}

function activeState(root: string): FlowState | null {
	const slug = currentSlug(root);
	return slug ? readState(root, slug) : null;
}

function worktreeAbs(root: string, cfg: Config, state: FlowState): string | null {
	return state.worktree ? path.resolve(root, state.worktree) : null;
}

// ---------------------------------------------------------------- gate runner

interface RunResult {
	text: string;
	isError?: boolean;
}

/** Single runner for both the /flow command and the flow tool. */
async function runFlow(args: string[], root: string, ui: Ui): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	if (!existsSync(dfDir(root)) && sub !== "init") return { text: "no .dev-flow/ in this repo — run /flow init first", isError: true };
	const cfg = loadConfig(dfDir(root));
	const flag = (name: string) => rest.includes(`--${name}`);
	const slugArg = rest.find((a) => !a.startsWith("--"));

	switch (sub) {
		case "init": {
			mkdirSync(dfDir(root), { recursive: true });
			const notes: string[] = [`.dev-flow/ created in ${root}`];
			const gi = path.join(root, ".gitignore");
			const body = existsSync(gi) ? readFileSync(gi, "utf8") : "";
			if (!body.split("\n").some((l) => l.trim() === ".dev-flow/")) writeFileSync(gi, `${body.trimEnd()}\n\n# dev-flow state (flow-owned, gitignored)\n.dev-flow/\n`.replace(/^\n+/, ""));
			if (cfg.mainHook) {
				const hookDir = path.join(root, ".git", "hooks");
				const hook = path.join(hookDir, "pre-commit");
				if (existsSync(hookDir) && !existsSync(hook)) {
					writeFileSync(
						hook,
						`#!/bin/sh\n# installed by dev-flow: direct commits to ${cfg.defaultBranch} are forbidden (override: DEV_FLOW_ALLOW_MAIN=1)\nbranch=$(git rev-parse --abbrev-ref HEAD)\nif [ "$branch" = "${cfg.defaultBranch}" ] && [ -z "$DEV_FLOW_ALLOW_MAIN" ]; then\n  echo "dev-flow: direct commits to ${cfg.defaultBranch} are forbidden — use a feature worktree and a PR" >&2\n  exit 1\nfi\n`,
						{ mode: 0o755 },
					);
					notes.push("pre-commit hook installed (blocks commits on main)");
				}
			}
			notes.push(`project config: ${existsSync(path.join(dfDir(root), "project.json")) ? ".dev-flow/project.json (operator-owned)" : "none — defaults in use, see README"}`);
			return { text: notes.join("\n") };
		}

		case "start": {
			if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] (slug: lowercase, dashes)", isError: true };
			if (existsSync(featDir(root, slugArg))) return { text: `feature ${slugArg} already exists`, isError: true };
			const state = newState(slugArg, flag("ui"));
			mkdirSync(path.join(featDir(root, slugArg), "plan"), { recursive: true });
			writeState(root, state);
			writeFileSync(currentFile(root), slugArg);
			return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}).\n${nextHint(state, cfg)}` };
		}

		case "status": {
			const slugs = slugArg ? [slugArg] : existsSync(dfDir(root)) ? (await listDirs(dfDir(root))).filter((s) => readState(root, s)) : [];
			if (!slugs.length) return { text: "no features — start one: flow start <slug> [--ui]" };
			const cur = currentSlug(root);
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
			const { state, err } = needState(root, slugArg);
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
			const { state, err } = needState(root, slugArg);
			if (err) return err;
			if (!cfg.commands.test) return { text: "no commands.test configured in .dev-flow/project.json", isError: true };
			const res = await sh(cfg.commands.test, root);
			state!.checks.test = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
		}

		case "verify": {
			const { state, err } = needState(root, slugArg);
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
				`Build passed. The app should be running locally (${cfg.commands.run ?? "no run command configured"}).\nHas the operator tested it and confirmed it works?`,
			);
			if (!ok) return { text: "verification declined — stay in implement and fix what failed" };
			state!.approvals.verify = now();
			state!.stage = "release";
			writeState(root, state!);
			return { text: `verified — entering release stage.\n${nextHint(state!, cfg)}` };
		}

		case "release-done": {
			const { state, err } = needState(root, slugArg);
			if (err) return err;
			const errs = releaseGate(state!);
			if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			state!.approvals.release = now();
			state!.stage = "cleanup";
			writeState(root, state!);
			return { text: `release recorded as complete.\n${nextHint(state!, cfg)}` };
		}

		case "cleanup": {
			const { state, err } = needState(root, slugArg);
			if (err) return err;
			if (state!.stage !== "cleanup") return { text: `stage is "${state!.stage}", cleanup only applies after release-done`, isError: true };
			const wt = worktreeAbs(root, cfg, state!);
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
			const { state, err } = needState(root, slugArg);
			if (err) return err;
			if (state!.stage !== "deploy") return { text: `stage is "${state!.stage}", deploy only applies after cleanup`, isError: true };
			const note = cfg.commands.deployNote ?? "Manual deployment: deploy the released tag to production yourself.";
			if (!ui.hasUI) return { text: `deploy runbook:\n${note}\n(confirmation requires an interactive session)` };
			const ok = await ui.confirm("Manual production deploy", `${note}\n\nWas the deploy completed (or intentionally skipped)?`);
			if (!ok) return { text: "deploy still pending — run flow deploy again afterwards" };
			rmSync(featDir(root, state!.slug), { recursive: true, force: true });
			if (currentSlug(root) === state!.slug) rmSync(currentFile(root), { force: true });
			return { text: `feature ${state!.slug} done — .dev-flow/${state!.slug}/ removed.` };
		}

		case "abort": {
			// Clears the active pointer only; state and worktree stay for manual recovery.
			if (slugArg && existsSync(currentFile(root)) && currentSlug(root) === slugArg) rmSync(currentFile(root), { force: true });
			else if (slugArg) return { text: `no active feature ${slugArg}` };
			else if (existsSync(currentFile(root))) rmSync(currentFile(root), { force: true });
			else return { text: "no active feature" };
			return { text: `active pointer cleared for ${slugArg ?? "last feature"} — remove any worktree/branch manually` };
		}

		default:
			return { text: `unknown subcommand "${sub}" — init | start <slug> [--ui] | status | approve | test | verify | release-done | cleanup | deploy | abort [slug]`, isError: true };
	}
}

function needState(root: string, slugArg?: string): { state: FlowState | null; err?: RunResult } {
	const slug = slugArg ?? currentSlug(root);
	if (!slug) return { state: null, err: { text: "no active feature — flow start <slug> [--ui]", isError: true } };
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

export default function devFlow(pi: ExtensionAPI) {
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const uiFrom = (ctx: ExtensionContext): Ui => ({
		hasUI: ctx.hasUI,
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
	});

	pi.registerCommand("flow", {
		description: "dev-flow gates: init | start <slug> [--ui] | status | approve | test | verify | release-done | cleanup | deploy | abort",
		handler: async (args, ctx) => {
			const res = await runFlow(parse(args), ctx.cwd, uiFrom(ctx));
			ctx.ui.notify(res.text, res.isError ? "error" : "info");
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
			const res = await runFlow(params.args, ctx.cwd, uiFrom(ctx));
			return { content: [{ type: "text", text: res.text }], details: undefined, isError: res.isError };
		},
	});
	pi.registerTool(flowTool);

	pi.on("tool_call", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const cfg = loadConfig(dfDir(ctx.cwd));
		const state = activeState(ctx.cwd);

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const abs = path.resolve(ctx.cwd, String(event.input.path ?? ""));
			const reason = pathFlowGuard({ abs, dfDir: dfDir(ctx.cwd), state, worktreeAbs: state ? worktreeAbs(ctx.cwd, cfg, state) : null });
			if (reason) return { block: true, reason };
			// Editing the worktree invalidates a passing test check until flow test reruns.
			const wt = state ? worktreeAbs(ctx.cwd, cfg, state) : null;
			if (state && state.stage === "implement" && state.checks.test?.ok && wt && abs.startsWith(wt + path.sep)) {
				delete state.checks.test;
				writeState(ctx.cwd, state);
			}
			return undefined;
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (stateTamper(command)) return { block: true, reason: "state.json is dev-flow-owned — advance stages with the flow tool only" };
			if (!/\bgit\b/.test(command)) return undefined;
			const branch = (await sh("git branch --show-current", ctx.cwd)).out.trim().split("\n")[0] ?? "";
			const reason = bashFlowGuard({ command, branch, stage: state?.stage ?? null, defaultBranch: cfg.defaultBranch });
			if (reason) return { block: true, reason };
		}
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const state = activeState(ctx.cwd);
		if (!state || state.stage === "done") return undefined;
		const cfg = loadConfig(dfDir(ctx.cwd));
		return {
			message: {
				customType: "dev-flow-context",
				display: false,
				content: `[dev-flow] active feature: ${state.slug} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
Rules: follow the dev-flow skill playbook; drive gates with the flow tool (/flow as user); stage guards block out-of-stage edits and main-branch git ops — do not work around them.`,
			},
		};
	});
}
