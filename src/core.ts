/**
 * dev-flow core: config, flow state, stage gates and guard decisions.
 *
 * Pure(ish) logic only — no pi imports here so it is unit-testable with
 * `node --test`. The extension in extensions/dev-flow.ts is thin wiring.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Stage = "plan" | "implement" | "release" | "cleanup" | "deploy" | "done";
export const STAGES: Stage[] = ["plan", "implement", "release", "cleanup", "deploy", "done"];

export interface Check {
	ok: boolean;
	at: string;
	note?: string;
}

export interface FlowState {
	slug: string;
	stage: Stage;
	ui: boolean;
	branch: string;
	worktree: string; // relative to repo root, filled at approve
	createdAt: string;
	approvals: Record<string, string>;
	checks: Record<string, Check>;
}

export interface Commands {
	setup?: string;
	test?: string;
	build?: string;
	run?: string;
	deployNote?: string;
}

export interface Config {
	defaultBranch: string;
	branchPattern: string; // {slug} substituted
	worktreeDir: string; // {slug} substituted, relative to repo root
	mockupGlobs: string[]; // suffix globs required in plan/ when ui (default: rendered screenshots)
	commands: Commands;
	release: { review: string; changelog?: string; tagPattern?: string };
	mainHook: boolean; // flow init installs a pre-commit hook blocking main commits
}

export const DEFAULTS: Config = {
	defaultBranch: "main",
	branchPattern: "feat/{slug}",
	worktreeDir: ".dev-flow/{slug}/worktree",
	mockupGlobs: ["*.png"],
	commands: {},
	release: { review: "/ponytail-review" },
	mainHook: true,
};

export function mergeConfig(raw: unknown): Config {
	const c: Config = structuredClone(DEFAULTS);
	if (!raw || typeof raw !== "object") return c;
	const r = raw as Record<string, unknown>;
	for (const key of ["defaultBranch", "branchPattern", "worktreeDir", "mainHook"] as const) {
		if (typeof r[key] === "string" || typeof r[key] === "boolean") (c[key] as never) = r[key] as never;
	}
	if (Array.isArray(r.mockupGlobs)) c.mockupGlobs = r.mockupGlobs.map(String);
	if (r.commands && typeof r.commands === "object")
		for (const [k, v] of Object.entries(r.commands as Record<string, unknown>)) if (typeof v === "string") (c.commands as Record<string, string>)[k] = v;
	if (r.release && typeof r.release === "object") Object.assign(c.release, r.release);
	return c;
}

export function subst(pattern: string, slug: string): string {
	return pattern.replaceAll("{slug}", slug);
}

export function validSlug(slug: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export function newState(slug: string, ui: boolean): FlowState {
	return { slug, stage: "plan", ui, branch: "", worktree: "", createdAt: new Date().toISOString(), approvals: {}, checks: {} };
}

/** Recursive relative file listing of a directory (empty when missing). */
export function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name)).map((f) => `${e.name}/${f}`));
		else out.push(e.name);
	}
	return out;
}

function matchesGlob(file: string, globs: string[]): boolean {
	return globs.some((g) => (g.startsWith("*.") ? file.endsWith(g.slice(1)) : file.includes(g)));
}

/** Gate: plan → implement. Returns reasons it cannot advance (empty = pass). */
export function approveGate(state: FlowState, cfg: Config, planFiles: string[]): string[] {
	const errs: string[] = [];
	if (state.stage !== "plan") errs.push(`stage is "${state.stage}", approval only applies to "plan"`);
	if (!planFiles.some((f) => f.endsWith(".md"))) errs.push("plan/ must contain the written plan (*.md)");
	if (state.ui && !planFiles.some((f) => matchesGlob(f, cfg.mockupGlobs)))
		errs.push(`UI feature: plan/mockups/ must contain rendered screenshots matching ${cfg.mockupGlobs.join(", ")} (headless chromium, embedded in plan.md)`);
	return errs;
}

/** Gate: implement → release. */
export function verifyGate(state: FlowState, cfg: Config): string[] {
	const errs: string[] = [];
	if (state.stage !== "implement") errs.push(`stage is "${state.stage}", verify only applies to "implement"`);
	if (cfg.commands.test && !state.checks.test?.ok) errs.push("test check has not passed — run flow test first");
	return errs;
}

/** Gate: release → cleanup (the release playbook was run to completion). */
export function releaseGate(state: FlowState): string[] {
	const errs: string[] = [];
	if (state.stage !== "release") errs.push(`stage is "${state.stage}", release-done only applies to "release"`);
	if (!state.approvals.verify) errs.push("operator verify approval is missing");
	return errs;
}

/**
 * Cleanup safety. Returns { errors, unmerged }: errors hard-block; unmerged is
 * a warning list the operator can confirm through (e.g. squash merges).
 */
export function cleanupAssess(porcelain: string, unmerged: string[]): { errors: string[]; unmerged: string[] } {
	const errors: string[] = [];
	if (porcelain.trim()) errors.push("worktree has uncommitted changes — commit or discard them first");
	return { errors, unmerged: unmerged.filter(Boolean) };
}

export interface GuardCtx {
	command: string;
	branch: string; // current branch of the main checkout
	stage: Stage | null; // active feature stage, null when no active feature
	defaultBranch: string;
}

