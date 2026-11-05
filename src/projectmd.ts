/**
 * `project.md` — the operator-owned playbook, three tiers by notation:
 *  tier 1: ```flow key = value``` config blocks and ```flow-check <name>``` executable blocks
 *  tier 2: `- [ ] item` checklist lines (structured confirmation, semantics up to the human)
 *  tier 3: every other line — prose injected to the agent when its stage begins
 * Parsing is pure and never fatal: unknown stages/keys and odd syntax become warnings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyAnswer, type ChecklistItem, type Config, DEFAULTS, healthProbe, parseMergeStyle, parseVersion, toSeconds, type GuardRules, type StageCheck } from "./core.ts";

export const MD_STAGES = ["global", "plan", "implement", "pre-release", "release"] as const;
export type MdStage = (typeof MD_STAGES)[number];

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
		bashTimeout: "bashTimeout", // inject (default) | require — must a shell call state its own timeout?
		branchPattern: "branchPattern",
		worktreeDir: "worktreeDir",
		mainHook: "mainHook",
		mockupGlobs: "mockupGlobs",
		forge: "forge",
		"versioning.file": "versioning.file",
		"versioning.pattern": "versioning.pattern",
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
		healthWait: "healthWait", // seconds the post-deploy probe may keep retrying (#42)
	},
	release: {
		versionFile: "versioning.file",
		versionTag: "versioning.pattern",
		review: "release.review",
		changelog: "release.changelog",
		releases: "release.releases",
		artifact: "release.artifact",
		preflight: "release.preflight", // run in the worktree at flow release, before anything ships (e.g. docker build .)
		merge: "release.merge", // how a merged branch lands: squash | merge | rebase | any
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
		if (verb === "protect" || verb === "forbid") {
			// only a basename glob is a sibling set; a glob mid-path names one literal file and guards nothing —
			// the same silent no-op as an invalid regex, so it gets the same loud treatment (#87).
			// The rule is kept: the operator hears it is a no-op and fixes the file, and doctor re-reads it.
			if (pattern.split("/").slice(0, -1).some((s) => /[*?]/.test(s))) {
				p.warn.push(`${where}: flow-guard ${verb} pattern globs outside its last segment — only a basename glob (docker/.env*) matches; as written this names one literal path and guards nothing`);
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
					else {
						// the only enum-valued key: a junk mode must not silently mean "block every shell call"
						if (m[1] === "bashTimeout" && !/^(require|inject)$/i.test(m[2].trim())) {
							p.warn.push(`${where}: bashTimeout = "${m[2]}" — expected require or inject, keeping inject`);
							return;
						}
						// merge is the other enum: a typo here must not quietly mean "no policy" and drop the teeth
						if (mapped === "release.merge" && !parseMergeStyle(m[2])) {
							p.warn.push(`${where}: merge = "${m[2]}" — expected squash, merge, rebase or any — ignored`);
							return;
						}
						p.flow[stage as MdStage][mapped] = m[2];
					}
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
			// qualifiers lead the item in any order: (ui) = --ui features only, (versioned) = not on a --no-version flow
			let text = item[1].trim();
			let uiOnly = false;
			let versionedOnly = false;
			for (let q = /^\((ui|versioned)\)\s+/.exec(text); q; q = /^\((ui|versioned)\)\s+/.exec(text)) {
				if (q[1] === "ui") uiOnly = true;
				else versionedOnly = true;
				text = text.slice(q[0].length);
			}
			(p.checklist[stage] ??= []).push(versionedOnly ? { text, uiOnly, versionedOnly } : { text, uiOnly });
			return;
		}
		if (/^(#|```|<!--|\s*$)/.test(line) && !line.startsWith("### ")) return; // h1/html comments/blank are not prose
		(prose[stage] ??= []).push(line.trim());
	});
	if (inFence) p.hard.push(`unterminated \`\`\`${inFence === "code" ? "" : inFence} block`);
	for (const [s, lines] of Object.entries(prose)) p.prose[s] = lines.join(" ").trim();
	for (const s of MD_STAGES) if (p.prose[s] === undefined) p.prose[s] = "";
	return p;
}

/** Fold parsed project.md onto DEFAULTS — project.md is the only persisted config source. */
export function mdToConfig(p: ParsedMd): Config {
	const c: Config = structuredClone(DEFAULTS);
	const raw: Record<string, unknown> = {};
	for (const stage of MD_STAGES) for (const [key, val] of Object.entries(p.flow[stage])) applyAnswer(raw, key, val);
	// playbook values arrive as strings: normalize the boolean and list keys
	if (typeof raw.mainHook === "string") raw.mainHook = /^(yes|true)$/i.test(raw.mainHook);
	if (typeof raw.mockupGlobs === "string") raw.mockupGlobs = String(raw.mockupGlobs).split(",").map((s) => s.trim()).filter(Boolean);
	// flow keys were mapped to dot paths (commands.x, versioning.y, release.z) — rebuild nested
	const nested: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) applyAnswer(nested, k, v as string);
	const rel = (nested as { release?: { releases?: unknown } }).release;
	if (rel && typeof rel.releases === "string") rel.releases = !/^(no|false)$/i.test(rel.releases);
	mergeInto(c, nested);
	// a flow-guard block is the whole rule set; with none in project.md the DEFAULTS (empty) stand
	if (GUARD_VERBS.some((v) => p.guard[v].length)) c.guard = structuredClone(p.guard);
	// one check per name: an explicit flow-check block wins over the `test =` / `health =` shorthand
	const named = new Set(p.checks.map((x) => x.name));
	c.checkList = [
		...(c.commands.test && !named.has("test") ? [{ name: "test", cmd: c.commands.test }] : []),
		...(c.commands.health && !named.has("health") ? [{ name: "health", cmd: c.commands.health }] : []),
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
	if (typeof r.forge === "string") c.forge = r.forge;
	if (r.bashTimeout === "require" || r.bashTimeout === "inject") c.bashTimeout = r.bashTimeout;
	if (typeof r.commands === "object" && r.commands) Object.assign(c.commands, r.commands);
	if (typeof r.versioning === "object" && r.versioning) Object.assign(c.versioning, r.versioning);
	if (typeof r.release === "object" && r.release) Object.assign(c.release, r.release);
	// playbook values arrive as strings; a junk healthWait must not make the gate wait forever
	const wait = toSeconds(r.healthWait);
	if (wait !== undefined) c.healthWait = wait;
}

