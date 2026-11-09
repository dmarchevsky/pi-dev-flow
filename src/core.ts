/**
 * dev-flow core: config, flow state, stage gates and guard decisions.
 *
 * Pure(ish) logic only — no pi imports here so it is unit-testable with
 * `node --test`. The extension in extensions/dev-flow.ts is thin wiring.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** A feature's stage. There is no "done": flow finish deletes the feature's state outright. */
export type Stage = "plan" | "implement" | "pre-release" | "release";

export interface Check {
	ok: boolean;
	at: string;
	/** The worktree state this check actually ran against (see checkFingerprint). A record whose
	 *  fingerprint differs from the current tree at gate time was measured against code that no
	 *  longer exists — green is not enough when the tree moved under it. Absent = recorded by an
	 *  older build, or git could not be asked: never proven stale, never dropped. */
	wt?: string;
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
	noVersion?: boolean; // operator chose: this flow ships merge + changelog only — no bump, no tag, no forge release; the entry rides under Unreleased until the next versioned release folds it
	yolo?: boolean; // operator said "yolo" at any gate question: that one answered, every later one pre-confirmed; checks and guardrails stay
	setupAt?: string; // commands.setup exited 0 in this worktree — a reused worktree reruns it only when unset (#49)
	releaseVersion?: string; // the manifest version the release gate approved — release-done publishes this, not whatever a checkout says later (#52)
	forgeReleaseSkipped?: string; // a gh/glab release create that failed: release-done says so, finish names it so the missing forge release cannot slip past (#63)
	staleBuild?: string; // release ran under an older dev-flow than the checkout by operator choice ("<loaded> (checkout <disk>)"); release-done repeats the acknowledgement
	pendingAsk?: string; // the checkpoint word a gate asked for and has not been given ("Approve?", "Verified?", …) — presentation only (💬 in the footer), it never gates
	releaseOnly?: boolean; // verify found nothing on the branch but unreleased work on main: this flow only cuts the version (#161)
	verifiedHead?: string; // HEAD the operator's Verified? was given over — release names commits after it, so the word is not recorded as the verdict for a tree nobody looked at (#162)
	reflectedAt?: string; // a reflect worker reported for this flow — finish runs one first while this is unset (only --no-reflect --confirmed skips it)
	devPort?: number; // the port the operator chose for this flow's dev deploy when the default was held by another flow — finish stops it (devDown)
	friction?: number; // gate refusals, guard blocks and post-Verified? code changes this feature hit — finish skips the closing reflection at 0 (playbook reflect = on-friction)
	aborted?: string; // flow abort on a feature whose worktree exists: the state is a deliberate abandoned-feature record (gh#138) — the doctor's git-consistency sweep must never flag its hand-removed worktree as drift
}

/** Tier-2 item: operator prose; uiOnly items ("(ui)" in project.md) apply only to --ui features;
 *  versionedOnly items ("(versioned)") presuppose a bump/tag and stand down on a --no-version flow (#166). */
export interface ChecklistItem {
	text: string;
	uiOnly: boolean;
	versionedOnly?: boolean;
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
	/** Stop a dev instance this flow started on a non-default port (run by flow finish). */
	devDown?: string;
	/** Print the commit the deployed app serves — verify refuses when it is not the worktree's HEAD. */
	servedBuild?: string;
}

/** How a merged feature branch lands on the default branch (playbook key `merge`).
 *  `any` is an explicit opt-out: "no policy, stop asking" — absent means unset and nagged about. */
export type MergeStyle = "squash" | "merge" | "rebase";
export const MERGE_STYLES = ["squash", "merge", "rebase", "any"] as const;

/** A playbook `merge` value, or null when it is not a policy at all (a typo must not silently mean "no policy"). */
export function parseMergeStyle(raw: unknown): MergeStyle | "any" | null {
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return (MERGE_STYLES as readonly string[]).includes(v) ? (v as MergeStyle | "any") : null;
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
	/** The dev deploy's default port (playbook `port`). Unset: dev-flow cannot run a second instance, only name who holds the stack. */
	devPort?: number;
	/** Can two dev instances run side by side (playbook `parallelDev`)? undefined = the playbook does not say. */
	parallelDev?: boolean;
	/** Bytes one dev instance needs (playbook `instanceMem` / `instanceDisk`, e.g. 2G) — the side-by-side feasibility check. */
	instanceMem?: number;
	instanceDisk?: number;
	release: { review: string; changelog?: string; releases?: boolean; artifact?: string; preflight?: string; merge?: MergeStyle | "any"; /** `until-release`: a standing yolo never answers Release? (gh#176) */ yolo?: "all" | "until-release"; /** `always`: finish runs the closing reflection even on a flow with no friction */ reflect?: "always" | "on-friction" };
	mainHook: boolean; // flow init installs a pre-commit hook blocking main commits
	/** `inject` (default): the class default timeout is armed silently on every shell call.
	 *  `require`: a shell call without its own visible timeout is refused (costs a turn per miss). */
	bashTimeout: "require" | "inject";
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
	release: { review: "/flow-review", changelog: "CHANGELOG.md", releases: true },
	mainHook: true,
	bashTimeout: "inject",
	guard: { deny: [], confirm: [], protect: [], forbid: [] },
};

/**
 * Built-in tier-3 guidance for stages with no `prose.<stage>` in project.md.
 * Operator prose replaces it (never appends) — a project that wants its own
 * implement guidance just sets prose.implement. Implement-only: this is the
 * writing discipline for where flows write code; it stays out of plan/release
 * turns. Senior-engineer discipline adapted from ponytail (MIT, DietrichGebert).
 */
export const DEFAULT_STAGE_GUIDANCE: Partial<Record<Stage, string>> = {
	implement:
		"Smallest complete change wins: skip what nobody asked for (name it in one line); reuse this repo's helpers before writing new ones; stdlib and installed deps before new code; one readable line over fifty. No speculative abstraction, wrapper, option or config — deletion beats addition, keep the structure the codebase has. Finish everything your change touches: the callers, tests and fixtures it breaks. A bug fix goes to the root cause in the shared code, after grepping every caller. New non-trivial logic (a branch, a loop, a parser, money, security) leaves one small failing-first test. A deliberate shortcut gets a `shortcut: <limit>, <upgrade>` comment. Never cut: validation at trust boundaries, error handling that prevents data loss, security, anything the operator asked for.",
};

/** Tier-3 stage guidance with provenance: operator prose (project.md) wins,
 *  else the built-in default (dev-flow). Undefined when neither exists. */
export function stageGuidance(cfg: Config, stage: Stage): { text: string; source: "project.md" | "dev-flow default" } | undefined {
	if (cfg.prose[stage]) return { text: cfg.prose[stage], source: "project.md" };
	const text = DEFAULT_STAGE_GUIDANCE[stage];
	return text ? { text, source: "dev-flow default" } : undefined;
}

/** Markers around the always-on core of `skills/dev-flow/SKILL.md`. Pi advertises a skill
 *  (name, description, path) and loads the body only when the model chooses to read it, so
 *  nothing in the file is guaranteed in front of the model. The extension injects what sits
 *  between these markers once per session; everything outside them (the stage map, and
 *  `references/` per stage) is read on demand. */
export const SKILL_CORE_START = "<!-- dev-flow:core:start -->";
export const SKILL_CORE_END = "<!-- dev-flow:core:end -->";

/** The always-on core of the dev-flow skill: the text between the markers, or null when the
 *  markers are missing, reversed or hold nothing. Null is a fallback, not an error — a checkout
 *  without `skills/`, or a botched edit, must leave the injection exactly as it was and must
 *  never throw inside a guard hook. */
export function extractSkillCore(md: string): string | null {
	const a = md.indexOf(SKILL_CORE_START);
	const b = md.indexOf(SKILL_CORE_END);
	if (a < 0 || b < 0 || b < a) return null;
	const core = md.slice(a + SKILL_CORE_START.length, b).trim();
	return core || null;
}

/** The playbook file carrying one stage's detail, relative to the skill directory. The state machine
 *  has no finish stage — closing out happens inside `release`, and release.md hands over to finish.md
 *  there. The pre-flow brief is `start`. */
export function stageReference(stage: Stage): string {
	return `references/${stage}.md`;
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

/** A playbook size (`2G`, `512M`, `1.5GB`, plain bytes) in bytes; undefined for junk. */
export function parseSize(raw: unknown): number | undefined {
	const m = typeof raw === "string" ? raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i) : null;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	if (!m) return undefined;
	const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase() as "" | "k" | "m" | "g" | "t"];
	return Math.floor(Number(m[1]) * mult);
}

/** Bytes as the operator reads them: 9.1G, 512M. */
export function formatSize(n: number): string {
	for (const [u, d] of [["T", 1024 ** 4], ["G", 1024 ** 3], ["M", 1024 ** 2], ["K", 1024]] as const) if (n >= d) return `${(n / d).toFixed(1).replace(/\.0$/, "")}${u}`;
	return `${n}B`;
}

/** Does a `servedBuild` printout name this HEAD? Any hex token of 7+ characters that is a prefix of the full sha counts. */
export function servedBuildMatches(out: string, head: string): boolean {
	const full = head.trim().toLowerCase();
	if (full.length < 7) return false;
	return (out.toLowerCase().match(/[0-9a-f]{7,40}/g) ?? []).some((t) => full.startsWith(t));
}

/** Who last deployed dev on a port (`.dev-flow/dev-ports.json`, key = port or "default"). */
export interface DevSlot {
	slug: string;
	head: string;
	at: string;
}

/** What the clash question offers, from measured resources and the playbook's declared costs. */
export function sideBySide(o: { cfg: Config; nextPort: number | null; memAvail: number | null; diskFree: number | null }): { ok: boolean; why: string[] } {
	const { cfg } = o;
	const why: string[] = [];
	if (cfg.devPort === undefined) why.push("the playbook names no `port`, so dev-flow cannot place a second instance");
	if (cfg.parallelDev === false) why.push("the playbook says `parallelDev = no` (instances would share state)");
	const dev = `${cfg.commands.dev ?? ""}\n${cfg.commands.health ?? ""}`;
	if (cfg.devPort !== undefined && !/DEV_FLOW_PORT/.test(dev)) why.push("the playbook's `dev`/`health` commands do not read $DEV_FLOW_PORT, so a second instance would land on the same port");
	if (o.nextPort === null && cfg.devPort !== undefined) why.push("no free port found above the default");
	if (cfg.instanceMem !== undefined && o.memAvail !== null && o.memAvail < cfg.instanceMem) why.push(`RAM available ${formatSize(o.memAvail)} < ${formatSize(cfg.instanceMem)} one instance needs`);
	if (cfg.instanceDisk !== undefined && o.diskFree !== null && o.diskFree < cfg.instanceDisk) why.push(`disk free ${formatSize(o.diskFree)} < ${formatSize(cfg.instanceDisk)} one instance needs`);
	return { ok: why.length === 0, why };
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
	const f = file.toLowerCase();
	return globs.some((g) => {
		const glob = g.toLowerCase();
		return glob.startsWith("*.") ? f.endsWith(glob.slice(1)) : f.includes(glob);
	});
}

/** Image extensions the embed proof keys on — independent of mockupGlobs: whatever the operator
 *  configured as the render proof, a render nobody embedded is one the operator never saw. */
const IMG_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

/** Gate: plan → implement. Returns reasons it cannot advance (empty = pass).
 *  planDoc is the text of plan/plan.md (undefined = absent) — the embed proofs read the plan
 *  document itself. Before it, the gate checked only that *a* *.md and *a* *.png existed, which
 *  let a pre-plan/direction file with unembedded screenshots walk through Approve. */
/** Links in a feature's mockup HTML that resolve into ANOTHER feature's worktree, as `file: href`.
 *  At plan this feature has no worktree yet, and a sibling's is a tempting stand-in for "the branch's
 *  stylesheet" — but it is a different branch that drifts or vanishes when that feature finishes, so
 *  every later re-render silently describes someone else's styles (lettuce rail-ui-fixes linked
 *  status-and-loading's). `mockups` are paths relative to plan/ with their HTML; dfDir is absolute. */
export function foreignWorktreeLinks(dfDir: string, slug: string, mockups: { file: string; html: string }[]): string[] {
	const out: string[] = [];
	const base = path.join(dfDir, slug, "plan");
	for (const m of mockups) {
		const refs = [
			...m.html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi),
			...m.html.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi),
		].map((x) => x[1]);
		for (const ref of refs) {
			if (/^(?:https?:|data:|#|mailto:)/i.test(ref)) continue;
			const p = ref.replace(/^file:\/\//i, "").split(/[?#]/)[0];
			const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(path.dirname(path.join(base, m.file)), p);
			const rel = path.relative(dfDir, abs);
			const owner = /^([^/\\]+)[/\\]worktree(?:[/\\]|$)/.exec(rel)?.[1];
			if (owner && owner !== slug && !rel.startsWith("..")) out.push(`${m.file}: ${ref}`);
		}
	}
	return out;
}

export function approveGate(state: FlowState, cfg: Config, planFiles: string[], planDoc?: string, foreignLinks: string[] = []): string[] {
	const errs: string[] = [];
	if (state.stage !== "plan") errs.push(`stage is "${state.stage}", approval only applies to "plan"`);
	if (!state.patch && !state.docs && !planFiles.includes("plan.md"))
		errs.push("plan/plan.md is missing — the plan IS plan.md (a preliminary direction belongs inside it, marked draft; a separate pre-plan/direction file does not open the gate)");
	if (state.ui && !planFiles.some((f) => matchesGlob(f, cfg.mockupGlobs)))
		errs.push(`UI feature: plan/mockups/ must contain rendered screenshots matching ${cfg.mockupGlobs.join(", ")} (headless chromium, embedded in plan.md)`);
	if (state.ui && planDoc !== undefined) {
		// ![alt](mockups/screen-390.png) with an optional "title" tolerated; matching is case-insensitive
		const embeds = [...planDoc.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1].toLowerCase());
		const unembedded = planFiles.filter((f) => IMG_EXT.test(f) && !embeds.some((e) => e === f.toLowerCase() || e.endsWith("/" + f.toLowerCase())));
		if (unembedded.length) errs.push(`plan.md must embed every render — missing embed: ${unembedded.join(", ")} (write ![<screen> — width](mockups/<file>) under the screen's section)`);
		// the naming plan.md prescribes (screen.html → screen-<width>.png): a mockups/*.html with no
		// embedded shot of its own was never rendered
		const unrendered = planFiles
			.filter((f) => /^mockups\/[^/]+\.html$/i.test(f))
			.filter((f) => {
				const stem = f.toLowerCase().replace(/\.html$/, "").split("/").pop()!;
				return !embeds.some((e) => (e.split("/").pop() ?? "").startsWith(stem) && IMG_EXT.test(e));
			});
		if (unrendered.length) errs.push(`mockups without an embedded render — ${unrendered.join(", ")} (render each screen and name the shot after it: <screen>-<width>.png)`);
	}
	if (foreignLinks.length)
		errs.push(`mockups link another feature's worktree — ${foreignLinks.join(", ")}: that branch drifts and is removed at its finish; at plan link the main checkout's stylesheet (this feature's worktree does not exist until approve) and re-render`);
	return errs;
}

/** What the feature branch has proved when verify is asked: commits it holds over its merge
 *  base with the default branch, and paths sitting uncommitted. commitsAhead is null when git
 *  could not answer (no merge base — shallow clone, unfetched origin): a gate must not refuse
 *  on its own measurement failure. */
export interface BranchState {
	commitsAhead: number | null;
	uncommitted: number;
	/** Only measured when nothing is committed on a versioned project: commits on the default branch since
	 *  the newest version tag (every commit when none is tagged yet), and that tag. > 0 = a release-only
	 *  flow — main carries the code, the flow only cuts the version (#161). null = git could not answer. */
	unreleased?: { count: number | null; since: string | null };
}

/** A release-only flow: nothing on the branch, but the default branch holds unreleased work to version (#161). */
export const isReleaseOnly = (cfg: Config, branch?: BranchState | null): boolean =>
	!!cfg.versioning.file && branch?.commitsAhead === 0 && (branch.unreleased?.count ?? 0) > 0;

/** Gate: implement → release. Tier 1: every parsed check green; tier 2: checklist confirmed;
 *  the branch must hold at least one commit — checks describe the working tree, so with nothing
 *  committed the operator is asked to approve state no gate has ever seen. */