/** True when a bash command looks like a direct write to flow state. */
export function stateTamper(command: string): boolean {
	// shortcut: verb-before-path order assumed; a state.json mention + any write verb blocks.
	return /\.dev-flow\/\S*state\.json/.test(command) && /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\btruncate\b|\bdd\b|python|-e|node\s)/.test(command);
}

/** Guard: decide whether a git bash command violates the flow. Returns a reason or null. */
export function bashFlowGuard(o: GuardCtx): string | null {
	const c = o.command;
	if (!/\bgit\b/.test(c)) return null;
	const onMain = o.branch === o.defaultBranch;
	const git = (word: string) => new RegExp(`\\bgit\\b[^|;&]*\\b${word}\\b`).test(c);

	if (git("commit") && onMain) return `direct commits to ${o.defaultBranch} are forbidden — work in the feature worktree`;
	if (git("push")) {
		const targetsMain = onMain || c.includes(o.defaultBranch);
		if (targetsMain && o.stage !== "release") return `pushing to ${o.defaultBranch} requires stage "release" (verified feature)`;
		if (/--tags|push\s+\S+\s+v\d/.test(c) && o.stage !== "release") return `pushing release tags requires stage "release"`;
	}
	if (git("merge") && onMain && o.stage !== "release") return `merging into ${o.defaultBranch} requires stage "release"`;
	return null;
}

export interface FeatureRef {
	state: FlowState;
	worktreeAbs: string | null;
}

const within = (abs: string, dir: string | null) => !!dir && (abs === dir || abs.startsWith(dir + path.sep));

/**
 * Write guard with per-path attribution: writes inside a worktree are judged by that
 * worktree's own feature; main-checkout writes are judged by the session's bound feature
 * (release+ may touch it; plan/implement may not); with no binding and unfinished features
 * the session must bind first (`flow use`). Returns a reason or null (allowed).
 */
export function writeGuard(o: { abs: string; dfDir: string; features: FeatureRef[]; boundSlug: string | null }): string | null {
	if (o.abs === path.join(o.dfDir, "project.json")) return ".dev-flow/project.json is operator-owned — ask the user to change it";
	if (o.abs.endsWith("state.json") && o.abs.includes(o.dfDir + path.sep)) return "state.json is dev-flow-owned — advance stages with the flow tool only";
	// Owner attribution BEFORE the .dev-flow allow: with the default worktreeDir inside .dev-flow,
	// a worktree must still be judged by its owning feature's stage, not treated as free plan space.
	const owner = o.features.find((f) => within(o.abs, f.worktreeAbs));
	if (owner) {
		if (owner.state.stage === "plan") return `feature ${owner.state.slug} is in plan — code is read-only until its plan is approved`;
		if (owner.state.stage === "done") return `feature ${owner.state.slug} is done`;
		return null; // implement/release/cleanup/deploy: own worktree is the working area
	}
	if (within(o.abs, o.dfDir)) return null;
	if (!o.features.length) return null;
	if (o.boundSlug) {
		const bound = o.features.find((f) => f.state.slug === o.boundSlug);
		if (bound) {
			if (bound.state.stage === "implement") return `bound feature ${o.boundSlug} is at implement — edit its worktree (${bound.state.worktree}), not the main checkout`;
			if (bound.state.stage === "plan") return `bound feature ${o.boundSlug} is in plan — code is read-only until approved`;
			return null; // release/cleanup/deploy: release chores may touch the main checkout
		}
	}
	return `unfinished features: ${o.features.map((f) => f.state.slug).join(", ")} — bind this session with flow use <slug> (or pass an explicit slug to gates)`;
}

/** Compact footer status text; coloring/theme is the extension's business. */
export function statusCompact(state: FlowState): { text: string; failed: boolean } {
	const failed = Object.values(state.checks).some((c) => !c.ok);
	return { text: `${state.slug} ▸ ${state.stage}`, failed };
}

/** What the agent/user should do next, per stage. */
export function nextHint(state: FlowState, cfg: Config): string {
	switch (state.stage) {
		case "plan":
			return `write the plan into .dev-flow/${state.slug}/plan/${state.ui ? ` — render mockups to plan/mockups/ (${cfg.mockupGlobs.join(", ")}) with headless chromium and embed them in plan.md` : ""}, then ask the operator to run /flow approve`;
		case "implement":
			return `implement in the worktree ${state.worktree}, add tests, run flow test, build + run locally, then ask the operator to run /flow verify`;
		case "release":
			return `run the release playbook (${cfg.release.review} → fix → docs${cfg.release.changelog ? ` → ${cfg.release.changelog}` : ""}${cfg.release.tagPattern ? ` → tag ${cfg.release.tagPattern}` : ""} → PR → merge), then run flow release-done`;
		case "cleanup":
			return "run flow cleanup (safety-checked worktree/branch removal)";
		case "deploy":
			return "run flow deploy for the manual production deployment";
		default:
			return "feature finished";
	}
}

export function loadConfig(dfDir: string): Config {
	const file = path.join(dfDir, "project.json");
	if (!existsSync(file)) return structuredClone(DEFAULTS);
	try {
		return mergeConfig(JSON.parse(readFileSync(path.join(dfDir, "project.json"), "utf8")));
	} catch {
		return structuredClone(DEFAULTS); // shortcut: broken config falls back to defaults with a warning from the caller
	}
}