/**
 * Insert — or replace in place — one `key = value` line in a stage's flow block. This is the surgical
 * playbook write `flow start --merge=` uses: a full `buildDraft` regeneration is not an option there,
 * because a draft cannot reproduce hand-written prose and checklist items and would drop them. Replacing an
 * existing line keeps an update idempotent (no stacked duplicates), and the caller validates the result with
 * `parseProjectMd` before writing anything.
 */
export function setPlaybookKey(text: string, stage: MdStage, key: string, value: string): { text: string; where: string } | { error: string } {
	const lines = text.split("\n");
	const headOf = (l: string) => l.match(/^##\s+(\S+)\s*$/)?.[1]?.toLowerCase();
	const head = lines.findIndex((l) => headOf(l) === stage);
	if (head === -1) {
		// no section yet: the heading and its flow block go at the end of the file — appending leaves every
		// hand-written line above it exactly where it was
		const tail = `\n## ${stage}\n\n` + "```flow\n" + key + " = " + value + "\n```\n";
		return { text: (text.endsWith("\n") ? text : text + "\n") + tail, where: `## ${stage} — the section was created for it` };
	}
	let end = lines.length;
	for (let i = head + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
	const kv = new RegExp(`^\\s*${key}\\s*=`);
	for (let i = head + 1; i < end; i++) {
		if (!/^```\s*flow\s*$/.test(lines[i])) continue;
		let close = end;
		for (let j = i + 1; j < end; j++) if (lines[j].trim() === "```") { close = j; break; }
		const existing = lines.findIndex((l, j) => j > i && j < close && kv.test(l));
		if (existing !== -1) {
			lines[existing] = `${key} = ${value}`;
			return { text: lines.join("\n"), where: `## ${stage} flow block (replaced the value it held)` };
		}
		lines.splice(i + 1, 0, `${key} = ${value}`);
		return { text: lines.join("\n"), where: `## ${stage} flow block` };
	}
	lines.splice(head + 1, 0, "", "```flow", `${key} = ${value}`, "```");
	return { text: lines.join("\n"), where: `## ${stage} — opened a flow block for it` };
}

/** Set one ` ```flow-check <name>` block under ## implement: replaces the body of an existing block of that
 *  name, else inserts a new block right after the section's last fence (or under the heading). An empty
 *  command removes the block — the operator's "no, we don't lint". */
export function setPlaybookCheck(text: string, name: string, cmd: string): { text: string; where: string } {
	const lines = text.split("\n");
	let head = lines.findIndex((l) => /^##\s+implement\s*$/i.test(l));
	if (head === -1) {
		if (!cmd) return { text, where: `no flow-check ${name} to remove` };
		const tail = `\n## implement\n\n` + "```flow-check " + name + "\n" + cmd + "\n```\n";
		return { text: (text.endsWith("\n") ? text : text + "\n") + tail, where: "## implement — the section was created for it" };
	}
	let end = lines.length;
	for (let i = head + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
	let lastClose = -1;
	for (let i = head + 1; i < end; i++) {
		if (!/^```/.test(lines[i]) || lines[i].trim() === "```") continue;
		let close = end - 1;
		for (let j = i + 1; j < end; j++) if (lines[j].trim() === "```") { close = j; break; }
		if (lines[i].trim() === "```flow-check " + name) {
			if (!cmd) {
				lines.splice(i, close - i + 1 + (lines[close + 1] === "" ? 1 : 0));
				return { text: lines.join("\n"), where: `## implement flow-check ${name} (removed)` };
			}
			lines.splice(i + 1, close - i - 1, cmd);
			return { text: lines.join("\n"), where: `## implement flow-check ${name} (replaced its command)` };
		}
		lastClose = close;
		i = close;
	}
	if (!cmd) return { text, where: `no flow-check ${name} to remove` };
	const at = lastClose === -1 ? head + 1 : lastClose + 1;
	lines.splice(at, 0, "", "```flow-check " + name, cmd, "```");
	return { text: lines.join("\n"), where: `## implement flow-check ${name}` };
}

/** Where each setup answer lives. `check.<name>` is a flow-check block; everything else a flow key. */
const ANSWER_STAGE: Record<string, MdStage> = {
	defaultBranch: "global", forge: "global", worktreeDir: "global", branchPattern: "global", mainHook: "global", mockupGlobs: "global", bashTimeout: "global",
	setup: "implement", test: "implement", build: "implement", run: "implement", seedData: "implement", health: "implement", dev: "implement", healthWait: "implement",
	versionFile: "pre-release", versionTag: "pre-release", changelog: "pre-release", review: "pre-release",
	releases: "release", artifact: "release", preflight: "release", merge: "release",
};
/** The draft's placeholder comment per key (buildDraft) — stale once the key has an answer. */
const DRAFT_HINTS: Record<string, RegExp> = { versionFile: /<!-- versionFile = /, merge: /<!-- merge = /, changelog: /<!-- no changelog found/ };
export const ANSWER_KEYS = [...Object.keys(ANSWER_STAGE), "check.<name>"];

/** Parse `key=value` answer tokens (CLI args, or the lines of an answers file; `#` lines are comments). */
export function parseAnswers(tokens: string[]): { answers: [string, string][]; errors: string[] } {
	const answers: [string, string][] = [];
	const errors: string[] = [];
	for (const raw of tokens) {
		const t = raw.trim();
		if (!t || t.startsWith("#")) continue;
		const m = t.match(/^([\w.-]+)\s*=\s*(.*)$/);
		if (!m) { errors.push(`"${t}" is not key=value`); continue; }
		const [, key, value] = m;
		if (!(key in ANSWER_STAGE) && !/^check\.[\w-]+$/.test(key)) { errors.push(`unknown answer key "${key}" — known: ${ANSWER_KEYS.join(", ")}`); continue; }
		answers.push([key, value.trim()]);
	}
	return { answers, errors };
}

/** Apply setup answers onto a playbook text — each a single targeted insert/replace, so hand-written lines
 *  survive. The section a key is already written under wins (a versionFile under ## release stays there). */
export function applyAnswers(text: string, answers: [string, string][]): { text: string; changes: string[] } {
	let cur = text;
	const changes: string[] = [];
	for (const [key, value] of answers) {
		if (key.startsWith("check.")) {
			const r = setPlaybookCheck(cur, key.slice("check.".length), value);
			cur = r.text;
			changes.push(`${key} → ${r.where}`);
			continue;
		}
		let stage = ANSWER_STAGE[key];
		const parsed = parseProjectMd(cur);
		const holder = MD_STAGES.find((s) => Object.keys(parsed.flow[s]).some((dot) => KEYMAP[s]?.[key] === dot));
		if (holder && holder !== stage && (stage === "pre-release" || stage === "release") && (holder === "pre-release" || holder === "release")) stage = holder;
		const r = setPlaybookKey(cur, stage, key, value);
		if ("error" in r) { changes.push(`${key}: ${r.error}`); continue; }
		cur = r.text;
		// the draft's "not decided yet" hint for this key is now wrong: drop it (and the blank line after it)
		const hint = DRAFT_HINTS[key];
		if (hint) cur = cur.replace(new RegExp(`^${hint.source}.*\\n\\n?`, "m"), "");
		changes.push(`${key} = ${value} → ${r.where}`);
	}
	return { text: cur, changes };
}

/** Minimal line diff (LCS) for showing the operator what a write changes — playbooks are small. */
export function lineDiff(before: string, after: string, context = 1): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const ops: { t: " " | "-" | "+"; l: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) { ops.push({ t: " ", l: a[i] }); i++; j++; }
		else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: "-", l: a[i++] });
		else ops.push({ t: "+", l: b[j++] });
	}
	const keep = ops.map((o, k) => o.t !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== " "));
	const out: string[] = [];
	let gap = false;
	ops.forEach((o, k) => {
		if (keep[k]) { out.push(`${o.t} ${o.l}`); gap = false; }
		else if (!gap) { out.push("  …"); gap = true; }
	});
	return ops.some((o) => o.t !== " ") ? out.join("\n") : "(no changes)";
}

/** Load the project config: project.md is the only source. */
export function loadProject(dfDir: string): { cfg: Config; md: ParsedMd | null } {
	const mdFile = path.join(dfDir, "project.md");
	let mdText: string | null = null;
	try {
		if (existsSync(mdFile)) mdText = readFileSync(mdFile, "utf8");
	} catch {
		mdText = null;
	}
	if (mdText === null) return { cfg: structuredClone(DEFAULTS), md: null };
	const md = parseProjectMd(mdText);
	return { cfg: mdToConfig(md), md };
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
 *  start). Nothing reads them: `flow status`, the guards and the footer all key off state.json.
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
export function doctorFindings(root: string, cfg: Config, md: ParsedMd | null): string[] {
	const f: string[] = [];
	const gi = path.join(root, ".dev-flow", ".gitignore");
	if (existsSync(gi) && !readFileSync(gi, "utf8").includes("!project.md")) f.push(".dev-flow/.gitignore still hides project.md from git — re-run flow init to heal it");
	if (cfg.forge && !["github", "gitlab", "self"].includes(cfg.forge)) f.push(`forge "${cfg.forge}" is invalid — use github, gitlab or self`);
	// the merge policy is the one playbook knob a repo can silently lack: without it nobody can say how a
	// merged branch was supposed to land, and `flow finish` can only ask about what it sees
	if (!cfg.release.merge) f.push("no merge policy — `flow start` asks once and writes it: merge = squash | merge | rebase under ## release (or any = no policy, stop asking)");
	else if (cfg.release.merge !== "any" && cfg.forge === "self") f.push(`merge = ${cfg.release.merge} is not provable on forge = self (no gh/glab to ask how the PR landed) — release-done prints an advisory instead of a proof`);
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
	for (const g of ghostFeatureDirs(root)) f.push(`${g} has a plan/ but no state.json — ghost of a closed, aborted or hand-made feature (flow start <slug> --confirmed adopts it as a new feature; flow init offers to remove it)`);
	return f;
}

/** Compact per-stage digest of project.md content for dialog display (raw md walls are unreadable). */
const DIGEST_STAGES: Record<string, string> = { global: "General", plan: "Planning", implement: "Implement", "pre-release": "Pre-release", release: "Release" };
const DIGEST_CMDS: Record<string, string> = { setup: "setup", test: "test", build: "build", run: "run app", seedData: "seed data", dev: "dev deploy" };
const DIGEST_WORDS: Record<string, string> = { defaultBranch: "default branch", branchPattern: "branch pattern", worktreeDir: "worktree dir", mainHook: "main-branch hook", mockupGlobs: "mockup files", forge: "forge", bashTimeout: "shell-call timeout mode", merge: "merge policy" };

/** Human summary of a playbook for the init confirm: one line per stage, real values and full item/guidance text, nothing truncated. */
export function mdDigest(text: string): string {
	const p = parseProjectMd(text);
	const rows: string[] = [];
	for (const s of MD_STAGES) {
		const label = DIGEST_STAGES[s];
		if (!label) continue;
		// pre-release owns release preparation and renders exactly like release — buildDraft writes the
		// version keys there, so without this the init dialog never showed the version rules at all.
		const relStage = s === "release" || s === "pre-release";
		const bits: string[] = [];
		const keys: Record<string, string> = {};
		for (const [k, v] of Object.entries(p.flow[s] as Record<string, string>)) keys[k.split(".").pop()!] = v; // config dot-paths → display keys
		for (const [k, v] of Object.entries(keys)) {
			if (relStage && ["file", "pattern", "artifact"].includes(k)) continue; // rendered specially below
			bits.push(DIGEST_CMDS[k] ? `${DIGEST_CMDS[k]}: ${JSON.stringify(v)}` : `${DIGEST_WORDS[k] ?? k}: ${v}`);
		}
		if (s === "implement" && p.checks.length) bits.push(`named checks: ${p.checks.map((c) => c.name).join(", ")}`);
		if (s === "global") {
			const rules = (["deny", "confirm", "protect", "forbid"] as const).flatMap((v) => p.guard[v].map((r) => `${v} ${r.pattern}`));
			if (rules.length) bits.push(`safety rules: ${rules.join(" · ")}`);
		}
		if (relStage && keys.file) {
			bits.push(`version in ${keys.file} → tag ${keys.pattern ?? "v{version}"}`);
			bits.push(keys.releases === "false" || keys.releases === "no" ? "forge release: off" : "forge release: created automatically (gh/glab)");
			bits.push(`artifact check: ${keys.artifact ?? "none set"}`);
		}
		if (s === "pre-release" && !keys.file && !p.flow.release["versioning.file"]) bits.push("version: no version file set — releases cannot bump or tag");
		const items = p.checklist[s] ?? [];
		if (items.length) bits.push(`manual check: ${items.map((i) => `${i.uiOnly ? "(UI only) " : ""}${i.versionedOnly ? "(versioned only) " : ""}\"${i.text}\"`).join(" · ")}`);
		if (p.prose[s]) bits.push(`guidance: "${p.prose[s].replace(/\s+/g, " ").trim()}"`);
		if (bits.length) rows.push(`${label} — ${bits.join(" · ")}`);
	}
	return `${rows.join("\n") || "(empty)"}\n\nnothing is executed or uploaded now — gates only run later inside the flow`;
}

/** Draft project.md from detection (first init, --force). Never a regeneration of an existing playbook:
 *  a draft cannot reproduce hand-written prose, checklist items and keys. */
export function buildDraft(det: {
	report: string[];
	partial: { defaultBranch: string; commands: Record<string, string>; versioning?: { file: string }; forge?: string; versionTag?: string; changelog?: string; checks?: Record<string, string>; guards?: string[] };
}): string {
	const cmd = (k: string) => det.partial.commands[k];
	const L: string[] = [];
	L.push("# dev-flow", "", "<!-- Operator-owned playbook. Regenerate with: flow init --draft -->", "");
	L.push("## global", "", "```flow", `defaultBranch = ${det.partial.defaultBranch}`);
	if (det.partial.forge) L.push(`forge = ${det.partial.forge}`); // from the origin URL — confirm or correct
	L.push("```", "");
	// only secrets that exist on disk: a guard on a path the repo does not have guards nothing and reads as noise
	if (det.partial.guards?.length) L.push("```flow-guard", ...det.partial.guards, "```", "");
	L.push("## plan", "", "- [ ] (ui) rendered mockups attached for every changed screen", "", "<!-- what the plan must contain, UI expectations -->", "");
	L.push("## implement", "", "```flow");
	for (const k of ["setup", "test", "build", "run", "seedData", "dev"]) if (cmd(k)) L.push(`${k} = ${cmd(k)}`);
	L.push("```", "");
	for (const [name, c] of Object.entries(det.partial.checks ?? {})) L.push("```flow-check " + name, c, "```", "");
	// never invent a health check: a placeholder that can't pass blocks verify forever (dogfooded: curl localhost:3000 in a library repo)
	if (cmd("health")) L.push("```flow-check health", cmd("health"), "```", "");
	else L.push("<!-- optional tier-1: add a flow-check 'health' block once the app exposes a health endpoint -->", "");
	// (ui): a library or CLI has no screen to give a visual pass — the item would ask on every feature
	L.push("- [ ] (ui) app runs locally with real data; visual pass: no overflows or stray scrollbars", "", "<!-- tier-3: standing guidance for this stage -->", "");
	L.push("## pre-release", "", "<!-- e.g. review policy, docs expectations, who picks the version -->", "");
	// never invent a manifest either: a versionFile naming a file the repo lacks is a doctor finding on day one
	const rel: string[] = [];
	if (det.partial.versioning?.file) rel.push(`versionFile = ${det.partial.versioning.file}`, `versionTag = ${det.partial.versionTag ?? "v{version}"}`);
	if (det.partial.changelog) rel.push(`changelog = ${det.partial.changelog}`);
	if (rel.length) L.push("```flow", ...rel, "```", "");
	if (!det.partial.versioning?.file) L.push("<!-- versionFile = <the file that holds the version> — none was detected; flow init asks -->", "");
	if (det.partial.changelog === "") L.push("<!-- no changelog found: create CHANGELOG.md, or set changelog = (empty) to opt out -->", "");
	// the merge policy is never invented by detection: flow init / flow start ask and write it
	L.push("## release", "", "<!-- merge = squash | merge | rebase — how a merged PR lands on the default branch (`any` = no policy). flow start also asks and writes it. -->", "");
	L.push("<!-- e.g. tag policy, who publishes artifacts -->", "");
	return L.join("\n") + "\n";
}
