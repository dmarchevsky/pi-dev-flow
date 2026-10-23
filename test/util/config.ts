/**
 * Test-only Config builder — the former `buildConfig` of src/core.ts.
 *
 * project.md is the only persisted config source (the legacy project.json
 * loader is gone); this helper stays so unit tests keep the partial-overrides
 * shorthand. It is deliberately NOT in production code: nothing at runtime
 * builds a Config from a raw object.
 */
import { type Config, DEFAULTS, toSeconds } from "../../src/core.ts";

/** project.json may spell a rule as a bare pattern string. */
function normalizeGuardRules(raw: unknown[]): Config["guard"]["deny"] {
	const out: Config["guard"]["deny"] = [];
	for (const e of raw) {
		if (typeof e === "string" && e.trim()) out.push({ pattern: e, why: "" });
		else if (e && typeof e === "object") {
			const o = e as Record<string, unknown>;
			if (typeof o.pattern === "string" && o.pattern.trim()) out.push({ pattern: o.pattern, why: typeof o.why === "string" ? o.why : "" });
		}
	}
	return out;
}

/** Build a Config from DEFAULTS + a partial overrides object (tests only). */
export function buildConfig(raw: unknown): Config {
	const c: Config = structuredClone(DEFAULTS);
	if (!raw || typeof raw !== "object") return c;
	const r = raw as Record<string, unknown>;
	for (const key of ["defaultBranch", "branchPattern", "worktreeDir", "mainHook", "forge"] as const) {
		if (typeof r[key] === "string" || typeof r[key] === "boolean") (c[key] as never) = r[key] as never;
	}
	if (Array.isArray(r.mockupGlobs)) c.mockupGlobs = r.mockupGlobs.map(String);
	if (r.commands && typeof r.commands === "object")
		for (const [k, v] of Object.entries(r.commands as Record<string, unknown>)) if (typeof v === "string") (c.commands as Record<string, string>)[k] = v;
	if (r.release && typeof r.release === "object") Object.assign(c.release, r.release);
	if (r.healthWait !== undefined) c.healthWait = toSeconds(r.healthWait) ?? c.healthWait;
	if (r.versioning && typeof r.versioning === "object") {
		const v = r.versioning as Record<string, unknown>;
		if (typeof v.file === "string") c.versioning.file = v.file;
		if (typeof v.pattern === "string") c.versioning.pattern = v.pattern;
	}
	if (r.guard && typeof r.guard === "object") {
		const g = r.guard as Record<string, unknown>;
		for (const verb of ["deny", "confirm", "protect", "forbid"] as const)
			if (Array.isArray(g[verb])) c.guard[verb] = normalizeGuardRules(g[verb]);
	}
	// tier-1 checks from plain commands so a raw config keeps the same teeth as project.md
	c.checkList = [
		...(c.commands.test ? [{ name: "test", cmd: c.commands.test }] : []),
		...(c.commands.health ? [{ name: "health", cmd: c.commands.health }] : []),
	];
	return c;
}
