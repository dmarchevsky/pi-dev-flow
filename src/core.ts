/**
 * dev-flow core: config, flow state, stage gates and guard decisions.
 *
 * Pure(ish) logic only — no pi imports here so it is unit-testable with
 * `node --test`. The extension in extensions/dev-flow.ts is thin wiring.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export type Stage = "plan" | "implement" | "pre-release" | "release" | "done";
export const STAGES: Stage[] = ["plan", "implement", "pre-release", "release", "done"];

export interface Check {
	ok: boolean;
	at: string;
	note?: string;
}

export interface StageCheck {
	name: string;
	cmd: string;
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
	confirmations?: Record<string, { hash: string; at: string }>;
	patch?: boolean; // chore release: no plan document, all gates intact
	docs?: boolean; // docs-only release: no plan document, no tier-1 checks; worktree discipline and the full release stay
	flowVersion?: string; // dev-flow build that started the feature (stamped at start, shown by status)
	noVersion?: boolean; // operator chose: this flow releases without a version bump or tag
	yolo?: boolean; // operator said "yolo" at approve: every later gate question pre-confirmed; checks and guardrails stay
	setupAt?: string; // commands.setup exited 0 in this worktree — a reused worktree reruns it only when unset (#49)
	releaseVersion?: string; // the manifest version the release gate approved — release-done publishes this, not whatever a checkout says later (#52)
	forgeReleaseSkipped?: string; // a gh/glab release create that failed: release-done says so, finish names it so the missing forge release cannot slip past (#63)
}

/** Tier-2 item: operator prose; uiOnly items ("(ui)" in project.md) apply only to --ui features. */
export interface ChecklistItem {
	text: string;
	uiOnly: boolean;
}

export interface Commands {
	setup?: string;
	test?: string;
	build?: string;
	seedData?: string;
	/** Must exit 0 only when the app is up locally AND its data looks real. */
	health?: string;
	run?: string;
	/** Deploy to a dev/staging environment before verification — operator reviews the running dev app. */
	dev?: string;
}

export interface Versioning {
	/** Repo-relative manifest holding the version: VERSION | package.json | Cargo.toml | pyproject.toml. */
	file?: string;
	/** Tag template; {version} substituted from the manifest. */
	pattern: string;
}

export interface Config {
	defaultBranch: string;
	branchPattern: string; // {slug} substituted
	worktreeDir: string; // {slug} substituted, relative to repo root
	mockupGlobs: string[]; // suffix globs required in plan/ when ui (default: rendered screenshots)
	/** Forge the release machinery targets: github (gh), gitlab (glab), self (forge-neutral).
	 *  "" = unset → detected from the origin URL at the moment of use. */
	forge: string;
	commands: Commands;
	checkList: StageCheck[]; // tier-1 executable checks (project.md flow blocks)
	checklist: Record<string, ChecklistItem[]>; // tier-2 operator items per stage
	prose: Record<string, string>; // tier-3 guidance per stage
	versioning: Versioning;
	/** Seconds the post-deploy health probe may keep retrying before the gate gives up (0 = single shot). */
	healthWait: number;
	release: { review: string; changelog?: string; tagPattern?: string; releases?: boolean; artifact?: string };
	mainHook: boolean; // flow init installs a pre-commit hook blocking main commits
	/** Operator safety rules from the project.md flow-guard block — stage-independent. */
	guard: GuardRules;
}

export const DEFAULTS: Config = {
	defaultBranch: "main",
	branchPattern: "feat/{slug}",
	worktreeDir: ".dev-flow/{slug}/worktree",
	mockupGlobs: ["*.png"],
	forge: "",
	commands: {},
	checkList: [],
	checklist: {},
	prose: {},
	versioning: { pattern: "v{version}" },
	healthWait: 30,
	release: { review: "/ponytail-review", releases: true },
	mainHook: true,
	guard: { deny: [], confirm: [], protect: [], forbid: [] },
};

/** Build a Config from DEFAULTS + a partial overrides object (tests, drafts — the persisted
 *  source is project.md alone; the legacy project.json loader is gone). */
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
	// tier-1 checks from plain commands so legacy project.json keeps the same teeth as project.md
	c.checkList = [
		...(c.commands.test ? [{ name: "test", cmd: c.commands.test }] : []),
		...(c.commands.health ? [{ name: "health", cmd: c.commands.health }] : []),
	];
	return c;
}

/** The project's own "running and healthy" probe — `commands.health` or a flow-check block named
 *  health. The plugin runs it, the project says what healthy means (readiness, served build stamp). */
export function healthProbe(c: Config): string | undefined {
	return c.checkList.find((x) => x.name === "health")?.cmd;
}