export function verifyGate(state: FlowState, cfg: Config, branch?: BranchState | null): string[] {
	const errs: string[] = [];
	if (state.stage !== "implement") errs.push(`stage is "${state.stage}", verify only applies to "implement"`);
	// a release-only flow (#161) proves main's committed tree here; its version bump is the pre-release commit
	if (branch && branch.commitsAhead === 0 && !isReleaseOnly(cfg, branch))
		errs.push(
			cfg.versioning.file && branch.unreleased?.count === 0
				? `nothing committed on the feature branch, and ${branch.unreleased.since ? `nothing landed on the default branch since ${branch.unreleased.since}` : "the default branch has nothing to release"} — there is nothing to verify or release`
				: "nothing committed on the feature branch yet — commit as you go, verify proves a committed state",
		);
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
	/** True when the branch changed the changelog vs its base — the proof a release prepared its own
	 *  entry. null when no base resolves at all (a rebased or squash-merged branch): the proof is
	 *  skipped with an advisory instead of refusing a legal release for a git-topology reason (#97). */
	changelogChanged: boolean | null;
	/** What the changelog held under Unreleased **before** this release, and where that came from: the
	 *  newest tag (what actually shipped) or the branch's merge base; "none" = unprovable. */
	changelogBase?: { pending: string[]; source: "tag" | "merge-base" | "none" };
	/** Operator-granted escape from the line-level fold proofs (`flow release --no-fold-check`). */
	noFoldCheck?: boolean;
	/** Conflict-marker lines the branch adds vs its merge base (`file:line: text`) — a hand-resolved merge
	 *  that kept one ships it otherwise (#164). Undefined = not measured (no merge base). */
	conflictMarkers?: string[];
	/** Operator-granted escape for a branch that adds marker-shaped lines on purpose (`--no-marker-check`). */
	noMarkerCheck?: boolean;
}

/** Added lines in a unified diff (`git diff -U0 <base>`) that are merge-conflict markers, as
 *  `file:line: text`. Only the unambiguous markers count — `<<<<<<<`, `|||||||`, `>>>>>>>` at the line start
 *  followed by a space or the end of the line; a bare `=======` is also a markdown heading underline. */
export function conflictMarkerLines(diff: string): string[] {
	const out: string[] = [];
	let file = "";
	let line = 0;
	for (const l of (diff ?? "").split("\n")) {
		if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
		const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
		if (h) { line = Number(h[1]); continue; }
		if (l.startsWith("+")) {
			if (/^(<{7}|\|{7}|>{7})( |$)/.test(l.slice(1))) out.push(`${file}:${line}: ${l.slice(1).slice(0, 80)}`);
			line++;
		}
	}
	return out;
}

/** One changelog line as the fold proofs compare it: indentation, bullet style and whitespace runs are
 *  markdown jitter and do not count; a reworded or deleted line does (#97). */
export function normalizeEntryLine(line: string): string {
	return line.trim().replace(/^[-*+]\s+/, "").replace(/\s+/g, " ");
}

/** The lines under the changelog's Unreleased heading (verbatim). Matches `## Unreleased` and
 *  `## [Unreleased]`; deeper `###` sub-headings stay inside the section; the next h1/h2 ends it. */
export function unreleasedBody(content: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of content.split("\n")) {
		if (/^#{1,2}\s/.test(line)) {
			if (inside) break; // section ended
			inside = /^#{2,3}\s*\[?Unreleased\]?\s*$/.test(line);
			continue;
		}
		if (inside) out.push(line);
	}
	return out;
}

function entryLines(text: string): string[] {
	// a section's sub-headings (`### Fixed`) are structure, not entries
	return text
		.split("\n")
		.filter((l) => l.trim() && !/^#{1,6}\s/.test(l))
		.map(normalizeEntryLine)
		.filter(Boolean);
}

/** The pending Unreleased entries, normalized: what a versioned release must carry into its own entry,
 *  and what an unversioned one must have added (#97). */
export function pendingEntryLines(content: string): string[] {
	return entryLines(unreleasedBody(content).join("\n"));
}

/** Pending lines the new version's entry does not carry — folded means moved, not deleted (#97). */
export function missingFoldedLines(basePending: string[], entryBody: string): string[] {
	const have = new Set(entryLines(entryBody));
	return basePending.filter((l) => !have.has(l));
}

/** A release body as the forge stores it: trailing whitespace and outer blank lines are markdown
 *  normalization, not a different body (#97). */
export function normalizeReleaseBody(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.trim();
}

/**
 * The body of a versioned forge release: the changelog entry for that version is the source of truth,
 * so the release page and the changelog cannot drift apart (#97). The tag annotation is only a
 * stand-in when the changelog has no entry for the version — and a shell complaint never becomes a
 * release body (#51).
 */
export function pickReleaseNotes(src: { changelog: string | null; version: string | null; annotation: string }): { notes: string; source: "changelog" | "annotation" | "none" } {
	const entry = src.changelog !== null && src.version ? changelogEntry(src.changelog, src.version) : "";
	if (entry) return { notes: entry, source: "changelog" };
	const ann = src.annotation.trim();
	if (ann && !looksLikeShellError(ann)) return { notes: ann, source: "annotation" };
	return { notes: "", source: "none" };
}

/**
 * Gate: pre-release → release ("Release?"). Machine-proves the parts of release prep that can be
 * proven — checks re-greened after the prep edits, manifest bumped past the last tag, and the
 * changelog: a heading for the version being tagged, an entry this branch actually prepared, the
 * entries that were pending before the release folded into it (not dropped), and nothing left under
 * Unreleased. An unversioned (--no-version) flow skips the version rules but still owes a new entry
 * under Unreleased. The git-dependent proofs (touched, folded) skip with an advisory when no base
 * resolves; the content proofs always run (#97). Review/docs quality stays tier-2.
 */
export function preReleaseGate(state: FlowState, cfg: Config, prep: ReleasePrep): string[] {
	const errs: string[] = [];
	if (state.stage !== "pre-release") errs.push(`stage is "${state.stage}", the release gate only applies to "pre-release"`);
	if (!state.docs) for (const c of cfg.checkList) if (!state.checks[c.name]?.ok) errs.push(`check "${c.name}" has not passed — run flow check`);
	const pend = checklistPending(cfg, state, "pre-release");
	if (pend) errs.push(`tier-2 checklist not confirmed (${pend} item(s)) — run flow release after ticking them off`);
	if (prep.conflictMarkers?.length && !prep.noMarkerCheck)
		errs.push(`the branch adds ${prep.conflictMarkers.length} merge-conflict marker line(s) — a hand-resolved merge kept them; fix and commit (or, when the lines are meant, re-run with --no-marker-check on the operator's word):\n  ${prep.conflictMarkers.slice(0, 5).join("\n  ")}${prep.conflictMarkers.length > 5 ? `\n  …(${prep.conflictMarkers.length - 5} more)` : ""}`);
	if (state.noVersion) {
		// unversioned flow (operator granted --no-version): no bump, no tag, no forge release —
		// but the merge still owes a changelog line under Unreleased, folded by the next versioned release.
		// A --docs flow does not (#163): it changes the playbook/docs, which many projects keep out of a
		// user-facing changelog — an entry it writes is still welcome, just not proven.
		if (cfg.release.changelog && !state.docs) {
			if (!prep.changelog) errs.push(`release.changelog "${cfg.release.changelog}" does not exist — an unversioned release must record its entry there (under Unreleased)`);
			else {
				if (prep.changelogChanged === false) errs.push(`${prep.changelog.file} is unchanged on this branch — an unversioned release must add its entry (under Unreleased)`);
				// an unversioned release must leave a trail someone can find later: the section is where it lives,
				// and a project with no changelog convention at all opts out with release.changelog = ""
				if (!/^#{2,3}\s*\[?Unreleased\]?\s*$/m.test(prep.changelog.content)) {
					errs.push(`${prep.changelog.file} has no Unreleased heading — an unversioned release records its entry there (add the heading, or set release.changelog = "" if this project keeps no changelog)`);
				} else {
					const pending = pendingEntryLines(prep.changelog.content);
					if (!pending.length) errs.push(`${prep.changelog.file} has no entry under its Unreleased heading — an unversioned release rides there until the next versioned release folds it`);
					else if (prep.changelogBase && prep.changelogBase.source !== "none" && !prep.noFoldCheck) {
						const base = prep.changelogBase;
						if (pending.every((l) => base.pending.includes(l)))
							errs.push(`${prep.changelog.file}'s Unreleased section gained nothing on this branch (vs the ${base.source}) — add this release's own entry under the Unreleased heading, or skip the fold proofs with --no-fold-check`);
					}
				}
			}
		}
	} else {
		if (cfg.versioning.file) {
			if (!prep.manifestVersion) errs.push(`versioning.file "${cfg.versioning.file}" has no parsable version — bump it to the version you will release`);
			else if (prep.remoteTags.includes(cfg.versioning.pattern.replace("{version}", prep.manifestVersion)))
				errs.push(`version ${prep.manifestVersion} is already tagged — bump the manifest to the next version`);
		}
		if (cfg.release.changelog) {
			if (!prep.changelog) errs.push(`release.changelog "${cfg.release.changelog}" does not exist — prepare the changelog`);
			else {
				const entry = prep.manifestVersion ? changelogEntry(prep.changelog.content, prep.manifestVersion) : "";
				if (prep.manifestVersion && !entry)
					errs.push(`${prep.changelog.file} has no entry heading for version ${prep.manifestVersion} — add the heading (a mention in prose or a link is not an entry)`);
				// the touched and fold proofs are about the release's own entry: a project with no version to
				// tag has no entry to prepare, so it keeps the old contract (nothing pending under Unreleased)
				if (prep.manifestVersion && prep.changelogChanged === false)
					errs.push(`${prep.changelog.file} is unchanged on this branch — a release must prepare its entry in this branch, not inherit one`);
				const base = prep.changelogBase;
				if (entry && base && base.source !== "none" && !prep.noFoldCheck) {
					const dropped = missingFoldedLines(base.pending, entry);
					if (dropped.length)
						errs.push(`${prep.changelog.file} drops ${dropped.length} Unreleased entr${dropped.length === 1 ? "y" : "ies"} from the ${base.source} under the ${prep.manifestVersion ?? "new"} heading — folding means moving them in as they are (reword afterwards, or skip with --no-fold-check):\n  ${dropped.slice(0, 5).join("\n  ")}${dropped.length > 5 ? `\n  …(${dropped.length - 5} more)` : ""}`);
				}
				if (unreleasedPending(prep.changelog.content))
					errs.push(`${prep.changelog.file} still has entries under Unreleased — fold them under the v${prep.manifestVersion ?? "new"} heading before releasing (they were left by --no-version flows)`);
			}
		}
	}
	return errs;
}

/** True when the changelog's Unreleased section still holds entries — --no-version flows park
 *  their lines there and a versioned release must fold them under its own heading. Matches
 *  `## Unreleased` / `## [Unreleased]`; deeper `###` sub-headings stay inside the section, the
 *  next h1/h2 ends it; no section = nothing pending (the convention is opt-in). */
export function unreleasedPending(content: string): boolean {
	return unreleasedBody(content).some((l) => l.trim());
}

export function checklistHash(items: ChecklistItem[]): string {
	return createHash("sha1")
		.update(items.map((i) => `${i.uiOnly ? "(ui) " : ""}${i.versionedOnly ? "(versioned) " : ""}${i.text}`).join("\n"))
		.digest("hex")
		.slice(0, 12);
}

/** Fingerprint of the worktree state a tier-1 check ran against: the caller composes the working
 *  tree's `git status --porcelain`, the hash of its uncommitted `git diff HEAD` (path presence and
 *  tracked content move it), and `git rev-parse HEAD`. Deterministic and cheap; the sha is only
 *  ever compared against itself, never decoded.
 *  shortcut: a content-only change to an UNTRACKED file stays invisible — git does not look at
 *  those contents, and untracked worktree content is normally build output, not code under test. */
export function checkFingerprint(treeState: string, head: string): string {
	return createHash("sha1").update(`${treeState}\n${head}`).digest("hex").slice(0, 12);
}

/**
 * Drop every check record that carries a fingerprint differing from the tree as it is now — those
 * greens describe code that no longer exists, and a gate must not advance on them. The caller
 * re-runs what is missing (verify re-runs at the gate; the release gate asks for `flow check`).
 * `fp === null` means git could not be asked: a gate must not refuse on its own measurement
 * failure — same rule as BranchState.commitsAhead. Records without a fingerprint (older builds)
 * are never proven stale.
 */
export function freshenChecks(state: FlowState, fp: string | null, keep: (name: string) => boolean = () => false): string[] {
	if (!fp) return [];
	const stale: string[] = [];
	for (const [name, rec] of Object.entries(state.checks)) {
		if (rec.wt && rec.wt !== fp && !keep(name)) {
			delete state.checks[name];
			stale.push(name);
		}
	}
	return stale;
}

/** Items that apply to this feature — "(ui)" items only when the UI flag is set. */
export function applicableItems(cfg: Config, state: FlowState, stage: string): ChecklistItem[] {
	return (cfg.checklist[stage] ?? []).filter((i) => (!i.uiOnly || state.ui) && (!i.versionedOnly || !state.noVersion));
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

/** The changelog's version headings strictly between `from` (exclusive) and `to` (inclusive), newest
 * first — what a session running `from` is missing against a checkout on `to`, i.e. the gate proofs
 * that will not run. Only `## [0.54.0]` / `## 0.54.0` headings with a parseable numeric-dot version
 * count; everything else (Unreleased, prose, `v` prefixes) is skipped, and so are unparseable bounds. */
export function changelogVersionsBetween(changelog: string, from: string, to: string): string[] {
	const versioned = (v: string) => /^\d+\.\d+\.\d+/.test(v);
	if (!versioned(from) || !versioned(to)) return [];
	const found: string[] = [];
	for (const m of changelog.matchAll(/^##\s+\[?([^\]\s]+)\]?/gm)) {
		const v = m[1];
		if (!versioned(v) || found.includes(v)) continue;
		if (cmpVersions(v, from) > 0 && cmpVersions(v, to) <= 0) found.push(v);
	}
	return found.sort((a, b) => cmpVersions(b, a));
}

/** Owner/slug from any GitHub repo reference — "owner/repo", "github.com/owner/repo", git+https or scp-style git@github.com:owner/repo.git; "" when it is not GitHub. */
export function githubSlug(ref: string): string {
	const m = ref.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/) ?? /^[\w.-]+\/[\w.-]+$/.exec(ref);
	return m ? m[1].replace(/\.git$/, "") : "";
}

/** Gate: the tag derived from the manifest version must exist among the given tags. */
export function versionTagGate(manifestVersion: string, tagPattern: string, tags: string[]): string[] {
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
	// the version must be what the heading names, not merely something it contains: `## [1.2.0]`,
	// `## 1.2.0 - 2026-01-01` and `## [v1.2.0]` count, `## [1.2.0-beta]` and a sentence naming the
	// version do not — the forge release body is taken from this section, so it must be the right one (#97)
	const heading = new RegExp(`^#{1,3}\\s*\\[?v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.\\-])`);
	const i = lines.findIndex((l) => level(l) <= 3 && heading.test(l));
	if (i === -1) return "";
	const base = level(lines[i]);
	const out: string[] = [];
	for (const l of lines.slice(i + 1)) {
		if (level(l) <= base) break;
		out.push(l);
	}
	return out.join("\n").trim();
}

/* -------------------------------------------------------------- merge policy */

/** Past tense of a style, for the wording of a refusal. */
const MERGE_PAST: Record<MergeStyle, string> = { squash: "squash-merged", merge: "merge-committed", rebase: "rebase-merged" };

/**
 * What the repo's own history says about its merge style, for `flow init` and `flow start` to suggest
 * instead of asking blind. Input is one line per first-parent commit as `%p|%s`: two parents is a merge
 * commit, a single commit whose subject ends in `(#123)` is what a squash leaves behind. Direct pushes and
 * release chores are neither — the answer must come from PR merges only. `recent` is the style of the newest
 * classified merge, which is what the repo actually does now (dev-flow: merge commits; ollamaMQ switched to
 * squash at PR #21 and nothing wrote it down).
 */
export function classifyMergeHistory(lines: string[]): { merges: number; squashes: number; recent: MergeStyle | null; note: string } {
	let merges = 0;
	let squashes = 0;
	let recent: MergeStyle | null = null;
	for (const line of lines) {
		const sep = line.indexOf("|");
		if (sep === -1) continue;
		const parents = line.slice(0, sep).trim().split(/\s+/).filter(Boolean).length;
		const subject = line.slice(sep + 1).trim();
		const isMerge = parents > 1;
		const isSquash = !isMerge && /\(#[0-9]+\)$/.test(subject);
		if (!isMerge && !isSquash) continue;
		if (isMerge) merges++;
		else squashes++;
		if (!recent) recent = isMerge ? "merge" : "squash";
	}
	const note = recent
		? `merge history: ${merges} merge commit(s), ${squashes} squash(es) — the most recent PR landed as ${recent}`
		: "merge history: no PR merges on the first parent to read a style from";
	return { merges, squashes, recent, note };
}

export interface MergeShapeFacts {
	/** Is the merged branch an ancestor of the default branch? null = not measurable (no origin, unfetched branch). */
	ancestor: boolean | null;
	/** What the forge says landed the PR, when `gh`/`glab` could answer — the only way to tell a squash from a rebase. */
	forgeStyle?: MergeStyle | null;
	/** Wording only. */
	branch?: string;
	defaultBranch?: string;
}

/**
 * Did what actually landed agree with the playbook's `merge` policy? A measured contradiction is an error;
 * what cannot be measured is a note — the split the changelog proofs learned (#97): a topology dev-flow
 * cannot see must never refuse a legal release. Note that ancestry alone proves *not squashed/rebased*:
 * a fast-forward looks exactly like a merge commit here.
 */
export function mergeShapeProof(policy: MergeStyle | "any" | undefined, facts: MergeShapeFacts): { errors: string[]; note: string } {
	const errors: string[] = [];
	if (!policy || policy === "any") return { errors, note: "" };
	const br = facts.branch ? `origin/${facts.branch}` : "the branch";
	const def = facts.defaultBranch ?? "the default branch";
	if (facts.ancestor === null) return { errors, note: `merge = ${policy} could not be checked from here (no origin or ${br} is not fetched) — confirm the merge style by hand` };
	const landed = facts.forgeStyle ?? null;
	if (policy === "merge") {
		if (!facts.ancestor) errors.push(`the playbook says merge = merge, but ${br} is not an ancestor of ${def} — the PR was ${landed ? MERGE_PAST[landed] : "squash- or rebase-merged"}, which rewrites the branch's commits out of the release's ancestry`);
		else if (landed && landed !== "merge") errors.push(`the forge reports a ${landed} merge, but the playbook says merge = merge`);
		else return { errors, note: `merge shape matches the playbook: ${br} is an ancestor of ${def} (merge = merge)` };
	} else {
		if (facts.ancestor) errors.push(`the playbook says merge = ${policy}, but ${br} is an ancestor of ${def} — the branch was merged as a merge commit or fast-forward, not ${MERGE_PAST[policy]}`);
		else if (landed && landed !== policy) errors.push(`the forge reports a ${landed} merge, but the playbook says merge = ${policy}`);
		else return { errors, note: `merge shape matches the playbook: ${br} is not on ${def} as its own commits (${policy === "squash" ? "one squashed commit" : "replayed commits"})` };
	}
	return { errors, note: "" };
}

export interface MergeStyleVerdict {
	block: string | null;
	confirm: string | null;
}

/**
 * Does this command pick a merge style the playbook forbids? The forge CLI is the one place the shape of the
 * default branch is decided, so an explicit contradiction is a hard block; a merge with no style flag lets the
 * forge default decide, which deserves a confirmation, not a refusal. A local `git merge --squash` is only ever
 * a confirmation: merging main into a feature branch is normal work and `--no-ff` there is not a merge policy at all.
 * Quoted text is prose (`grep "gh pr merge --squash" docs/` searches), except inside a head that execs its argument.
 */
export function mergeStyleInvocation(command: string, policy: MergeStyle | "any" | undefined): MergeStyleVerdict {
	const none: MergeStyleVerdict = { block: null, confirm: null };
	if (!policy || policy === "any") return none;
	for (const seg of bashSegments(command)) {
		if (READ_ONLY_HEADS.has(segHead(seg))) continue; // `grep "gh pr merge --squash" docs/` searches, it does not merge
		const head = segHead(seg);
		const hay = REEXEC_HEADS.has(head) ? `${seg} ${maskQuoted(seg)}` : maskQuoted(seg);
		const forge: "gh" | "glab" | null = /\bgh\s+pr\s+merge\b/.test(hay) ? "gh" : /\bglab\s+mr\s+merge\b/.test(hay) ? "glab" : null;
		if (forge) {
			const style: MergeStyle | null = /--no-squash\b/.test(hay) ? "merge" : /--squash\b/.test(hay) ? "squash" : /--rebase\b/.test(hay) ? "rebase" : /--merge\b/.test(hay) ? "merge" : null;
			const wanted = forge === "glab" ? (policy === "squash" ? "--squash" : "--no-squash") : `--${policy}`;
			if (!style) return { block: null, confirm: `this merge carries no style flag, so the forge default decides the shape of the default branch — the playbook says merge = ${policy}; pass ${wanted} explicitly` };
			if (style !== policy) return { block: `the playbook says merge = ${policy} (.dev-flow/project.md) — this command forces a ${style} merge; drop the flag or pass ${wanted}`, confirm: null };
			return none;
		}
		if (/\bgit\b[^\n]*\bmerge\b[^\n]*--squash\b/.test(hay) && policy !== "squash")
			return { block: null, confirm: `git merge --squash folds a branch into a single commit, but the playbook says merge = ${policy} — if this is the PR merge itself, merge it on the forge instead` };
	}
	return none;
}

export interface GuardCtx {
	command: string;
	branch: string; // branch of the directory the git commands run in (feature worktree or main checkout)
	stage: Stage | null; // active feature stage, null when no active feature
	defaultBranch: string;
	pushRefs?: PushRef[]; // caller-resolved push targets (bare names disambiguated tag vs branch); omit = guard parses raw command
	playbookChore?: boolean; // the only change in this checkout is the playbook — tracking it is setup, not feature work (#53)
	dir?: string; // absolute directory this segment runs in; named in the refusal so a wrong verdict is diagnosable
	attribution?: string; // why the call could not be attributed to a bound feature; appended to the stage refusals when stage is null, so a misattribution names itself instead of lying about the stage
}

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, "$2");

/** The shell expands a leading `~` or `$HOME` before git sees the path and path.resolve does not: an
 *  unexpanded `~/wt` resolved against the session cwd, so a worktree commit was judged from the main
 *  checkout. shortcut: any other $var stays literal — resolving it needs a shell, and a wrong guess is
 *  what produced the bogus verdict in the first place. */
export function expandHome(p: string): string {
	const home = process.env.HOME;
	if (!home) return p;
	return p.replace(/^\$(?:HOME|\{HOME\})(?=$|\/)/, home).replace(/^~(?=$|\/)/, home);
}

/** git usage in a bash command, parsed per shell segment (split on ; | & newline):
 *  the git subcommands invoked — empty when git is not a command, so paths like
 *  .git/hooks or words like pre-commit never trigger the guard — and the per-segment
 *  entries the guard judges, each carrying the directory that segment runs in
 *  (last preceding `cd` target or `git -C` target; null = session cwd).
 *  shortcut: naive segment split, subshells/backticks not tracked; the pre-commit
 *  hook still covers what slips past this advisory guard. */
export function gitInvocation(command: string): { subs: string[]; pushes: string[][]; gitSegs: { seg: string; dir: string | null }[] } {
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
			dir = expandHome(unquote(tok[i + 1]));
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
				dir = expandHome(eq === -1 ? unquote(tok[++i] ?? "") : unquote(t.slice(eq + 1)));
				continue;
			}
			if (OPT_VAL.has(name) && eq === -1) i++;
		}
		gitSegs.push({ seg: seg.trim(), dir }); // after -C parsing so the entry carries its own effective dir
	}
	return { subs, pushes, gitSegs };
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

