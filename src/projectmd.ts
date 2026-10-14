/**
 * `project.md` — the operator-owned playbook, three tiers by notation:
 *  tier 1: ```flow key = value``` config blocks and ```flow-check <name>``` executable blocks
 *  tier 2: `- [ ] item` checklist lines (structured confirmation, semantics up to the human)
 *  tier 3: every other line — prose injected to the agent when its stage begins
 * Parsing is pure and never fatal: unknown stages/keys and odd syntax become warnings.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyAnswer, type ChecklistItem, type Config, DEFAULTS, mergeConfig, parseVersion } from "./core.ts";

export const MD_STAGES = ["global", "plan", "implement", "release", "cleanup", "deploy"] as const;
export type MdStage = (typeof MD_STAGES)[number];

export interface StageCheck {
	name: string;
	cmd: string;
}

export interface ParsedMd {
	hard: string[]; // errors: init --write refuses on these
	warn: string[];
	global: Record<string, string>;
	flow: Record<MdStage, Record<string, string>>;
	checks: StageCheck[];
	checklist: Record<string, ChecklistItem[]>;
	prose: Record<string, string>;
}

// stage → flow-key → config dot-path (aliases); unknown keys warn
const KEYMAP: Record<string, Record<string, string>> = {
	global: {
		defaultBranch: "defaultBranch",
		branchPattern: "branchPattern",
		worktreeDir: "worktreeDir",
		mainHook: "mainHook",
		mockupGlobs: "mockupGlobs",
		"versioning.file": "versioning.file",
		"versioning.pattern": "versioning.pattern",
		"release.review": "release.review",
		"release.changelog": "release.changelog",
		"release.github": "release.githubRelease",
		"release.artifact": "release.artifact",
	},
	plan: {},
	implement: {
		setup: "commands.setup",
		test: "commands.test",
		build: "commands.build",
		run: "commands.run",
		seedData: "commands.seedData",
		health: "commands.health",
		dev: "commands.dev",
	},
	release: {
		versionFile: "versioning.file",
		versionTag: "versioning.pattern",
		review: "release.review",
		changelog: "release.changelog",
		github: "release.githubRelease",
		artifact: "release.artifact",
	},
	cleanup: {},
	deploy: { note: "commands.deployNote" },
};

const CHECK_ITEM = /^\s*-\s*\[[ xX]\]\s+(.+)/;

export function parseProjectMd(text: string): ParsedMd {
	const p: ParsedMd = { hard: [], warn: [], global: {}, flow: Object.fromEntries(MD_STAGES.map((s) => [s, {}])) as Record<MdStage, Record<string, string>>, checks: [], checklist: {}, prose: {} };
	let stage: string | null = null;
	const prose: Record<string, string[]> = {};
	let inFence: string | null = null; // "flow" | "flow-check" | other lang
	let checkName = "";
	let checkBody: string[] = [];
	let lastLine = ""; // for fence-start line numbers (1-based = index+1)
	text.split("\n").forEach((line, i) => {
		const where = `line ${i + 1}`;
		if (inFence) {
			if (line.trim() === "```") {
				if (inFence === "flow-check") {
					const cmd = checkBody.join("\n").trim();
					if (!checkName) p.hard.push(`${where}: flow-check block missing a name`);
					else if (!cmd) p.hard.push(`${lastLine}: flow-check "${checkName}" is empty`);
					else if (stage !== "implement") p.warn.push(`${where}: flow-check "${checkName}" ignored (tier-1 checks belong to ## implement)`);
					else p.checks.push({ name: checkName, cmd });
				}
				inFence = null;
				checkName = "";
				checkBody = [];
				return;
			}
			if (inFence === "flow") {
				const m = line.match(/^\s*([A-Za-z][\w.]*)\s*=\s*(.+?)\s*$/);
				if (!m || !stage) {
					if (line.trim() && !line.trim().startsWith("#")) p.hard.push(`${where}: expected \`key = value\` inside flow block`);
				} else if (!MD_STAGES.includes(stage as MdStage)) {
					/* unknown stage already warned */
				} else {
					const mapped = KEYMAP[stage][m[1]];
					if (!mapped) p.warn.push(`${where}: unknown key "${m[1]}" in ## ${stage} — ignored`);
					else p.flow[stage as MdStage][mapped] = m[2];
				}
			} else if (inFence === "flow-check") checkBody.push(line);
			return;
		}
		lastLine = where;
		const fence = line.match(/^```\s*(.*)$/);
		if (fence) {
			const lang = fence[1].trim();
			if (lang === "flow") inFence = "flow";
			else if (lang.startsWith("flow-check")) {
				inFence = "flow-check";
				checkName = lang.slice("flow-check".length).trim();
			} else inFence = lang || "code";
			return;
		}
		const head = line.match(/^##\s+(\S+)\s*$/);
		if (head) {
			stage = head[1].toLowerCase();
			if (!MD_STAGES.includes(stage as MdStage)) p.warn.push(`${where}: unknown stage "${stage}" — its content is kept as inert prose`);
			return;
		}
		if (!stage || stage === "global" || !MD_STAGES.includes(stage as MdStage)) return; // preamble/unknown → not injected
		const item = line.match(CHECK_ITEM);
		if (item) {
			const rawItem = item[1].trim();
			const uiOnly = rawItem.startsWith("(ui) ");
			(p.checklist[stage] ??= []).push({ text: uiOnly ? rawItem.slice(5).trim() : rawItem, uiOnly });
			return;
		}
		if (/^(#|```|\s*$)/.test(line) && !line.startsWith("### ")) return; // h1/comments/blank not prose
		(prose[stage] ??= []).push(line.trim());
	});
	if (inFence) p.hard.push(`unterminated \`\`\`${inFence === "code" ? "" : inFence} block`);
	for (const [s, lines] of Object.entries(prose)) p.prose[s] = lines.join(" ").trim();
	for (const s of MD_STAGES) if (p.prose[s] === undefined) p.prose[s] = "";
	return p;
}