/** A playbook number of seconds, or undefined when it is not a usable non-negative number. */
export function toSeconds(raw: unknown): number | undefined {
	const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Retry schedule for the health probe (#42): a service whose readiness lags its container start can
 * never pass a single shot, so the gate waits instead of failing the deploy. One immediate attempt
 * plus one retry per interval, spanning `waitSeconds`; 0 keeps the old single-shot behaviour.
 */
export function healthRetry(waitSeconds: number, intervalSeconds = 2): { attempts: number; delayMs: number } {
	const wait = toSeconds(waitSeconds) ?? 0;
	const interval = toSeconds(intervalSeconds) ?? 2;
	return { attempts: 1 + Math.ceil(wait / interval), delayMs: interval * 1000 };
}

export function subst(pattern: string, slug: string): string {
	return pattern.replaceAll("{slug}", slug);
}

export function validSlug(slug: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

export function newState(slug: string, ui: boolean, patch = false, docs = false, flowVersion?: string): FlowState {
	return { slug, stage: "plan", ui, branch: "", worktree: "", createdAt: new Date().toISOString(), approvals: {}, checks: {}, ...(patch ? { patch: true } : {}), ...(docs ? { docs: true } : {}), ...(flowVersion ? { flowVersion } : {}) };
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
	if (!state.patch && !state.docs && !planFiles.some((f) => f.endsWith(".md"))) errs.push("plan/ must contain the written plan (*.md)");
	if (state.ui && !planFiles.some((f) => matchesGlob(f, cfg.mockupGlobs)))
		errs.push(`UI feature: plan/mockups/ must contain rendered screenshots matching ${cfg.mockupGlobs.join(", ")} (headless chromium, embedded in plan.md)`);
	return errs;
}

/** Gate: implement → release. Tier 1: every parsed check green; tier 2: checklist confirmed. */
export function verifyGate(state: FlowState, cfg: Config): string[] {
	const errs: string[] = [];
	if (state.stage !== "implement") errs.push(`stage is "${state.stage}", verify only applies to "implement"`);
	if (!state.docs) for (const c of cfg.checkList) if (!state.checks[c.name]?.ok) errs.push(`check "${c.name}" has not passed — run flow check`);
	const pend = checklistPending(cfg, state, "implement");
	if (pend) errs.push(`tier-2 checklist not confirmed (${pend} item(s)) — run flow verify after ticking them off`);
	return errs;
}

export interface ReleasePrep {
	/** Version parsed from the manifest (versioning.file), null when unset/unparsable. */
	manifestVersion: string | null;
	/** Tag names as the forge sees them (origin when the repo has one) — not what one clone happens to have fetched (#52). */
	remoteTags: string[];
	/** Changelog file + content when release.changelog names a file that exists, else null. */
	changelog: { file: string; content: string } | null;
}

/**
 * Gate: pre-release → release ("Release?"). Machine-proves the parts of release prep that can be
 * proven — checks re-greened after the prep edits, manifest bumped past the last tag, changelog
 * mentions the version. Review/docs quality stays tier-2 (operator confirms the checklist).
 */
export function preReleaseGate(state: FlowState, cfg: Config, prep: ReleasePrep): string[] {
	const errs: string[] = [];
	if (state.stage !== "pre-release") errs.push(`stage is "${state.stage}", the release gate only applies to "pre-release"`);
	if (!state.docs) for (const c of cfg.checkList) if (!state.checks[c.name]?.ok) errs.push(`check "${c.name}" has not passed — run flow check`);
	const pend = checklistPending(cfg, state, "pre-release");
	if (pend) errs.push(`tier-2 checklist not confirmed (${pend} item(s)) — run flow release after ticking them off`);
	// unversioned flow (operator granted --no-version): the release publishes as-is — no bump, changelog-entry or tag requirement
	if (!state.noVersion) {
		if (cfg.versioning.file) {
			if (!prep.manifestVersion) errs.push(`versioning.file "${cfg.versioning.file}" has no parsable version — bump it to the version you will release`);
			else if (prep.remoteTags.includes(cfg.versioning.pattern.replace("{version}", prep.manifestVersion)))
				errs.push(`version ${prep.manifestVersion} is already tagged — bump the manifest to the next version`);
		}
		if (cfg.release.changelog) {
			if (!prep.changelog) errs.push(`release.changelog "${cfg.release.changelog}" does not exist — prepare the changelog`);
			else if (prep.manifestVersion && !prep.changelog.content.includes(prep.manifestVersion))
				errs.push(`${prep.changelog.file} does not mention version ${prep.manifestVersion} — add its entry before releasing`);
		}
	}
	return errs;
}

export function checklistHash(items: ChecklistItem[]): string {
	return createHash("sha1")
		.update(items.map((i) => `${i.uiOnly ? "(ui) " : ""}${i.text}`).join("\n"))
		.digest("hex")
		.slice(0, 12);
}

/** Items that apply to this feature — "(ui)" items only when the UI flag is set. */
export function applicableItems(cfg: Config, state: FlowState, stage: string): ChecklistItem[] {
	return (cfg.checklist[stage] ?? []).filter((i) => !i.uiOnly || state.ui);
}

/** Items exist for the stage and current confirmation does not match their hash; returns pending count or 0. */
export function checklistPending(cfg: Config, state: FlowState, stage: string): number {
	const items = applicableItems(cfg, state, stage);
	if (!items.length) return 0;
	return state.confirmations?.[stage]?.hash === checklistHash(items) ? 0 : items.length;
}

/** Read the version out of a manifest file's content; null when unparseable. */
export function parseVersion(file: string, content: string): string | null {
	if (file.endsWith("VERSION")) return content.trim() || null;
	if (file.endsWith("package.json")) {
		try {
			const v = (JSON.parse(content) as { version?: string }).version;
			return typeof v === "string" && v ? v : null;
		} catch {
			return null;
		}
	}
	// Cargo.toml / pyproject.toml style: version = "x.y.z"
	return content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/**
 * dev-flow's own version, for `flow version`: the nearest package.json above `fromDir` (the
 * extension's module directory) whose name is `pkgName`. Walking up instead of a fixed `../`
 * keeps it right for this checkout, an installed pi package and a copy loaded from elsewhere.
 * `dir` is the manifest's directory when found, else `fromDir` — the place to name in the error.
 */
export function pluginVersion(fromDir: string, pkgName = "pi-dev-flow"): { version: string | null; dir: string; repo: string } {
	for (let dir = path.resolve(fromDir); ; ) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown; repository?: unknown };
			if (pkg.name === pkgName) {
				const repository = typeof pkg.repository === "string" ? pkg.repository : typeof (pkg.repository as { url?: unknown })?.url === "string" ? (pkg.repository as { url: string }).url : "";
				return { version: typeof pkg.version === "string" && pkg.version ? pkg.version : null, dir, repo: githubSlug(repository) };
			}
		} catch {
			/* missing, unreadable or not JSON: keep walking up */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return { version: null, dir: fromDir, repo: "" };
		dir = parent;
	}
}

/** A session keeps the code it loaded at start, while the manifest on disk moves past it after a release.
 * `flow version` read the manifest, so a stale session reported the new number while running the old gate code —
 * and shipped the previous session's broken release-notes path twice. Returns the loaded version when the session
 * runs behind the checkout, "" when it is current or either side is unknown. */
export function sessionRunsOlderBuild(loaded: string | null, disk: string | null): string {
	return loaded && disk && loaded !== disk ? loaded : "";
}

/** Owner/slug from any GitHub repo reference — "owner/repo", "github.com/owner/repo", git+https or scp-style git@github.com:owner/repo.git; "" when it is not GitHub. */
export function githubSlug(ref: string): string {
	const m = ref.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/) ?? /^[\w.-]+\/[\w.-]+$/.exec(ref);
	return m ? m[1].replace(/\.git$/, "") : "";
}

/** Gate: the tag derived from the manifest version must exist among local tags. */
export function versionTagGate(manifestVersion: string | null, tagPattern: string, tags: string[]): string[] {
	if (!manifestVersion) return ["versioning.file is set but its version could not be parsed — fix versioning config"];
	const expected = tagPattern.replace("{version}", manifestVersion);
	if (tags.includes(expected)) return [];
	return [`expected release tag "${expected}" (from manifest version ${manifestVersion}) not found; recent tags: ${tags.slice(0, 5).join(", ") || "none"}`];
}

/** Gate: release-done records the release; `flow finish` then closes the feature. */
export function releaseGate(state: FlowState): string[] {
	const errs: string[] = [];
	if (state.stage !== "release") errs.push(`stage is "${state.stage}", release-done only applies to "release"`);
	if (!state.approvals.verify) errs.push("operator verify approval is missing");
	return errs;
}

/**
 * Version comparison for release guards: dot-separated numeric segments, a missing or non-numeric
 * segment counts as 0 (`1.2` == `1.2.0`, `1.2.3-rc1` compares as `1.2.0`). Negative when `a` is older.
 */
export function cmpVersions(a: string, b: string): number {
	const seg = (v: string, i: number) => Number(v.split(".")[i]) || 0;
	const parts = Math.max(a.split(".").length, b.split(".").length);
	for (let i = 0; i < parts; i++) {
		if (seg(a, i) !== seg(b, i)) return seg(a, i) - seg(b, i);
	}
	return 0;
}

/** Tag names from `git ls-remote --tags` output: refs peeled with `^{}` collapse into their tag. */
export function parseLsRemoteTags(out: string): string[] {
	return [...new Set(out.split("\n").map((l) => (l.split("\t")[1] ?? "").trim().replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "")).filter(Boolean))];
}

