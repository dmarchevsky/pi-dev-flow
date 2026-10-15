/**
 * `project.md` — the operator-owned playbook, three tiers by notation:
 *  tier 1: ```flow key = value``` config blocks and ```flow-check <name>``` executable blocks
 *  tier 2: `- [ ] item` checklist lines (structured confirmation, semantics up to the human)
 *  tier 3: every other line — prose injected to the agent when its stage begins
 * Parsing is pure and never fatal: unknown stages/keys and odd syntax become warnings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyAnswer, type ChecklistItem, type Config, DEFAULTS, healthProbe, mergeConfig, parseVersion, type GuardRules } from "./core.ts";

export const MD_STAGES = ["global", "plan", "implement", "pre-release", "release"] as const;
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
	guard: GuardRules;
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
};
// pre-release owns release preparation; the release keys are accepted under both sections so
// existing playbooks (## release with versionFile/…) keep parsing unchanged
KEYMAP["pre-release"] = { ...KEYMAP.release };

const CHECK_ITEM = /^\s*-\s*\[[ xX]\]\s+(.+)/;

const GUARD_VERBS = ["deny", "confirm", "protect", "forbid"] as const;
type GuardVerb = (typeof GUARD_VERBS)[number];
const isGuardVerb = (w: string): w is GuardVerb => (GUARD_VERBS as readonly string[]).includes(w);

/** ` ```flow-guard ` body: `<verb> <pattern> :: <why>` — deny/confirm carry a JS regex source,
 *  protect/forbid a repo-relative path. ` :: ` (whitespace before the colons) is the separator so a
 *  regex like `pr::list` survives; a bad regex is a hard finding so `flow init --write` refuses it. */
