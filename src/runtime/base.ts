/** dev-flow runtime — Shared runtime: shell, paths, flow state, sessions and claims, skill core, compaction pacing. Moved out of extensions/dev-flow.ts as is (exports added). */
import { exec } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { compact, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checklistPending, claimBlocks, classifyMergeHistory, cmpVersions, detectForge, extractSkillCore, featureBranchPrefix, healthRetry, parseMergeStyle, parseLsRemoteTags, pluginVersion, reflectItems, sessionRunsOlderBuild, listFiles, shouldSelfCompact, sq, featureTmpDir, featureTmpEnv, mainCheckoutRoot, type ReflectItem, type Config, type FeatureRef, type FlowState, type SessionClaim } from "../core.ts";
import { loadProject, parseProjectMd, setPlaybookKey } from "../projectmd.ts";
import { bashTimeout } from "../timeouts.ts";
import { type RunResult, type Session } from "./checks.ts";
import { GIT_TRACK_NOTE, isSelfRepo } from "./setup.ts";

export const execAsync = promisify(exec);

/** This build's own identity, read once at load: it is what this session's code IS — an update that
 * rewrites the package on disk later does not change the code already running. */
export const SELF_BUILD = pluginVersion(import.meta.dirname);

/** The dev-flow build this session actually loaded — see sessionRunsOlderBuild. The load-time
 * manifest, never a fresh read: re-reading the package after an in-place update reported the NEW
 * version as loaded and the stale one as shipped (lettuce rail-ui-fixes, 0.79.0 → 0.80.0).
 * DEV_FLOW_LOADED_VERSION (read at call time) can stand in for it (the smoke suite runs gates
 * in-process and needs to pretend it is an old session): the override can only ever make a gate more
 * cautious — it never lifts a proof, it turns a release into a warn-and-ask. */
export function loadedVersion(): string | null {
	return process.env.DEV_FLOW_LOADED_VERSION?.trim() || SELF_BUILD.version;
}

/** The dev-flow build this session *should* be running, as the disk describes it, and how to call it.
 * In the dev-flow repo that is the checkout's own manifest: main moves ahead of the installed copy at
 * every release, while `loadedVersion()` and the plugin's own package.json are the same file — so a
 * session running 0.54.0 in a checkout already at 0.58.1 compared equal and nothing anywhere said so.
 * In a normal project the only manifest is the installed package's, which a mid-session update moves. */
export function checkoutBuild(root: string): { version: string | null; dir: string; repo: string; label: string } {
	return isSelfRepo(root)
		? { ...pluginVersion(root), label: "this checkout" }
		: { ...pluginVersion(import.meta.dirname), label: "the dev-flow install" }; // fresh: what the disk ships NOW
}

/** The build this session runs vs the one the disk ships: `behind` is the loaded version when they differ
 *  ("" when current or unknown), `line` the one warning every surface prints for it. */
export function buildSkew(root: string): { disk: ReturnType<typeof checkoutBuild>; behind: string; line: string } {
	const disk = checkoutBuild(root);
	const behind = sessionRunsOlderBuild(loadedVersion(), disk.version);
	return { disk, behind, line: behind ? `this session runs dev-flow ${behind}, ${disk.label} ships ${disk.version ?? "?"} — /reload rebinds session state; only restarting the host swaps the code it runs` : "" };
}

/** Cross-copy registry: one process can register dev-flow more than once (the documented
 * two-sources-at-once hazard: a project dogfood pointer plus an installed copy), and EVERY copy
 * evaluates every guard hook. The flow-tool binding belongs to whichever copy served the call,
 * so the other copy judges from a missing binding — claims on disk (see boundFeature) keep its
 * verdict honest, and these entries let `flow version`, `status` and `start` name the duplicate
 * instead of leaving a misattribution a mystery. Same-process only: it is a globalThis list. */