/** Flow control files by full path — state.json and claim.json — or a bare name when the command
 *  also touches `.dev-flow` (that is how `cd .dev-flow/<slug> && mv state.json …` reaches it).
 *  The claim is the live-session lock: deleting it is as much theft as forging a stage. */
const STATE_PATH = /(^|[\s'"\/])(?:state|claim)\.json$/;
const STATE_PATH_ABS = /\.dev-flow\/[\w./-]*(?:state|claim)\.json$/;
const PLAYBOOK_PATH = /\.dev-flow\/[\w./-]*project\.md/;
const DF_ANYWHERE = /\.dev-flow\b/;
/** The `.dev-flow/` folder itself or one feature directory under it — deleting either destroys the flow
 *  state and its plan for good. The advisory files the agent owns, and anything deeper (a worktree, a
 *  plan/mockups path), are not "the folder". The leading boundary takes `/` too: an absolute path names
 *  the same folder, and absolute paths are the shape the harness hands the agent. */
const DF_FOLDER = /(?:^|[\s'"/])\.dev-flow(?:\/(?!project\.md$|roadmap\.md$|reflections\.md$|\.gitignore$)[\w.-]+)?(?=$|[\s'"])/;
/** The advisory files under `.dev-flow/` the agent owns (the reflection queue and the roadmap backlog):
 *  writable with no flow bound — they are suggestions, not state — unlike everything else in the folder. */
export const DF_ADVISORY_FILES = new Set(["reflections.md", "roadmap.md"]);
// write tools that can overwrite a file. A bare `>` is deliberately absent: the redirect target is
// checked on its own, and testing for any `>` here refused every segment that merely mentioned an
// owned path while redirecting elsewhere (`gh pr create … 2>&1`).
const WRITE_TOOLS = /\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\btruncate\b|\bdd\b|python|node\s/;
/** copy/replace verbs: only the destination (last positional) is written to. */
const COPY_HEADS = new Set(["cp", "install", "tee", "dd"]);
/** verbs that destroy the file they name — copying a file somewhere safe is not one of them. */
const DESTROY_HEADS = new Set(["rm", "mv", "truncate"]);
const DESTROY_ANY = /\b(rm|mv|truncate)\b/;

/** The file a `>`/`>>` writes (`2>` allowed), or null. */
function redirectTarget(seg: string): string | null {
	const m = seg.match(/(?:^|\s)\d?>+ ?(\S+)/);
	return m ? unquote(m[1]) : null;
}

/** One shell segment: does it write, move or delete a path dev-flow owns? Decided per segment and by
 *  target, never by "owned path anywhere + write verb anywhere": reading flow state or backing the
 *  playbook up is safety, prose about `cp` is not a write (#53), and the loose match both refused
 *  `jq -e .stage .dev-flow/x/state.json` and waved through `rm -rf .dev-flow/x`. Each caller asks about
 *  its own subject so the block message names what was actually touched. */
function ownedWrite(seg: string, what: "state" | "playbook", flowState: boolean): boolean {
	const stateNamed = (q: string): boolean => (flowState ? STATE_PATH.test(q) : STATE_PATH_ABS.test(q));
	const owned = (p: string): boolean => {
		const q = unquote(p);
		return what === "playbook" ? PLAYBOOK_PATH.test(q) : stateNamed(q) || DF_FOLDER.test(q);
	};
	const tok = seg.split(/\s+/).filter(Boolean);
	if (!tok.some((t) => owned(t))) return false;
	const redir = redirectTarget(seg);
	if (redir && owned(redir)) return true; // a redirect into an owned path is a write even behind `echo`
	const head = segHead(seg);
	if (READ_ONLY_HEADS.has(head)) return false; // cat/grep/ls/jq read it
	if (head === "sed" && !/\s-i\b/.test(seg)) return false; // sed as a printer is a read
	if (DESTROY_HEADS.has(head)) return tok.slice(1).some((t) => !t.startsWith("-") && owned(t));
	if (COPY_HEADS.has(head)) return owned(tok[tok.length - 1] ?? "");
	// what is left is the loose fallback — a write tool named in the clear. A wrapper's payload counts; everyone
	// else's quoted text is prose, and prose about `cp`/`sed` is not a write (it refused a PR body describing #53).
	const payload = REEXEC_HEADS.has(head) ? seg : maskQuoted(seg);
	if (!WRITE_TOOLS.test(payload)) return false;
	// a generic writer (interpreter, wrapper): state and playbook always count; the folder only when the
	// payload really destroys it — `python tools/x.py --dir .dev-flow/<slug>` points at a directory, it does not delete it.
	if (what === "playbook") return true;
	return tok.some((t) => stateNamed(unquote(t))) || (tok.some((t) => DF_FOLDER.test(unquote(t))) && DESTROY_ANY.test(payload));
}

/** True when a bash command writes, moves or deletes flow state — or the `.dev-flow` folder/feature
 *  directory that holds it. */
export function stateTamper(command: string): boolean {
	const flowState = DF_ANYWHERE.test(command); // a bare state.json counts only next to .dev-flow
	return bashSegments(command).some((seg) => ownedWrite(seg, "state", flowState));
}

/** True when a bash segment runs a command named `flow`. There is no flow CLI — gates live inside the
 *  session as the flow tool — and a bare 127 taught agents nothing, so the habit repeated.
 *  Head token of a masked segment only: `grep flow status`, `skills/dev-flow/SKILL.md` and a commit
 *  message quoting a gate are prose/arguments, not invocations. */
export function flowShellInvocation(command: string): boolean {
	return bashSegments(command).some((seg) => segHead(maskQuoted(seg).replace(/^(?:\w+=\S*\s+)+/, "")) === "flow");
}

/** Refusal for a bash call named `flow` — it names the call that works, like bashTimeout's hint does. */
export const FLOW_SHELL_HINT = 'there is no "flow" shell command — gates live in the session: call the flow tool with an args array, e.g. flow {args:["status"]}';

/** True when a bash command writes the playbook (project.md) — the sanctioned channels are
 *  `flow init --write` (runs in-plugin, never matches) and edits inside a docs/patch flow's worktree.
 *  Decided per segment and by target, not by any verb anywhere: reading the playbook or copying it to
 *  a backup is safety, and blocking it cost the operator their only backup before a write (#53). */
export function playbookTamper(command: string): boolean {
	return bashSegments(command).some((seg) => ownedWrite(seg, "playbook", false));
}

/** The playbook-tracking chore (#53): the playbook is the only change in the checkout, so whatever
 *  the commit says it can only contain that file — setup, not feature work, legal on the default
 *  branch with no flow bound. Any other dirty path refuses the lane, so there is nothing to widen
 *  and no command parsing to fool. shortcut: a guard rail against accidents, not a sandbox. */
export function playbookOnlyChange(porcelain: string): boolean {
	const paths = porcelain.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
	return paths.length === 1 && PLAYBOOK_PATH.test(paths[0]);
}

/** The operator's authorisation for rewriting a branch that is already pushed — same contract as
 *  DEV_FLOW_ALLOW_MAIN: the guard prints it, the operator grants it, the agent types it. (#83) */
export const ALLOW_REWRITE = "DEV_FLOW_ALLOW_REWRITE=1";

/** True when a segment force-pushes: `git push` carrying a force flag (`--force`, `--force-with-lease…`,
 *  `-f`, `-uf`). Decided on the verb per segment, not on a flag anywhere after `git` — `filter-branch
 *  --force` rewrites a local copy and `git show -f` lists files, and a blunt flag-only deny blocks both,
 *  which agents learn to route around. (#82, #83) */
export function forcePushInvocation(command: string): boolean {
	return bashSegments(command).some((seg) => {
		const tok = maskQuoted(seg).trim().split(/\s+/);
		let i = 0;
		while (i < tok.length && /^[\w.]+=/.test(tok[i])) {
			if (tok[i] === ALLOW_REWRITE) return false; // the operator's word, spelled on the command itself
			i++;
		}
		if (tok[i] === "sudo") i++; // a wrapper is not an authorisation and not an escape either
		if (!/(^|\/)git$/.test(tok[i] ?? "") || !tok.includes("push")) return false;
		return tok.some((t) => /^--force\S*$/.test(t) || /^-[a-z]*f[a-z]*$/.test(t));
	});
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
	// a cd earlier in the command picks the directory this verdict is about — name it, or a misjudged segment
	// reads as "the rule is broken" instead of "the guard looked in the wrong place".
	const judgedIn = o.dir ? ` — judged in ${o.dir}; a cd or git -C earlier in the command picks the directory` : "";
	// an unattributed refusal must admit it is guessing: "requires stage release" reads as a verdict on
	// the feature when the real finding is "I never found your feature" (a second registered dev-flow
	// copy judging with no bindings of its own — see boundFeature's claim path)
	const attr = o.stage === null && o.attribution ? ` — ${o.attribution}` : "";
	if (git("commit") && onMain && o.stage !== "release" && !playbookCommit) return `direct commits to ${o.defaultBranch} are forbidden — work in the feature worktree (tracking the playbook is legal: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit)${judgedIn}${attr}`;
	if (git("push")) {
		// ref-aware: only pushes that WRITE the default branch need stage release — tags and other branches pass.
		// unresolved bare names arrive pre-resolved by the caller (tag vs branch); no parse info → conservative onMain.
		const refs = o.pushRefs ?? parsePushRefs(gitInvocation(c).pushes);
		const writesDefault = refs.some((r) => (r.kind === "branch" && (r.name === o.defaultBranch || r.name === "*")) || (r.kind === "current" && onMain));
		if (writesDefault && o.stage !== "release") return `pushing to ${o.defaultBranch} requires stage "release" (verified feature)${attr}`;
	}
	if (git("merge") && onMain && o.stage !== "release") return `merging into ${o.defaultBranch} requires stage "release"${attr}`;
	// Shipping belongs to the release stage: a tag cut (or pushed) while the feature is still before release
	// leaves the gates unable to record it — flow release then refuses "already tagged" and the flow cannot close.
	if (o.stage && BEFORE_RELEASE.has(o.stage)) {
		if (git("tag") && tagCreates(c)) return `tagging is release work — the feature is at ${o.stage}; run flow release first (it gates the version, then tags)${judgedIn}`;
		if (git("push")) {
			const refs = o.pushRefs ?? parsePushRefs(gitInvocation(c).pushes);
			if (/\s--(?:tags|follow-tags)\b/.test(c) || /refs\/tags\//.test(c) || refs.some((r) => r.kind === "tag")) return `pushing tags is release work — the feature is at ${o.stage}; run flow release first${judgedIn}`;
		}
	}
	return null;
}

const BEFORE_RELEASE = new Set<Stage>(["plan", "implement", "pre-release"]);

/** Does this `git tag` invocation create (or move) a tag? Bare `git tag` and the listing/verify forms only read. */
export function tagCreates(command: string): boolean {
	const m = command.match(/\bgit\s+(?:-C\s+\S+\s+)?tag\b([^;|&\n]*)/);
	if (!m) return false;
	const tok = m[1].trim().split(/\s+/).filter(Boolean);
	if (!tok.length) return false;
	if (tok.some((t) => /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify|-d|--delete)$/.test(t))) return false;
	return true;
}

/** Forge-side shipping (`gh pr merge`, `glab mr merge`, `gh|glab release create`) before the release stage, or null.
 *  Quoted text is prose except inside a head that execs its argument — the same reading as mergeStyleInvocation. */
export function releaseOrderInvocation(command: string, stage: Stage | null): string | null {
	if (!stage || !BEFORE_RELEASE.has(stage)) return null;
	for (const seg of bashSegments(command)) {
		if (READ_ONLY_HEADS.has(segHead(seg))) continue;
		const hay = REEXEC_HEADS.has(segHead(seg)) ? `${seg} ${maskQuoted(seg)}` : maskQuoted(seg);
		if (/\bgh\s+pr\s+merge\b/.test(hay) || /\bglab\s+mr\s+merge\b/.test(hay))
			return `merging the PR is release work — the feature is at ${stage}; ask the operator Release? and run flow release first (yolo pre-answers the question, it does not skip the gate)`;
		if (/\b(?:gh|glab)\s+release\s+create\b/.test(hay))
			return `publishing a forge release is release work — the feature is at ${stage}; run flow release, then flow release-done creates it`;
	}
	return null;
}

/** The branch a `git checkout` / `git switch` targets, and whether it creates it (`-b/-B/-c/-C/--create/
 *  --force-create/--orphan`), or null. Leading flags are skipped; `--` ends the branch part (paths follow). */
export function checkoutInvocation(command: string): { target: string; creates: boolean } | null {
	const m = command.match(/\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b([^;|&\n]*)/);
	if (!m) return null;
	const all = m[1].trim().split(/\s+/).filter(Boolean);
	const tok = all.includes("--") ? all.slice(0, all.indexOf("--")) : all;
	const i = tok.findIndex((t) => /^(-[bBcC]|--create|--force-create|--orphan)$/.test(t));
	if (i >= 0) return tok[i + 1] ? { target: unquote(tok[i + 1]), creates: true } : null;
	const target = tok.find((t) => !t.startsWith("-"));
	return target ? { target: unquote(target), creates: false } : null;
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

/** A heredoc redirector at the end of a word: `<<EOF`, `<<'EOF'`, `<<-MSG`, `<<- 'SQL'`. `2>file` and `<<<`
 *  are not heredocs; neither is the shift in `$((1<<2))` — the lookbehind refuses a word character or `(` in
 *  front of the second `<`, and a word character or quote in front of the first. */
const HEREDOC_OP = /(?<![\w(<])<<(-)?(['"]?)([A-Za-z_][\w]*)\2\s*$/;

/** Blank the body of every heredoc, keeping the line count. A heredoc body is an argument's prose exactly
 *  like a quoted string — `git commit -F - <<'MSG' … flow approve … MSG` carries no invocation — but the
 *  body lines are unquoted, so the newline split read each of them as its own command and a commit message
 *  that started a line with `flow …` was refused as an invocation. A head that execs its argument is not
 *  masked: a heredoc fed to `sh`/`node`/`python` really executes, and prose-is-argument is a rule about
 *  data, not a licence to unsee code. Unterminated bodies are left alone (fail toward judging more).
 *  shortcut: a heredoc whose redirector sits on a continuation line takes the head of that line, so a
 *  re-exec head written on the line above keeps its body judged — again the safe direction. */
export function stripHeredocBodies(command: string): string[] {
	const lines = command.split("\n");
	const out = lines.slice();
	const skip = new Set<number>(); // redirector lines, so a nested opener inside a body is never parsed
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (skip.has(i) || line.trim() === "") {
			i++;
			continue;
		}
		const m = line.match(HEREDOC_OP);
		if (!m || REEXEC_HEADS.has(heredocHead(line))) {
			i++;
			continue;
		}
		const term = m[3];
		const tab = !!m[1];
		const stops: number[] = [];
		let j = i + 1;
		let terminated = false;
		while (j < lines.length) {
			const t = tab ? lines[j].trimStart() : lines[j];
			if (t === term) {
				terminated = true;
				break;
			}
			const inner = skip.has(j) ? null : lines[j].match(HEREDOC_OP);
			if (inner && !REEXEC_HEADS.has(heredocHead(lines[j]))) {
				// a nested heredoc: its body is data for the data — skip past its terminator unparsed
				const it = inner[3];
				let k = j + 1;
				for (; k < lines.length && lines[k] !== it; k++) skip.add(k);
				if (k < lines.length) {
					skip.add(k);
					j = k + 1;
					continue;
				}
			}
			stops.push(j);
			j++;
		}
		if (!terminated) {
			i++;
			continue; // an unterminated body is left for the guard to judge — masking less is the safe direction
		}
		for (const l of stops) out[l] = "";
		out[i] = line.replace(HEREDOC_OP, " ");
		skip.add(i);
		i = j + 1;
	}
	return out;
}

/** The head a heredoc redirector belongs to: the first word of its line, env-prefixes and a `dir/` path
 *  ignored (`/usr/bin/git commit -F - <<'MSG'`), so REEXEC_HEADS reads the verb and not the path. */
function heredocHead(line: string): string {
	return segHead(line.replace(/^(?:\w+=\S*\s+)+/, "")).replace(/\S*\/$/, "");
}

/** Split on shell separators — but only outside quotes. Text inside quotes is an argument's prose, not a
 * command: a gh --body that discusses a commit is one segment, not five. Unbalanced quoting keeps the plain
 * split, so a stray quote cannot be used to hide a real command. The same split the git guard uses, so
 * `cd … &&`, `;`, pipes and `&` each judge on their own. Heredoc bodies are stripped first (see
 * stripHeredocBodies) — a `git commit -F - <<'MSG'` message is an argument, not five commands. */
export function bashSegments(command: string): string[] {
	const src = stripHeredocBodies(command).join("\n");
	if (!quotesBalanced(src)) return src.split(/[\n;|&]+/).map((s) => s.trim()).filter(Boolean);
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		const esc = i > 0 && src[i - 1] === "\\" && q !== "'";
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
/** Write-capable flags that make a READ_ONLY head a writer after all: `find -delete`, `find -exec`,
 *  `sort -o FILE`, `awk 'BEGIN{system(...)}'`. Over-flagging only means a rule gets evaluated. */
const WRITE_FLAG = /(?:^|\s)(?:-delete|-exec(dir)?\b|-o\s)|\bsystem\(/;
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "cat-file", "ls-files", "rev-parse"]);
const GIT_INVOKED = /(^|[\s/;|&(])git\s+(\S+)/;

// project.md is re-parsed on every tool call; compiled rules are cached by source.
// Process-global on purpose, and safe only because compile() builds flag-less regexes: no /g and no /y
// means no lastIndex, so a shared RegExp carries nothing mutable between sessions. Add a stateful flag
// here and this cache becomes cross-session state — the one thing this package must never keep.
const regexCache = new Map<string, RegExp | null>();
function compile(source: string): RegExp | null {
	if (!regexCache.has(source)) {
		try {
			regexCache.set(source, new RegExp(source));
		} catch {
			regexCache.set(source, null); // unreachable through project.md (parse validates) — kept so a bad rule never throws in a hook
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
		if (WRITE_FLAG.test(seg)) return false; // `find -delete`/`-exec`, `sort -o`, awk system() write behind a read-only head
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

/** A protect/forbid pattern whose last segment globs (`docker/.env*`) is a sibling set: the files in that
 *  directory whose basename matches. A secret's backup beside it is the same secret, and a prefix rule
 *  cannot say that — `docker/.env*` as a path names one file literally called `.env*` and guards nothing.
 *  Anywhere else in the pattern a glob is not supported (see the parse warning in projectmd.ts). */
function globSegment(pattern: string): { dir: string; re: RegExp } | null {
	const base = path.basename(pattern);
	if (!/[*?]/.test(base)) return null;
	const re = base
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return { dir: path.dirname(pattern), re: new RegExp(`^${re}$`) };
}

/** Protect/forbid verdict for an edit/write target: a rule on a directory covers its subtree, and
 *  comparing realpaths means `../` cannot reach out of the root. */
export function guardPath(abs: string, root: string, g: GuardRules): { block: string | null; confirm: string | null } {
	const real = realAbs(path.resolve(abs)); // resolve collapses lexical `..` so an escape cannot dodge the rule
	const hit = (rule: GuardRule): boolean => {
		const glob = globSegment(rule.pattern);
		if (glob) {
			// the directory is realpath'd the same way, so a symlinked or `..`-reached dir cannot dodge the rule
			return path.dirname(real) === realAbs(path.resolve(root, glob.dir)) && glob.re.test(path.basename(real));
		}
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
 * A throwaway outside the repository, which is not a repo write at all: a mechanical multi-file rewrite
 * needs somewhere to keep a scratch script, and refusing `/tmp/split_skill.py` only taught agents to park
 * junk inside the checkout. Both sides are realpath'd, so a symlink in the temp dir cannot reach back into
 * the guarded checkout, and `repoRoot` keeps a repository that merely lives under the temp dir (every
 * smoke-test repo) under the normal stage rules.
 */
/** The main checkout a linked worktree shares its history with, from git's answer for the common dir
 *  (`<main>/.git`), or null when there is nothing to remap: git did not answer, or cwd already is that
 *  checkout (a plain clone answers its own dir). */
export function mainCheckoutRoot(cwd: string, commonDir: string | null): string | null {
	if (!commonDir) return null;
	const main = path.resolve(path.dirname(path.resolve(cwd, commonDir)));
	return main === path.resolve(cwd) ? null : main;
}

/** A bound feature's scratch dir: every process the flow runs for it gets this as TMPDIR, so throwaways
 *  and test fixtures land inside `.dev-flow/<slug>/` and `flow finish` removes them with the feature. */
export function featureTmpDir(dfDir: string, slug: string): string {
	return path.join(dfDir, slug, "tmp");
}

/** The env every process of a bound feature gets: TMPDIR in the feature's scratch dir, and that dir as a
 *  git ceiling. The scratch dir sits inside the repo, so without the ceiling git walks up out of a
 *  test's mkdtemp fixture and answers with the enclosing checkout — a suite asserting "no repo here"
 *  goes red only under dev-flow (lettuce rail-ui-fixes: a build-info test failed every gate run).
 *  Commands run from the worktree or the main checkout never climb through the scratch dir, so they
 *  are untouched. An inherited ceiling list is kept. */
export function featureTmpEnv(dir: string, inherited = process.env.GIT_CEILING_DIRECTORIES): Record<string, string> {
	return { TMPDIR: dir, GIT_CEILING_DIRECTORIES: inherited ? `${dir}${path.delimiter}${inherited}` : dir };
}

/** The agent's shell command with the feature env (featureTmpEnv) exported (newline-prefixed, the
 *  shape pi's own commandPrefix uses — the command itself stays byte-for-byte what the guards judged). */
export function withTmpDir(command: string, dir: string): string {
	return `export TMPDIR=${sq(dir)} GIT_CEILING_DIRECTORIES=${sq(dir)}\${GIT_CEILING_DIRECTORIES:+:\$GIT_CEILING_DIRECTORIES}\n${command}`;
}

export function inScratchDir(abs: string, repoRoot?: string | null): boolean {
	const real = realAbs(abs);
	if (repoRoot) {
		const root = realAbs(path.resolve(repoRoot));
		if (real === root || real.startsWith(root + path.sep)) return false;
	}
	const tmp = realAbs(path.resolve(os.tmpdir()));
	return real === tmp || real.startsWith(tmp + path.sep);
}

/**
 * Write guard with per-path attribution: writes inside a worktree are judged by that
 * worktree's own feature; main-checkout writes are judged by the session's bound feature
 * (release+ may touch it; plan/implement may not); with no binding and unfinished features
 * the session must bind first (`flow use`). Flow-by-default: a session with no flow may not
 * touch the checkout at all — a bound feature is the only way in.
 * Returns a reason or null (allowed).
 */
export function writeGuard(o: { abs: string; dfDir: string; features: FeatureRef[]; boundSlug: string | null; repoRoot?: string | null; ignored?: boolean }): string | null {
	// Judge where the bytes land, not where the path pretends: a symlink inside the worktree pointing
	// out of it is the same write as the target path (realAbs walks the deepest existing ancestor, so
	// a brand-new file under a real directory resolves right, and a never-existing one is stable).
	const abs = realAbs(o.abs);
	const dfDir = realAbs(o.dfDir);
	if (abs === path.join(dfDir, "project.md")) return "project.md is the operator playbook — change it with flow init --write (setup) or inside a docs/patch flow's worktree";
	if (abs.endsWith("state.json") && abs.includes(dfDir + path.sep)) return "state.json is dev-flow-owned — advance stages with the flow tool only";
	if (abs.endsWith("claim.json") && abs.includes(dfDir + path.sep)) return "claim.json is dev-flow-owned — the live-session lock is not an edit target; take a feature over with flow use <slug>";
	// Owner attribution BEFORE the .dev-flow allow: with the default worktreeDir inside .dev-flow,
	// a worktree must still be judged by its owning feature's stage, not treated as free plan space.
	const owner = o.features.find((f) => within(abs, f.worktreeAbs ? realAbs(f.worktreeAbs) : null));
	if (owner) {
		if (owner.state.stage === "plan") return `feature ${owner.state.slug} is in plan — code is read-only until its plan is approved`;
		// the playbook copy inside a worktree: only operator-granted lightweight modes may change it
		if (path.basename(abs) === "project.md" && abs.includes(path.join(".dev-flow", "project.md")) && !owner.state.docs && !owner.state.patch)
			return `project.md changes belong to a docs or patch flow — ${owner.state.slug} is a normal feature (flow start <slug> --docs --confirmed)`;
		return null; // implement/pre-release/release: own worktree is the working area
	}
	// Scratch outside the checkout is not a repo write: every stage (and an unbound session) may use it. It
	// sits after the dev-flow-owned refusals and after owner attribution, so no path shape — a symlink, or a
	// worktreeDir an operator parked in the temp dir — reaches those rules through the temp dir.
	if (inScratchDir(abs, o.repoRoot)) return null;
	const bound = o.boundSlug ? o.features.find((f) => f.state.slug === o.boundSlug) : undefined;
	// A plan-stage session may only write its own feature directory: otherwise one session edits another
	// feature's plan and that feature's approval gate then rubber-stamps text it never wrote.
	if (bound?.state.stage === "plan" && !within(abs, path.join(dfDir, bound.state.slug)))
		return `bound feature ${bound.state.slug} is in plan — write only inside its own .dev-flow/${bound.state.slug}/`;
	if (within(abs, dfDir)) {
		// `.dev-flow/` is not a free write area: it gitignores everything, so the blanket allow let an unbound
		// session drop arbitrary files there (.dev-flow/COMMUNICATION-PLAN.md was one) — a folder whose whole
		// point is flow state must not double as an untracked scratch dir. Only the two advisory files the
		// agent owns stay writable with no binding; project.md is refused above, state/claim.json too.
		if (DF_ADVISORY_FILES.has(path.relative(dfDir, abs))) return null;
		if (!bound) return `.dev-flow/ holds flow state — an unbound session may write only its advisory files there (.dev-flow/reflections.md, .dev-flow/roadmap.md); bind with flow start <slug> or flow use <slug>, and a throwaway script goes outside the repo (under $TMPDIR)`;
		// another feature's directory, or a hand-made one shaped like a feature (`<x>/plan/…`): a plan dir
		// with no state.json is a ghost no gate can pick up — `flow start` refuses the existing dir, `flow use`
		// finds no state, doctor offers to delete it. A spin-off feature is parked in the roadmap instead.
		const [top, second] = path.relative(dfDir, abs).split(path.sep);
		if (top !== bound.state.slug && (second === "plan" || o.features.some((f) => f.state.slug === top)))
			return `.dev-flow/${top}/ is not this session's feature (${bound.state.slug}) — never create a feature dir by hand: park a new feature with flow roadmap add "<title>" --slug=${top} --brief=<notes> (the brief seeds its plan), and flow start ${top} once ${bound.state.slug} ships`;
		return null;
	}
	if (bound) {
		if (bound.state.stage === "implement" || bound.state.stage === "pre-release")
			return `bound feature ${o.boundSlug} is at ${bound.state.stage} — edit its worktree (${bound.state.worktree}), not the main checkout; a throwaway script goes in $TMPDIR (.dev-flow/${o.boundSlug}/tmp/, removed at finish)`;
		return null; // release: release chores may touch the main checkout
	}
	// a path git ignores can never reach a commit nor dirty the checkout finish proves clean: a per-machine
	// file (local secrets, editor state) is not source, and refusing it only sent agents around the guard
	// through bash (gh#175). The caller asks git; tracked and untracked-unignored paths stay refused.
	if (o.ignored) return null;
	const ignoreHint = " — a per-machine file that must never be committed: add its path to .git/info/exclude first (a git-ignored path is writable without a flow)";
	if (!o.features.length) return `no active flow — every request goes through flow: flow start <slug> for new work, flow use <slug> for an unfinished feature${ignoreHint}`;
	return `unfinished features: ${o.features.map((f) => f.state.slug).join(", ")} — bind this session with flow use <slug> (or pass an explicit slug to gates)${ignoreHint}`;
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

/** True only when another live session holds the claim — its feature can only be taken by an explicit `flow use`, never quietly. */
export function claimBlocks(claim: SessionClaim | null, myKey: string, alive: (pid: number) => boolean = pidAlive): boolean {
	return !!claim && claim.key !== myKey && alive(claim.pid);
}

/** Footer glyph per stage: the footer has no room for stage words and no legend of its own (README:Status bar is the legend). */
export const STAGE_EMOJI: Record<Stage, string> = { plan: "📝", implement: "🔨", "pre-release": "🔍", release: "🚀" };

/** Mode markers in footer order: ⚡ patch / 📚 docs, 🎱 yolo, 💬 unanswered checkpoint. */
function modeMarkers(state: FlowState): string[] {
	// 💬 is the legend's "operator, your turn" (docs/playbook.md stage lines): a bound flow whose checkpoint
	// is unanswered is parked on the operator, and the footer is the only thing they see.
	return [state.patch ? "⚡" : state.docs ? "📚" : "", state.yolo ? "🎱" : "", state.pendingAsk ? "💬" : ""].filter(Boolean);
}

export function statusCompact(state: FlowState): { text: string; failed: boolean } {
	const failed = Object.values(state.checks).some((c) => !c.ok);
	return { text: [STAGE_EMOJI[state.stage], state.slug, ...modeMarkers(state)].join(" "), failed };
}

/** Footer decision for any session in an initiated repo: a bound feature renders as statusCompact, its ⚠️
 *  from its own failing checks only; an unbound session shows the count of unfinished features — never a
 *  slug, so a fresh session is never shown (or made to feel bound to) a feature it did not take with flow
 *  use — and `💬 no flows` when nothing is in flight: dev-flow initiated means a footer always present.
 *  💬 is the legend's "operator, your turn": an unbound session is parked on the operator by definition (an
 *  answer to start, or nothing to do until they say), so the pre-flow glyph is the honest one there too. */
export function statusFor(bound: FlowState | null, openCount: number): { text: string } {
	if (bound) {
		const { text, failed } = statusCompact(bound);
		return { text: failed ? `${text} ⚠️` : text };
	}
	if (openCount < 1) return { text: "💬 no flows" };
	return { text: `💬 ${openCount} flow${openCount === 1 ? "" : "s"} open` };
}

/** The pi-web footer chip's label: pi-web chips are a fixed ~108px and ellipsize anything longer, so the
 *  unbound count drops the word "flows" (`💬 2 open`; the panel spells the flows out), and a bound flow
 *  packs every glyph up front with no spaces — stage, markers, ⚠️ — then the slug (`🔨⚡⚠️my-feature`):
 *  the state survives the ellipsis, only the slug's tail clips (the hover tooltip shows it whole). */
export function chipLabel(bound: FlowState | null, openCount: number): string {
	if (bound) {
		const failed = Object.values(bound.checks).some((c) => !c.ok);
		return `${STAGE_EMOJI[bound.stage]}${modeMarkers(bound).join("")}${failed ? "⚠️" : ""}${bound.slug}`;
	}
	if (openCount < 1) return statusFor(bound, openCount).text;
	return `💬 ${openCount} open`;
}

/** The pi-web footer chip's panel lines: the chip's label already is this session's footer (the bound
 *  flow, or the open count), so the panel lists only the OTHER unfinished flows, one lean line each —
 *  glyph + markers ride on statusCompact so panel and footer never drift in vocabulary — plus the
 *  spelled-out stage word and the `⚠️` on failing checks. A bound session alone in the repo gets one
 *  "no other flows open" line (the chip still expands, never looks dead); unbound with nothing open
 *  gets no lines (a plain `💬 no flows` chip). `flow status` stays the detailed surface. */
export function widgetLines(bound: FlowState | null, states: FlowState[]): string[] {
	const others = states.filter((st) => st.slug !== bound?.slug);
	if (bound && !others.length) return ["no other flows open"];
	return others.map((st) => {
		const { text, failed } = statusCompact(st);
		return `${text} · ${st.stage}${failed ? " ⚠️" : ""}`;
	});
}

/** `- [ ]` checklist items of a markdown document (reflections.md and roadmap.md share the format). */
export function openChecklistItems(text: string): string[] {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- [ ] "));
}

/** Checked-off (`- [x]`) items — what `flow reflect tidy` and `flow roadmap tidy` drop. */
export const doneItemCount = (text: string) => text.split("\n").filter(isDoneItem).length;

/** Drop the closed (`- [x]`) reflection items: the preamble and the open lines stay verbatim
 *  (a line filter — no re-bucketing like appendReflection's rewrite), and a `## section` heading
 *  left with no open items under it goes with its items. */
export function reflectionsTidy(text: string): string {
	const bucket = (l: string) => (REFLECT_HEADING.test(l) ? REFLECT_HEADING.exec(l)![1].toLowerCase() : "unfiled");
	const lines = text.split("\n");
	// pass 1: open items per heading decides which sections survive; items above every heading are legacy flat lines with no heading to drop
	let section: string | null = null;
	const openUnder = new Map<string, number>();
	for (const raw of lines) {
		const l = raw.trim();
		if (ANY_HEADING.test(l)) section = bucket(l);
		else if (section && isOpenItem(l)) openUnder.set(section, (openUnder.get(section) ?? 0) + 1);
	}
	// pass 2: closed items never survive; an emptied heading never survives
	const out: string[] = [];
	section = null;
	for (const raw of lines) {
		const l = raw.trim();
		if (ANY_HEADING.test(l)) {
			section = bucket(l);
			if ((openUnder.get(section) ?? 0) > 0) out.push(raw);
			continue;
		}
		if (isDoneItem(raw)) continue;
		out.push(raw);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Shared wording for every surface that notices closed items piling up, so all hints read alike. */
export const reflectionsTidyHint = (closed: number) => `↻ ${closed} closed reflection(s) — flow reflect tidy drops them`;

/** The note text of an item, without the checkbox and without the trailing ` — <attribution>`: what
 *  two reflects are compared on, so the same note at another date is still the same note.
 *  shortcut: split on the last em dash — matches what the tool writes; a hand-written item ending in
 *  an em-dash clause compares wider than intended. */
const reflectionBody = (l: string) => l.trim().replace(/^-\s*\[[ xX]\]\s*/, "").replace(/\s*—.*$/, "").trim();

/** One reflections.md item line — with no flow bound the slug is left out; `— - <date>` read as a broken slug. */
export function reflectionLine(note: string, slug: string | null, date: string): string {
	return `- [ ] ${note.trim()} — ${slug ? `${slug} ` : ""}${date}`;
}

export const REFLECT_HEADER =
	"# dev-flow reflections\n\n<!-- This project's queue, filed by the agent; the operator decides. ## playbook = fix in project.md (docs flow), ## code = fix in code (patch flow). dev-flow plugin feedback never lands here — it is filed as a GitHub issue upstream. Check off when handled. -->\n";

/** The sections a note can be written to, in document order: `playbook` — the fix lives only in
 *  project.md (docs flow); `code` — the fix touches project code, maybe the playbook too (patch flow).
 *  Plugin feedback has no section: it is filed as an upstream GitHub issue, never kept locally. */
export const REFLECT_SECTIONS = ["playbook", "code"] as const;
export type ReflectSection = (typeof REFLECT_SECTIONS)[number];
/** `## plugin` from before plugin notes went upstream: still read (and flagged), never written to. */
const LEGACY_SECTIONS = ["plugin"] as const;
type KnownSection = ReflectSection | (typeof LEGACY_SECTIONS)[number];
const KNOWN_SECTIONS: readonly KnownSection[] = [...REFLECT_SECTIONS, ...LEGACY_SECTIONS];

/** One matcher for the section headings: the writer, the tidy and the reader share it, so a heading
 *  one of them accepts cannot be invisible to another. */
const REFLECT_HEADING = new RegExp(`^##\\s*(${KNOWN_SECTIONS.join("|")})\\s*$`, "i");
/** Any `## …` line claims the items under it — one that names no section leaves them unfiled, so the
 *  reader (and doctor) can say so instead of inheriting whichever heading came before. */
const ANY_HEADING = /^##/;

/** An open reflections.md item together with the section that owns it. The heading is the record of
 *  where a note was filed; the keyword guess is made once, when the note is queued. */
export interface ReflectItem {
	/** the `## section` the line sits under; "plugin" = legacy heading (belongs on GitHub); "unfiled" = above every heading or under an unknown one */
	section: KnownSection | "unfiled";
	/** the verbatim `- [ ] …` line, trimmed */
	line: string;
	/** the note without checkbox and without the ` — attribution` tail */
	body: string;
}

/** Open items of reflections.md, each carrying the heading that owns it. Items above every known
 *  heading (a legacy flat file) or under an unknown `## …` heading come back "unfiled" instead of
 *  silently inheriting whichever bucket came before them. */
export function reflectItems(text: string): ReflectItem[] {
	const out: ReflectItem[] = [];
	let section: KnownSection | "unfiled" = "unfiled";
	for (const raw of text.split("\n")) {
		const l = raw.trim();
		if (ANY_HEADING.test(l)) {
			const h = REFLECT_HEADING.exec(l);
			section = h ? (h[1].toLowerCase() as KnownSection) : "unfiled";
			continue;
		}
		if (!isOpenItem(l)) continue;
		out.push({ section, line: l, body: reflectionBody(l) });
	}
	return out;
}

/** Open items the file does not place in a known section — doctor names the count so a note that
 *  would once have quietly migrated to `## playbook` on the next write gets moved on purpose. */
export const reflectUnfiledCount = (text: string) => reflectItems(text).filter((i) => i.section === "unfiled").length;
/** Open items still under the legacy `## plugin` heading — doctor and list ask for each to be filed upstream. */
export const reflectLegacyPluginCount = (text: string) => reflectItems(text).filter((i) => i.section === "plugin").length;

// The classifier decides where a note being queued LANDS — nothing re-derives it afterwards.
// Signals are ranked. A note that names dev-flow's own surface is a plugin issue, and its commands
// and files are a closed set, so that read is high-precision. Vague words (tool, hook, session) are
// weak on purpose: every project has git hooks and CI gates of its own, and matching those as
// "plugin" is how project feedback ended up in the plugin queue.
const PLUGIN_STRONG_SRC =
	"\\bflow (?:help|init|reflect|roadmap|doctor|status|start|use|test|check|health|approve|verify|release(?:-done)?|finish|abort|version)\\b|\\/flow\\b|\\.dev-flow\\b|state\\.json|flow-guard|flow-check|\\bdoctor\\b|\\bgates?\\b|\\bguards?\\b|checkpoint|worktree";
const PLUGIN_STRONG_ALL = new RegExp(PLUGIN_STRONG_SRC, "gi");
/** …but "CI gate", "deploy gate", "review gate" is the project's own gate, not a flow gate. */
const PROJECT_QUALIFIED = /\b(?:ci|cd|deploy|staging|stage|prod(?:uction)?|build|lint|review|preview|merge|security)\s+(?:gates?|checks?|hooks?|tools?|tooling)\b/i;
const PLAYBOOK_STRONG = /project\.md|playbook|checklist|defaultBranch|merge policy|versionFile|versionTag|release rules|(?:npm|pnpm|yarn|bun|make|cargo)\s+\S+|\b(?:our|this) (?:repo|project)\b|health (?:command|endpoint)/i;
const PLUGIN_WEAK = /\b(plugin|extension|dev-flow|tool|session|compact\w*|hook|status bar)\b/i;
const PLAYBOOK_WEAK = /\b(playbook|checklist|versioning|prose|setup|docs?|readme)\b/i;

/** Where a note belongs: one of this project's sections, or `plugin` — dev-flow itself, filed upstream. */
export type ReflectTarget = ReflectSection | "plugin";

export interface ReflectGuess {
	target: ReflectTarget;
	/** why the note landed there — printed, so a wrong guess is visible at the moment it is filed */
	why: string;
}

/** Where a fresh note lands: ONE home. A strong plugin signal wins (it goes upstream, not into the
 *  file); otherwise the playbook, where the operator reads it and can move it. `code` is never a
 *  guess — the agent states it with --code. */
export function guessReflectSections(note: string): ReflectGuess {
	// never classify the ` — <slug> <date>` tail: slugs are made of "guard", "release", "versioning"
	const body = reflectionBody(note);
	// every signal counts, not just the first one found: "the CI gate is wrong, flow doctor reports it
	// twice" is a plugin note even though its earliest match is a demoted one
	const qualified = PROJECT_QUALIFIED.test(body);
	const hits = [...body.matchAll(PLUGIN_STRONG_ALL)]
		.map((m) => m[0].trim())
		.filter((h) => !(qualified && /gates?|guards?/i.test(h)));
	if (hits.length) return { target: "plugin", why: `"${hits[0]}" names dev-flow itself` };
	const plug = PLUGIN_WEAK.test(body);
	const playStrong = PLAYBOOK_STRONG.test(body);
	const play = playStrong || PLAYBOOK_WEAK.test(body);
	if (plug && !play) return { target: "plugin", why: "plugin wording" };
	if (play) return { target: "playbook", why: playStrong ? "playbook or project wording" : "playbook wording" };
	return { target: "playbook", why: "nothing plugin-shaped in the note — a code fix: flow reflect move <n> --code; a dev-flow bug: file it upstream (flow reflect --plugin)" };
}

/** How a plugin note is filed: never into reflections.md — search the upstream tracker, then open an
 *  issue whose body ends in the `— reflection from` tail the fold matches on. dev-flow runs nothing
 *  itself; the agent runs these on the operator's fold answer. */
export function pluginIssueRecipe(note: string, upstream: string, slug: string | null, date: string): string[] {
	const title = reflectionBody(note).replace(/"/g, "'");
	const tail = `— reflection from ${slug ? `${slug} ` : ""}${date}`;
	if (!upstream)
		return [
			`plugin note — not written to reflections.md (dev-flow feedback is filed upstream, never kept in a project): "${title}"`,
			"upstream repo unknown — ask the operator for the dev-flow repo, then file a GitHub issue with a detailed description, session evidence and a suggested fix,",
			`ending the body with '${tail}'.`,
		];
	return [
		`plugin note — not written to reflections.md (dev-flow feedback is filed upstream, never kept in a project): "${title}"`,
		`1. dedupe: gh issue list --repo ${upstream} --state all --search "<keywords>" — an issue the author already answered (fixed in v… / won't-fix) is reported back, never re-filed.`,
		`2. no match: gh issue create --repo ${upstream} --title "${title}" --body "<what happened, session evidence, suggested fix>\n\n${tail}"`,
		"3. report the issue URL to the operator. No gh / offline: hand the operator the title and body to file by hand.",
	];
}

/** Where a fix must be implemented: every fix runs through a flow whose gates confirm it —
 *  playbook-only change → docs flow; code change → patch flow (normal flow when bigger); a legacy
 *  `## plugin` row → upstream issue (or the code route in the dev-flow repo itself). */
export interface ReflectionRoute {
	text: string;
	sections: (KnownSection | "unfiled")[];
	mode: "docs" | "code" | "upstream";
	route: string;
}

const DOCS_ROUTE = "docs flow (flow start fold-<topic> --docs --confirmed) — project.md edits only pass its worktree";
const CODE_ROUTE = "patch flow (flow start fix-<topic> --patch --confirmed), normal flow when bigger";

export function reflectionRoutes(items: ReflectItem[], selfRepo: boolean): ReflectionRoute[] {
	return items.map((it) => {
		const text = it.line.replace(/^-\s*\[[ xX]\]\s*/, "").trim();
		const sections = [it.section];
		if (it.section === "code") return { text, sections, mode: "code" as const, route: CODE_ROUTE };
		if (it.section === "plugin")
			return selfRepo
				? { text, sections, mode: "code" as const, route: `${CODE_ROUTE} — legacy ## plugin row: flow reflect move <n> --code files it where it belongs` }
				: { text, sections, mode: "upstream" as const, route: "legacy ## plugin row — belongs on GitHub, not here: file it upstream (flow reflect --plugin \"<note>\" prints the recipe), then check it off '— filed: gh#NNN'" };
		return { text, sections, mode: "docs" as const, route: DOCS_ROUTE };
	});
}

/** Move open item n (1-based over open items — the numbering `flow reflect list` prints) under
 *  `## section`. null = out of range; an item already in that section comes back unchanged, so the
 *  caller can say so instead of pretending to relocate it. */
export function reflectMove(text: string, n: number, section: ReflectSection): string | null {
	const lines = text.split("\n");
	let seen = 0;
	let hit = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!isOpenItem(lines[i])) continue;
		if (++seen === n) {
			hit = i;
			break;
		}
	}
	if (hit < 0) return null;
	const [line] = lines.splice(hit, 1);
	return appendReflection(lines.join("\n"), [section], line.trim());
}

/** Check open item `n` (the `flow reflect list` numbering) off: `- [x] … — fixed: <note>` — the convention
 *  doctor reads as closed, so a folded item stops re-nagging (#165). null when there is no item `n`. */
export function reflectDone(text: string, n: number, note: string): string | null {
	const lines = text.split("\n");
	let seen = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!isOpenItem(lines[i])) continue;
		if (++seen !== n) continue;
		lines[i] = `${lines[i].replace(/^(\s*)- \[ \] /, "$1- [x] ").trimEnd()} — fixed: ${note.trim()}`;
		return lines.join("\n");
	}
	return null;
}

/** What `flow doctor <note>` prints: the note is an investigation order, not an answer —
 *  the plugin has no LLM; the agent investigates, the gates confirm, the flow implements. */
export function investigationBrief(note: string, selfRepo: boolean): string[] {
	const guess = guessReflectSections(note);
	const target = guess.target === "plugin" ? (selfRepo ? "code" : "plugin") : guess.target;
	const route =
		target === "plugin"
			? "file a GitHub issue upstream (flow reflect --plugin \"<note>\" prints the recipe) — plugin notes never go into reflections.md"
			: target === "code"
				? CODE_ROUTE
				: DOCS_ROUTE;
	return [
		`investigate: "${note.trim()}"`,
		"read first: .dev-flow/project.md, flow doctor findings, and whatever files the note names.",
		target === "plugin" ? `if it is real it is dev-flow feedback (${guess.why}) — an upstream issue, not a local row` : `if it is real it belongs in ## ${target} (${guess.why})`,
		`fix routing: ${route}`,
		"the note is not implemented by doctor — propose the fix to the operator first; only after they confirm, open the routed flow; its gates carry the confirmation.",
	];
}

/** Bare `flow reflect`: the session-reflection protocol for the agent (the plugin has no LLM). Bound to
 *  a flow, the review itself is delegated to a fresh reflect worker (flow_stage op "reflect") that reads
 *  the driver's and every worker's transcript; unbound, the agent runs the review inline. Either way the
 *  operator decides fold or drop per finding. Writes nothing, runs no network calls. */
export function reflectProtocol(
	items: ReflectItem[],
	selfRepo: boolean,
	facts: { version: string | null; upstream: string; tidy?: string | null; fix?: string | null; bound?: boolean; ghFold?: { repo: string; open: number; similar: number } },
): string[] {
	const ver = facts.version ? `dev-flow ${facts.version}` : "dev-flow version unknown";
	const up = facts.upstream || "<upstream — ask the operator for the dev-flow repo>";
	const url = facts.upstream ? `https://github.com/${facts.upstream}` : "<upstream-url>";
	const review = facts.bound
		? '1. delegate the review: call flow_stage(op: "reflect", note: "<anything the operator said about friction this session>") — a fresh read-only reviewer reads this session\'s transcript and every flow_stage worker transcript, re-checks the open items below and returns a classified list (docs / code / plugin) with a fold-or-drop recommendation per finding. Only if the worker fails, do the review inline: read the full session log — every message, tool call and result.'
		: "1. review the current session log in full — every message, tool call and result: friction, wrong turns, repeated failures, guards or gates that misfired, playbook drift, optimization candidates. Classify each finding: docs (fix only in project.md), code (fix in this project's code, maybe the playbook too) or plugin (dev-flow itself).";
	const lines = [
		`flow reflect — session reflection (${ver}, upstream: ${up})`,
		"this output is your work instruction: execute these steps now — do not echo the protocol and do not ask to begin.",
		"queue: .dev-flow/reflections.md — this project's queue only (## playbook → docs flow, ## code → patch flow); dev-flow plugin feedback is never written there, it becomes a GitHub issue upstream. Gitignored and yours to edit; check items off as `- [x] … — fixed: <what or where>`.",
		review,
		`2. re-check every open item below: handled by the current playbook (.dev-flow/project.md) or code, or obsolete → propose checking it off with a fixed: note. dev-flow behaviour possibly fixed in a newer release: npm view pi-dev-flow version — newer → recommend the operator update (pi install npm:pi-dev-flow, then /reload; a git-installed copy: git ls-remote --tags --sort=-v:refname ${url} | head -1), never update it yourself.`,
		"3. show the operator the findings as one numbered list — per item: the note, its kind (docs / code / plugin), its route (docs flow / patch flow / upstream issue), a duplicate it matches, and your recommendation (fold or drop, with a one-clause reason). Ask fold or drop per item (one answer like 'fold 1,3 drop 2' is fine) and STOP until the operator answers.",
		"4. apply the answer: fold docs → flow reflect --playbook \"<note>\"; fold code → flow reflect --code \"<note>\"; fold plugin → flow reflect --plugin \"<note>\" prints the upstream recipe (dedupe search, then gh issue create — the fold answer is the operator's confirmation), report the issue URL; drop → nothing is recorded anywhere.",
	];
	if (facts.ghFold)
		lines.push(
			`upstream fold: ${facts.ghFold.open} open issue(s) on ${facts.ghFold.repo} ride along in flow doctor and flow reflect list — treat them as already filed: never file a finding an open issue covers, resolve them on GitHub (close there, never in reflections.md)${facts.ghFold.similar ? `; ${facts.ghFold.similar} flagged near-duplicate(s) of local items need your verdict before anything is fixed twice` : ""}.`,
		);
	if (facts.fix) lines.push(`${facts.fix} — offer it to the operator after the fold/drop answer.`);
	if (facts.tidy) lines.push(`${facts.tidy} — offer it to the operator after the fold/drop answer; check an item off only when it is handled.`);
	if (!items.length) lines.push("open items: none — steps 1, 3 and 4 still apply.");
	else {
		lines.push(`open items (${items.length}):`);
		for (const r of reflectionRoutes(items, selfRepo)) lines.push(`  [${r.sections.join("+")}] ${r.text}`, `      → ${r.route}`);
	}
	return lines;
}

/**
 * Rewrite reflections.md as a preamble + one section per non-empty bucket, with `line` appended to
 * the end of each named section. Everything above the first item (title, comment, operator notes) is
 * kept verbatim. Below the first item a `## section` heading owns the lines under it, so an existing
 * line never changes section; an item under no known heading files under `## playbook` (where the
 * operator reads it — `flow reflect move` re-files it). Legacy `## plugin` rows are kept verbatim
 * (last, so they read as the leftover they are) but nothing new is ever written there. A note already
 * in a section is not written there again — an all-duplicate call returns the content untouched so the
 * caller can say so.
 */
export function appendReflection(text: string, sections: ReflectSection[], line: string): string {
	const lines = text.split("\n");
	const sectionHeader = REFLECT_HEADING;
	// shortcut: only the preamble above the first header or item survives verbatim; hand-written prose below the items is dropped.
	// a header is part of the body, not of the preamble: it owns the items under it, and one with no items left simply disappears from the rewrite.
	const firstBody = lines.findIndex((l) => l.trim().startsWith("- [") || sectionHeader.test(l.trim()));
	const preamble = (firstBody < 0 ? lines : lines.slice(0, firstBody))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const buckets = Object.fromEntries(KNOWN_SECTIONS.map((s) => [s, [] as string[]])) as Record<KnownSection, string[]>;
	let section: KnownSection | null = null;
	for (const raw of firstBody < 0 ? [] : lines.slice(firstBody)) {
		const l = raw.trim();
		if (ANY_HEADING.test(l)) {
			const header = sectionHeader.exec(l);
			// a heading is authoritative for the items under it: deriving the bucket from the inline
			// marker instead moved every marker-less `## plugin` line into `## playbook` on the next write.
			// an unknown `## …` heading places nothing (it used to inherit the previous section by accident).
			section = header ? (header[1].toLowerCase() as KnownSection) : null;
			continue;
		}
		if (!l.startsWith("- [")) continue;
		buckets[section ?? "playbook"].push(l);
	}
	const note = line.trim();
	const body = reflectionBody(note);
	// only open items block a duplicate: a checked-off note may be reported again when it comes back.
	for (const s of sections) if (!buckets[s].some((l) => l.trim().startsWith("- [ ]") && reflectionBody(l) === body)) buckets[s].push(note);
	return `${preamble || REFLECT_HEADER.trimEnd()}\n\n` + KNOWN_SECTIONS.filter((s) => buckets[s].length).map((s) => `## ${s}\n\n${buckets[s].join("\n")}\n`).join("\n");
}

/** The `YYYY-MM-DD` an item was filed — the first date in its ` — <slug> <date>` tail (a later
 *  ` — fixed: …` clause may carry another date; the note itself is never read). */
const itemDate = (line: string): string | null => {
	const at = line.indexOf(" — ");
	return at < 0 ? null : (/\b(\d{4}-\d{2}-\d{2})\b/.exec(line.slice(at))?.[1] ?? null);
};
const daysBetween = (from: string, to: string): number => Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Thresholds for the two timing nudges. Mid-feature is the wrong moment for either — they surface
 *  at finish, between flows, and in doctor. */
export const REFLECT_NUDGE = { staleDays: 14, docsBatch: 3, tidyClosed: 5, tidyMinClosed: 3, tidyAgeDays: 30 } as const;

/**
 * When to suggest fixing the open project reflections, and when to suggest the tidy. Pure: the
 * reflections.md text, today's date, and what the caller knows (`recurred` — open items the reflect
 * worker saw hit again this session; `between` — no flow bound, the natural moment to start one).
 * fix fires on: a recurrence (strongest), an item ≥ staleDays old, ≥ docsBatch playbook items (one
 * docs flow takes them all), or any code item while between flows. tidy fires on: ≥ tidyClosed
 * closed, closed ≥ open with ≥ tidyMinClosed closed, or a closed item filed ≥ tidyAgeDays ago.
 */
export function reflectionNudges(text: string, today: string, opts: { recurred?: number; between?: boolean } = {}): { fix: string | null; tidy: string | null } {
	const open = reflectItems(text).filter((i) => i.section !== "plugin");
	const docs = open.filter((i) => i.section === "playbook" || i.section === "unfiled").length;
	const code = open.filter((i) => i.section === "code").length;
	const stale = open.filter((i) => {
		const d = itemDate(i.line);
		return d !== null && daysBetween(d, today) >= REFLECT_NUDGE.staleDays;
	}).length;
	const why: string[] = [];
	if (opts.recurred) why.push(`${opts.recurred} recurred this session`);
	if (stale) why.push(`${stale} open ≥ ${REFLECT_NUDGE.staleDays} days`);
	if (docs >= REFLECT_NUDGE.docsBatch) why.push(`${docs} playbook items batch into one docs flow`);
	if (code && opts.between) why.push("between flows");
	let fix: string | null = null;
	if (open.length && why.length) {
		const split = [docs ? `${docs} playbook item(s) → one docs flow (flow start fold-<topic> --docs --confirmed)` : "", code ? `${code} code item(s) → patch flow (flow start fix-<topic> --patch --confirmed)` : ""].filter(Boolean).join("; ");
		fix = `⚑ fix the open reflections now? (${why.join(", ")}) — ${split}`;
	}
	const closedLines = text.split("\n").filter(isDoneItem);
	const closed = closedLines.length;
	const oldClosed = closedLines.some((l) => {
		const d = itemDate(l);
		return d !== null && daysBetween(d, today) >= REFLECT_NUDGE.tidyAgeDays;
	});
	const tidy =
		closed >= REFLECT_NUDGE.tidyClosed || (closed >= REFLECT_NUDGE.tidyMinClosed && closed >= open.length) || (closed > 0 && oldClosed)
			? reflectionsTidyHint(closed)
			: null;
	return { fix, tidy };
}

/** Header of roadmap.md — the backlog of future features (gitignored, agent-editable like reflections.md). */
export const ROADMAP_HEADER =
	"# dev-flow roadmap\n\n<!-- Backlog of features to build later. flow roadmap add/pick/done/tidy; a pick stamps its item (slug) and flow finish checks it off when that feature ships. -->\n";

// one strict format rules them all: the tool writes "- [ ] "/"- [x] " and counts exactly that —
// a looser matcher made `list` numbering disagree with what pick/done edit.
const isOpenItem = (line: string) => line.trim().startsWith("- [ ] ");
const isDoneItem = (line: string) => /^\s*-\s*\[[xX]\]\s/.test(line);
const stampItem = (line: string, stamp: string) => `- [x] ${line.trim().slice(6)} — done: ${stamp}`;

/** A brief line under a roadmap item: indented blockquote (`  > …`). The quote keeps a brief's own
 *  `- [ ]` lines from counting as backlog items (item matching trims, then wants a leading dash). */
const isBriefLine = (line: string) => /^\s+>/.test(line);

/** Append an open item to roadmap.md content; a header is minted from empty content. An optional
 *  brief (the notes a spin-off feature carries into its plan) lands as indented `  > ` lines under it. */
export function appendRoadmapItem(text: string, item: string, brief?: string): string {
	const body = (brief ?? "").replace(/\r/g, "").trim();
	const quoted = body ? `${body.split("\n").map((l) => `  > ${l}`.trimEnd()).join("\n")}\n` : "";
	return `${text.trimEnd() || ROADMAP_HEADER.trimEnd()}\n- [ ] ${item.trim()}\n${quoted}`;
}

/** The open item stamped `(slug)` and its brief (quote markers stripped) — what flow start seeds a
 *  picked feature's plan with. Null when no open item carries the stamp. */
export function roadmapBriefFor(text: string, slug: string): { item: string; brief: string } | null {
	const lines = text.split("\n");
	const i = lines.findIndex((l) => isOpenItem(l) && l.includes(`(${slug})`));
	if (i === -1) return null;
	const brief: string[] = [];
	for (let j = i + 1; j < lines.length && isBriefLine(lines[j]); j++) brief.push(lines[j].replace(/^\s+> ?/, ""));
	return { item: lines[i].trim().slice(6), brief: brief.join("\n").trim() };
}

/** Number of open roadmap items. */
export const roadmapOpenCount = (text: string) => openChecklistItems(text).length;

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

/** Remove the nth open item (1-based, open items only) and its brief — an idea the operator no longer
 *  wants, which `done` would record as shipped. Returns null when n is out of range. */
export function roadmapDrop(text: string, n: number): { text: string; item: string } | null {
	let seen = 0;
	let item: string | null = null;
	let dropping = false;
	const out = text.split("\n").filter((l) => {
		if (isBriefLine(l)) return !dropping;
		dropping = false;
		if (!isOpenItem(l) || ++seen !== n) return true;
		item = l.trim().slice(6);
		dropping = true;
		return false;
	});
	return item === null ? null : { text: out.join("\n"), item };
}

/** Check every open item stamped `(slug)` by a pick — flow finish closes the backlog item a picked feature ships.
 *  shortcut: "(slug)" matches as substring — item prose literally containing "(fin)" closes when fin ships; only pick-minted stamps are meant to match. */
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
	// a done item's brief goes with it — left behind it would read as the brief of the item above
	let dropping = false;
	const out = text.split("\n").filter((l) => {
		if (isBriefLine(l)) return !dropping;
		dropping = isDoneItem(l);
		return !dropping;
	});
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
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
	if (!d.stage) return false;
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

/** The playbook's merge style spelled for a hint: "" when the project has no policy. */
function mergeHintFor(cfg: Config): string {
	const m = cfg.release.merge;
	return m && m !== "any" ? ` (merge = ${m} — gh pr merge <n> --${m === "merge" ? "merge" : m}, number before the flag)` : "";
}

/** The block a flow-aware compaction appends to its summary: the flow's state as the disk holds it.
 *  A summarizer merging an older summary can carry a stale stage forward (lettuce rail-ui-fixes: a
 *  pre-release compaction still said "implement, next: flow verify"); this block is written from
 *  state.json, never by the model, and says it outranks the prose above it. */
export function compactionStateBlock(state: FlowState, cfg: Config): string {
	const approvals = Object.keys(state.approvals ?? {});
	const checks = Object.entries(state.checks ?? {}).map(([k, v]) => `${k}:${v?.ok ? "ok" : "FAILED"}`);
	return [
		"",
		"---",
		"[dev-flow state on disk — authoritative; where the summary above disagrees, this wins]",
		`- feature ${state.slug}${state.patch ? " (patch)" : state.docs ? " (docs)" : ""}${state.ui ? " (UI)" : ""} — stage: ${state.stage}${state.branch ? `, branch ${state.branch}` : ""}`,
		`- approvals recorded: ${approvals.length ? approvals.join(", ") : "none"}`,
		`- checks: ${checks.length ? checks.join(", ") : "none recorded"}`,
		`- next: ${nextHint(state, cfg)}`,
	].join("\n");
}

/** The next action for the agent, per stage — one line. The stage file (skills/dev-flow/references/)
 *  holds the how; this carries only what the gate knows and the file cannot: paths, the playbook's
 *  merge command, which versioning steps apply. */
export function nextHint(state: FlowState, cfg: Config): string {
	switch (state.stage) {
		case "plan":
			if (state.patch || state.docs) return `${state.patch ? "patch" : "docs"}: describe the change in one line, ask Approve? in chat, then flow approve --confirmed — no plan file${state.docs ? ", no tier-1 checks" : ""}`;
			return `clarify the direction in chat, write .dev-flow/${state.slug}/plan/plan.md${state.ui ? ` and render mockups to plan/mockups/ (${cfg.mockupGlobs.join(", ")}) with headless chromium, embedded in plan.md` : ""}, then ask Approve? and run flow approve --confirmed on the answer`;
		case "implement":
			if (state.docs) return `edit in ${state.worktree} (docs mode: no project commands), tick the tier-2 checklist with the operator, ask Verified?, then flow verify --confirmed`;
			return `build and test in ${state.worktree}, commit as you go, flow check; then flow verify (deploys for review), look yourself, keep the app running, ask Verified? and run flow verify --confirmed on the answer`;
		case "pre-release": {
			const prep = [cfg.release.changelog ? `prepare ${cfg.release.changelog} (fold Unreleased lines verbatim)` : "", cfg.versioning.file ? `bump version in ${cfg.versioning.file}` : ""].filter(Boolean).join(" and ");
			if (state.docs && prep) return `${cfg.release.review}, fix must/should; a docs flow usually ships unversioned — ask the operator (flow release --no-version on their word); versioned instead: ${prep}; then ask Release? and run flow release`;
			return `${cfg.release.review}, fix must/should, update docs${prep ? `, ${prep}` : ""}, flow check; show the PR summary, version and changelog, ask Release? and run flow release`;
		}
		case "release":
			if (state.approvals.release) return `release recorded — commit and push any release chores in the main checkout (DEV_FLOW_ALLOW_MAIN=1 for the pre-commit hook), then flow finish (closing reflection first; its fold/drop answer is Finish?)`;
			return `publish: push the branch, open the PR, merge once CI is green (gh pr checks <n> --watch)${mergeHintFor(cfg)}${state.noVersion ? " — unversioned: no bump, no tag" : ", push the annotated tag"}; then flow finish records the release and closes out`;
	}
}

/** Stable token prefixing every no-UI operator refusal, so a headless orchestrator can route refusals without grepping prose. */
export const NEEDS_OPERATOR = "NEEDS-OPERATOR";

/** Prefix of a gate-output line meant for the agent only: the operator's view (src/present.ts) leaves it out. */
export const AGENT_MARK = "↪ ";

/** Refusal for "the gate needs the operator's word and no UI is present": `<TOKEN> [Question?] — <what the
 *  operator should know>`, then the agent's own instructions on an agent-only line (`todo`). */
export function needsOperator(detail: string, question?: string, todo?: string): string {
	return `${NEEDS_OPERATOR}${question ? ` ${question}` : ""} — ${detail}${todo ? `\n${AGENT_MARK}${todo}` : ""}`;
}

/** Machine-readable `flow status --json`: the prose view's facts as stable JSON (no git probes, same as prose). */
export function statusJson(states: FlowState[], bound: string | null, cfg: Config): string {
	return JSON.stringify(
		{
			bound,
			features: states.map((st) => ({
				slug: st.slug,
				stage: st.stage,
				current: st.slug === bound,
				ui: st.ui,
				patch: !!st.patch,
				docs: !!st.docs,
				yolo: !!st.yolo,
				noVersion: !!st.noVersion,
				branch: st.branch || null,
				worktree: st.worktree || null,
				flowVersion: st.flowVersion ?? null,
				releaseVersion: st.releaseVersion ?? null,
				approvals: Object.keys(st.approvals),
				checks: Object.fromEntries(Object.entries(st.checks).map(([k, v]) => [k, v.ok])),
				checklistConfirmed: !!st.confirmations?.implement,
				next: nextHint(st, cfg),
			})),
		},
		null,
		"\t",
	);
}

/** Machine-readable `flow help --json` from the one GATE_HELP source: the command list splits on " | " (bracketed alternations carry no spaces around the pipe), the shared note starts at the first " — ". No parallel help text to drift. */
export function gateHelpJson(gateHelp: string, version: string | null): string {
	const i = gateHelp.indexOf(" — ");
	return JSON.stringify(
		{
			version,
			gates: (i < 0 ? gateHelp : gateHelp.slice(0, i)).split(" | "),
			notes: i < 0 ? "" : gateHelp.slice(i + 3),
			protocol: {
				checkpointQuestions: ["Approve?", "Verified?", "Release?", "Finish?"],
				refusalMarker: NEEDS_OPERATOR,
				confirmFlag: "--confirmed",
				yoloFlag: "--yolo",
			},
		},
		null,
		"\t",
	);
}

/** Write (or delete, on null) a dot-path value in a nested config object. */
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


// ------------------------------------------------------------- stage worker (flow_stage)

export type WorkerOp = "implement" | "review" | "reflect";

/** Stages where each worker op is legal: implement edits only while the flow is at implement; a review
 *  (read-only, advisory) is useful before verify and again before release; a reflection (read-only,
 *  reviews the session transcripts) runs whenever the operator asks — finish is its standard moment. */
export const WORKER_OP_STAGES: Record<WorkerOp, Stage[]> = { implement: ["implement"], review: ["implement", "pre-release"], reflect: ["plan", "implement", "pre-release", "release"] };

/** Default wall-clock budget per op, in minutes. */
export const WORKER_BUDGET_MIN: Record<WorkerOp, number> = { implement: 60, review: 30, reflect: 20 };

/** Times a worker that stopped without its REPORT is told to keep going before the run gives up. */
export const WORKER_NUDGES = 2;

export const clampBudgetMin = (n: unknown, op: WorkerOp): number => {
	const v = typeof n === "number" && Number.isFinite(n) ? n : WORKER_BUDGET_MIN[op];
	return Math.min(180, Math.max(5, Math.round(v)));
};

/** Why an op is not legal for a feature at this stage, or null. */
export function workerOpError(op: string, stage: Stage): string | null {
	if (op !== "implement" && op !== "review" && op !== "reflect") return `unknown op "${op}" — flow_stage ops: implement (a worker edits and commits a slice), review (a fresh read-only reviewer), reflect (a fresh reviewer of this session's transcripts)`;
	const ok = WORKER_OP_STAGES[op];
	return ok.includes(stage) ? null : `op "${op}" runs at ${ok.join(" or ")} — the feature is at ${stage}`;
}

export interface WorkerBriefInput {
	op: Exclude<WorkerOp, "reflect">;
	slug: string;
	workDir: string;
	/** null = no plan file on disk (a --docs / --patch flow needs none) — the brief says so instead of sending the worker after an ENOENT */
	planFile: string | null;
	defaultBranch: string;
	commits: string; // `git log --oneline <base>..HEAD`
	status: string; // `git status --short`
	checks: { name: string; command: string }[];
	note: string;
}

/** The facts every worker needs, so the driver's note can be just the slice. The plan path is absolute:
 *  it lives in the MAIN checkout's gitignored .dev-flow/, never inside the worktree. */
export function buildWorkerBrief(o: WorkerBriefInput): string {
	const checks = o.checks.length ? o.checks.map((c) => `- ${c.name}: \`${c.command}\``).join("\n") : "- (the playbook defines no tier-1 commands)";
	const head = [
		`You are a ${o.op === "implement" ? "stage worker implementing a slice" : "fresh, independent reviewer"} for dev-flow feature \`${o.slug}\`.`,
		"",
		"## Facts",
		`- Worktree (your cwd; work only here): ${o.workDir}`,
		o.planFile
			? `- Approved plan (read it first; it is outside the worktree): ${o.planFile}`
			: "- Plan: none — this flow (--docs / --patch) has no plan file by design; judge the work against the task below and the commits",
		`- Branch base: ${o.defaultBranch}`,
		`- Commits on the branch so far:\n${o.commits.trim() ? o.commits.trim().split("\n").map((l) => `  ${l}`).join("\n") : "  (none)"}`,
		`- Uncommitted now: ${o.status.trim() ? `\n${o.status.trim().split("\n").map((l) => `  ${l}`).join("\n")}` : "clean"}`,
		`- Project checks (run them before you report):\n${checks}`,
		"- You hold no flow tool: gates, checkpoints and the operator stay with the driving session.",
		"",
		"## Your task",
		o.note.trim() || "(no note — do what the plan's next unfinished step asks)",
		"",
	];
	const contract =
		o.op === "implement"
			? [
					"## Contract",
					"- Use the edit/write tools for source changes. Commit as you go on the feature branch (small, meaningful commits).",
					...(o.status.trim()
						? [
								"- The uncommitted paths above are the driving session's work in progress, not yours: never stage or commit them. Commit only your own paths by name (`git add <paths>` then `git commit -m … -- <paths>`); never `git add -A`, `git add .` or `git commit -a`. Check `git diff --cached --name-only` before every commit.",
							]
						: []),
					"- Do not stop to narrate — keep working until the slice is done or you are blocked.",
					"- Finish with a final message whose last section starts with a line `REPORT` followed by: done, commits, open items, risks.",
				]
			: [
					"## Contract",
					`- Check, don't fix: read ${o.planFile ? "the plan" : "the task"}, the diff (\`git diff ${o.defaultBranch}...HEAD\`) and the code; run the checks and any probe that proves a claim. Change no files, make no commits.`,
					"- Look for correctness bugs, claims in docs/changelog the code does not back, missing tests for risky paths, and plan items not delivered.",
					"- Finish with a final message whose last section starts with a line `REPORT` followed by: `verdict: PASS` or `verdict: FAIL`, then findings (most severe first, each with file:line and how you proved it).",
				];
	return [...head, ...contract].join("\n");
}

/** A worker turn that ended in a model error (gh#173): the newest assistant message has stopReason
 *  "error". pi has already auto-retried inside the prompt by then, so this is a dead model, not a stall —
 *  nudging it only buys another retry storm. `streak` counts the consecutive trailing error turns. */
export function workerTurnError(messages: readonly unknown[]): { reason: string; message: string; streak: number } | null {
	const turns = messages.filter((m): m is { role: string; stopReason?: string; errorMessage?: string } => !!m && typeof m === "object" && (m as { role?: unknown }).role === "assistant");
	const last = turns.at(-1);
	if (!last || last.stopReason !== "error") return null;
	let streak = 0;
	for (let i = turns.length - 1; i >= 0 && turns[i].stopReason === "error"; i--) streak++;
	return { reason: last.stopReason, message: String(last.errorMessage ?? "").trim() || "(no error message)", streak };
}

/** A reply that ended as a normal stop yet said nothing: no visible text and no tool call (typically a
 *  provider that closed the stream inside the reasoning block). pi reads it as a finished turn and goes idle,
 *  so a flow stops mid-stage with nothing for the operator to answer. Error and aborted ends are not hollow:
 *  pi has its own handling for those. Returns whether the reply carried reasoning, for the note. */
export function hollowStop(message: unknown): { thinking: boolean } | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; stopReason?: unknown; content?: unknown };
	if (m.role !== "assistant" || m.stopReason !== "stop") return null;
	const parts = Array.isArray(m.content) ? (m.content as { type?: unknown; text?: unknown; thinking?: unknown }[]) : [];
	if (parts.some((p) => p?.type === "toolCall" || (p?.type === "text" && typeof p.text === "string" && p.text.trim()))) return null;
	return { thinking: parts.some((p) => p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim() !== "") };
}

/** The note that resumes a hollow stop. The operator sees it too; the model reads it as the next user turn. */
export function hollowStopNote(h: { thinking: boolean }): string {
	return h.thinking
		? "[dev-flow] Your last reply ended inside your reasoning: no answer and no tool call reached the operator. Continue from where your reasoning stopped."
		: "[dev-flow] Your last reply was empty: no answer and no tool call reached the operator. Continue the task.";
}

/** The REPORT section of a worker's final message: everything after the last `REPORT` heading line. */
export function parseWorkerReport(text: string): { found: boolean; body: string; verdict: "PASS" | "FAIL" | null } {
	const lines = (text ?? "").split("\n");
	let at = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^\s*[#*_>\s]*REPORT[*_:\s]*$/i.test(lines[i])) { at = i; break; }
	}
	if (at < 0) return { found: false, body: lines.slice(-12).join("\n").slice(-800), verdict: null };
	const body = lines.slice(at + 1).join("\n").trim();
	const v = /verdict\s*[:=]\s*\**\s*(PASS|FAIL)/i.exec(body);
	return { found: true, body, verdict: v ? (v[1].toUpperCase() as "PASS" | "FAIL") : null };
}

/** The nudge a worker gets when its turn ended without the REPORT block. */
export const WORKER_NUDGE = "You stopped before finishing and without the REPORT section. Continue the task now (keep using tools; commit as you go). When it is done — or you are truly blocked — end with the `REPORT` section the contract asks for.";

/** The nudge a read-only worker (review, reflect) gets — it has nothing to commit. */
export const WORKER_NUDGE_READONLY = "You stopped before finishing and without the REPORT section. Continue the task now (keep using tools; change no files). When it is done — or you are truly blocked — end with the `REPORT` section the contract asks for.";

/** Share of the budget at which a worker is steered to wrap up (gh#142's grace, restored for every op). */
export const WORKER_STEER_AT = 0.75;

/** Grace after the hard cut: one REPORT-only prompt, so an interrupted worker hands back what it found. */
export const WORKER_SALVAGE_MS = 3 * 60_000;

/** The steer a worker gets at WORKER_STEER_AT of its budget — wrap up while there is time to. */
export function workerSteer(op: WorkerOp, budgetMin: number): string {
	const left = Math.max(1, Math.round(budgetMin * (1 - WORKER_STEER_AT)));
	return op === "implement"
		? `Time check: about ${left} min of your ${budgetMin}-min budget are left. Finish the edit in hand, commit what works, and end with the REPORT section now (done, commits, open items, risks) — an honest partial report beats being cut off.`
		: `Time check: about ${left} min of your ${budgetMin}-min budget are left. Stop probing and write the REPORT section now with what you have — rows you could not fully prove say so in their evidence. Being cut off loses every finding.`;
}

/** The prompt an interrupted worker gets once after the hard cut — report only, no more tools. */
export const WORKER_SALVAGE = "Your time budget is spent and your last turn was interrupted. Do not call any more tools. Reply now with only the REPORT section the contract asks for, from what you already found (mark anything unfinished or unproven as such).";

// ------------------------------------------------------------- reflect worker (flow_stage op "reflect")

/** Compact, line-referenced digest of a pi session JSONL for the reflect worker. A driver transcript
 *  runs to megabytes; the worker used to spend half its budget dumping and paging it. The digest keeps
 *  what a reflection looks for — operator messages, flow gate calls and their answers, tool errors,
 *  refusals, repeated commands — each tagged `L<n>` (the JSONL line) so the worker can open the raw
 *  entry when one needs context. Pure: text in, text out. */
export function digestTranscript(jsonl: string, opts: { maxChars?: number } = {}): string {
	const max = opts.maxChars ?? 80_000;
	const clip = (t: string, n: number) => {
		const one = t.replace(/\s+/g, " ").trim();
		return one.length > n ? `${one.slice(0, n)}…` : one;
	};
	const textOf = (c: unknown): string =>
		typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && (b as { type?: string }).type === "text").map((b) => String((b as { text?: unknown }).text ?? "")).join("\n") : "";
	const out: string[] = [];
	const calls = new Map<string, { line: number; name: string; args: string }>();
	const cmdCount = new Map<string, { n: number; first: number }>();
	let entries = 0, toolCalls = 0, errors = 0, first = "", last = "";
	const lines = (jsonl ?? "").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!raw) continue;
		let e: Record<string, unknown>;
		try { e = JSON.parse(raw); } catch { continue; }
		entries++;
		const L = `L${i + 1}`;
		const ts = typeof e.timestamp === "string" ? e.timestamp : "";
		if (ts) { first ||= ts; last = ts; }
		if (e.type === "compaction") { out.push(`${L} ── compaction (earlier context summarized)`); continue; }
		if (e.type === "custom_message" && e.customType === "flow") { out.push(`${L} /flow → ${clip(textOf(e.content), 400)}`); continue; }
		if (e.type !== "message") continue;
		const m = (e.message ?? {}) as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
		if (m.role === "user") {
			const t = textOf(m.content);
			if (t.trim()) out.push(`${L} OPERATOR: ${clip(t, 900)}`);
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
			const said = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join(" ");
			if (said.trim()) out.push(`${L} agent: ${clip(said, 300)}`);
			for (const b of blocks) {
				if (b.type !== "toolCall") continue;
				toolCalls++;
				const name = String(b.name ?? "?");
				const a = (b.arguments ?? {}) as Record<string, unknown>;
				const args = name === "bash" ? String(a.command ?? "") : name === "flow" ? (Array.isArray(a.args) ? (a.args as unknown[]).join(" ") : JSON.stringify(a)) : JSON.stringify(a);
				calls.set(String(b.id ?? ""), { line: i + 1, name, args });
				if (name === "bash") {
					const k = clip(args, 200);
					const c = cmdCount.get(k);
					if (c) c.n++; else cmdCount.set(k, { n: 1, first: i + 1 });
				}
				if (name === "flow" || name === "flow_stage") out.push(`${L} ${name} ${clip(name === "flow" ? args : `${String(a.op ?? "")} ${String(a.note ?? "")}`, 300)}`);
			}
		} else if (m.role === "toolResult") {
			const call = calls.get(String(m.toolCallId ?? ""));
			const name = call?.name ?? m.toolName ?? "?";
			const res = textOf(m.content);
			if (m.isError) {
				errors++;
				out.push(`${L} ERROR ${name}${call ? ` (call L${call.line}: ${clip(call.args, 160)})` : ""} → ${clip(res, 400)}`);
			} else if (name === "flow" || name === "flow_stage") {
				out.push(`${L}   ↳ ${clip(res, name === "flow_stage" ? 600 : 400)}`);
			} else if (/NEEDS-OPERATOR/.test(res.slice(0, 600))) {
				out.push(`${L} GUARD ${name}${call ? ` (call L${call.line}: ${clip(call.args, 160)})` : ""} → ${clip(res, 300)}`);
			}
		}
	}
	const repeats = [...cmdCount.entries()].filter(([, c]) => c.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 15);
	const head = [
		`digest: ${entries} entries, ${toolCalls} tool calls, ${errors} tool errors${first ? `, ${first} → ${last}` : ""}`,
		"(L<n> = line in the raw JSONL — open it with: sed -n '<n>p' <file> | jq . — only when a row needs context)",
		...(repeats.length ? ["repeated shell commands (≥3×):", ...repeats.map(([k, c]) => `  ×${c.n} from L${c.first}: ${k}`)] : []),
		"",
	];
	let body = out.join("\n");
	if (body.length > max) {
		// keep both ends: the start frames the task, the end holds the release and the operator's last words
		const half = Math.floor(max / 2);
		body = `${body.slice(0, half)}\n… (digest clipped — ${body.length - max} chars dropped from the middle; grep the raw JSONL for that span) …\n${body.slice(-half)}`;
	}
	return [...head, body].join("\n");
}

/** A pi session file and the `parentSession` its header names (line 1 of the JSONL). */
export interface SessionHeaderInfo {
	file: string;
	parentSession?: string;
	name?: string;
}

/** The sub-agent transcripts of a driver session: every session file whose header names the driver
 *  (flow_stage workers are created with parentSession = the driver's file), and their children in
 *  turn. Ordered as found; cycles and the driver itself are never returned. */
export function childSessionFiles(driverFile: string, headers: SessionHeaderInfo[]): SessionHeaderInfo[] {
	const out: SessionHeaderInfo[] = [];
	const seen = new Set<string>([path.resolve(driverFile)]);
	const queue = [path.resolve(driverFile)];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const h of headers) {
			const f = path.resolve(h.file);
			if (seen.has(f) || !h.parentSession || path.resolve(h.parentSession) !== parent) continue;
			seen.add(f);
			out.push(h);
			queue.push(f);
		}
	}
	return out;
}

export interface ReflectBriefInput {
	slug: string;
	root: string;
	today: string;
	driverFile: string | null;
	children: SessionHeaderInfo[];
	reflectionsFile: string;
	items: ReflectItem[];
	projectMd: string;
	version: string | null;
	upstream: string;
	selfRepo: boolean;
	/** open issues on this project's own GitHub repo (the read-time fold), when gh could list them */
	projectIssues?: { repo: string; issues: { number: number; title: string }[] };
	/** the upstream dev-flow repo's issues (all states), prefetched so dedupe is a read, not a gh loop */
	upstreamIssues?: { number: number; title: string; state: string }[];
	/** pre-built transcript digests (driver first), one per transcript, in the feature's scratch dir */
	digests?: { transcript: string; digest: string }[];
	/** the wall-clock budget the worker runs under, in minutes */
	budgetMin?: number;
	note: string;
}

/** The brief for the reflect worker: a fresh, read-only reviewer of the session transcripts. It
 *  classifies, dedupes and recommends; it never writes reflections.md and never files an issue —
 *  the operator decides fold or drop per finding in the driving session. */
export function buildReflectBrief(o: ReflectBriefInput): string {
	const up = o.upstream || "(unknown — say so in the REPORT)";
	const open = o.items.length ? o.items.map((it, i) => `  ${i + 1}. [${it.section}] ${it.line.replace(/^- \[ \] /, "")}`).join("\n") : "  (none)";
	const kids = o.children.length ? o.children.map((c) => `  - ${c.file}${c.name ? ` (${c.name})` : ""}`).join("\n") : "  (none — no flow_stage worker ran in this session)";
	const digests = o.digests?.length ? o.digests.map((d) => `  - ${d.digest}  (of ${path.basename(d.transcript)})`).join("\n") : "";
	const upIssues = o.upstreamIssues ? (o.upstreamIssues.length ? o.upstreamIssues.map((i) => `  gh#${i.number} [${i.state.toLowerCase()}] ${i.title}`).join("\n") : "  (none)") : "";
	const budget = o.budgetMin ? `${o.budgetMin} min` : "a fixed wall-clock budget";
	const issues = o.projectIssues ? (o.projectIssues.issues.length ? o.projectIssues.issues.map((i) => `  gh#${i.number} ${i.title}`).join("\n") : "  (none open)") : "";
	return [
		`You are a fresh, independent reviewer of the dev-flow session for feature \`${o.slug}\`: find what went wrong or was slow, and say where each fix belongs.`,
		"",
		"## Facts",
		`- Repo (your cwd): ${o.root} — today is ${o.today}`,
		`- Driver session transcript (read it in full): ${o.driverFile ?? "(unknown — the session is not file-backed; say so and review what you can)"}`,
		`- Sub-agent (flow_stage worker) transcripts:\n${kids}`,
		...(digests
			? [`- **Start here — digests already built for you** (operator messages, flow calls and answers, tool errors, guard refusals, repeated commands; each row tagged L<n> = its line in the raw JSONL). Read these in full; open a raw entry only when a row needs context (sed -n '<n>p' <file> | jq .). Do not re-dump the raw transcripts:\n${digests}`]
			: ["- Transcripts are pi JSONL, one entry per line (type session / message / custom …; messages carry role, content, tool calls and tool results). Skim with jq or grep — e.g. jq -c 'select(.type==\"message\")' <file> — for tool errors, guard or gate refusals, NEEDS-OPERATOR, retries, repeated commands, operator corrections; then read the surrounding entries."]),
		`- This project's playbook: ${o.projectMd}`,
		`- This project's reflection queue: ${o.reflectionsFile} — open items:\n${open}`,
		`- dev-flow ${o.version ?? "(version unknown)"}; upstream repo: ${up}${o.selfRepo ? " — this checkout IS dev-flow, so plugin findings are this project's code findings" : ""}`,
		...(o.upstreamIssues && o.upstream
			? [`- Issues on ${o.upstream} (all states) — dedupe plugin findings against this list; cite gh#N when one covers it. Run gh issue view <N> --repo ${o.upstream} only for a likely match:\n${upIssues}`]
			: o.upstream && !o.selfRepo
				? [`- Dedupe plugin findings upstream (read-only): gh issue list --repo ${o.upstream} --state all --search "<keywords>" — cite gh#N when one covers it (fixed / won't-fix / open).`]
				: []),
		...(o.projectIssues ? [`- Open issues on this project's repo ${o.projectIssues.repo}:\n${issues}`] : []),
		"- You hold no flow tool and write nothing: no file edits, no commits, no gh issue create, no scratch dumps outside $TMPDIR. The driving session and the operator decide.",
		`- Budget: ${budget}, wall clock. Aim to write the REPORT by about 60% of it; an interrupted run loses every finding.`,
		"",
		"## Your task",
		o.note.trim() ? `Operator context: ${o.note.trim()}` : "(no extra context from the driver)",
		"1. Review the transcripts for real friction only: wrong turns, repeated failures, misfiring guards or gates, playbook drift, slow paths with an obvious fix. One-off typos, environment hiccups and things already fixed later in the session are not findings. You review the session, not the product: evidence is a transcript line — do not re-audit the project's source to second-guess what the session shipped.",
		`2. Classify each finding: docs — the fix lives only in this project's playbook (project.md) → docs flow; code — the fix touches this project's code (maybe the playbook too) → patch flow; plugin — dev-flow's own behaviour or wording → upstream GitHub issue${o.selfRepo ? " (here: report it as code)" : ""}.`,
		"3. Dedupe each finding against the open items above and the issues; a finding an open item already covers is not new — mark that item recurred instead.",
		"4. Recommend fold (worth recording / filing) or drop (one-off, environmental, operator choice, already covered) with a one-clause reason.",
		"5. Re-check every open item: still-open, fixed (cite where — playbook line, commit, newer dev-flow) or recurred (hit again in this session).",
		"",
		"## Contract",
		"- Check, don't fix: read and run read-only probes only. Change no files, make no commits, file nothing.",
		"- Finish with a final message whose last section starts with a line `REPORT`, then one row per line, pipe-separated, nothing else in the section:",
		"  F<n> | fold|drop | docs|code|plugin | <one-line note, written as the reflection itself> | dup: none|#<open item>|gh#<N> | why: <reason> | evidence: <transcript file:line or a short quote>",
		"  O<n> | still-open|fixed|recurred | <reason, with evidence>",
		"  (no findings → a single line `F0 | none`; no open items → no O rows)",
	].join("\n");
}

export type ReflectKind = "docs" | "code" | "plugin";
export interface ReflectFinding {
	n: number;
	rec: "fold" | "drop";
	kind: ReflectKind;
	note: string;
	dup: string;
	why: string;
	evidence: string;
}
export interface ReflectOpenCheck {
	n: number;
	status: "still-open" | "fixed" | "recurred";
	reason: string;
}

/** Parse the reflect worker's REPORT rows. Malformed rows are skipped — the caller shows the raw
 *  REPORT when nothing parsed, so a sloppy report is never silently lost. */
export function parseReflectReport(body: string): { findings: ReflectFinding[]; open: ReflectOpenCheck[] } {
	const findings: ReflectFinding[] = [];
	const open: ReflectOpenCheck[] = [];
	for (const raw of (body ?? "").split("\n")) {
		const cells = raw.replace(/^[\s>*`-]+/, "").replace(/`+\s*$/, "").split("|").map((c) => c.trim());
		const f = /^F(\d+)$/i.exec(cells[0] ?? "");
		if (f && cells.length >= 4) {
			const rec = cells[1].toLowerCase();
			const kind = cells[2].toLowerCase();
			if ((rec !== "fold" && rec !== "drop") || !["docs", "code", "plugin"].includes(kind) || !cells[3]) continue;
			const field = (k: string) => cells.slice(4).find((c) => c.toLowerCase().startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? "";
			findings.push({ n: Number(f[1]), rec, kind: kind as ReflectKind, note: cells[3], dup: field("dup") || "none", why: field("why"), evidence: field("evidence") });
			continue;
		}
		const o = /^O(\d+)$/i.exec(cells[0] ?? "");
		if (o && cells.length >= 2) {
			const status = cells[1].toLowerCase();
			if (status !== "still-open" && status !== "fixed" && status !== "recurred") continue;
			open.push({ n: Number(o[1]), status, reason: cells.slice(2).join(" | ") });
		}
	}
	return { findings, open };
}

/** The numbered list the driver shows the operator: one row per finding with its route, then the
 *  open-item re-check. Routes follow where the fix lives — plugin is always an upstream issue
 *  (code in the dev-flow repo itself), never a local row. */
export function renderReflectFindings(r: { findings: ReflectFinding[]; open: ReflectOpenCheck[] }, selfRepo: boolean): string[] {
	const route = (k: ReflectKind) =>
		k === "docs" ? "docs flow · record: flow reflect --playbook" : k === "code" || selfRepo ? "patch flow · record: flow reflect --code" : "upstream GitHub issue · flow reflect --plugin prints the recipe (never a local row)";
	const out: string[] = [];
	if (r.findings.length) {
		out.push(`findings (${r.findings.length}) — recommendation · kind → route:`);
		for (const f of r.findings) {
			out.push(`  ${f.n}. [${f.rec}] ${f.kind}: ${f.note}`);
			out.push(`      → ${route(f.kind === "plugin" && selfRepo ? "code" : f.kind)}${f.dup && f.dup !== "none" ? ` · dup: ${f.dup}` : ""}${f.why ? ` · ${f.why}` : ""}`);
		}
	} else out.push("findings: none");
	if (r.open.length) {
		out.push("open items re-checked:");
		for (const o of r.open) out.push(`  #${o.n} ${o.status}${o.reason ? ` — ${o.reason}` : ""}${o.status === "fixed" ? " → propose the check-off" : o.status === "recurred" ? " → recommend fixing it now" : ""}`);
	}
	return out;
}