/** Fold parsed project.md onto a (possibly merged project.json) config. */
export function mdToConfig(p: ParsedMd, base?: Config): Config {
	const c: Config = base ? structuredClone(base) : structuredClone(DEFAULTS);
	const raw: Record<string, unknown> = {};
	for (const stage of MD_STAGES) for (const [key, val] of Object.entries(p.flow[stage])) applyAnswer(raw, key, val);
	// boolean/key normalization identical to project.json semantics
	if (typeof raw.mainHook === "string") raw.mainHook = /^(yes|true)$/i.test(raw.mainHook);
	if (typeof raw.mockupGlobs === "string") raw.mockupGlobs = String(raw.mockupGlobs).split(",").map((s) => s.trim()).filter(Boolean);
	// flow keys were mapped to dot paths (commands.x, versioning.y, release.z) — rebuild nested
	const nested: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) applyAnswer(nested, k, v as string);
	const rel = (nested as { release?: { githubRelease?: unknown } }).release;
	if (rel && typeof rel.githubRelease === "string") rel.githubRelease = !/^(no|false)$/i.test(rel.githubRelease);
	mergeInto(c, nested);
	c.checkList = [
		...(c.commands.test ? [{ name: "test", cmd: c.commands.test }] : []),
		...(c.commands.health ? [{ name: "health", cmd: c.commands.health }] : []),
		...p.checks.map((x) => ({ name: x.name, cmd: x.cmd })),
	];
	c.checklist = p.checklist;
	c.prose = p.prose;
	return c;
}

function mergeInto(c: Config, r: Record<string, unknown>): void {
	if (typeof r.defaultBranch === "string") c.defaultBranch = r.defaultBranch;
	if (typeof r.branchPattern === "string") c.branchPattern = r.branchPattern;
	if (typeof r.worktreeDir === "string") c.worktreeDir = r.worktreeDir;
	if (typeof r.mainHook === "boolean") c.mainHook = r.mainHook;
	if (Array.isArray(r.mockupGlobs)) c.mockupGlobs = r.mockupGlobs.map(String);
	if (typeof r.commands === "object" && r.commands) Object.assign(c.commands, r.commands);
	if (typeof r.versioning === "object" && r.versioning) Object.assign(c.versioning, r.versioning);
	if (typeof r.release === "object" && r.release) Object.assign(c.release, r.release);
}

/** Load merged config: project.json as legacy base, project.md overriding. */
export function loadProject(root: string, dfDir: string): { cfg: Config; md: ParsedMd | null; findings: string[] } {
	const jsonFile = path.join(dfDir, "project.json");
	const mdFile = path.join(dfDir, "project.md");
	const cfg = mergeConfig(existsSync(jsonFile) ? safeJson(readFileSync(jsonFile, "utf8")) : null);
	let mdText: string | null = null;
	try {
		if (existsSync(mdFile)) mdText = readFileSync(mdFile, "utf8");
	} catch {
		mdText = null;
	}
	if (mdText === null) return { cfg, md: null, findings: [] };
	const md = parseProjectMd(mdText);
	return { cfg: mdToConfig(md, cfg), md, findings: [] };
}

const safeJson = (s: string): unknown => {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};

/**
 * Doctor: cheap file-level probes only — NEVER runs user commands.
 * Findings are advisory strings for `flow init` (fixer) and the status flag.
 */