function parseGuardRules(entries: { line: string; where: string }[], stage: string | null, p: ParsedMd): void {
	if (stage !== "global") {
		p.warn.push(`${entries[0].where}: flow-guard rules belong to ## global — the block under ## ${stage ?? "(no stage)"} is ignored`);
		return;
	}
	for (const { line, where } of entries) {
		const m = line.match(/^(\w+)\s+(.*?)\s*::\s*(.*?)\s*$/);
		if (!m) {
			const part = line.match(/^(\w+)\s+/);
			p.hard.push(`${where}: flow-guard rule needs \` :: <why>\`${part ? ` (no separator after \`${part[1]}\`)` : ""}`);
			continue;
		}
		const [, verb, pattern, why] = m;
		if (!isGuardVerb(verb)) {
			p.warn.push(`${where}: unknown flow-guard verb "${verb}" — expected deny, confirm, protect or forbid — ignored`);
			continue;
		}
		if (!pattern) {
			p.hard.push(`${where}: flow-guard ${verb} rule has no pattern`);
			continue;
		}
		if (verb === "deny" || verb === "confirm") {
			try {
				new RegExp(pattern);
			} catch (e) {
				p.hard.push(`${where}: flow-guard ${verb} pattern is not a valid regular expression: ${(e as Error).message}`);
				continue;
			}
		}
		p.guard[verb].push({ pattern, why });
	}
}

export function parseProjectMd(text: string): ParsedMd {
	const p: ParsedMd = { hard: [], warn: [], global: {}, flow: Object.fromEntries(MD_STAGES.map((s) => [s, {}])) as Record<MdStage, Record<string, string>>, checks: [], guard: structuredClone(DEFAULTS.guard), checklist: {}, prose: {} };
	let stage: string | null = null;
	const prose: Record<string, string[]> = {};
	let inFence: string | null = null; // "flow" | "flow-check" | other lang
	let checkName = "";
	let checkBody: string[] = [];
	let guardBody: { line: string; where: string }[] = [];
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
				if (inFence === "flow-guard") {
					if (guardBody.length) parseGuardRules(guardBody, stage, p);
					guardBody = [];
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
			else if (inFence === "flow-guard") guardBody.push({ line, where });
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
			} else if (lang === "flow-guard") inFence = "flow-guard";
			else inFence = lang || "code";
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
	// a flow-guard block is the whole rule set; with none in project.md the project.json base stands
	if (GUARD_VERBS.some((v) => p.guard[v].length)) c.guard = structuredClone(p.guard);
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
export function loadProject(dfDir: string): { cfg: Config; md: ParsedMd | null; findings: string[] } {
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

/** `.dev-flow/<slug>/` directories holding a plan/ with no state.json — a closed or aborted feature
 *  whose directory outlived its flow state (a hand-close from before auto-close, an interrupted
 *  start). Nothing reads them: `flow status`, the guards and auto-bind all key off state.json.
 *  Root-relative paths, for the doctor report and the operator-confirmed remover. */
export function ghostFeatureDirs(root: string): string[] {
	const df = path.join(root, ".dev-flow");
	if (!existsSync(df)) return [];
	return readdirSync(df, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(path.join(df, d.name, "plan")) && !existsSync(path.join(df, d.name, "state.json")))
		.map((d) => `.dev-flow/${d.name}`);
}

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
			// only root-relative paths are probeable — checks run in the worktree, where `../../docker/.env` is correct
			if (/^[\w][\w-]*\/[\w./-]+$/.test(tok) && /\.\w+$/.test(tok) && !existsSync(path.join(root, tok))) {
				f.push(`${label} references missing file ${tok}`);
				break;
			}
		}
	}
	if (md) f.push(...md.hard.map((h) => `project.md: ${h}`), ...md.warn.map((w) => `project.md: ${w}`));
	if (cfg.commands.run && !cfg.checkList.some((c) => c.name === "health")) f.push('run command configured but no tier-1 health check — add commands.health or a flow-check so "running and healthy" is enforced');
	if (cfg.commands.dev && !healthProbe(cfg)) f.push("dev deploy configured but no health check — flow verify cannot prove the deploy came back serving this build: add commands.health or a flow-check health block");
	if (!cfg.checkList.length) f.push("implement tier-1 gates nothing — no test, no health, no flow-check block: 'flow check' would pass vacuously");
	for (const g of ghostFeatureDirs(root)) f.push(`${g} has a plan/ but no state.json — ghost of a closed or aborted feature (flow init offers to remove it)`);
	// dev-flow must load its own working code in its own checkout: the committed .pi shim is the only thing that guarantees it
	if (pkgRaw && (pkgRaw as { name?: unknown }).name === "pi-dev-flow") {
		const shim = path.join(root, ".pi", "extensions", "dev-flow.ts");
		if (!existsSync(shim) || !readFileSync(shim, "utf8").includes("../../extensions/dev-flow.ts"))
			f.push("dogfood shim .pi/extensions/dev-flow.ts is missing or does not re-export ../../extensions/dev-flow.ts — sessions in this checkout will not load the current code");
	}
	return f;
}

/** Compact per-stage digest of project.md content for dialog display (raw md walls are unreadable). */
const DIGEST_STAGES: Record<string, string> = { global: "General", plan: "Planning", implement: "Implement", release: "Release" };
const DIGEST_CMDS: Record<string, string> = { setup: "setup", test: "test", build: "build", run: "run app", seedData: "seed data", dev: "dev deploy" };
const DIGEST_WORDS: Record<string, string> = { defaultBranch: "default branch", branchPattern: "branch pattern", worktreeDir: "worktree dir", mainHook: "main-branch hook", mockupGlobs: "mockup files" };

/** Human summary of a playbook for the init confirm: one line per stage, real values and full item/guidance text, nothing truncated. */
export function mdDigest(text: string): string {
	const p = parseProjectMd(text);
	const rows: string[] = [];
	for (const s of MD_STAGES) {
		const label = DIGEST_STAGES[s];
		if (!label) continue;
		const bits: string[] = [];
		const keys: Record<string, string> = {};
		for (const [k, v] of Object.entries(p.flow[s] as Record<string, string>)) keys[k.split(".").pop()!] = v; // config dot-paths → display keys
		for (const [k, v] of Object.entries(keys)) {
			if (s === "release" && ["file", "pattern", "github", "artifact"].includes(k)) continue; // rendered specially below
			bits.push(DIGEST_CMDS[k] ? `${DIGEST_CMDS[k]}: ${JSON.stringify(v)}` : `${DIGEST_WORDS[k] ?? k}: ${v}`);
		}
		if (s === "implement" && p.checks.length) bits.push(`named checks: ${p.checks.map((c) => c.name).join(", ")}`);
		if (s === "release" && keys.file) {
			bits.push(`version in ${keys.file} → tag ${keys.pattern ?? "v{version}"}`);
			bits.push(keys.github === "false" || keys.github === "no" ? "GitHub release: off" : "GitHub release: created automatically");
			bits.push(`artifact check: ${keys.artifact ?? "none set"}`);
		}
		const items = p.checklist[s] ?? [];
		if (items.length) bits.push(`manual check: ${items.map((i) => `${i.uiOnly ? "(UI only) " : ""}\"${i.text}\"`).join(" · ")}`);
		if (p.prose[s]) bits.push(`guidance: "${p.prose[s].replace(/\s+/g, " ").trim()}"`);
		if (bits.length) rows.push(`${label} — ${bits.join(" · ")}`);
	}
	return `${rows.join("\n") || "(empty)"}\n\nnothing is executed or uploaded now — gates only run later inside the flow`;
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
	L.push("## pre-release", "", "<!-- e.g. review policy, docs expectations, who picks the version -->", "", "```flow", `versionFile = ${verFile}`, "versionTag = v{version}", "```", "");
	L.push("## release", "", "<!-- e.g. PR/merge/tag policy, who publishes artifacts -->", "");
	return L.join("\n") + "\n";
}