/** Newest version among tags matching the release pattern; null when none does (#52). */
export function newestTaggedVersion(pattern: string, tags: string[]): string | null {
	const parts = pattern.split("{version}");
	if (parts.length !== 2) return null;
	const re = new RegExp("^" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+)") + "$");
	let best: string | null = null;
	for (const t of tags) {
		const m = t.match(re);
		if (m && (best === null || cmpVersions(m[1], best) > 0)) best = m[1];
	}
	return best;
}

/** The command that prints a tag's annotation. The format must be quoted for /bin/sh: an unquoted
 *  `%(contents)` is a syntax error, and `sh()` folds stderr into its output, so the error text
 *  landed in release bodies as if it were the notes (#51). */
/** POSIX shell literal: embeds arbitrary text as one argument — the JSON-style quoting a template string suggests is not shell quoting (backticks and $() inside it still execute, #51 fallout). */
export function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function tagNotesCommand(tag: string): string {
	return `git tag -l --format='%(contents)' ${sq(tag)}`;
}

/** Is this "release body" actually a shell complaint? The #51 shape is
 *  `/bin/sh: 1: Syntax error: "(" unexpected`. Deliberately narrow: a changelog line that merely
 *  mentions a syntax error is a real body and must not be dropped. */
export function looksLikeShellError(text: string): boolean {
	return /Syntax error:|\bsh: ?\d+:/.test(text);
}

/** A changelog entry by version: the section whose heading names the version, up to the next heading
 *  of the same or a higher level. "" when no heading mentions it — used as a deterministic release
 *  body when the tag carries no annotation (#51). */