export interface CopyEntry {
	dir: string;
	version: string | null;
	pid: number;
	at: string;
}
export const COPIES: CopyEntry[] = ((globalThis as { __piDevFlowCopies?: CopyEntry[] }).__piDevFlowCopies ??= []);
export function registerCopy(): void {
	const mine = COPIES.find((r) => r.dir === SELF_BUILD.dir && r.pid === process.pid);
	if (mine) Object.assign(mine, { version: loadedVersion(), at: new Date().toISOString() });
	else COPIES.push({ dir: SELF_BUILD.dir, version: loadedVersion(), pid: process.pid, at: new Date().toISOString() });
}
export function otherCopies(): CopyEntry[] {
	return COPIES.filter((r) => r.pid === process.pid && r.dir !== SELF_BUILD.dir);
}
/** Election: when one process runs several dev-flow copies (the documented two-sources hazard, or a
 *  copy whose loaded code predates an update), only the highest-version copy may judge — stale code
 *  must not veto tool calls with a build nobody reviewed. Node cannot unload a loaded module and pi
 *  cannot unregister its hooks, so silence is the most removal can be from inside the package; only
 *  a host restart truly drops stale code. Equal versions both judge (same code, same verdicts); a
 *  copy whose version cannot be read is never outranked. Gate tool/command handlers stay live on
 *  every copy: the host dispatches a session's flow calls to whichever copy loaded that session,
 *  and staleness there is what the /reload warnings address. */
export function guardsAreMine(): boolean {
	const mine = SELF_BUILD.version;
	if (!mine) return true; // an unreadable version is never outranked
	return !otherCopies().some((r) => r.version && cmpVersions(r.version, mine) > 0);
}
export function copyWarning(): string | null {
	const dup = otherCopies();
	if (!dup.length) return null;
	const verdict = guardsAreMine() ? "this copy is the newest and judges the guards" : "this copy is older and stays silent \u2014 the newest copy judges";
	return `warning: ${dup.length} other dev-flow cop${dup.length === 1 ? "y" : "ies"} registered in this process: ${dup.map((d) => `${d.dir} (${d.version ?? "?"})`).join(", ")} \u2014 this call served by ${SELF_BUILD.dir} (${SELF_BUILD.version ?? "?"}); ${verdict}. Keep only one source you intend; a host restart drops stale code (README: two sources at once)`;
}
/** Test seams the runtime reads; the entry file adds the worker ones and exports the whole set. */
export const baseSeams = { copies: COPIES, skillCore: { value: undefined as string | null | undefined }, bashTimeout: { cap: undefined as number | undefined } };

export interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
}

export const now = () => new Date().toISOString();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sh(command: string, cwd: string, timeoutMs = 15 * 60_000, env?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
		return { ok: true, out: `${stdout}\n${stderr}`.trim() };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || String(err.message) };
	}
}