export function doctorFindings(root: string, cfg: Config, md: ParsedMd | null, hasJson: boolean, hasMd: boolean): string[] {
	const f: string[] = [];
	if (hasJson && hasMd) f.push("both project.json and project.md exist — project.md overrides it; fold legacy values in and delete project.json");
	if (cfg.versioning.file) {
		const mf = path.join(root, cfg.versioning.file);
		if (!existsSync(mf)) f.push(`versioning.file "${cfg.versioning.file}" does not exist`);
		else if (!parseVersion(cfg.versioning.file, readFileSync(mf, "utf8"))) f.push(`versioning.file "${cfg.versioning.file}": no parsable version found`);
	}
	// drift: `npm|pnpm|yarn|bun run <script>` where the script no longer exists
	let pkgScripts: Record<string, string> | null = null;
	const pkgRaw = existsSync(path.join(root, "package.json")) ? safeJson(readFileSync(path.join(root, "package.json"), "utf8")) : null;
	if (pkgRaw && typeof pkgRaw === "object" && typeof (pkgRaw as { scripts?: unknown }).scripts === "object") pkgScripts = (pkgRaw as { scripts: Record<string, string> }).scripts;
	const cmdList = [...Object.entries(cfg.commands).map(([k, v]) => [`commands.${k}`, v!] as [string, string]), ...cfg.checkList.map((c) => [`check ${c.name}`, c.cmd] as [string, string])];
	for (const [label, cmd] of cmdList) {
		const run = cmd.match(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/);
		if (run && pkgScripts && !(run[1] in pkgScripts)) f.push(`${label} runs "run ${run[1]}" but package.json has no such script`);
		for (const tok of cmd.split(/\s+/)) {
			if (/^[\w.-]+\/[\w./-]+$/.test(tok) && /\.\w+$/.test(tok) && !existsSync(path.join(root, tok))) {
				f.push(`${label} references missing file ${tok}`);
				break;
			}
		}
	}
	if (md) f.push(...md.hard.map((h) => `project.md: ${h}`), ...md.warn.map((w) => `project.md: ${w}`));
	if (cfg.commands.run && !cfg.checkList.some((c) => c.name === "health")) f.push('run command configured but no tier-1 health check — add commands.health or a flow-check so "running and healthy" is enforced');
	if (!cfg.checkList.length) f.push("implement tier-1 gates nothing — no test, no health, no flow-check block: 'flow check' would pass vacuously");
	return f;
}

/** Compact per-stage digest of project.md content for dialog display (raw md walls are unreadable). */
export function mdDigest(text: string): string {
	const p = parseProjectMd(text);
	const rows: string[] = [];
	for (const s of MD_STAGES) {
		const bits: string[] = [];
		const keys = Object.keys(p.flow[s]).map((k) => k.split(".").pop()!);
		if (keys.length) bits.push(`set: ${keys.join(", ")}`);
		if (s === "implement" && p.checks.length) bits.push(`checks: ${p.checks.map((c) => c.name).join(", ")}`);
		const n = (p.checklist[s] ?? []).length;
		if (n) bits.push(`checklist: ${n}`);
		if (p.prose[s]) bits.push("prose");
		if (bits.length) rows.push(`## ${s} — ${bits.join(" \u00b7 ")}`);
	}
	return rows.join("\n") || "(empty)";
}

/** Draft project.md: fresh = pure detection (first init, --force); otherwise a refresh keeping configured values. */
export function buildDraft(det: { report: string[]; partial: { defaultBranch: string; commands: Record<string, string>; versioning?: { file: string } } }, cfg?: Config): string {
	const fresh = cfg === undefined;
	const c = cfg ?? structuredClone(DEFAULTS);
	const cmd = (k: string) => (fresh ? undefined : (c.commands as Record<string, string>)[k]) || det.partial.commands[k];
	const branch = fresh ? det.partial.defaultBranch : c.defaultBranch;
	const verFile = (fresh ? undefined : c.versioning.file) || det.partial.versioning?.file || "package.json";
	const L: string[] = [];
	L.push("# dev-flow", "", "<!-- Operator-owned playbook. Regenerate with: flow init --draft -->", "");
	L.push("## global", "", "```flow", `defaultBranch = ${branch}`, "```", "");
	L.push("## plan", "", "- [ ] rendered mockups attached for every changed screen", "", "<!-- what the plan must contain, UI expectations -->", "");
	L.push("## implement", "", "```flow");
	for (const k of ["setup", "test", "build", "run", "seedData", "dev"]) if (cmd(k)) L.push(`${k} = ${cmd(k)}`);
	L.push("```", "");
	const healthCmd = cmd("health") || (fresh ? undefined : c.checkList.find((x) => x.name === "health")?.cmd);
	// never invent a health check: a placeholder that can't pass blocks verify forever (dogfooded: curl localhost:3000 in a library repo)
	if (healthCmd) L.push("```flow-check health", healthCmd, "```", "");
	else L.push("<!-- optional tier-1: add a flow-check 'health' block once the app exposes a health endpoint -->", "");
	// carry every other explicit check through a refresh, or regeneration would silently drop teeth
	for (const x of fresh ? [] : c.checkList) {
		if (x.name === "test" || x.name === "health") continue; // implicit ones ride the flow key block / healthCmd above
		L.push("```flow-check " + x.name, x.cmd, "```", "");
	}
	L.push("- [ ] app runs locally with real data; visual pass: no overflows or stray scrollbars", "", "<!-- tier-3: standing guidance for this stage -->", "");
	L.push("## release", "", "<!-- e.g. semver rules, changelog policy, who confirms the version -->", "", "```flow", `versionFile = ${verFile}`, "versionTag = v{version}", "```", "");
	if (cmd("deployNote")) L.push("## deploy", "", cmd("deployNote"), "");
	return L.join("\n") + "\n";
}