export function changelogEntry(content: string, version: string): string {
	const lines = content.split("\n");
	const level = (l: string) => (l.match(/^#+/)?.[0].length ?? 99);
	const i = lines.findIndex((l) => level(l) <= 3 && l.includes(version));
	if (i === -1) return "";
	const base = level(lines[i]);
	const out: string[] = [];
	for (const l of lines.slice(i + 1)) {
		if (level(l) <= base) break;
		out.push(l);
	}
	return out.join("\n").trim();
}

/**
 * Cleanup safety for `flow finish`. Returns { errors, unmerged }: errors hard-block;
 * unmerged is a warning list the operator can confirm through (e.g. squash merges).
 */
export function cleanupAssess(porcelain: string, unmerged: string[]): { errors: string[]; unmerged: string[] } {
	const errors: string[] = [];
	if (porcelain.trim()) errors.push("worktree has uncommitted changes — commit or discard them first");
	return { errors, unmerged: unmerged.filter(Boolean) };
}

export interface GuardCtx {
	command: string;
	branch: string; // branch of the directory the git commands run in (feature worktree or main checkout)
	stage: Stage | null; // active feature stage, null when no active feature
	defaultBranch: string;
	pushRefs?: PushRef[]; // caller-resolved push targets (bare names disambiguated tag vs branch); omit = guard parses raw command
	playbookChore?: boolean; // the only change in this checkout is the playbook — tracking it is setup, not feature work (#53)
}

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, "$2");

/** git usage in a bash command, parsed per shell segment (split on ; | & newline):
 *  the git subcommands invoked — empty when git is not a command, so paths like
 *  .git/hooks or words like pre-commit never trigger the guard — and the directory
 *  git runs in (last preceding `cd` target or `git -C` target; null = session cwd).
 *  shortcut: naive segment split, subshells/backticks not tracked; the pre-commit
 *  hook still covers what slips past this advisory guard. */
export function gitInvocation(command: string): { subs: string[]; dir: string | null; pushes: string[][]; gitSegs: { seg: string; dir: string | null }[] } {
	const subs: string[] = [];
	const pushes: string[][] = [];
	const gitSegs: { seg: string; dir: string | null }[] = [];
	let dir: string | null = null;
	// global git options that consume a following value
	const OPT_VAL = new Set(["-c", "-C", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--super-prefix"]);
	for (const seg of bashSegments(command)) {
		const tok = seg.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < tok.length && /^[\w.]+=/.test(tok[i])) i++; // leading ENV=val prefixes
		if (tok[i] === "sudo") i++;
		if (tok[i] === "cd" && tok[i + 1]) {
			dir = unquote(tok[i + 1]);
			continue;
		}
		if (REEXEC_HEADS.has(tok[i] ?? "")) {
			// a wrapper that execs its argument: every git verb in the payload is still that verb (sh -c "git add . && git commit -m x")
			let wrapped = false;
			for (const m of seg.matchAll(/\bgit\s+([\w-]+)/g)) {
				subs.push(m[1]);
				if (m[1] === "push") pushes.push(seg.slice((m.index ?? 0) + m[0].length).replace(/["']/g, "").split(/[\s&]+/).filter((x) => x && !x.startsWith("-")));
				wrapped = true;
			}
			if (wrapped) gitSegs.push({ seg: seg.trim(), dir });
			continue;
		}
		if (!/(^|\/)git$/.test(tok[i] ?? "")) continue; // git must be the command (git, /usr/bin/git)
		for (i++; i < tok.length; i++) {
			const t = tok[i];
			if (!t.startsWith("-")) {
				subs.push(t);
				if (t === "push") pushes.push(tok.slice(i + 1).filter((x) => x !== "&&"));
				break;
			}
			const eq = t.indexOf("=");
			const name = eq === -1 ? t : t.slice(0, eq);
			if (name === "-C") {
				dir = eq === -1 ? unquote(tok[++i] ?? "") : unquote(t.slice(eq + 1));
				continue;
			}
			if (OPT_VAL.has(name) && eq === -1) i++;
		}
		gitSegs.push({ seg: seg.trim(), dir }); // after -C parsing so the entry carries its own effective dir
	}
	return { subs, dir, pushes, gitSegs };
}

export type PushRef = { kind: "tag" | "branch" | "current"; name: string };

/** Refspecs of each `git push` (from gitInvocation.pushes): what ref does each push actually write?
 *  bare names come back "branch" (conservative) — the caller resolves tags via git. */
export function parsePushRefs(pushes: string[][]): PushRef[] {
	const out: PushRef[] = [];
	for (const toks of pushes) {
		if (toks.includes("--mirror")) {
			out.push({ kind: "branch", name: "*" }); // mirror rewrites every branch, assume the worst
			continue;
		}
		if (toks.includes("--tags")) {
			out.push({ kind: "tag", name: "*" });
			continue;
		}
		const bare = toks.filter((t) => !t.startsWith("-")).map(unquote);
		const specs = bare.slice(1); // first bare token is the remote
		if (!specs.length) {
			out.push({ kind: "current", name: "" });
			continue;
		}
		for (const s of specs) {
			const [src, dest] = s.split(":");
			// 'src:' deletes remote src → judge src; ':dest' pushes local dest; otherwise dest is what lands remotely
			const target = dest === undefined ? src : dest || src;
			if (target === "HEAD") {
				out.push({ kind: "current", name: "" });
				continue;
			}
			const kind = target.startsWith("refs/tags/") ? "tag" : "branch";
			out.push({ kind, name: target.replace(/^refs\/(heads|tags)\//, "") });
		}
	}
	return out;
}

/** True when a bash command looks like a direct write to flow state. */
export function stateTamper(command: string): boolean {
	// shortcut: verb-before-path order assumed; a state.json mention + any write verb blocks.
	return /\.dev-flow\/\S*state\.json/.test(command) && /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\btruncate\b|\bdd\b|python|-e|node\s)/.test(command);
}

const WRITE_VERBS = /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\btruncate\b|\bdd\b|python|node\s)/;
const PLAYBOOK_PATH = /\.dev-flow\/[\w./-]*project\.md/;
const REDIRECT_INTO_PLAYBOOK = />>?\s*['"]?\.dev-flow\/[\w./-]*project\.md/;
/** copy/replace verbs whose last positional token is the destination */
const MOVE_VERBS = new Set(["cp", "mv", "install", "tee", "dd"]);

/** True when a bash command writes the playbook (project.md) — the sanctioned channels are
 *  `flow init --write` (runs in-plugin, never matches) and edits inside a docs/patch flow's worktree.
 *  Decided per segment and by target, not by any verb anywhere: reading the playbook or copying it to
 *  a backup is safety, and blocking it cost the operator their only backup before a write (#53). */
export function playbookTamper(command: string): boolean {
	return bashSegments(command).some((raw) => {
		if (!PLAYBOOK_PATH.test(raw)) return false;
		if (REDIRECT_INTO_PLAYBOOK.test(raw)) return true; // a redirect whose target is the playbook (quotes allowed)
		const tok = raw.split(/\s+/).filter(Boolean);
		const head = segHead(raw);
		if (MOVE_VERBS.has(head)) return PLAYBOOK_PATH.test(unquote(tok[tok.length - 1] ?? "")); // the destination is last: cp SRC PLAYBOOK
		if (READ_ONLY_HEADS.has(head) || (head === "sed" && !/\s-i\b/.test(raw))) return false; // cat/grep/ls and sed-as-a-printer read it
		// what is left is the loose fallback — a write tool named in the clear. A wrapper's payload counts; everyone
		// else's quoted text is prose, and prose about `cp`/`sed` is not a write (it refused a PR body describing #53).
		return WRITE_VERBS.test(REEXEC_HEADS.has(head) ? raw : maskQuoted(raw));
	});
}

/** The playbook-tracking chore (#53): the playbook is the only change in the checkout, so whatever
 *  the commit says it can only contain that file — setup, not feature work, legal on the default
 *  branch with no flow bound. Any other dirty path refuses the lane, so there is nothing to widen
 *  and no command parsing to fool. shortcut: a guard rail against accidents, not a sandbox. */
export function playbookOnlyChange(porcelain: string): boolean {
	const paths = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
	return paths.length === 1 && PLAYBOOK_PATH.test(paths[0]);
}

/** Forge from an origin URL: github.com / github enterprise hosts → github, any gitlab host → gitlab. */
export function detectForge(remoteUrl: string): string {
	return /github/i.test(remoteUrl) ? "github" : /gitlab/i.test(remoteUrl) ? "gitlab" : "self";
}

/** Guard: decide whether a git bash command violates the flow. Returns a reason or null.
 *  Call per git segment (gitInvocation().gitSegs) with that segment's own branch — a chain may span directories. */
export function bashFlowGuard(o: GuardCtx): string | null {
	const c = o.command;
	const { subs } = gitInvocation(c);
	if (!subs.length) return null;
	const onMain = o.branch === o.defaultBranch;
	const git = (word: string) => subs.includes(word);

	// release chores commit in the main checkout — same stage exception as push/merge below; the playbook
	// tracking chore is the other legal main commit: its only content is the operator's own playbook (#53).
	// --amend is not a chore: it rewrites the default branch's history.
	const playbookCommit = o.playbookChore && !c.includes("--amend");
	if (git("commit") && onMain && o.stage !== "release" && !playbookCommit) return `direct commits to ${o.defaultBranch} are forbidden — work in the feature worktree (tracking the playbook is legal: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit)`;
	if (git("push")) {
		// ref-aware: only pushes that WRITE the default branch need stage release — tags and other branches pass.
		// unresolved bare names arrive pre-resolved by the caller (tag vs branch); no parse info → conservative onMain.
		const refs = o.pushRefs ?? parsePushRefs(gitInvocation(c).pushes);
		const writesDefault = refs.some((r) => (r.kind === "branch" && (r.name === o.defaultBranch || r.name === "*")) || (r.kind === "current" && onMain));
		if (writesDefault && o.stage !== "release") return `pushing to ${o.defaultBranch} requires stage "release" (verified feature)`;
	}
	if (git("merge") && onMain && o.stage !== "release") return `merging into ${o.defaultBranch} requires stage "release"`;
	return null;
}

// ------------------------------------------------------- project safety rules

/** One flow-guard rule: `pattern` is a JS regex source (deny/confirm) or a repo-relative path (protect/forbid). */
export interface GuardRule {
	pattern: string;
	why: string;
}

export interface GuardRules {
	deny: GuardRule[];
	confirm: GuardRule[];
	protect: GuardRule[];
	forbid: GuardRule[];
}

/** project.json may spell a rule as a bare pattern string. */
function normalizeGuardRules(raw: unknown[]): GuardRule[] {
	const out: GuardRule[] = [];
	for (const e of raw) {
		if (typeof e === "string" && e.trim()) out.push({ pattern: e, why: "" });
		else if (e && typeof e === "object") {
			const o = e as Record<string, unknown>;
			if (typeof o.pattern === "string" && o.pattern.trim()) out.push({ pattern: o.pattern, why: typeof o.why === "string" ? o.why : "" });
		}
	}
	return out;
}

/** Heads that execute their argument: inside these, quoted text is code, not prose. */
export const REEXEC_HEADS = new Set(["sh", "bash", "zsh", "dash", "ksh", "node", "nodejs", "python", "python2", "python3", "perl", "ruby", "php", "env", "xargs", "sudo", "time", "nice", "nohup", "watch"]);

/** The first command word of a segment (a leading ./ ignored). */
export const segHead = (seg: string): string => (seg.trim().split(/\s+/)[0] ?? "").replace(/^\.\//, "");

/** Quoted argument contents are what a command says, not what it does — collapse them to empty. */
export function maskQuoted(seg: string): string {
	return seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

function quotesBalanced(command: string): boolean {
	let q: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "\\" && q !== "'") { i++; continue; }
		if (q === null) { if (c === '"' || c === "'") q = c; }
		else if (c === q) q = null;
	}
	return q === null;
}

/** Split on shell separators — but only outside quotes. Text inside quotes is an argument's prose, not a
 * command: a gh --body that discusses a commit is one segment, not five. Unbalanced quoting keeps the plain
 * split, so a stray quote cannot be used to hide a real command. The same split the git guard uses, so
 * `cd … &&`, `;`, pipes and `&` each judge on their own. */
export function bashSegments(command: string): string[] {
	if (!quotesBalanced(command)) return command.split(/[\n;|&]+/).map((s) => s.trim()).filter(Boolean);
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const esc = i > 0 && command[i - 1] === "\\" && q !== "'";
		if (!esc && (c === '"' || c === "'")) q = q === null ? c : q === c ? null : q;
		if (q === null && /[\n;|&]/.test(c)) {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** Heads whose arguments are data, not commands: a `grep "git push origin main"` in a docs search must not trip a deny rule. */
const READ_ONLY_HEADS = new Set(["grep", "rg", "cat", "bat", "head", "tail", "less", "awk", "jq", "find", "fd", "ls", "tree", "wc", "sort", "uniq", "column", "cut", "diff", "cmp", "stat", "file", "du", "echo", "printf", "which", "man"]);
/** `sed` is deliberately absent — `sed -i` writes. */
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "cat-file", "ls-files", "rev-parse"]);
const GIT_INVOKED = /(^|[\s/;|&(])git\s+(\S+)/;

// project.md is re-parsed on every tool call; compiled rules are cached by source.
const regexCache = new Map<string, RegExp | null>();
function compile(source: string): RegExp | null {
	if (!regexCache.has(source)) {
		try {
			regexCache.set(source, new RegExp(source));
		} catch {
			regexCache.set(source, null); // unreachable through project.md (parse validates); project.json is not
		}
	}
	return regexCache.get(source)!;
}

/** Why this bash segment must never run (deny), or needs an explicit operator OK (confirm).
 *  Segments are judged one at a time — rule regexes are written with a no-newline character class,
 *  so an `&&` chain cannot let one segment's text drag a rule across from the next. */
export function guardBash(command: string, g: GuardRules): { block: string | null; confirms: GuardRule[] } {
	const segs = bashSegments(command);
	const confirms: GuardRule[] = [];
	const skip = (seg: string): boolean => {
		if (/[<>]/.test(seg)) return false; // a redirect makes even a read-only head a write
		const head = seg.split(/\s+/)[0].replace(/^\.\//, "");
		if (READ_ONLY_HEADS.has(head)) return true;
		const gm = seg.match(GIT_INVOKED);
		return !!gm && READ_ONLY_GIT.has(gm[2]);
	};
	for (const seg of segs) {
		if (skip(seg)) continue;
		for (const r of g.deny) if (compile(r.pattern)?.test(seg)) return { block: `project rule: ${r.why || `denied pattern ${r.pattern}`}`, confirms };
		for (const r of g.confirm) if (compile(r.pattern)?.test(seg) && !confirms.includes(r)) confirms.push(r);
	}
	return { block: null, confirms };
}

/** realpath the deepest existing ancestor and walk back down, so a rule on a directory covers
 *  `docker/secrets/new-key` on a host where that directory does not exist yet. */
function realAbs(abs: string): string {
	const missing: string[] = [];
	let cur = abs;
	while (!existsSync(cur)) {
		missing.unshift(path.basename(cur));
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	let real = realpathSync(cur);
	for (const seg of missing) real = path.join(real, seg);
	return real;
}

/** Protect/forbid verdict for an edit/write target: a rule on a directory covers its subtree, and
 *  comparing realpaths means `../` cannot reach out of the root. */
export function guardPath(abs: string, root: string, g: GuardRules): { block: string | null; confirm: string | null } {
	const real = realAbs(path.resolve(abs)); // resolve collapses lexical `..` so an escape cannot dodge the rule
	const hit = (rule: GuardRule): boolean => {
		const target = realAbs(path.resolve(root, rule.pattern));
		return real === target || real.startsWith(target + path.sep);
	};
	const forbid = g.forbid.find(hit);
	if (forbid) return { block: `project rule: ${forbid.why || `forbidden path ${forbid.pattern}`}`, confirm: null };
	const protect = g.protect.find(hit);
	return { block: null, confirm: protect ? protect.why || `protected path ${protect.pattern}` : null };
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
 * the session must bind first (`flow use`). Flow-by-default: a session with no flow may not
 * touch the checkout at all — a bound feature is the only way in.
 * Returns a reason or null (allowed).
 */
export function writeGuard(o: { abs: string; dfDir: string; features: FeatureRef[]; boundSlug: string | null }): string | null {
	if (o.abs === path.join(o.dfDir, "project.json")) return ".dev-flow/project.json is legacy — it is no longer read; fold its values into project.md and delete it";
	if (o.abs === path.join(o.dfDir, "project.md")) return "project.md is the operator playbook — change it with flow init --write (setup) or inside a docs/patch flow's worktree";
	if (o.abs.endsWith("state.json") && o.abs.includes(o.dfDir + path.sep)) return "state.json is dev-flow-owned — advance stages with the flow tool only";
	// Owner attribution BEFORE the .dev-flow allow: with the default worktreeDir inside .dev-flow,
	// a worktree must still be judged by its owning feature's stage, not treated as free plan space.
	const owner = o.features.find((f) => within(o.abs, f.worktreeAbs));
	if (owner) {
		if (owner.state.stage === "plan") return `feature ${owner.state.slug} is in plan — code is read-only until its plan is approved`;
		if (owner.state.stage === "done") return `feature ${owner.state.slug} is done`;
		// the playbook copy inside a worktree: only operator-granted lightweight modes may change it
		if (path.basename(o.abs) === "project.md" && o.abs.includes(path.join(".dev-flow", "project.md")) && !owner.state.docs && !owner.state.patch)
			return `project.md changes belong to a docs or patch flow — ${owner.state.slug} is a normal feature (flow start <slug> --docs --confirmed)`;
		return null; // implement/pre-release/release: own worktree is the working area
	}
	if (within(o.abs, o.dfDir)) return null;
	if (o.boundSlug) {
		const bound = o.features.find((f) => f.state.slug === o.boundSlug);
		if (bound) {
			if (bound.state.stage === "implement" || bound.state.stage === "pre-release")
				return `bound feature ${o.boundSlug} is at ${bound.state.stage} — edit its worktree (${bound.state.worktree}), not the main checkout`;
			if (bound.state.stage === "plan") return `bound feature ${o.boundSlug} is in plan — code is read-only until approved`;
			return null; // release: release chores may touch the main checkout
		}
	}
	if (!o.features.length) return "no active flow — every request goes through flow: flow start <slug> for new work, flow use <slug> for an unfinished feature";
	return `unfinished features: ${o.features.map((f) => f.state.slug).join(", ")} — bind this session with flow use <slug> (or pass an explicit slug to gates)`;
}

/** Branch targeted by a `git checkout`/`git switch` in the command, or null. */
export function checkoutTarget(command: string): string | null {
	const m = command.match(/\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\s+(?:-[bBc]\s+)?([^\s;|&]+)/);
	return m ? m[1] : null;
}

/** Prefix feature branches match: branchPattern up to `{slug}` — used to keep feature branches out of the main checkout. */
export function featureBranchPrefix(cfg: Config): string {
	return cfg.branchPattern.split("{")[0];
}

/** Content of .dev-flow/<slug>/claim.json: which session is working the feature. */
export interface SessionClaim {
	key: string;
	pid: number;
	at: string;
}

/** Whether a process is running (kill 0 only probes existence; EPERM means it exists, foreign-owned). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** True only when another live session holds the claim — that blocks silently auto-binding onto its feature. */
export function claimBlocks(claim: SessionClaim | null, myKey: string, alive: (pid: number) => boolean = pidAlive): boolean {
	return !!claim && claim.key !== myKey && alive(claim.pid);
}

/** Footer glyph per stage: the footer has no room for stage words and no legend of its own (README:Status bar is the legend). */
export const STAGE_EMOJI: Record<Stage, string> = { plan: "📝", implement: "🔨", "pre-release": "🔍", release: "🚀", done: "🏁" };

export function statusCompact(state: FlowState): { text: string; failed: boolean } {
	const failed = Object.values(state.checks).some((c) => !c.ok);
	return { text: `${STAGE_EMOJI[state.stage]} ${state.slug}${state.patch ? " ⚡" : state.docs ? " 📚" : ""}${state.yolo ? " 🎱" : ""}`, failed };
}

/** `- [ ]` checklist items of a markdown document (reflections.md and roadmap.md share the format). */
export function openChecklistItems(text: string): string[] {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- [ ] "));
}

/** Open (unchecked) reflection items in reflections.md content — the agent's suggestion queue. */
export function openReflections(text: string): string[] {
	return openChecklistItems(text);
}

export const REFLECT_HEADER =
	"# dev-flow reflections\n\n<!-- Suggestions queued by the agent; the operator decides. Fold playbook items in via flow init --write, file plugin items as issues; check off when handled. -->\n";

/** The two reflections.md sections, in document order. */
export const REFLECT_SECTIONS = ["playbook", "plugin"] as const;
export type ReflectSection = (typeof REFLECT_SECTIONS)[number];

// keyword sets decide the section: plugin = dev-flow's own behaviour, playbook = this project's
const PLUGIN_HINT = /\b(plugin|extension|dev-flow|gate|guard|tool|session|compact\w*|hook|status bar)\b/i;
const PLAYBOOK_HINT = /\b(project\.md|playbook|checklist|versioning|defaultBranch|prose|setup|health|release rules)\b/i;

/** Which reflections.md section(s) a note belongs to. Both keyword sets → both sections;
 *  neither → playbook, where the operator will notice and move it. */
export function reflectSections(note: string): ReflectSection[] {
	const plugin = PLUGIN_HINT.test(note);
	return plugin && PLAYBOOK_HINT.test(note) ? ["playbook", "plugin"] : plugin ? ["plugin"] : ["playbook"];
}

/** Where a fix must be implemented: every fix runs through a flow whose gates confirm it —
 *  playbook-only change → docs flow; code in the dev-flow repo → patch/normal flow;
 *  plugin feedback in someone else's repo → upstream issue (dev-flow files nothing itself). */
export interface ReflectionRoute {
	text: string;
	sections: ReflectSection[];
	mode: "docs" | "code" | "upstream";
	route: string;
}

export function reflectionRoutes(items: string[], selfRepo: boolean): ReflectionRoute[] {
	return items.map((l) => {
		const text = l.replace(/^-\s*\[[ xX]\]\s*/, "").trim();
		const sections = reflectSections(text);
		if (sections.includes("plugin"))
			return selfRepo
				? { text, sections, mode: "code" as const, route: "patch flow for a small fix (flow start fix-<topic> --patch --confirmed), normal flow when bigger" }
				: { text, sections, mode: "upstream" as const, route: "file an issue against pi-dev-flow upstream (manual — dev-flow files nothing itself); copy the item text there" };
		return { text, sections, mode: "docs", route: "docs flow (flow start fold-<topic> --docs --confirmed) — project.md edits only pass its worktree" };
	});
}

/** What `flow doctor <note>` prints: the note is an investigation order, not an answer —
 *  the plugin has no LLM; the agent investigates, the gates confirm, the flow implements. */
export function investigationBrief(note: string, selfRepo: boolean): string[] {
	const [route] = reflectionRoutes([`- [ ] ${note}`], selfRepo);
	return [
		`investigate: "${route.text}"`,
		"read first: .dev-flow/project.md, flow doctor findings, and whatever files the note names.",
		`fix routing: ${route.route}`,
		"the note is not implemented by doctor — propose the fix to the operator first; only after they confirm, open the routed flow; its gates carry the confirmation.",
	];
}

/** Bare `flow reflect`: the full session-reflection protocol for the agent (the plugin has no LLM —
 *  the agent reviews the session log, re-checks open items against shipped fixes, dedupes new
 *  findings and puts the fix decision to the operator). Writes nothing, runs no network calls. */
export function reflectProtocol(items: string[], selfRepo: boolean, facts: { version: string | null; upstream: string }): string[] {
	const ver = facts.version ? `dev-flow ${facts.version}` : "dev-flow version unknown";
	const up = facts.upstream || "<upstream — ask the operator for the dev-flow repo>";
	const url = facts.upstream ? `https://github.com/${facts.upstream}` : "<upstream-url>";
	const lines = [
		`flow reflect — session reflection (${ver}, upstream: ${up})`,
		"this output is your work instruction: execute these steps now — do not echo the protocol and do not ask to begin.",
		"queue: .dev-flow/reflections.md — gitignored and yours to edit; check items off as `- [x] … — fixed: <what or where>`.",
		"1. review the current session log in full — every message, tool call and result: friction, wrong turns, repeated failures, guards or gates that misfired, playbook drift, optimization candidates. Decide for each: playbook issue or plugin issue.",
		`2. re-check every open item below: already handled by the current playbook (.dev-flow/project.md) or obsolete → check it off with a fixed: note. Possibly fixed in a newer dev-flow: git ls-remote --tags --sort=-v:refname ${url} | head -1 — a newer v<version> tag covering the item → recommend the operator update the git-installed plugin (${facts.upstream ? `pi install git:github.com/${facts.upstream}` : "pi install git:github.com/<dev-flow repo>"}, then /reload); never update it yourself.`,
		'3. new findings: dedupe against the open items first — never reflect the same issue twice; queue each real one with flow reflect "<one-line note>", then report to the operator structurally: playbook items vs plugin items, each with its route from the list below.',
		"4. ask the operator whether to fix the open issues now. If yes:",
		`   a. plugin items: search upstream first — gh issue list --repo ${up} --state all --search "<keywords>" — an author-addressed match → report the verdict back to the operator (fixed in v… / closed won't-fix + reason), do not re-file; no match → gh issue create --repo ${up} with a detailed description, session evidence and a suggested fix.`,
		"   b. playbook items: run flow doctor — it reviews each open item and routes it to the docs flow that implements the fix.",
	];
	if (!items.length) lines.push("open items: none — steps 1 and 3 still apply.");
	else {
		lines.push(`open items (${items.length}):`);
		for (const r of reflectionRoutes(items, selfRepo)) lines.push(`  [${r.sections.join("+")}] ${r.text}`, `      → ${r.route}`);
	}
	return lines;
}

/**
 * Rewrite reflections.md as a preamble + one section per non-empty bucket, with `line` appended to
 * each named section. Everything above the first item (title, comment, operator notes) is kept
 * verbatim. Legacy flat lines carry their target inline (`- [ ] (plugin) …`, `— to playbook`);
 * that marker buckets them and is then dropped, so an old file migrates on next write.
 */
export function appendReflection(text: string, sections: ReflectSection[], line: string): string {
	const lines = text.split("\n");
	const firstItem = lines.findIndex((l) => l.trim().startsWith("- ["));
	// shortcut: only the preamble above the first item survives verbatim; hand-written prose below the items is dropped.
	// bare `## section` headers above the first item are leftovers of an earlier rewrite; dropped here so they never duplicate verbatim into every following file.
	const staleHeader = new RegExp(`^## (${REFLECT_SECTIONS.join("|")})\\s*$`, "i");
	const preamble = (firstItem < 0 ? lines : lines.slice(0, firstItem))
		.filter((l) => !staleHeader.test(l.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const buckets = Object.fromEntries(REFLECT_SECTIONS.map((s) => [s, [] as string[]])) as Record<ReflectSection, string[]>;
	for (const raw of firstItem < 0 ? [] : lines.slice(firstItem)) {
		const l = raw.trim();
		if (!l.startsWith("- [")) continue;
		const key: ReflectSection = /\((plugin|doctor)\)/.test(l) || /\bto plugin\b/.test(l) ? "plugin" : "playbook";
		buckets[key].push(l.replace(/\((plugin|playbook|doctor)\)/, "").replace(/\s*[—-]\s*to\s+(playbook|plugin|doctor)/, "").replace(/\s{2,}/g, " ").trim());
	}
	for (const s of sections) buckets[s].push(line.trim());
	return `${preamble || REFLECT_HEADER.trimEnd()}\n\n` + REFLECT_SECTIONS.filter((s) => buckets[s].length).map((s) => `## ${s}\n\n${buckets[s].join("\n")}\n`).join("\n");
}

/** Header of roadmap.md — the backlog of future features (gitignored, agent-editable like reflections.md). */
export const ROADMAP_HEADER =
	"# dev-flow roadmap\n\n<!-- Backlog of features to build later. flow roadmap add/pick/done/tidy; a pick stamps its item (slug) and flow finish checks it off when that feature ships. -->\n";

const isDoneItem = (line: string) => /^\s*-\s*\[[xX]\]\s/.test(line);
const isOpenItem = (line: string) => /^\s*-\s*\[[ ]]\s/.test(line);
const stampItem = (line: string, stamp: string) => `- [x] ${line.trim().replace(/^-\s*\[[ ]]\s+/, "")} — done: ${stamp}`;

/** Append an open item to roadmap.md content; a header is minted from empty content. */
export function appendRoadmapItem(text: string, item: string): string {
	return `${text.trimEnd() || ROADMAP_HEADER.trimEnd()}\n- [ ] ${item.trim()}\n`;
}

/** Number of open roadmap items. */
export const roadmapOpenCount = (text: string) => openChecklistItems(text).length;
/** Number of done roadmap items (tidy removes them). */
export const roadmapDoneCount = (text: string) => text.split("\n").filter(isDoneItem).length;

/** Stamp the nth open item (1-based, open items only) with `(slug)` — the pick→finish handshake.
 *  Returns null when n is out of range. Re-picking the same slug is a no-op stamp. */
export function roadmapPick(text: string, n: number, slug: string): string | null {
	let seen = 0;
	let hit = false;
	const out = text.split("\n").map((l) => {
		if (!isOpenItem(l)) return l;
		++seen;
		if (seen !== n) return l;
		hit = true;
		return l.trim().includes(`(${slug})`) ? l.trim() : `${l.trim()} (${slug})`;
	});
	return hit ? out.join("\n") : null;
}

/** Check the nth open item (1-based, open items only) with a done stamp. Returns null when n is out of range. */
export function roadmapDone(text: string, n: number, stamp: string): string | null {
	let seen = 0;
	let hit = false;
	const out = text.split("\n").map((l) => {
		if (!isOpenItem(l)) return l;
		++seen;
		if (seen !== n) return l;
		hit = true;
		return stampItem(l, stamp);
	});
	return hit ? out.join("\n") : null;
}

/** Check every open item stamped `(slug)` by a pick — flow finish closes the backlog item a picked feature ships. */
export function roadmapDoneForSlug(text: string, slug: string, stamp: string): { text: string; count: number } {
	let count = 0;
	const out = text.split("\n").map((l) => {
		if (!isOpenItem(l) || !l.includes(`(${slug})`)) return l;
		count++;
		return stampItem(l, stamp);
	});
	return { text: out.join("\n"), count };
}

/** Drop the done (`- [x]`) items; preamble and open items stay verbatim. */
export function roadmapTidy(text: string): string {
	return text.split("\n").filter((l) => !isDoneItem(l)).join("\n").replace(/\n{3,}/g, "\n\n");
}

/** How far before pi's own compaction threshold dev-flow compacts (one fat tool turn). */
export const COMPACT_MARGIN = 16384;
/** pi's default compaction reserveTokens; pass the real value if known. */
export const PI_RESERVE_DEFAULT = 16384;

/**
 * Safe-point decision for flow-aware self-compaction: only when the context is
 * within COMPACT_MARGIN of pi's threshold AND nothing important lives only in chat —
 * an open operator dialog (pending checklist) or an undigested plan discussion both mean the transcript IS the state.
 */
export function shouldSelfCompact(
	d: { tokens: number | null; contextWindow: number; stage: Stage | null; planFiles: number; checklistPending: number; compacting: boolean },
	reserve = PI_RESERVE_DEFAULT,
): boolean {
	if (d.compacting || d.tokens === null) return false;
	if (!d.stage || d.stage === "done") return false;
	if (d.checklistPending > 0) return false;
	if (d.stage === "plan" && d.planFiles === 0) return false;
	return d.tokens > d.contextWindow - reserve - COMPACT_MARGIN;
}

/**
 * Forced pi compaction that dev-flow should take over and redo with flow-aware instructions:
 * only the threshold path — overflow must keep pi's compact-and-retry, manual is the operator's or ours.
 */
export function shouldTakeOverCompaction(d: { reason: "manual" | "threshold" | "overflow"; bound: boolean; inFlight: boolean }): boolean {
	return d.reason === "threshold" && d.bound && !d.inFlight;
}

/** reflections.md line for a forced (non-manual) pi compaction while a flow is bound — advisory, never gates. */
export function compactionReflectionLine(slug: string, stage: Stage, reason: string, today: string): string {
	return `- [ ] pi auto-compacted (${reason}) at stage ${stage} — pace gates so work lands on disk before compaction; draft plan discussion into plan/ early — ${slug} ${today}`;
}

/** What the agent/user should do next, per stage. */
export function nextHint(state: FlowState, cfg: Config): string {
	switch (state.stage) {
		case "plan":
			if (state.patch) return `patch: describe the change to the operator in one line, then ask them to approve — no plan file needed (all gates still apply)`;
			if (state.docs) return `docs: describe the change to the operator in one line, then ask them to approve — no plan file and no tier-1 checks (worktree and release stay intact)`;
			return `investigate, present your direction and proposed mode to the operator and clarify in chat, then write the plan into .dev-flow/${state.slug}/plan/${state.ui ? ` — render mockups to plan/mockups/ (${cfg.mockupGlobs.join(", ")}) with headless chromium and embed them in plan.md` : ""}, then ask the operator to run /flow approve`;
		case "implement":
			if (state.docs) return `implement in the worktree ${state.worktree} — docs mode runs no project command (no build, no dev deploy, no health probe); tick the tier-2 checklist with the operator, then ask them to run /flow verify`;
			return `implement in the worktree ${state.worktree}, add tests, run flow check (tier-1 checks, incl. health with seeded data); tick the tier-2 checklist with the operator, then ask them to run /flow verify`;
		case "pre-release":
			return `${cfg.release.review} → fix must-have/should-have → update docs${cfg.release.changelog ? ` → prepare ${cfg.release.changelog}` : ""}${cfg.versioning.file ? ` → bump version in ${cfg.versioning.file}` : ""}, re-run flow check, then show the operator the PR summary, version and changelog, ask Release? and run flow release`;
		case "release":
			return state.approvals.release
				? "release recorded — commit and push the release chores in the main checkout (prefix the commit with DEV_FLOW_ALLOW_MAIN=1 — the installed pre-commit hook otherwise blocks main commits), ask the operator Finish? and run flow finish (removes worktree, branch and .dev-flow/" + state.slug + "/)"
				: state.noVersion
					? "publish: commit and push the branch, open and merge the PR — unversioned release: no manifest bump, no tag; then run flow release-done (no further question)"
					: "publish: commit and push the branch, open and merge the PR, create the annotated tag from the manifest version and push it, then run flow release-done (no further question)";
		default:
			return "feature finished";
	}
}

export function getPath(obj: Record<string, unknown>, key: string): unknown {
	let cur: unknown = obj;
	for (const seg of key.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** Write (or delete, on null) a dot-path value in a partial project.json object. */
export function applyAnswer(partial: Record<string, unknown>, key: string, value: string | boolean | null): void {
	const segs = key.split(".");
	const leaf = segs.pop()!;
	const chain: Record<string, unknown>[] = [partial];
	for (const s of segs) {
		const next = chain[chain.length - 1][s];
		if (typeof next !== "object" || next === null) {
			const created: Record<string, unknown> = {};
			chain[chain.length - 1][s] = created;
			chain.push(created);
		} else chain.push(next as Record<string, unknown>);
	}
	const holder = chain[chain.length - 1];
	if (value === null || value === "" || value === "(none)") delete holder[leaf];
	else holder[leaf] = value;
	for (let i = chain.length - 2; i >= 0; i--) {
		const child = chain[i][segs[i]] as Record<string, unknown>;
		if (child && Object.keys(child).length === 0) delete chain[i][segs[i]];
	}
}