/** origin's URL, or null when the repo has no origin. */
export async function originUrl(root: string): Promise<string | null> {
	const r = await sh("git remote get-url origin", root, 10_000);
	return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** The forge the release machinery targets: the playbook's `forge`, else detected from origin ("self" without one). */
export const forgeOf = (cfg: Config, origin: string | null): string => cfg.forge || detectForge(origin ?? "");

/** The branch's merge base with the default branch (origin's when fetched), or "" when git cannot say. */
export async function mergeBase(cwd: string, defaultBranch: string): Promise<string> {
	const mb = await sh(`git merge-base origin/${sq(defaultBranch)} HEAD 2>/dev/null || git merge-base ${sq(defaultBranch)} HEAD 2>/dev/null || true`, cwd);
	return mb.ok ? mb.out.trim() : "";
}

/** The published pi-dev-flow version (`--check-upstream`), or "" when the registry cannot be asked. */
export async function publishedVersion(root: string): Promise<string> {
	const pub = await sh("npm view pi-dev-flow version", root);
	return pub.ok ? (pub.out.trim().split("\n").pop() ?? "") : "";
}

export const dfDir = (root: string) => path.join(root, ".dev-flow");
/** dev-flow is initiated once the operator playbook exists: before flow init writes project.md the
 *  extension is silent in that folder — no injections, no guards (not even the no-playbook bash-timeout
 *  default), no footer. The flow tool itself stays registered so flow init remains callable. */
export const initiated = (root: string): boolean => existsSync(path.join(dfDir(root), "project.md"));

/** A `--merge=squash` style flag, or null when absent. Returned as the raw string: the caller validates it
 *  with parseMergeStyle so a typo is reported instead of ignored. */
export function flagValue(rest: string[], name: string): string | null {
	for (const a of rest) {
		const m = a.match(new RegExp(`^--${name}=([\\s\\S]+)$`)); // a --brief= value spans lines
		if (m) return m[1];
	}
	return null;
}

/** One cheap first-parent log tells the operator what their repo actually does when a PR merges: merge
 *  commits or one squashed commit per PR. `flow init` and `flow start` ask with this evidence instead of
 *  asking blind; null when there is no default-branch log to read. */
export async function mergeHistoryEvidence(root: string, defaultBranch: string): Promise<{ note: string; recent: "squash" | "merge" | "rebase" | null } | null> {
	const log = await sh(`git log --first-parent -n 40 --format=%p|%s ${sq(`origin/${defaultBranch}`)} 2>/dev/null || git log --first-parent -n 40 --format=%p|%s ${sq(defaultBranch)} 2>/dev/null`, root);
	if (!log.ok || !log.out.trim()) return null;
	const c = classifyMergeHistory(log.out.split("\n"));
	return { note: c.note, recent: c.recent };
}

/** How the forge says the PR landed, when it can be asked — the only way to tell a squash from a rebase,
 *  because both erase the branch's ancestry. null = unaskable (self-hosted, no CLI, no merged PR found). */
export async function forgeMergeStyle(root: string, forge: string, branch: string): Promise<"squash" | "merge" | "rebase" | null> {
	if (!branch) return null;
	// sh() folds stderr into stdout, so a CLI error can arrive where the JSON was expected: parse defensively
	const json = (out: string): unknown | null => {
		try {
			return JSON.parse(out);
		} catch {
			return null;
		}
	};
	if (forge === "github") {
		const pr = await sh(`gh pr list --state merged --head ${sq(branch)} --json number,squashCommit,rebaseCommit,mergeCommit --jq '.[0]'`, root);
		if (!pr.ok || !pr.out.trim() || pr.out.trim() === "null") return null;
		const parsed = json(pr.out.trim()) as { squashCommit?: string | null; rebaseCommit?: string | null; mergeCommit?: string | null } | null;
		return parsed?.squashCommit ? "squash" : parsed?.rebaseCommit ? "rebase" : parsed?.mergeCommit ? "merge" : null;
	}
	if (forge === "gitlab") {
		const mr = await sh(`glab api ${sq(`projects/:id/merge_requests?source_branch=${branch}&state=merged&per_page=1`)}`, root);
		if (!mr.ok || !mr.out.trim() || mr.out.trim() === "[]") return null;
		const list = json(mr.out.trim()) as { squash_commit_sha?: string | null; merge_commit_sha?: string | null }[] | null;
		const parsed = Array.isArray(list) ? list[0] : null;
		return parsed?.squash_commit_sha ? "squash" : parsed?.merge_commit_sha ? "merge" : null;
	}
	return null;
}

/**
 * Write the merge policy into the playbook with a single-line insert — never a draft regeneration, which
 * cannot reproduce hand-written prose and checklist items and would drop them. Validated before it is
 * written and kept as `.bak`, exactly like `flow init --write`. The commit is the playbook chore the guard
 * already blesses, and only when the playbook is the only dirty path: a gate never sweeps someone else's
 * work into a chore commit.
 */
export async function writePlaybookMergePolicy(root: string, style: string): Promise<{ note: string } | { err: string }> {
	const mdFile = path.join(dfDir(root), "project.md");
	if (!existsSync(mdFile)) return { err: "no .dev-flow/project.md to write the policy into — run flow init first" };
	const ins = setPlaybookKey(readFileSync(mdFile, "utf8"), "release", "merge", style);
	if ("error" in ins) return { err: ins.error };
	const parsed = parseProjectMd(ins.text);
	if (parsed.hard.length) return { err: `refusing to write project.md — the result would not parse:\n- ${parsed.hard.join("\n- ")}` };
	copyFileSync(mdFile, `${mdFile}.bak`);
	writeFileSync(mdFile, ins.text);
	const dirty = await sh("git status --porcelain", root);
	const onlyPlaybook = dirty.ok && dirty.out.trim().split("\n").every((l) => l.trim().endsWith(" .dev-flow/project.md"));
	const tracked = (await sh("git ls-files --error-unmatch .dev-flow/project.md", root)).ok;
	let note = `merge = ${style} written to .dev-flow/project.md (${ins.where}; previous copy kept as project.md.bak)`;
	if (tracked && onlyPlaybook) {
		const commit = await sh(`git add .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -q -m ${sq(`playbook: merge policy = ${style}`)}`, root);
		note += commit.ok ? " — committed as a playbook chore" : ` — commit failed (${tail(commit.out)}); commit it yourself`;
	} else note += `. ${GIT_TRACK_NOTE}`;
	return { note };
}

/**
 * Run the health probe with the playbook's wait budget (#42). A service whose readiness lags its
 * container start can never pass a single shot, and hand-writing a poll loop into every playbook was
 * the workaround; the gate waits and says how long it tried. Attempts/schedule: core.healthRetry.
 */
export async function runHealthProbe(cmd: string, cwd: string, waitSec: number, env?: Record<string, string>): Promise<{ ok: boolean; out: string; attempts: number }> {
	const { attempts, delayMs } = healthRetry(waitSec);
	const deadline = Date.now() + waitSec * 1000; // the budget is wall time: a slow probe must not multiply it by its own duration
	let res = { ok: false, out: "" };
	for (let i = 1; ; i++) {
		res = await sh(cmd, cwd, undefined, env);
		if (res.ok || i >= attempts || Date.now() >= deadline) return { ...res, attempts: i };
		await sleep(delayMs);
	}
}

/** Tags to judge a release against: what origin holds — a clone that has not fetched must not get to
 *  decide what is already tagged (#52). Local tags only when there is no remote to ask; null when an
 *  origin exists but could not be asked (offline, no ssh agent) — then local tags must not stand in. */
export async function releaseTags(root: string): Promise<string[] | null> {
	if (!(await originUrl(root))) return (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
	const remote = await sh("git ls-remote --tags origin", root);
	if (!remote.ok) return null;
	return parseLsRemoteTags(remote.out);
}

export const GATE_HELP =
	"help [--json] | init [--force|--draft|--write <text>|--write-file <path>|--answers key=value…|--answers-file <path>] [--confirmed] [--track] | reflect [<note>|list|tidy|move <n> --playbook|--code|done <n> [<what>]] | roadmap [add <text> [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]|pick <n> <slug>|done <n>|tidy] | doctor [<issue note>] | status [slug] [--json] | start <slug> [--ui|--patch|--docs --confirmed] [--force] [--merge=squash|merge|rebase|any] [--check-upstream] | use <slug> | test | check | health | approve [--yolo] | verify [--yolo] [--port=<n>|--replace] | release [--yolo|--no-version|--no-fold-check|--no-marker-check] | release-done [--no-artifact-check|--no-release-create] | finish [--yolo] [--no-reflect] [--note=<text>] [slug] | abort [slug] | version [--check-upstream] — state gates take [slug] and --confirmed (the operator already answered in chat); without it the agent's call returns NEEDS-OPERATOR with the question to ask in chat (it never opens a dialog), and the /flow slash command asks in a dialog — verify without --confirmed rebases a branch that is behind the default branch and deploys for review; --port=<n> / --replace answer its Dev port? question when another flow holds the stack — --ui/--patch/--docs and --merge=<style> on start are operator-granted (--confirmed); start refuses until the playbook has a merge policy and writes the answer into project.md — --yolo (with --confirmed) answers that checkpoint and pre-confirms every later one; checks and guardrails stay — release --no-version ships merge + changelog only (no bump, tag or forge release); --no-fold-check skips the changelog fold line proofs on the operator's word; --no-marker-check lets a branch add conflict-marker-shaped lines on purpose — finish runs the closing reflection worker first (before removing anything) and stops for the operator's fold/drop; the re-run with --confirmed cleans up; --no-reflect --confirmed skips it on the operator's explicit word (yolo never does), --note= hands the worker the operator's friction notes — release names a session running an older dev-flow build than the disk ships and asks update (/reload) or proceed — recorded, never a block — reflect <note> queues a project suggestion in reflections.md (--playbook = docs-flow fix, --code = patch-flow fix); --plugin never writes — dev-flow feedback goes upstream and it prints the GitHub issue recipe; bare reflect prints the session-reflection protocol (bound: run flow_stage op reflect); list numbers open items, move <n> re-files one, done <n> checks a fixed one off, tidy drops closed ones — roadmap manages .dev-flow/roadmap.md: pick <n> <slug> (or add --slug=) stamps an item for flow start, which seeds the new plan from its brief; finish checks it off — a new feature asked for mid-flow is parked there, never as a hand-made .dev-flow/<slug>/; start <slug> --confirmed adopts such a ghost dir — doctor reviews structure, git consistency and open reflections (never writes); doctor <note> prints an investigation brief — version prints the build the disk ships and any other dev-flow copies in this process (--check-upstream asks the registry)";
export const featDir = (root: string, slug: string) => path.join(dfDir(root), slug);
export const stateFile = (root: string, slug: string) => path.join(featDir(root, slug), "state.json");
export const claimFile = (root: string, slug: string) => path.join(featDir(root, slug), "claim.json");

export function readState(root: string, slug: string): FlowState | null {
	try {
		return JSON.parse(readFileSync(stateFile(root, slug), "utf8")) as FlowState;
	} catch {
		return null;
	}
}

export function writeState(root: string, state: FlowState): void {
	atomicWrite(stateFile(root, state.slug), `${JSON.stringify(state, null, "\t")}\n`);
}

/** Count one refusal or guard block against the session's bound feature (best effort, never throws). */
export function noteFriction(root: string, key: string): void {
	try {
		const st = boundFeature(root, key);
		if (!st) return;
		st.friction = (st.friction ?? 0) + 1;
		writeState(root, st);
	} catch {
		/* a counter must never fail the call it watches */
	}
}

/** Replace a file in one move. Gates write state after every check, and a kill in the middle left a
 *  truncated state.json — which reads as "no such feature", silently orphaning the worktree, the plan
 *  and every recorded check, with the folder gitignored so nothing else could restore it. */
export function atomicWrite(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Session bindings: one flow per pi session; persisted per session branch via appendEntry.
 *  Module-level means shared by every session in the process — pi runs many sessions inside one Node
 *  process (pi-web's agent lives in the server) — so every key here is a session identity and every
 *  entry is released when that session ends (see releaseSession). */
export const bindings = new Map<string, string | null>();
// Two identities are possible: pi's session id, or — when the host hands out none — the working
// directory. Both are prefixed, because a claim written under the directory identity is not a session:
// two pi sessions sharing one directory share that key, and `cwd:` in a claim file says so out loud
// instead of reading like a session that went missing.
export const sessionKey = (ctx: { cwd: string; sessionManager?: { getSessionId(): string } }): string =>
	ctx.sessionManager?.getSessionId() ? `sid:${ctx.sessionManager.getSessionId()}` : `cwd:${ctx.cwd}`;
/** Sessions with a dev-flow-initiated compaction in flight (prevents stacked compactions). */
export const compacting = new Set<string>();
/** Sessions that already received the skill's always-on core this session. The `dev-flow-skill`
 *  entry records the injection in the session branch, so /reload, resume and fork restore the fact
 *  instead of paying ~1k tokens a second time. */
export const coreInjected = new Set<string>();
/** Sessions whose last compaction dropped the core out of context — the next run pays it once more. */
export const coreStale = new Set<string>();
/** The last stage context each session was handed. The context rides a hidden message on every run, and
 *  a long session at one stage used to carry the same ~200-word note dozens of times: an unchanged one
 *  is now one line. Cleared by a compaction (the summary may have dropped it) and by a reload. */
export const lastContext = new Map<string, string>();
/** The skill dir of THIS loaded copy: the copy a session runs and a development checkout can be
 *  different installs, so playbook paths resolve from the code actually loaded — never from cwd. */
export const SKILL_DIR = path.join(import.meta.dirname, "..", "..", "skills", "dev-flow");
export let skillCoreCache: string | null | undefined;
/** The core block between SKILL.md's markers, read once per process (/reload reloads the module
 *  and picks up edits). Null — no file, no markers, empty core — leaves every message exactly as it
 *  was: a copy shipped without its skill must not take the guards, or the run, down. */
export function skillCore(): string | null {
	// Seam first: a test cannot ship a copy of the package with its skills/ directory deleted.
	if (baseSeams.skillCore.value !== undefined) return baseSeams.skillCore.value;
	if (skillCoreCache === undefined) {
		try {
			skillCoreCache = extractSkillCore(readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8"));
		} catch {
			skillCoreCache = null;
		}
	}
	return skillCoreCache;
}

/** Seam for the takeover's summarize call (pi's own compact()); tests replace `.run` — mutable object stands in for ESM mocking. */
export const compactionTakeover: { run: typeof compact } = { run: compact };

/** Marks the before_agent_start pass that already wrote this run's [dev-flow] line — see the claim in that handler. */
export const CONTEXT_EMITTED = Symbol.for("pi-dev-flow.context-emitted");

/** Every feature with a state file — finish deletes the state, so whatever is on disk is unfinished. */
export function unfinishedStates(root: string): FlowState[] {
	if (!existsSync(dfDir(root))) return [];
	return readdirSync(dfDir(root), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readState(root, d.name))
		.filter((s): s is FlowState => !!s);
}

/** Open items of the agent's suggestion queue (.dev-flow/reflections.md), each with its section. */
export const readReflections = (root: string): ReflectItem[] => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? reflectItems(readFileSync(f, "utf8")) : [];
};

/** Raw reflections.md content — the closed-item count needs the checked lines the open-only reader drops. */
export const readReflectionsText = (root: string): string => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};

export const roadmapFile = (root: string) => path.join(dfDir(root), "roadmap.md");
export const readRoadmap = (root: string): string => {
	const f = roadmapFile(root);
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** The session's feature — explicit bindings only: flow start/flow use bind, resume restores from session
 *  history. Never binds on its own: an unbound session stays unbound however few features are unfinished,
 *  and reading it must never claim anything. The claim on disk IS the persisted binding — bind() stamps the
 *  session key into claim.json — so trust the disk after the in-memory map: a second registered dev-flow
 *  copy (both copies evaluate the guard hooks) or a re-instantiated module then attributes the session's
 *  own feature from disk instead of misjudging with stage null. */
export function boundFeature(root: string, key: string): FlowState | null {
	const bound = bindings.get(key);
	if (bound) {
		const s = readState(root, bound);
		if (s) return s;
	}
	return unfinishedStates(root).find((s) => readClaim(root, s.slug)?.key === key) ?? null;
}

export function readClaim(root: string, slug: string): SessionClaim | null {
	try {
		return JSON.parse(readFileSync(claimFile(root, slug), "utf8")) as SessionClaim;
	} catch {
		return null;
	}
}

export const writeClaim = (root: string, slug: string, key: string) =>
	atomicWrite(claimFile(root, slug), `${JSON.stringify({ key, pid: process.pid, at: now() })}\n`);

/** Let go of everything one session held. In a shared-process host the pid on a claim is the server's and
 *  never dies, so a claim left behind by a finished session keeps refusing every later session with
 *  "claimed by another live session" — the lock has to end with the session that wrote it. Idempotent:
 *  shutdown, reload and process exit can converge on this path. */
export function releaseSession(root: string, key: string): void {
	bindings.delete(key);
	compacting.delete(key);
	coreInjected.delete(key);
	coreStale.delete(key);
	if (!existsSync(dfDir(root))) return;
	for (const d of readdirSync(dfDir(root), { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		if (readClaim(root, d.name)?.key === key) rmSync(claimFile(root, d.name), { force: true });
	}
}

/** A lone unfinished feature another live session holds — lets the unbound-context message name it and offer the explicit takeover. */
export function claimBlocker(root: string, key: string): { state: FlowState; claim: SessionClaim } | null {
	const un = unfinishedStates(root);
	if (un.length !== 1) return null;
	const claim = readClaim(root, un[0].slug);
	return claim && claimBlocks(claim, key) ? { state: un[0], claim } : null;
}

/** Flow-aware focus for any compaction dev-flow initiates — state lives on disk, the summary must not invent it. */
export const flowCompactInstructions = (st: FlowState) =>
	`dev-flow feature "${st.slug}", stage "${st.stage}" — flow state is persisted on disk (state.json, plan/). Preserve verbatim: operator answers not yet recorded by a gate, reasons for uncommitted changes, and the exact next action from the last exchange.`;

/**
 * Flow-aware self-compaction at safe points: called after a successful gate (state just hit disk),
 * at every turn_end and when a run settles. Only fires within COMPACT_MARGIN of pi's own threshold
 * (computed with the *effective* reserveTokens — settings + model overrides, like pi does) and
 * never while chat-only state is pending (open dialog, undigested plan) — see shouldSelfCompact.
 */
export function maybeCompactNow(ctx: ExtensionContext, root: string): void {
	if (!initiated(root)) return;
	const u = ctx.getContextUsage?.(); // minimal/fake contexts may lack usage info — treat as unknown
	if (!u || u.tokens === null) return;
	const key = sessionKey(ctx);
	const st = boundFeature(root, key);
	if (!st) return;
	let reserve: number;
	try {
		const settings = SettingsManager.create(ctx.cwd); // throws on a malformed compaction setting — pi surfaces that itself; we just stay out
		if (!settings.getCompactionEnabled()) return; // operator turned auto-compaction off — don't do it behind their back
		reserve = settings.getCompactionReserveTokens(ctx.model);
	} catch {
		return;
	}
	const cfg = loadProject(dfDir(root)).cfg;
	const decision = {
		tokens: u.tokens,
		contextWindow: u.contextWindow,
		stage: st.stage,
		planFiles: listFiles(path.join(featDir(root, st.slug), "plan")).length,
		checklistPending: checklistPending(cfg, st, st.stage),
		compacting: compacting.has(key),
	};
	if (!shouldSelfCompact(decision, reserve)) return;
	compacting.add(key);
	const done = () => compacting.delete(key);
	try {
		ctx.compact({ customInstructions: flowCompactInstructions(st), onComplete: done, onError: done });
	} catch {
		done(); // a throw before the run started must not leave the flag set: that switched off self-compaction and the takeover for the rest of the session
	}
}

export function featureRefs(root: string): FeatureRef[] {
	return unfinishedStates(root).map((s) => ({ state: s, worktreeAbs: s.worktree ? path.resolve(root, s.worktree) : null }));
}

export function worktreeAbs(root: string, state: FlowState): string | null {
	return state.worktree ? path.resolve(root, state.worktree) : null;
}

/** Git-level consistency probes for the doctor: orphan worktrees/branches, features missing their worktree. */
export async function gitConsistency(root: string, cfg: Config): Promise<string[]> {
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
	const brRaw = await sh(`git branch --list ${sq(`${featureBranchPrefix(cfg)}*`)}`, root);
	if (brRaw.ok)
		// git marks the current branch with "* " and a worktree-checked-out one with "+ " — strip both, or an active feature's own branch never matches ownedBr
		for (const b of brRaw.out.split("\n").map((x) => x.replace(/^[*+]?\s+/, "").trim()).filter(Boolean)) {
			if (!ownedBr.has(b)) out.push(`orphan branch ${b} — no unfinished feature owns it (git branch -D ${b})`);
		}
	// an aborted feature is a designed state, not drift: the abort echo tells the operator to remove
	// the worktree by hand, and the stamp keeps that cleanup from being re-reported forever (gh#138)
	for (const f of feats) if (f.worktree && !f.aborted && !existsSync(path.resolve(root, f.worktree))) out.push(`feature ${f.slug} (${f.stage}) has no worktree at ${f.worktree}`);
	// the playbook belongs in git — an untracked project.md is invisible to teammates and lost on machine changes
	if (existsSync(path.join(root, ".dev-flow", "project.md")) && !(await sh("git ls-files --error-unmatch -- .dev-flow/project.md", root)).ok)
		out.push('.dev-flow/project.md is not tracked in git — track it: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md" (force: a root .gitignore may exclude .dev-flow/ wholesale; the env prefix is for the installed hook — dev-flow allows a main commit whose only change is the playbook)');
	return out;
}

/** Where feature commands run: the feature worktree once it exists (that is where the
 *  code under test lives), else the main checkout. Keeps gates off the main branch. */
export function gateCwd(root: string, state: FlowState): string {
	const wt = worktreeAbs(root, state);
	return wt && existsSync(wt) ? wt : root;
}

/** TMPDIR for the project commands a gate runs: the feature's own scratch dir, removed at finish —
 *  a test suite's mkdtemp fixtures no longer pile up in the OS temp dir. */
export function featureEnv(root: string, state: FlowState): Record<string, string> {
	const dir = featureTmpDir(dfDir(root), state.slug);
	mkdirSync(dir, { recursive: true });
	return featureTmpEnv(dir);
}

/** Per-cwd cache of the main checkout a linked worktree belongs to (null = not a linked worktree) —
 *  every hook resolves its root through flowRoot, so git is asked once per directory. */
export const mainCheckoutCache = new Map<string, string | null>();

/** The root whose .dev-flow/ is the flow truth for a session cwd. A feature worktree is a linked git
 *  worktree whose tracked .dev-flow/ holds only project.md — state, claims and plans live in the main
 *  checkout. Judging a session by its own cwd found no features and every guard answered "no active
 *  flow". So a linked worktree resolves to its main checkout when that checkout is initiated. */
export async function flowRoot(cwd: string): Promise<string> {
	if (!mainCheckoutCache.has(cwd)) {
		const r = await sh("git rev-parse --path-format=absolute --git-dir --git-common-dir", cwd);
		const [gitDir, common] = r.ok ? r.out.split("\n").map((l) => l.trim()) : [];
		const linked = !!gitDir && !!common && path.resolve(gitDir) !== path.resolve(common);
		mainCheckoutCache.set(cwd, linked ? mainCheckoutRoot(cwd, common) : null);
	}
	const main = mainCheckoutCache.get(cwd);
	return main && initiated(main) ? main : cwd;
}

export async function currentBranch(root: string): Promise<string> {
	const r = await sh("git branch --show-current", root);
	return r.ok ? r.out.split("\n")[0] : "";
}

export function needState(root: string, sess: Session, slugArg?: string): { state: FlowState | null; err?: RunResult } {
	// no implicit feature: gates run on this session's binding or an explicit slug — never on "the one
	// feature left", which is how an unbound session would end up steering a flow it never took
	const slug = slugArg ?? sess.slug;
	if (!slug) {
		const un = unfinishedStates(root);
		if (!un.length) return { state: null, err: { text: "no unfinished features — flow start <slug> [--ui]", isError: true } };
		return { state: null, err: { text: `nothing bound — flow use <slug> or pass an explicit slug (unfinished: ${un.map((s) => s.slug).join(", ")})`, isError: true } };
	}
	const state = readState(root, slug);
	if (!state) return { state: null, err: { text: `no state for feature ${slug}`, isError: true } };
	// passing a slug is not a takeover: a live session that holds the claim drives its gates, or the two
	// sessions overwrite one state file (last write wins) while both believe they own the stage.
	const claim = readClaim(root, slug);
	if (sess.slug !== slug && claimBlocks(claim, sess.key))
		return { state: null, err: { text: `${slug} is claimed by another live session (pid ${claim!.pid}) — flow use ${slug} takes it over explicitly`, isError: true } };
	return { state };
}

export function tail(out: string, n = 15): string {
	const lines = out.split("\n").filter(Boolean);
	return lines.length > n ? `…(${lines.length - n} lines)…\n${lines.slice(-n).join("\n")}` : out;
}

// ------------------------------------------------------------------ extension

/** The pi-web chip's current key, per session: the chip's label IS the widget key, so it changes with the
 *  footer text and the previous one must be cleared on every repaint. Per session, not per process — one
 *  pi-web server repaints many sessions (drivers, chats, workers), and a single shared slot let session B's
 *  repaint overwrite A's key, so A's next repaint cleared a key A never had and left its old chip beside
 *  the new one. On globalThis so a /reload or a duplicate copy still knows the chip already painted. */
export const WEB_CHIP_KEYS: Map<string, string> = ((globalThis as { __piDevFlowChipKeys?: Map<string, string> }).__piDevFlowChipKeys ??= new Map());
