/**
 * dev-flow: enforced feature-flow state machine for Pi (pi package extension).
 *
 * Stages: plan → implement → pre-release → release → done, per feature,
 * with state in <repo>/.dev-flow/<slug>/state.json (gitignored, flow-owned).
 *
 * Enforcement has three teeth:
 *  1. Gate commands (/flow approve|verify|release|release-done|finish) refuse
 *     to advance unless exit criteria hold (plan file, mockups, green tests,
 *     operator confirmations, recorded release).
 *  2. tool_call guards: no commits/pushes on the main branch outside the
 *     release stage; edits confined to the plan dir or the worktree; state.json
 *     is untouchable and the project.md playbook is operator-owned.
 *  3. before_agent_start injects the active stage so the model always knows
 *     where it is and which gate comes next, plus the skill's always-on core once
 *     per session (pi only advertises a skill; it never loads it unasked) and the
 *     one playbook reference file the current stage needs.
 *
 * The stage logic lives in src/core.ts (unit-tested); this file is pi wiring.
 * Inactive (fully pass-through) in repos without a .dev-flow/ directory.
 */
import { exec } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { compact, createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, isToolCallEventType, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	ALLOW_REWRITE,
	approveGate,
	applicableItems,
	appendReflection,
	appendRoadmapItem,
	bashFlowGuard,
	checkFingerprint,
	changelogVersionsBetween,
	normalizeReleaseBody,
	pendingEntryLines,
	pickReleaseNotes,
	checklistHash,
	checklistPending,
	checkoutInvocation,
	claimBlocks,
	classifyMergeHistory,
	cmpVersions,
	doneItemCount,
	detectForge,
	extractSkillCore,
	featureBranchPrefix,
	FLOW_SHELL_HINT,
	flowShellInvocation,
	forcePushInvocation,
	freshenChecks,
	gateHelpJson,
	gitInvocation,
	githubSlug,
	guardBash,
	guardPath,
	healthProbe,
	healthRetry,
	mergeShapeProof,
	mergeStyleInvocation,
	parseMergeStyle,
	investigationBrief,
	parseLsRemoteTags,
	parsePushRefs,
	playbookTamper,
	playbookOnlyChange,
	pluginVersion,
	preReleaseGate,
	guessReflectSections,
	reflectItems,
	reflectMove,
	reflectDone,
	reflectProtocol,
	reflectUnfiledCount,
	reflectLegacyPluginCount,
	reflectionNudges,
	pluginIssueRecipe,
	type ReflectTarget,
	buildReflectBrief,
	parseReflectReport,
	renderReflectFindings,
	childSessionFiles,
	conflictMarkerLines,
	isReleaseOnly,
	digestTranscript,
	workerSteer,
	WORKER_STEER_AT,
	WORKER_SALVAGE,
	WORKER_SALVAGE_MS,
	WORKER_NUDGE_READONLY,
	type SessionHeaderInfo,
	reflectionLine,
	reflectionRoutes,
	reflectionsTidy,
	type ReflectItem,
	type ReflectSection,
	stageReference,
	sessionRunsOlderBuild,

	listFiles,
	looksLikeShellError,
	needsOperator,
	newestTaggedVersion,
	newState,
	nextHint,
	openChecklistItems,
	releaseGate,
	parseVersion,
	roadmapDone,
	roadmapDoneForSlug,
	roadmapOpenCount,
	roadmapBriefFor,
	roadmapPick,
	roadmapTidy,
	shouldSelfCompact,
	shouldTakeOverCompaction,
	stageGuidance,
	stateTamper,
	statusFor,
	statusJson,
	subst,
	sq,
	featureTmpDir,
	featureTmpEnv,
	compactionStateBlock,
	foreignWorktreeLinks,
	withTmpDir,
	tagNotesCommand,
	validSlug,
	verifyGate,
	versionTagGate,
	widgetLines,
	chipLabel,
	writeGuard,
	mainCheckoutRoot,
	buildWorkerBrief,
	clampBudgetMin,
	parseWorkerReport,
	workerTurnError,
	workerOpError,
	WORKER_NUDGE,
	WORKER_NUDGES,
	type WorkerOp,
	releaseOrderInvocation,
	type BranchState,
	type Config,
	type FeatureRef,
	type FlowState,
	type StageCheck,
	type PushRef,
	type SessionClaim,
} from "../src/core.ts";
import { applyAnswers, buildDraft, doctorFindings, ghostFeatureDirs, lineDiff, loadProject, mdDigest, parseAnswers, parseProjectMd, setPlaybookKey } from "../src/projectmd.ts";
import { dedupeReflections, linkedTag, parseGhIssues, similarNote, type FoldResult, type GhIssue } from "../src/fold.ts";
import { bashTimeout, requireTimeout } from "../src/timeouts.ts";
import { detectProject, type Detection } from "../src/detect.ts";

const execAsync = promisify(exec);

/** This build's own identity, read once at load: it is what this session's code IS — an update that
 * rewrites the package on disk later does not change the code already running. */
const SELF_BUILD = pluginVersion(import.meta.dirname);

/** The dev-flow build this session actually loaded — see sessionRunsOlderBuild. The load-time
 * manifest, never a fresh read: re-reading the package after an in-place update reported the NEW
 * version as loaded and the stale one as shipped (lettuce rail-ui-fixes, 0.79.0 → 0.80.0).
 * DEV_FLOW_LOADED_VERSION (read at call time) can stand in for it (the smoke suite runs gates
 * in-process and needs to pretend it is an old session): the override can only ever make a gate more
 * cautious — it never lifts a proof, it turns a release into a warn-and-ask. */
function loadedVersion(): string | null {
	return process.env.DEV_FLOW_LOADED_VERSION?.trim() || SELF_BUILD.version;
}

/** The dev-flow build this session *should* be running, as the disk describes it, and how to call it.
 * In the dev-flow repo that is the checkout's own manifest: main moves ahead of the installed copy at
 * every release, while `loadedVersion()` and the plugin's own package.json are the same file — so a
 * session running 0.54.0 in a checkout already at 0.58.1 compared equal and nothing anywhere said so.
 * In a normal project the only manifest is the installed package's, which a mid-session update moves. */
function checkoutBuild(root: string): { version: string | null; dir: string; repo: string; label: string } {
	return isSelfRepo(root)
		? { ...pluginVersion(root), label: "this checkout" }
		: { ...pluginVersion(import.meta.dirname), label: "the dev-flow install" }; // fresh: what the disk ships NOW
}

/** The build this session runs vs the one the disk ships: `behind` is the loaded version when they differ
 *  ("" when current or unknown), `line` the one warning every surface prints for it. */
function buildSkew(root: string): { disk: ReturnType<typeof checkoutBuild>; behind: string; line: string } {
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
interface CopyEntry {
	dir: string;
	version: string | null;
	pid: number;
	at: string;
}
const COPIES: CopyEntry[] = ((globalThis as { __piDevFlowCopies?: CopyEntry[] }).__piDevFlowCopies ??= []);
function registerCopy(): void {
	const mine = COPIES.find((r) => r.dir === SELF_BUILD.dir && r.pid === process.pid);
	if (mine) Object.assign(mine, { version: loadedVersion(), at: new Date().toISOString() });
	else COPIES.push({ dir: SELF_BUILD.dir, version: loadedVersion(), pid: process.pid, at: new Date().toISOString() });
}
function otherCopies(): CopyEntry[] {
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
function guardsAreMine(): boolean {
	const mine = SELF_BUILD.version;
	if (!mine) return true; // an unreadable version is never outranked
	return !otherCopies().some((r) => r.version && cmpVersions(r.version, mine) > 0);
}
function copyWarning(): string | null {
	const dup = otherCopies();
	if (!dup.length) return null;
	const verdict = guardsAreMine() ? "this copy is the newest and judges the guards" : "this copy is older and stays silent \u2014 the newest copy judges";
	return `warning: ${dup.length} other dev-flow cop${dup.length === 1 ? "y" : "ies"} registered in this process: ${dup.map((d) => `${d.dir} (${d.version ?? "?"})`).join(", ")} \u2014 this call served by ${SELF_BUILD.dir} (${SELF_BUILD.version ?? "?"}); ${verdict}. Keep only one source you intend; a host restart drops stale code (README: two sources at once)`;
}
/** Test seam: the smoke suite cannot load a second copy of this module, so it plants registry
 * entries and asserts the warnings the real duplicate would print. */
export const testSeams = { copies: COPIES, skillCore: { value: undefined as string | null | undefined }, piweb: { meta: piwebWorkerMeta, stamp: piwebStamp, liveClaim: piwebLiveClaim, workerName } };

interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
}

const now = () => new Date().toISOString();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sh(command: string, cwd: string, timeoutMs = 15 * 60_000, env?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
		return { ok: true, out: `${stdout}\n${stderr}`.trim() };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || String(err.message) };
	}
}

/** origin's URL, or null when the repo has no origin. */
async function originUrl(root: string): Promise<string | null> {
	const r = await sh("git remote get-url origin", root, 10_000);
	return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** The forge the release machinery targets: the playbook's `forge`, else detected from origin ("self" without one). */
const forgeOf = (cfg: Config, origin: string | null): string => cfg.forge || detectForge(origin ?? "");

/** The branch's merge base with the default branch (origin's when fetched), or "" when git cannot say. */
async function mergeBase(cwd: string, defaultBranch: string): Promise<string> {
	const mb = await sh(`git merge-base origin/${sq(defaultBranch)} HEAD 2>/dev/null || git merge-base ${sq(defaultBranch)} HEAD 2>/dev/null || true`, cwd);
	return mb.ok ? mb.out.trim() : "";
}

/** The published pi-dev-flow version (`--check-upstream`), or "" when the registry cannot be asked. */
async function publishedVersion(root: string): Promise<string> {
	const pub = await sh("npm view pi-dev-flow version", root);
	return pub.ok ? (pub.out.trim().split("\n").pop() ?? "") : "";
}

const dfDir = (root: string) => path.join(root, ".dev-flow");
/** dev-flow is initiated once the operator playbook exists: before flow init writes project.md the
 *  extension is silent in that folder — no injections, no guards (not even the no-playbook bash-timeout
 *  default), no footer. The flow tool itself stays registered so flow init remains callable. */
const initiated = (root: string): boolean => existsSync(path.join(dfDir(root), "project.md"));

/** A `--merge=squash` style flag, or null when absent. Returned as the raw string: the caller validates it
 *  with parseMergeStyle so a typo is reported instead of ignored. */
function flagValue(rest: string[], name: string): string | null {
	for (const a of rest) {
		const m = a.match(new RegExp(`^--${name}=([\\s\\S]+)$`)); // a --brief= value spans lines
		if (m) return m[1];
	}
	return null;
}

/** One cheap first-parent log tells the operator what their repo actually does when a PR merges: merge
 *  commits or one squashed commit per PR. `flow init` and `flow start` ask with this evidence instead of
 *  asking blind; null when there is no default-branch log to read. */
async function mergeHistoryEvidence(root: string, defaultBranch: string): Promise<{ note: string; recent: "squash" | "merge" | "rebase" | null } | null> {
	const log = await sh(`git log --first-parent -n 40 --format=%p|%s ${sq(`origin/${defaultBranch}`)} 2>/dev/null || git log --first-parent -n 40 --format=%p|%s ${sq(defaultBranch)} 2>/dev/null`, root);
	if (!log.ok || !log.out.trim()) return null;
	const c = classifyMergeHistory(log.out.split("\n"));
	return { note: c.note, recent: c.recent };
}

/** How the forge says the PR landed, when it can be asked — the only way to tell a squash from a rebase,
 *  because both erase the branch's ancestry. null = unaskable (self-hosted, no CLI, no merged PR found). */
async function forgeMergeStyle(root: string, forge: string, branch: string): Promise<"squash" | "merge" | "rebase" | null> {
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
async function writePlaybookMergePolicy(root: string, style: string): Promise<{ note: string } | { err: string }> {
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
async function runHealthProbe(cmd: string, cwd: string, waitSec: number, env?: Record<string, string>): Promise<{ ok: boolean; out: string; attempts: number }> {
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
async function releaseTags(root: string): Promise<string[] | null> {
	if (!(await originUrl(root))) return (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
	const remote = await sh("git ls-remote --tags origin", root);
	if (!remote.ok) return null;
	return parseLsRemoteTags(remote.out);
}

const GATE_HELP =
	"help [--json] | init [--force|--draft|--write <text>|--write-file <path>|--answers key=value…|--answers-file <path>] [--confirmed] [--track] | reflect [<note>|list|tidy|move <n> --playbook|--code|done <n> [<what>]] | roadmap [add <text> [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]|pick <n> <slug>|done <n>|tidy] | doctor [<issue note>] | status [slug] [--json] | start <slug> [--ui|--patch|--docs --confirmed] [--force] [--merge=squash|merge|rebase|any] [--check-upstream] | use <slug> | test | check | health | approve [--yolo] | verify [--yolo] | release [--yolo|--no-version|--no-fold-check|--no-marker-check] | release-done [--no-artifact-check|--no-release-create] | finish [--yolo] [--no-reflect] [--note=<text>] [slug] | abort [slug] | version [--check-upstream] — state gates take [slug] and --confirmed (the operator already answered in chat); without it they ask in a dialog, or refuse with NEEDS-OPERATOR when no UI is present — --ui/--patch/--docs and --merge=<style> on start are operator-granted (--confirmed); start refuses until the playbook has a merge policy and writes the answer into project.md — --yolo (with --confirmed) answers that checkpoint and pre-confirms every later one; checks and guardrails stay — release --no-version ships merge + changelog only (no bump, tag or forge release); --no-fold-check skips the changelog fold line proofs on the operator's word; --no-marker-check lets a branch add conflict-marker-shaped lines on purpose — finish runs the closing reflection worker first (before removing anything) and stops for the operator's fold/drop; the re-run with --confirmed cleans up; --no-reflect --confirmed skips it on the operator's explicit word (yolo never does), --note= hands the worker the operator's friction notes — release names a session running an older dev-flow build than the disk ships and asks update (/reload) or proceed — recorded, never a block — reflect <note> queues a project suggestion in reflections.md (--playbook = docs-flow fix, --code = patch-flow fix); --plugin never writes — dev-flow feedback goes upstream and it prints the GitHub issue recipe; bare reflect prints the session-reflection protocol (bound: run flow_stage op reflect); list numbers open items, move <n> re-files one, done <n> checks a fixed one off, tidy drops closed ones — roadmap manages .dev-flow/roadmap.md: pick <n> <slug> (or add --slug=) stamps an item for flow start, which seeds the new plan from its brief; finish checks it off — a new feature asked for mid-flow is parked there, never as a hand-made .dev-flow/<slug>/; start <slug> --confirmed adopts such a ghost dir — doctor reviews structure, git consistency and open reflections (never writes); doctor <note> prints an investigation brief — version prints the build the disk ships and any other dev-flow copies in this process (--check-upstream asks the registry)";
const featDir = (root: string, slug: string) => path.join(dfDir(root), slug);
const stateFile = (root: string, slug: string) => path.join(featDir(root, slug), "state.json");
const claimFile = (root: string, slug: string) => path.join(featDir(root, slug), "claim.json");

function readState(root: string, slug: string): FlowState | null {
	try {
		return JSON.parse(readFileSync(stateFile(root, slug), "utf8")) as FlowState;
	} catch {
		return null;
	}
}

function writeState(root: string, state: FlowState): void {
	atomicWrite(stateFile(root, state.slug), `${JSON.stringify(state, null, "\t")}\n`);
}

/** Replace a file in one move. Gates write state after every check, and a kill in the middle left a
 *  truncated state.json — which reads as "no such feature", silently orphaning the worktree, the plan
 *  and every recorded check, with the folder gitignored so nothing else could restore it. */
function atomicWrite(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Session bindings: one flow per pi session; persisted per session branch via appendEntry.
 *  Module-level means shared by every session in the process — pi runs many sessions inside one Node
 *  process (pi-web's agent lives in the server) — so every key here is a session identity and every
 *  entry is released when that session ends (see releaseSession). */
const bindings = new Map<string, string | null>();
// Two identities are possible: pi's session id, or — when the host hands out none — the working
// directory. Both are prefixed, because a claim written under the directory identity is not a session:
// two pi sessions sharing one directory share that key, and `cwd:` in a claim file says so out loud
// instead of reading like a session that went missing.
const sessionKey = (ctx: { cwd: string; sessionManager?: { getSessionId(): string } }): string =>
	ctx.sessionManager?.getSessionId() ? `sid:${ctx.sessionManager.getSessionId()}` : `cwd:${ctx.cwd}`;
/** Sessions with a dev-flow-initiated compaction in flight (prevents stacked compactions). */
const compacting = new Set<string>();
/** Sessions that already received the skill's always-on core this session. The `dev-flow-skill`
 *  entry records the injection in the session branch, so /reload, resume and fork restore the fact
 *  instead of paying ~1k tokens a second time. */
const coreInjected = new Set<string>();
/** Sessions whose last compaction dropped the core out of context — the next run pays it once more. */
const coreStale = new Set<string>();
/** The skill dir of THIS loaded copy: the copy a session runs and a development checkout can be
 *  different installs, so playbook paths resolve from the code actually loaded — never from cwd. */
const SKILL_DIR = path.join(import.meta.dirname, "..", "skills", "dev-flow");
let skillCoreCache: string | null | undefined;
/** The core block between SKILL.md's markers, read once per process (/reload reloads the module
 *  and picks up edits). Null — no file, no markers, empty core — leaves every message exactly as it
 *  was: a copy shipped without its skill must not take the guards, or the run, down. */
function skillCore(): string | null {
	// Seam first: a test cannot ship a copy of the package with its skills/ directory deleted.
	if (testSeams.skillCore.value !== undefined) return testSeams.skillCore.value;
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
const CONTEXT_EMITTED = Symbol.for("pi-dev-flow.context-emitted");

/** Every feature with a state file — finish deletes the state, so whatever is on disk is unfinished. */
function unfinishedStates(root: string): FlowState[] {
	if (!existsSync(dfDir(root))) return [];
	return readdirSync(dfDir(root), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readState(root, d.name))
		.filter((s): s is FlowState => !!s);
}

/** Open items of the agent's suggestion queue (.dev-flow/reflections.md), each with its section. */
const readReflections = (root: string): ReflectItem[] => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? reflectItems(readFileSync(f, "utf8")) : [];
};

/** Raw reflections.md content — the closed-item count needs the checked lines the open-only reader drops. */
const readReflectionsText = (root: string): string => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};

const roadmapFile = (root: string) => path.join(dfDir(root), "roadmap.md");
const readRoadmap = (root: string): string => {
	const f = roadmapFile(root);
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** The session's feature — explicit bindings only: flow start/flow use bind, resume restores from session
 *  history. Never binds on its own: an unbound session stays unbound however few features are unfinished,
 *  and reading it must never claim anything. The claim on disk IS the persisted binding — bind() stamps the
 *  session key into claim.json — so trust the disk after the in-memory map: a second registered dev-flow
 *  copy (both copies evaluate the guard hooks) or a re-instantiated module then attributes the session's
 *  own feature from disk instead of misjudging with stage null. */
function boundFeature(root: string, key: string): FlowState | null {
	const bound = bindings.get(key);
	if (bound) {
		const s = readState(root, bound);
		if (s) return s;
	}
	return unfinishedStates(root).find((s) => readClaim(root, s.slug)?.key === key) ?? null;
}

function readClaim(root: string, slug: string): SessionClaim | null {
	try {
		return JSON.parse(readFileSync(claimFile(root, slug), "utf8")) as SessionClaim;
	} catch {
		return null;
	}
}

const writeClaim = (root: string, slug: string, key: string) =>
	atomicWrite(claimFile(root, slug), `${JSON.stringify({ key, pid: process.pid, at: now() })}\n`);

/** Let go of everything one session held. In a shared-process host the pid on a claim is the server's and
 *  never dies, so a claim left behind by a finished session keeps refusing every later session with
 *  "claimed by another live session" — the lock has to end with the session that wrote it. Idempotent:
 *  shutdown, reload and process exit can converge on this path. */
function releaseSession(root: string, key: string): void {
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
function claimBlocker(root: string, key: string): { state: FlowState; claim: SessionClaim } | null {
	const un = unfinishedStates(root);
	if (un.length !== 1) return null;
	const claim = readClaim(root, un[0].slug);
	return claim && claimBlocks(claim, key) ? { state: un[0], claim } : null;
}

/** Flow-aware focus for any compaction dev-flow initiates — state lives on disk, the summary must not invent it. */
const flowCompactInstructions = (st: FlowState) =>
	`dev-flow feature "${st.slug}", stage "${st.stage}" — flow state is persisted on disk (state.json, plan/). Preserve verbatim: operator answers not yet recorded by a gate, reasons for uncommitted changes, and the exact next action from the last exchange.`;

/**
 * Flow-aware self-compaction at safe points: called after a successful gate (state just hit disk),
 * at every turn_end and when a run settles. Only fires within COMPACT_MARGIN of pi's own threshold
 * (computed with the *effective* reserveTokens — settings + model overrides, like pi does) and
 * never while chat-only state is pending (open dialog, undigested plan) — see shouldSelfCompact.
 */
function maybeCompactNow(ctx: ExtensionContext, root: string): void {
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

function featureRefs(root: string): FeatureRef[] {
	return unfinishedStates(root).map((s) => ({ state: s, worktreeAbs: s.worktree ? path.resolve(root, s.worktree) : null }));
}

function worktreeAbs(root: string, state: FlowState): string | null {
	return state.worktree ? path.resolve(root, state.worktree) : null;
}

/** Git-level consistency probes for the doctor: orphan worktrees/branches, features missing their worktree. */
async function gitConsistency(root: string, cfg: Config): Promise<string[]> {
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
function gateCwd(root: string, state: FlowState): string {
	const wt = worktreeAbs(root, state);
	return wt && existsSync(wt) ? wt : root;
}

/** TMPDIR for the project commands a gate runs: the feature's own scratch dir, removed at finish —
 *  a test suite's mkdtemp fixtures no longer pile up in the OS temp dir. */
function featureEnv(root: string, state: FlowState): Record<string, string> {
	const dir = featureTmpDir(dfDir(root), state.slug);
	mkdirSync(dir, { recursive: true });
	return featureTmpEnv(dir);
}

/** Tier-1 checks the gate still has to see green. Entering a stage — and every edit of the worktree —
 * clears the records, so "run flow check first" cost three round trips to say what one could (#84).
 * `health` is left to the post-deploy probe when there is a deploy to prove: probing twice only waits twice. */
function pendingChecks(state: FlowState, cfg: Config): StageCheck[] {
	if (state.docs) return [];
	return cfg.checkList.filter((c) => !state.checks[c.name]?.ok && !(c.name === "health" && healthRerunsAfterDeploy(cfg)));
}

/** Run tier-1 checks in the feature cwd and record each result (health seeds first, as `flow health` does). */
async function runChecks(root: string, state: FlowState, cfg: Config, checks: StageCheck[]): Promise<{ lines: string[]; failed: boolean }> {
	const lines: string[] = [];
	let failed = false;
	const ran: string[] = [];
	for (const c of checks) {
		// health is the same probe `flow health` runs: seeded first, retried within healthWait
		const res = c.name === "health" ? await seededProbe(root, state, cfg, c.cmd) : await sh(c.cmd, gateCwd(root, state), undefined, featureEnv(root, state));
		if ("seedFail" in res) {
			lines.push(res.seedFail.text);
			failed = true;
			break;
		}
		state.checks[c.name] = { ok: res.ok, at: now() };
		ran.push(c.name);
		const tried = triedNote((res as { attempts?: number }).attempts ?? 1);
		lines.push(`${c.name}: ${res.ok ? "PASS" : "FAIL"} (${c.cmd}${tried})${res.ok ? "" : `\n${tail(res.out)}`}`);
		if (!res.ok) failed = true;
	}
	await stampChecks(root, state, ran);
	writeState(root, state);
	return { lines, failed };
}

/** Which health record a verify may leave stale on purpose: the post-deploy probe re-runs it, so
 *  the pre-deploy record must survive the gate that schedules the deploy. */
const healthRerunsAfterDeploy = (cfg: Config) => !!cfg.commands.dev && !!healthProbe(cfg);

/** Seed pre-existing data before a health probe, recording the step (`flow health` and the verify
 *  deploy probe both do this). Returns an error result on failure, null when seeded or not configured. */
async function seedStep(root: string, state: FlowState, cfg: Config): Promise<{ text: string; isError: true } | null> {
	if (!cfg.commands.seedData) return null;
	const seed = await sh(cfg.commands.seedData, gateCwd(root, state), undefined, featureEnv(root, state));
	state.checks.seedData = { ok: seed.ok, at: now() };
	writeState(root, state);
	return seed.ok ? null : { text: `seedData FAILED (${cfg.commands.seedData}):\n${tail(seed.out)}`, isError: true };
}

type HealthRun = { ok: boolean; out: string; attempts: number } | { seedFail: RunResult };

/** Seed (when configured), then run the health probe within the playbook's wait budget. */
async function seededProbe(root: string, state: FlowState, cfg: Config, probe: string): Promise<HealthRun> {
	const seedFail = await seedStep(root, state, cfg);
	return seedFail ? { seedFail } : runHealthProbe(probe, gateCwd(root, state), cfg.healthWait, featureEnv(root, state));
}

/** seededProbe, recorded and stamped as the `health` check — `flow health` and both verify probes. */
async function probeHealth(root: string, state: FlowState, cfg: Config, probe: string): Promise<HealthRun> {
	const res = await seededProbe(root, state, cfg, probe);
	if ("seedFail" in res) return res;
	state.checks.health = { ok: res.ok, at: now() };
	await stampChecks(root, state, ["health"]);
	writeState(root, state);
	return res;
}

/** A probe that needed the wait budget says so — "it passed on the 9th try" is the operator's business (#42). */
const triedNote = (attempts: number) => (attempts > 1 ? `, ${attempts} attempts` : "");

/** Fingerprint of the working-tree state the checks ran against: paths (`status --porcelain`),
 *  tracked content (a hash of the uncommitted diff) and HEAD. Null when git cannot answer — a
 *  measurement failure must never mark a green record stale (see freshenChecks). */
async function worktreeFingerprint(cwd: string): Promise<string | null> {
	const st = await sh("git status --porcelain", cwd);
	if (!st.ok) return null;
	const diff = await sh("git diff HEAD --no-color | git hash-object --stdin", cwd);
	const head = await sh("git rev-parse HEAD", cwd);
	if (!diff.ok || !head.ok) return null;
	return checkFingerprint(`${st.out}\n${diff.out}`, head.out);
}

/** Stamp freshly recorded checks with the tree they ran against — taken AFTER the run, so a check
 *  that rewrites tracked files (a formatter, codegen) does not mark itself stale the moment it passes. */
async function stampChecks(root: string, state: FlowState, names: string[]): Promise<void> {
	const fp = await worktreeFingerprint(gateCwd(root, state));
	if (!fp) return;
	for (const n of names) if (state.checks[n]) state.checks[n].wt = fp;
}

/** Commits the feature branch holds over its merge base with the default branch, plus how many
 *  paths sit uncommitted: verify's proof that there is a committed state behind the operator's
 *  question. Local refs only — same offline-safe stance as the changelog proof — and an
 *  unanswerable merge base reports null instead of refusing on a measurement failure. */
async function branchState(cwd: string, defaultBranch: string): Promise<BranchState> {
	const base = await mergeBase(cwd, defaultBranch);
	if (!base) return { commitsAhead: null, uncommitted: 0 };
	const ahead = await sh(`git rev-list --count ${sq(base)}..HEAD`, cwd);
	const n = Number.parseInt(ahead.out.trim(), 10);
	const dirty = await sh("git status --porcelain", cwd);
	return {
		commitsAhead: Number.isFinite(n) ? n : null,
		uncommitted: dirty.ok ? dirty.out.split("\n").filter((l) => l.trim()).length : 0,
	};
}

/** Commits HEAD carries since the newest local version tag (all of them before the first release) —
 *  local refs only, so the probe stays offline-safe. HEAD is the default branch's tip on an empty branch. */
async function unreleasedOnMain(cwd: string, pattern: string): Promise<{ count: number | null; since: string | null }> {
	const tags = await sh("git tag --list", cwd);
	const newest = tags.ok ? newestTaggedVersion(pattern, tags.out.split("\n").map((t) => t.trim()).filter(Boolean)) : null;
	const since = newest ? pattern.replace("{version}", newest) : null;
	const r = await sh(since ? `git rev-list --count ${sq(since)}..HEAD` : "git rev-list --count HEAD", cwd);
	const n = Number.parseInt(r.out.trim(), 10);
	return { count: r.ok && Number.isFinite(n) ? n : null, since };
}

function describeBranchState(b: BranchState, defaultBranch: string): string {
	if (b.commitsAhead === null) return `commits: unknown (no merge base with ${defaultBranch} — the commit proof is skipped)`;
	const line = `commits: ${b.commitsAhead} ahead of ${defaultBranch}, ${b.uncommitted} uncommitted path(s)`;
	return b.commitsAhead === 0 && (b.unreleased?.count ?? 0) > 0
		? `${line} — release-only flow: ${b.unreleased!.count} unreleased commit(s) on ${defaultBranch}${b.unreleased!.since ? ` since ${b.unreleased!.since}` : " (nothing tagged yet)"}; verify proves that tree, the version bump is the pre-release commit`
		: line;
}

// ---------------------------------------------------------------- gate runner

interface RunResult {
	text: string;
	isError?: boolean;
}

interface Session {
	slug: string | null;
	key: string;
	bind: (slug: string | null) => void;
	/** Name the pi session after a slug (one session = one feature: the picker shows the feature). */
	rename: (slug: string) => void;
}

/** Is this checkout the dev-flow repo itself? Plugin reflections are fixable in-repo only here. */
function isSelfRepo(root: string): boolean {
	try {
		return (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown }).name === "pi-dev-flow";
	} catch {
		return false;
	}
}

/** Which tag convention the repo already uses — read off its newest tags, like the merge style is read off
 *  its history. null = no version-like tags yet (the v{version} default stands, and is asked about). */
async function tagPatternEvidence(root: string): Promise<{ pattern: string; note: string } | null> {
	const r = await sh("git tag --list --sort=-creatordate", root, 10_000);
	if (!r.ok) return null;
	const tags = r.out.split("\n").map((t) => t.trim()).filter((t) => /\d+\.\d+\.\d+/.test(t)).slice(0, 20);
	if (!tags.length) return null;
	const prefix = (t: string) => t.slice(0, t.search(/\d+\.\d+\.\d+/));
	const counts = new Map<string, number>();
	for (const t of tags) counts.set(prefix(t), (counts.get(prefix(t)) ?? 0) + 1);
	const [top] = [...counts.entries()].sort((x, y) => y[1] - x[1]);
	return { pattern: `${top[0]}{version}`, note: `${tags.length} version tag(s), newest ${tags[0]}${counts.size > 1 ? ` (mixed prefixes: ${[...counts.keys()].map((k) => k || "none").join(", ")})` : ""}` };
}

/** One setup question: what to ask, what detection found, why it matters, and the answer that accepts it. */
export interface SetupQuestion {
	key: string;
	ask: string;
	detected?: string;
	/** `flow init --answers` token(s) that accept the detected/suggested value */
	accept?: string;
	why: string;
}

/** The questions `flow init` asks before writing a playbook — detection fills what it can, the operator
 *  answers the rest (the agent relays them). Every question says why it matters and what skipping costs,
 *  so it is answerable without reading docs/playbook.md first. */
function setupQuestions(det: Detection, ev: { merge?: { note: string; recent: string | null } | null; tag?: { pattern: string; note: string } | null }): SetupQuestion[] {
	const sug = (k: string) => det.suggestions.filter((x) => x.key === k);
	const q: SetupQuestion[] = [];
	const forge = det.partial.forge;
	q.push({ key: "forge", ask: "Where is the repo hosted: github, gitlab or self (plain git)?", detected: forge ? `${forge} (from the origin URL)` : "no origin remote", accept: forge ? `forge=${forge}` : undefined, why: "decides who creates the release and how dev-flow proves a PR really merged (gh/glab); self = git only, no automatic releases" });
	const vf = det.partial.versioning?.file;
	q.push({ key: "versionFile", ask: vf ? `Version lives in ${vf} — keep it?` : "Which file holds the version? (VERSION recommended for non-package repos; or answer that releases carry no version)", detected: vf, accept: vf ? `versionFile=${vf}` : undefined, why: "a release bumps this file and the tag must match it; without one, every release is merge-only (no bump, no tag)" });
	const tag = ev.tag?.pattern ?? "v{version}";
	q.push({ key: "versionTag", ask: `Tag pattern: ${tag}?`, detected: ev.tag ? `${ev.tag.note}` : "no version tags yet — default v{version}", accept: `versionTag=${tag}`, why: "release tags and the manifest are checked against each other; a pattern that differs from your existing tags breaks the last-release lookup" });
	q.push({ key: "merge", ask: "How should a merged PR land on the default branch: squash, merge (a merge commit), rebase, or any (no policy)?", detected: ev.merge?.note ?? "no history to read a style from", accept: ev.merge?.recent ? `merge=${ev.merge.recent}` : undefined, why: "the guard blocks a PR merge in a different style and release-done proves what landed; flow start refuses until this is answered" });
	q.push({ key: "releases", ask: "Should release-done create the forge release automatically (gh/glab release from the changelog entry)?", detected: forge === "self" ? "forge = self: no CLI to create one" : undefined, accept: forge === "self" ? "releases=false" : "releases=true", why: "off = the tag is pushed and publishing the release page stays your manual step" });
	const art = sug("artifact");
	q.push({ key: "artifact", ask: art.length ? "Verify the published artifact after release with this command?" : "Do you publish anything to a registry (npm, crates.io, a container image)? If so, which command proves the version is out?", detected: art.map((a) => a.why).join("; ") || undefined, accept: art[0] ? `artifact=${art[0].value}` : undefined, why: "release-done refuses to finish until the artifact is really there — catches a CI publish that silently failed; none = no check" });
	const pre = sug("preflight");
	if (pre.length) q.push({ key: "preflight", ask: `Run \`${pre[0].value}\` before anything ships?`, detected: pre[0].why, accept: `preflight=${pre[0].value}`, why: "flow release runs it in the worktree first — a build the tag would trigger, proven before the tag exists" });
	const checks = det.partial.checks ?? {};
	q.push({
		key: "check.<name>",
		ask: `Tier-1 checks: ${det.missing.length ? `not detected: ${det.missing.join(", ")}` : "test/build/run detected"}${Object.keys(checks).length ? `; drafted extra checks: ${Object.keys(checks).join(", ")}` : ""}. Correct? Anything CI runs that is missing (lint, typecheck, e2e)?`,
		detected: Object.entries(det.partial.commands).filter(([k]) => k !== "setup").map(([k, v]) => `${k}: ${v}`).join(" · ") || undefined,
		why: "flow check runs every one of these and the gates refuse while any fails — a check missing here is a failure only CI will see; answer test=… / build=… / check.<name>=<cmd> (empty value removes)",
	});
	const dev = sug("dev");
	q.push({ key: "health", ask: `Does the app expose a health probe (e.g. curl -fs localhost:PORT/healthz)?${dev.length ? ` And use \`${dev[0].value}\` as the dev deploy reviewed before verify?` : " Is there a dev deploy reviewed before verify?"}`, detected: dev[0]?.why, accept: dev[0] ? `dev=${dev[0].value}` : undefined, why: "verify proves the running build is healthy only with a probe; none is fine for libraries and CLIs" });
	if (det.partial.changelog === "") q.push({ key: "changelog", ask: "No changelog found — create CHANGELOG.md, or run without one?", accept: "changelog=", why: "the release gates fold the branch's entry into the version heading; empty = no changelog checks at all" });
	q.push({ key: "guard", ask: `Any commands the agent must never run, or files it must never touch?${det.partial.guards?.length ? ` (drafted from disk: ${det.partial.guards.map((g) => g.split(" :: ")[0].replace(/\s+/g, " ")).join(", ")})` : ""}`, why: "flow-guard rules are hard blocks or operator confirmations on every shell call and edit; added with flow init --write-file (free text)" });
	q.push({ key: "checklist", ask: "Anything you want to tick off by hand per stage (e.g. 'migration tested on a prod copy'), or standing guidance the agent should read at a stage?", why: "checklist items are confirmed as a set at the gate; prose is injected when the stage begins — both are free text: flow init --write-file" });
	return q;
}

function renderQuestions(qs: SetupQuestion[]): string[] {
	const out: string[] = [];
	qs.forEach((x, i) => {
		out.push(`  ${i + 1}. [${x.key}] ${x.ask}`);
		if (x.detected) out.push(`     detected: ${x.detected}`);
		if (x.accept) out.push(`     accept: ${x.accept}`);
		out.push(`     why: ${x.why}`);
	});
	return out;
}

const GIT_TRACK_NOTE = 'the playbook belongs in git: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md" (force-add: a root .gitignore may exclude .dev-flow/ entirely — tracked once, the ignore stops mattering; the env prefix is for the pre-commit hook, dev-flow itself lets a main commit whose only change is the playbook)';

/** The dev-flow repo plugin notes are filed against: the manifest's repository field; the dev-flow
 *  checkout itself falls back to its origin. */
async function pluginUpstream(root: string): Promise<string> {
	return pluginVersion(import.meta.dirname).repo || (isSelfRepo(root) ? githubSlug((await originUrl(root)) ?? "") : "");
}

/** `flow reflect <note>` — this project's queue, operator decides. `--playbook` / `--code` states the
 *  section (the agent knows what its own note is about); `--plugin` is dev-flow feedback, which never
 *  lands in a project's file — it prints the upstream issue recipe instead (in the dev-flow repo itself
 *  plugin IS code, so it files under `## code`). With no flag the wording guesses and the echo prints why. */
async function reflectNote(root: string, sess: Session, note: string[], forced: ReflectTarget | null): Promise<RunResult> {
	const file = path.join(dfDir(root), "reflections.md");
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const guess = guessReflectSections(note.join(" "));
	const self = isSelfRepo(root);
	const target = forced ?? guess.target;
	const why = forced ? "as told" : guess.why;
	const date = now().slice(0, 10);
	if (target === "plugin" && !self) return { text: [...pluginIssueRecipe(note.join(" "), await pluginUpstream(root), sess.slug, date), ...(forced ? [] : [`(filed as plugin: ${why} — a project note: flow reflect --playbook|--code "<note>")`])].join("\n") };
	const section: ReflectSection = target === "plugin" ? "code" : target;
	const line = reflectionLine(note.join(" "), sess.slug, date);
	const next = appendReflection(text, [section], line);
	if (next === text) return { text: `already reflected (duplicate): ${line}` };
	writeFileSync(file, next);
	// queueing is exactly when the operator hears about the checked-off pile — nudge only once it is worth a tidy
	const { tidy } = reflectionNudges(next, date);
	return { text: `reflected (${section} — ${target === "plugin" ? "dev-flow repo: plugin feedback is this project's code" : why}): ${line}` + (tidy ? `\n${tidy}` : "") };
}

/** In-process TTL cache per repo slug — repeat doctor runs in one session must not re-hit the API. */
const ghFoldCache = new Map<string, { at: number; issues: GhIssue[] }>();
const GH_FOLD_TTL_MS = 5 * 60_000;

/** Open GitHub issues of the repo's own origin — the channel external parties can file through.
 *  Three outcomes, only the third ever speaks: absent (no GitHub remote — not every repo has one,
 *  say nothing), skipped (gh missing / unauthenticated / offline / DEV_FLOW_NO_ISSUES — one line
 *  with the reason, never a guess), ok (the parsed list). */
async function fetchUpstream(root: string): Promise<{ slug: string; issues: GhIssue[] } | { skipped: string } | { absent: true }> {
	if (process.env.DEV_FLOW_NO_ISSUES) return { skipped: "disabled (DEV_FLOW_NO_ISSUES)" };
	const slug = githubSlug((await originUrl(root)) ?? "");
	if (!slug) return { absent: true };
	const hit = ghFoldCache.get(slug);
	if (hit && Date.now() - hit.at < GH_FOLD_TTL_MS) return { slug, issues: hit.issues };
	const r = await sh(`gh issue list --repo ${slug} --state open --json number,title,body --limit 100`, root, 10_000);
	if (!r.ok) return { skipped: `gh: ${r.out.split("\n").find(Boolean)?.slice(0, 140) || "failed"}` };
	const parsed = parseGhIssues(r.out);
	if (parsed === null) return { skipped: "unparseable gh output" };
	ghFoldCache.set(slug, { at: Date.now(), issues: parsed });
	return { slug, issues: parsed };
}

type FoldView = { state: "absent" } | { state: "skipped"; why: string } | { state: "ok"; slug: string; result: FoldResult; open: number };

async function foldView(root: string, items: ReflectItem[]): Promise<FoldView> {
	const up = await fetchUpstream(root);
	if ("absent" in up) return { state: "absent" };
	if ("skipped" in up) return { state: "skipped", why: up.skipped };
	return { state: "ok", slug: up.slug, result: dedupeReflections(items, up.issues), open: up.issues.length };
}

/** The fold block shared by flow doctor and flow reflect list: header, one row per unmatched
 *  issue with its route, then the unmerged near-miss hints. Local rows carry their ⟷ gh#N tag
 *  at the call site — the fold lists upstream items, it never re-numbers the local queue. */
function foldRows(fold: FoldView, selfRepo: boolean): string[] {
	if (fold.state === "absent") return [];
	if (fold.state === "skipped") return [`upstream issues: skipped (${fold.why})`];
	if (!fold.open) return [];
	const rows = [`upstream on ${fold.slug} — ${fold.open} open issue(s) on GitHub (canonical there — close on GitHub, never here; this is a fold, not a copy):`];
	for (const i of fold.result.upstreamOnly) rows.push(`  gh#${i.number} ${i.title} → ${selfRepo ? "fix in a flow here (patch flow if small)" : "fix in a flow here, or close won't-fix on GitHub"}`);
	for (const s of fold.result.similar) rows.push(`  ${similarNote(s, s.item + 1)}`);
	return rows;
}

/** `flow reflect list` — the queue numbered, so `move <n>` can address an item (same numbering as
 *  `flow roadmap`). Upstream items ride below the local queue as gh#N — never numbered, never
 *  addressable by move: each item keeps the home it is resolved in. */
async function reflectList(root: string): Promise<RunResult> {
	const items = readReflections(root);
	const fold = await foldView(root, items);
	const local = items.length
		? [
				`reflections — ${items.length} open:`,
				...items.map((it, i) => {
					const link = fold.state === "ok" ? fold.result.linked.find((l) => l.item === i) : undefined;
					return `  ${i + 1}. [${it.section}] ${it.line.replace(/^- \[ \] /, "")}${link ? linkedTag(link.issue) : ""}`;
				}),
			]
		: fold.state === "absent" || fold.state === "skipped"
			? ["reflections: nothing open"]
			: ["reflections: nothing open locally"];
	return { text: [...local, ...legacyPluginRows(readReflectionsText(root), isSelfRepo(root)), ...foldRows(fold, isSelfRepo(root))].join("\n") };
}

/** Open rows still under the legacy `## plugin` heading: they belong on GitHub, not in a project's queue. */
function legacyPluginRows(text: string, selfRepo: boolean): string[] {
	const n = reflectLegacyPluginCount(text);
	if (!n) return [];
	return [
		selfRepo
			? `reflections: ${n} open item(s) under the legacy ## plugin heading — in the dev-flow repo plugin is code: flow reflect move <n> --code`
			: `reflections: ${n} open item(s) under the legacy ## plugin heading belong on GitHub, not here — file each upstream (flow reflect --plugin "<note>" prints the recipe), then check it off '— filed: gh#NNN'`,
	];
}

/** `flow reflect move <n> --playbook|--code` — re-file an item under the other heading, so fixing a
 *  misfile is one command instead of hand-editing markdown. Nothing moves INTO `## plugin`: dev-flow
 *  feedback is filed upstream (flow reflect --plugin prints the recipe), then the row is checked off. */
function reflectMoveNote(root: string, args: string[], forced: ReflectTarget | null): RunResult {
	if (forced === "plugin") return { text: "move: plugin notes are not kept in reflections.md — file the item upstream (flow reflect --plugin \"<note>\" prints the recipe), then check the row off '— filed: gh#NNN' (in the dev-flow repo itself: move <n> --code)", isError: true };
	if (!forced) return { text: "usage: flow reflect move <n> --playbook | --code", isError: true };
	const section = forced;
	const n = Number(args[0]);
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	if (!Number.isInteger(n) || n < 1 || n > items.length) return { text: `move: open item 1–${items.length} required — flow reflect list numbers them`, isError: true };
	if (items[n - 1].section === section) return { text: `reflect: item ${n} is already under ## ${section}` };
	// the same note open under both headings (an old --both filing): the move merges it, it does not copy it
	const twin = items.some((it, i) => i !== n - 1 && it.section === section && it.body === items[n - 1].body);
	const next = reflectMove(text, n, section);
	if (next === null) return { text: `move: open item 1–${items.length} required — flow reflect list numbers them`, isError: true };
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const note = items[n - 1].line.replace(/^- \[ \] /, "");
	return { text: twin ? `reflect: item ${n} was already recorded under ## ${section} — the duplicate is gone (${note})` : `reflect: item ${n} re-filed under ## ${section} — ${note}` };
}

/** `flow reflect done <n> [what fixed it]` — check a folded/fixed item off, so doctor stops re-reporting it (#165). */
function reflectDoneNote(root: string, sess: Session, args: string[]): RunResult {
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	const n = Number(args[0]);
	if (!Number.isInteger(n) || n < 1 || n > items.length)
		return { text: items.length ? `done: open item 1–${items.length} required — flow reflect list numbers them` : "done: nothing open in reflections.md", isError: true };
	const stamp = [now().slice(0, 10), sess.slug].filter(Boolean).join(" ");
	const what = args.slice(1).join(" ").trim();
	const next = reflectDone(text, n, what ? `${stamp} — ${what}` : stamp)!;
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const { tidy } = reflectionNudges(next, now().slice(0, 10));
	return { text: `reflect: item ${n} checked off — ${items[n - 1].body}` + (tidy ? `\n${tidy}` : "") };
}

/** `flow reflect tidy` — drop the closed (`- [x]`) items; the `— fixed:` note already recorded the outcome. */
function reflectTidy(root: string): RunResult {
	const file = path.join(dfDir(root), "reflections.md");
	if (!existsSync(file)) return { text: "reflections: nothing to tidy (no queue yet)" };
	const text = readFileSync(file, "utf8");
	const closed = doneItemCount(text);
	const open = openChecklistItems(text).length;
	if (!closed) return { text: `reflections: nothing to tidy (${open} open, 0 closed)` };
	writeFileSync(file, reflectionsTidy(text));
	return { text: `reflections: dropped ${closed} closed item(s) — ${open} open` };
}

/** What a gate may need from the extension closure: finish runs the closing reflection worker itself. */
export interface FlowHooks {
	reflect?: (state: FlowState, note: string) => Promise<{ text: string; recorded: boolean; findings: number; failed: boolean }>;
}

/** Single runner for both the /flow command and the flow tool. */
async function runFlow(args: string[], root: string, ui: Ui, sess: Session, hooks: FlowHooks = {}): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	// help and version are questions about the plugin, not the repo: answerable with no .dev-flow/ at all
	if (sub === "help" || sub === "--help" || sub === "-h") return { text: rest.includes("--json") ? gateHelpJson(GATE_HELP, loadedVersion()) : `usage: flow <sub> — ${GATE_HELP}` };
	// an uninitiated folder is dormant: every gate verb but init and version needs the operator playbook (project.md)
	if (!initiated(root) && sub !== "init" && sub !== "version") return { text: "dev-flow is not initiated here — no .dev-flow/project.md — run flow init first", isError: true };
	const cfg = loadProject(dfDir(root)).cfg;
	const flag = (name: string) => rest.includes(`--${name}`);
	// the yolo word at Verified?/Release?/Finish?: the operator said it in chat, then re-run with --confirmed; checks and guardrails stay enforced
	const takeYoloWord = (state: FlowState): string | null => {
		if (!flag("yolo")) return null;
		if (!state.yolo && !flag("confirmed")) return "yolo is the operator's word — the operator must have said it in chat, then re-run with --yolo --confirmed";
		state.yolo = true;
		return null;
	};
	const slugArg = rest.find((a) => !a.startsWith("--"));
	const o: GateCtx = { root, ui, sess, cfg, rest, flag, slugArg, takeYoloWord, hooks };

	switch (sub) {
		case "init":
			return gateInit(o);

		case "start":
			return gateStart(o);

		case "status":
			return gateStatus(o);

		case "reflect":
			return gateReflect(o);

		case "roadmap":
			return gateRoadmap(o);

		case "doctor":
			return gateDoctor(o);

		case "version":
			return gateVersion(o);

		case "approve":
			return gateApprove(o);

		case "test":
			return gateTest(o);

		case "verify":
			return gateVerify(o);

		case "check":
			return gateCheck(o);

		case "health":
			return gateHealth(o);

		case "release":
			return gateRelease(o);

		case "release-done":
			return gateReleaseDone(o);

		case "finish":
			return gateFinish(o);

		case "use":
			return gateUse(o);

		case "abort":
			return gateAbort(o);

		default:
			return { text: `unknown subcommand "${sub}" — ${GATE_HELP}`, isError: true };
	}
}
/** Records the checkpoint word a gate asked for and has not been given: the footer shows 💬 (“operator,
 *  your turn”, the legend in docs/playbook.md) while a session is parked on an answer. Presentation only —
 *  no verdict reads it — and the same gate clears it when the word arrives (or when the answer is no and the
 *  turn returns to the agent). */
function markPendingAsk(root: string, state: FlowState, word: string): void {
	state.pendingAsk = word;
	writeState(root, state);
}

async function gateVerify(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const items = applicableItems(cfg, state!, "implement");
	const branch = await branchState(gateCwd(root, state!), cfg.defaultBranch);
	if (branch.commitsAhead === 0 && cfg.versioning.file) branch.unreleased = await unreleasedOnMain(gateCwd(root, state!), cfg.versioning.pattern);
	const branchLine = describeBranchState(branch, cfg.defaultBranch);
	// A green record belongs to the tree it ran against. A worktree change made through bash (sed,
	// a formatter, codegen) fires no edit-tool invalidation — the fingerprint is what notices the
	// tree moved, and the dropped records become pending so the gate itself reruns them (#84 path).
	const staleAtGate = freshenChecks(state!, await worktreeFingerprint(gateCwd(root, state!)), (n) => n === "health" && healthRerunsAfterDeploy(cfg));
	if (staleAtGate.length) writeState(root, state!);
	const pending = pendingChecks(state!, cfg);
	const gateRun = pending.length ? await runChecks(root, state!, cfg, pending) : null;
	if (gateRun?.failed) return { text: `verify gate FAILED — a check run at the gate failed:\n${gateRun.lines.join("\n")}\n${branchLine}`, isError: true };
	// tier-1 gate first (tier-2 confirmation is recorded by this very command, so it is excluded here)
	const preGate = verifyGate({ ...state!, confirmations: { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } } }, cfg, branch);
	if (preGate.length) return { text: `verify gate FAILED:\n- ${preGate.join("\n- ")}\n${branchLine}`, isError: true };
	// commands that take minutes and touch live services must say so (#38): a terse gate let the
	// agent tell the operator the dev deploy had never run, right after it recreated a container.
	const did: string[] = [];
	if (gateRun) did.push(`checks ran at the gate (${pending.map((c) => c.name).join(", ")})`);
	if (staleAtGate.length) did.push(`stale record(s) rerun after a worktree change: ${staleAtGate.join(", ")}`);
	if (state!.docs) {
		// docs mode's contract: no tier-1 work happens, so a docs flow neither builds, deploys nor probes (#43 #49)
		did.push("docs mode: project commands skipped (build/dev/health)");
	} else {
		if (cfg.commands.build) {
			const res = await sh(cfg.commands.build, gateCwd(root, state!), undefined, featureEnv(root, state!));
			state!.checks.build = { ok: res.ok, at: now() };
			writeState(root, state!);
			if (!res.ok) return { text: `build FAILED (${cfg.commands.build}):\n${tail(res.out)}`, isError: true };
			did.push(`build ran (${cfg.commands.build})`);
		}
		// deploy to dev before asking — the operator reviews the running dev app, not a promise
		const probe = healthProbe(cfg);
		if (cfg.commands.dev) {
			const res = await sh(cfg.commands.dev, gateCwd(root, state!), undefined, featureEnv(root, state!));
			state!.checks.dev = { ok: res.ok, at: now() };
			writeState(root, state!);
			if (!res.ok) return { text: `dev deploy FAILED (${cfg.commands.dev}):\n${tail(res.out)}`, isError: true };
			did.push(`dev ran (${cfg.commands.dev})`);
			// the deploy is what must be proven, not just run: a container that came back unhealthy, or
			// still serves the previous build, must not pass on a health PASS recorded before it was
			// recreated. What "the expected version" means is the project's business — the probe runs in
			// the worktree cwd, so it can compare the served build stamp with `git rev-parse HEAD`.
			if (!probe) did.push("health: none configured");
			else {
				const probed = await probeHealth(root, state!, cfg, probe);
				if ("seedFail" in probed) return probed.seedFail;
				if (!probed.ok) return { text: `post-deploy probe FAILED (${probe}) — the deploy is not healthy / not serving this build (gave up after ${probed.attempts} attempt(s), healthWait ${cfg.healthWait}s):\n${tail(probed.out)}`, isError: true };
				did.push(`health: PASS (${probe}${triedNote(probed.attempts)})`);
			}
		} else if (!probe) did.push("dev: none configured");
		else {
			// no deploy to prove, but the operator still reviews a live app — and a green health record
			// survives a killed server (process death dirties no worktree fingerprint), so the record
			// cannot stand for liveness: re-probe, before anyone is asked.
			const probed = await probeHealth(root, state!, cfg, probe);
			if ("seedFail" in probed) return probed.seedFail;
			if (!probed.ok)
				return { text: `live probe FAILED (${probe}) — nothing is answering and no dev deploy is configured: the app the operator must review has to be running before verify — start it and rerun (gave up after ${probed.attempts} attempt(s), healthWait ${cfg.healthWait}s):\n${tail(probed.out)}`, isError: true };
			did.push(`health: live re-probe PASS (${probe}${triedNote(probed.attempts)})`);
		}
	}
	const ran = [branchLine, ...did].join("; ");
	// yolo is the operator's word at Verified? — answers this question and pre-confirms the later ones
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
	const askPending = !flag("confirmed") && !state!.yolo;
	if (askPending) {
		markPendingAsk(root, state!, "Verified?"); // pending however it is asked — a chat question or a dialog
		// these commands already ran — say so even on the way out
		if (!ui.hasUI) {
			return { text: `${needsOperator("verification needs the operator: confirm interactively, or re-run with --confirmed once the operator answered in chat.", "Verified?")}\n${ran}`, isError: true };
		}
		const ok = await ui.confirm("Operator verification", `Verified? All checks green${cfg.commands.dev && !state!.docs ? `; dev deploy is up for review (${cfg.commands.dev})` : ""} \u2014 does it work?`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "verification declined — stay in implement and fix what failed" };
		}
	}
	state!.confirmations = { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } };
	const final = verifyGate(state!, cfg, branch);
	if (final.length) return { text: `verify gate FAILED:\n- ${final.join("\n- ")}`, isError: true };
	state!.approvals.verify = now();
	if (isReleaseOnly(cfg, branch)) state!.releaseOnly = true;
	else delete state!.releaseOnly;
	// the tree the word was given over (#162) — a git that cannot answer leaves it unset, never a refusal
	const vHead = await sh("git rev-parse HEAD", gateCwd(root, state!));
	if (vHead.ok && vHead.out.trim()) state!.verifiedHead = vHead.out.trim();
	else delete state!.verifiedHead;
	state!.stage = "pre-release";
	delete state!.pendingAsk;
	writeState(root, state!);
	return { text: `verified${audit} — entering pre-release stage.\n${ran}\n${nextHint(state!, cfg)}` };
}

async function gateRelease(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// operator's word at Release?: this flow ships without a version bump or tag — recorded only once Release? is answered
	const noVersion = flag("no-version") || !!state!.noVersion;
	// (versioned) items stand down on an unversioned flow — the set confirmed here is the one that applies to it
	const items = applicableItems(cfg, { ...state!, noVersion }, "pre-release");
	// yolo is the operator's word at Release? — pre-confirms Finish?; publishing guardrails stay enforced
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	// prep evidence is read from the worktree: the bump and changelog entry exist on the branch before the PR merges
	const wtCwd = gateCwd(root, state!);
	// gh#131: a merge ships the branch, not the working tree — an uncommitted fix at this gate is a fix
	// that never ships. verify shows the operator uncommitted paths; release proves them away. A git
	// that cannot answer is a measurement failure, never a refusal — same stance as the merge-base probes.
	const dirtyWt = await sh("git status --porcelain", wtCwd);
	if (dirtyWt.ok && dirtyWt.out.trim()) {
		const n = dirtyWt.out.split("\n").filter((l) => l.trim()).length;
		return { text: `release gate FAILED:\n- ${n} uncommitted path(s) in ${state!.worktree} — a merge ships the branch, not your working tree: commit or discard them, then re-run\n${tail(dirtyWt.out)}`, isError: true };
	}
	const branchProof = await branchState(wtCwd, cfg.defaultBranch);
	const manifestVer = cfg.versioning.file && existsSync(path.join(wtCwd, cfg.versioning.file))
		? parseVersion(cfg.versioning.file, readFileSync(path.join(wtCwd, cfg.versioning.file), "utf8"))
		: null;
	// tags are only needed on the versioned path; a project without versioning must not be held up by an offline origin
	const remoteTags = cfg.versioning.file && !noVersion ? await releaseTags(root) : [];
	if (remoteTags === null) return { text: "release gate FAILED:\n- cannot list tags on origin (offline?) — retry; local tags do not decide what is already released", isError: true };
	const changelog =
		cfg.release.changelog && existsSync(path.join(wtCwd, cfg.release.changelog))
			? { file: cfg.release.changelog, content: readFileSync(path.join(wtCwd, cfg.release.changelog), "utf8") }
			: null;
	// The changelog's baseline is what was pending before this release. The newest tag wins over the
	// merge base: it is what actually shipped, and a rebase or squash merge can leave the merge base
	// unreachable — a git-topology accident must not refuse a legal release (#97).
	let changelogChanged: boolean | null = null;
	const changelogBase: { pending: string[]; source: "tag" | "merge-base" | "none" } = { pending: [], source: "none" };
	if (changelog) {
		const p = sq(cfg.release.changelog!);
		const mbRef = await mergeBase(wtCwd, cfg.defaultBranch);
		// proof the branch touched the changelog: local refs only, so the check stays offline-safe
		if (mbRef) {
			const changes = await sh(`git diff --name-only ${sq(mbRef)} -- ${p} 2>/dev/null; git ls-files --others --exclude-standard -- ${p}`, wtCwd);
			changelogChanged = changes.out.split("\n").some((l) => l.trim());
		}
		const newest = !noVersion && cfg.versioning.file ? newestTaggedVersion(cfg.versioning.pattern, remoteTags) : null;
		// tag first, merge base as the understudy: `releaseTags` asks origin, so a clone that has not
		// fetched the tag yet must still get a baseline instead of losing the fold proof
		const bases: { ref: string; source: "tag" | "merge-base" }[] = [];
		if (newest) bases.push({ ref: cfg.versioning.pattern.replace("{version}", newest), source: "tag" });
		if (mbRef) bases.push({ ref: mbRef, source: "merge-base" });
		for (const b of bases) {
			const base = await sh(`git show ${sq(b.ref)}:${p} 2>/dev/null || true`, wtCwd);
			if (base.out.trim()) {
				changelogBase.pending = pendingEntryLines(base.out);
				changelogBase.source = b.source;
				break;
			}
		}
	}
	// #164: a hand-resolved merge can commit a leftover marker — content to git, so nothing else catches it
	const markerBase = await mergeBase(wtCwd, cfg.defaultBranch);
	const markerDiff = markerBase ? await sh(`git diff -U0 --no-color --no-ext-diff ${sq(markerBase)} HEAD`, wtCwd) : null;
	const conflictMarkers = markerDiff?.ok ? conflictMarkerLines(markerDiff.out) : undefined;
	const prep = { manifestVersion: manifestVer, remoteTags, changelog, changelogChanged, changelogBase, noFoldCheck: flag("no-fold-check"), conflictMarkers, noMarkerCheck: flag("no-marker-check") };
	// same freshness rule as verify: a green predating a worktree write may not stand for the tree this gate blesses
	if (freshenChecks(state!, await worktreeFingerprint(wtCwd)).length) writeState(root, state!);
	// tier-2 pre-release confirmation is recorded by this very command, so it is excluded here
	const preGate = preReleaseGate({ ...state!, noVersion, confirmations: { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } } }, cfg, prep);
	if (preGate.length) return { text: `release gate FAILED:\n- ${preGate.join("\n- ")}`, isError: true };
	// the build the tag will trigger, proven before anything ships: a broken artifact build found after the
	// tag costs follow-up PRs and a re-cut tag
	if (cfg.release.preflight) {
		const pf = await sh(cfg.release.preflight, wtCwd);
		if (!pf.ok) return { text: `release gate FAILED:\n- release.preflight failed in ${state!.worktree} (${cfg.release.preflight}) — fix it on the branch before anything ships:\n${tail(pf.out)}`, isError: true };
	}
	// a stale session build is the operator's decision, never a block: publishing under an older gate is a
	// legitimate choice (hotfix, offline reload), and refusing would close exactly the emergency the relaxed
	// modes exist for. The gate names both builds, lists what the running code is missing, and folds the
	// update-or-proceed question into the Release? checkpoint — the operator's word, recorded in state.
	const { disk: selfBuild, behind } = buildSkew(root);
	// truly behind, not merely different: a session whose loaded build is NEWER than the checkout's manifest
	// has every proof the checkout would run, and asking about it would be noise.
	const stale = !!behind && !!selfBuild.version && cmpVersions(behind, selfBuild.version) < 0;
	let staleAsk = "";
	let staleNote = "";
	if (stale) {
		const clPath = path.join(selfBuild.dir, "CHANGELOG.md");
		const missing = existsSync(clPath) && selfBuild.version ? changelogVersionsBetween(readFileSync(clPath, "utf8"), behind, selfBuild.version) : [];
		staleAsk =
			` This session runs dev-flow ${behind}, ${selfBuild.label} ships ${selfBuild.version ?? "?"} — gate proofs shipped between the two will NOT run. ` +
			(missing.length
				? `Shipped since ${behind}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` …(${missing.length} total)` : ""} — see ${clPath}. `
				: `What shipped between them is not readable from the checkout's CHANGELOG.md — read it before deciding. `) +
			`Update (/reload, then re-run flow release on the current build) or proceed with the old release?`;
		staleNote = `released under dev-flow ${behind} (${selfBuild.label} ${selfBuild.version ?? "?"}) by operator choice — proofs newer than ${behind} did not run`;
	}
	// #162: Verified? was answered over one tree; commits after it ship under that word unless someone says
	// so. A warning, never a refusal — doc-only moves after verify are normal; the operator decides.
	let postVerify = "";
	if (state!.verifiedHead) {
		const since = await sh(`git log --oneline --no-decorate ${sq(state!.verifiedHead)}..HEAD`, wtCwd);
		const commits = since.ok ? since.out.split("\n").filter((l) => l.trim()) : [];
		// a release-only flow commits its bump and changelog after verify by design — only other files count
		const prepFiles = new Set([cfg.versioning.file, cfg.release.changelog, cfg.versioning.file === "package.json" ? "package-lock.json" : ""].filter(Boolean) as string[]);
		const touched = state!.releaseOnly && commits.length ? await sh(`git diff --name-only ${sq(state!.verifiedHead)} HEAD`, wtCwd) : null;
		const prepOnly = !!touched?.ok && touched.out.split("\n").filter((l) => l.trim()).every((f) => prepFiles.has(f.trim()));
		if (commits.length && !prepOnly)
			postVerify = `${commits.length} commit(s) landed after the operator's Verified? (given over ${state!.verifiedHead.slice(0, 7)}): ${commits.slice(0, 6).join(" | ")}${commits.length > 6 ? ` …(${commits.length - 6} more)` : ""} — the verify verdict does not cover them: if behaviour changed, have the operator check the current build before Release?, and either way say in the PR body which commit the verdict was given over`;
	}
	// a standing yolo (given at an earlier checkpoint) stops short of Release? when the playbook says so, or
	// when commits landed after Verified? — the word was given before those commits existed (gh#176).
	// --confirmed is the operator's own answer at this checkpoint, yolo-at-Release? included: it always stands.
	const yoloHeld = !state!.yolo || flag("confirmed")
		? ""
		: cfg.release.yolo === "until-release"
			? "the playbook sets yolo = until-release: a yolo given earlier never answers Release? — ask it"
			: postVerify
				? "a yolo given earlier does not cover commits that landed after Verified? — ask Release? with them named"
				: "";
	const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
	const askPending = !flag("confirmed") && (!state!.yolo || !!yoloHeld);
	if (askPending) {
		markPendingAsk(root, state!, "Release?");
		if (!ui.hasUI) {
			return { text: needsOperator(`release confirmation needs the operator${yoloHeld ? ` (${yoloHeld})` : ""}: confirm interactively, or re-run with --confirmed once the operator answered 'Release?' in chat${stale ? ` — the operator must also answer the stale-build question: ${staleAsk}` : ""}${postVerify ? ` — tell them: ${postVerify}` : ""}`, "Release?"), isError: true };
		}
		const ok = await ui.confirm("Enter release", `Release ${state!.slug}${manifestVer ? ` v${manifestVer}` : ""}${noVersion ? " (unversioned — merge + changelog entry only: no bump, no tag for this flow)" : ""}? Publishing starts: PR, merge${noVersion ? "" : ", tag"} — release-done afterwards needs no further answer.${staleAsk ? `\n\n${staleAsk}` : ""}${postVerify ? `\n\n${postVerify}` : ""}${yoloHeld ? `\n\n(${yoloHeld})` : ""}`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "release declined — keep preparing in pre-release" };
		}
	}
	if (noVersion) state!.noVersion = true;
	state!.confirmations = { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } };
	state!.approvals["pre-release"] = now();
	state!.stage = "release";
	// a skipped proof is never silent: the gate says which one and why (#97)
	const foldNote = !changelog
		? ""
		: flag("no-fold-check")
			? " Warning: the changelog fold proofs were skipped (--no-fold-check) — check that the entry carries what was pending."
			: changelogBase.source === "none"
				? " Warning: no tag or merge base to compare against, so the changelog fold was not proven — check the entry by hand."
			: "";
	// the version of record is fixed here, from the manifest this gate validated: release-done must not
	// re-read a checkout that may still be behind (#52)
	if (!state!.noVersion && manifestVer) state!.releaseVersion = manifestVer;
	if (stale) state!.staleBuild = `${behind} (${selfBuild.label} ${selfBuild.version ?? "?"})`;
	delete state!.pendingAsk;
	writeState(root, state!);
	return { text: `release approved${audit}${state!.noVersion ? " — unversioned: no bump or tag; your changelog entry rides under Unreleased until the next versioned release folds it" : ""} — entering release stage.${manifestVer ? ` Version ${manifestVer}.` : ""}${foldNote}${staleNote ? ` ${staleNote}.` : ""}${postVerify ? ` Warning: ${postVerify}.` : ""}\n${describeBranchState(branchProof, cfg.defaultBranch)}\n${nextHint(state!, cfg)}` };
}

async function gateReleaseDone(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, flag, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const errs = releaseGate(state!);
	// the version of record is what flow release approved (#52) — never a re-read of a checkout that may be behind
	const manifestVer: string | null = state!.releaseVersion ?? null;
	if (cfg.versioning.file && !state!.noVersion && !manifestVer) errs.push(`flow release approved no version (versioning.file "${cfg.versioning.file}" was set after it?) — fix the playbook, or ship this flow unversioned`);
	const expectedTag = manifestVer ? cfg.versioning.pattern.replace("{version}", manifestVer) : null;
	const origin = await originUrl(root);
	const hasOrigin = origin !== null;
	const forgeName = forgeOf(cfg, origin);
	// one round-trip answers both questions about the tag: is it there, and did it leave this laptop (#52)
	const tags = expectedTag ? await releaseTags(root) : [];
	if (tags === null) errs.push("cannot list tags on origin (offline?) — retry: local tags must not decide what is already released");
	else if (expectedTag && manifestVer) {
		const verrs = versionTagGate(manifestVer, cfg.versioning.pattern, tags);
		if (verrs.length) {
			// the actionable version of "not on the forge": the tag exists but never got pushed
			const local = hasOrigin ? (await sh(`git tag --list ${sq(expectedTag)}`, root)).out.trim() : "";
			if (local) errs.push(`tag ${expectedTag} is local-only — git push origin ${expectedTag} (git push --follow-tags silently skips lightweight tags; tag with git tag -a and push the ref explicitly)`);
			else errs.push(...verrs);
		}
		// never publish behind what the forge already has — that is how a stale manifest republished
		// the previous version and its artifact probe passed (#52)
		const newest = newestTaggedVersion(cfg.versioning.pattern, tags);
		if (newest && cmpVersions(newest, manifestVer) > 0) errs.push(`${cfg.versioning.pattern.replace("{version}", newest)} is already tagged — refusing to release ${expectedTag} behind it`);
		if (!verrs.length) {
			const reach = await sh(`git merge-base --is-ancestor ${sq(expectedTag)} origin/${cfg.defaultBranch} 2>/dev/null || git merge-base --is-ancestor ${sq(expectedTag)} ${cfg.defaultBranch}`, root);
			if (!reach.ok) errs.push(`tag ${expectedTag} is not reachable from ${cfg.defaultBranch} — tag what actually shipped on ${cfg.defaultBranch}`);
		}
	}
	let artNote = "";
	if (expectedTag && cfg.release.artifact) {
		if (flag("no-artifact-check")) artNote = "Artifact check skipped (--no-artifact-check).";
		else {
			const cmd = cfg.release.artifact.replaceAll("{version}", manifestVer!).replaceAll("{tag}", expectedTag);
			const art = await sh(cmd, root);
			if (art.ok) artNote = `Artifact verified for ${manifestVer}.`;
			else errs.push(`artifact not published — release.artifact check failed (${cmd}):\n${tail(art.out)}`);
		}
	}
	// merge policy: did what actually landed agree with what the playbook says? A measured contradiction
	// refuses the release record; what dev-flow cannot see stays an advisory — the split the changelog
	// proofs learned (#97): an invisible topology never blocks a legal release.
	let mergeNote = "";
	if (cfg.release.merge && cfg.release.merge !== "any" && state!.branch) {
		const br = state!.branch;
		await sh(`git fetch -q origin ${sq(br)} 2>/dev/null; git fetch -q origin ${sq(cfg.defaultBranch)} 2>/dev/null`, root);
		const refsOk = hasOrigin && (await sh(`git show-ref --quiet --verify ${sq(`refs/remotes/origin/${br}`)} ${sq(`refs/remotes/origin/${cfg.defaultBranch}`)}`, root)).ok;
		// ancestry proves "not squashed, not rebased"; a squash and a rebase look identical here, so when it
		// fails the forge itself is asked which one it was (gh/glab; self-hosted stays an advisory)
		const ancestor = refsOk ? (await sh(`git merge-base --is-ancestor origin/${sq(br)} origin/${sq(cfg.defaultBranch)}`, root)).ok : null;
		const proof = mergeShapeProof(cfg.release.merge, { ancestor, forgeStyle: ancestor === false ? await forgeMergeStyle(gateCwd(root, state!), forgeName, br) : null, branch: br, defaultBranch: cfg.defaultBranch });
		if (proof.errors.length) errs.push(...proof.errors);
		else mergeNote = proof.note;
	}
	if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
	// no checkpoint here — the operator's Release? answer covered the whole publication; everything left is objective checks
	const releasesWanted = !!manifestVer && !flag("no-release-create") && cfg.release.releases !== false;
	let ghNote = "";
	let bodyOfRecord: string | null = null; // the changelog entry the forge body must match (#97)
	let bodyNote = "";
	if (manifestVer && flag("no-release-create")) ghNote = "Forge release skipped (--no-release-create).";
	else if (manifestVer && !releasesWanted) ghNote = "no forge release created (release.releases = false — the playbook says publication is manual; a stale key is how a repo ends up with tags and an empty Releases page #85).";
	else if (manifestVer && releasesWanted) {
		// forge release for the verified tag — gh for GitHub, glab for GitLab. A failed create is no
		// longer the end of the story: the proof below asks the forge whether anything is there (#63, #85)
		const tag = expectedTag!;
		if (forgeName === "self") ghNote = "Forge release skipped (forge=self — publication stays manual).";
		else {
			// the body is the changelog entry for this version (#97); the tag annotation only stands in
			// when the changelog has no entry for it — and never the output of a failed command, which
			// is how a shell error became a release body (#51)
			const notesRes = await sh(tagNotesCommand(tag), root);
			const annotation = notesRes.ok ? notesRes.out.trim() : "";
			let changelogText: string | null = null;
			if (cfg.release.changelog) {
				const cl = path.join(gateCwd(root, state!), cfg.release.changelog);
				if (existsSync(cl)) changelogText = readFileSync(cl, "utf8");
			}
			const picked = pickReleaseNotes({ changelog: changelogText, version: manifestVer, annotation });
			const notes = picked.notes;
			if (picked.source === "changelog") bodyOfRecord = notes;
			let notesNote = "";
			if (picked.source === "changelog") notesNote = `notes from ${cfg.release.changelog}. `;
			else if (picked.source === "annotation") notesNote = `notes from the ${tag} tag annotation — ${cfg.release.changelog ?? "no changelog"} has no ${manifestVer} entry, so the release page does not read like the changelog. `;
			else if (!notesRes.ok) notesNote = `no release notes (the tag command failed: ${tail(notesRes.out)}). `;
			else if (annotation && looksLikeShellError(annotation)) notesNote = "no release notes (the tag command returned a shell error, not a body). ";
			else notesNote = `no release notes (tag ${tag} carries no annotation${cfg.release.changelog ? ` and ${cfg.release.changelog} has no ${manifestVer} entry` : ""} — tag with git tag -a). `;
			const cmd = forgeName === "gitlab"
				? `glab release create ${sq(tag)} --name ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`
				: `gh release create ${sq(tag)} --title ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`;
			const gr = await sh(cmd, root);
			// a failed create is the operator's call to decline, never a choice we make for them — stamp it so finish names it (#63)
			if (gr.ok) delete state!.forgeReleaseSkipped; // a successful retry lifts the stamp
			else state!.forgeReleaseSkipped = tail(gr.out);
			ghNote = gr.ok ? `${forgeName} release ${tag} created. ${notesNote}`.trim() : `${forgeName} release skipped: ${tail(gr.out)}`;
		}
	}
	const skew = buildSkew(root);
	const openRelease = checklistPending(cfg, state!, "release");
	// release-stage items have no gate of their own: the operator's Finish? answer is what closes them, so
	// name them at the last objective gate — on the way out too, or the refusal hides half the story
	const openNote = openRelease ? `release-stage checklist still open (${openRelease}): ${applicableItems(cfg, state!, "release").map((i) => i.text).join(" | ")} — close these with the operator before finishing.` : "";
	// #85: ask the forge whether the release exists instead of trusting the attempt. #51, #60 and #63
	// were three ways of recording a release nothing published, and the artifact probe saw none of them
	if (releasesWanted && expectedTag && forgeName !== "self") {
		const view = forgeName === "gitlab" ? `glab release view ${sq(expectedTag)}` : `gh release view ${sq(expectedTag)}`;
		if (!(await sh(view, root)).ok) {
			return { text: `release gate FAILED:\n- no ${forgeName} release exists for ${expectedTag} — create it (${view.split(" ")[0]} release create ${expectedTag}) or, if publication is deliberately manual, say so with release.releases = false in project.md${ghNote ? `. ${ghNote}` : ""}${openNote ? ` ${openNote}` : ""}`, isError: true };
		}
		delete state!.forgeReleaseSkipped; // the forge has it, whatever the create call reported
		ghNote += `${ghNote ? " " : ""}Release ${expectedTag} verified on ${forgeName}.`;
		// #97: the changelog entry is the release body — prove the forge kept it. gh normalizes the
		// markdown it stored, so the comparison normalizes too; on another forge say it was skipped
		// rather than guess at a JSON shape nobody pinned.
		if (bodyOfRecord !== null) {
			if (forgeName !== "github") bodyNote = `Release body proof skipped (forge=${forgeName}).`;
			else {
				const got = await sh(`gh release view ${sq(expectedTag)} --json body --jq .body`, root);
				if (!got.ok) bodyNote = `warning: could not read back the ${expectedTag} release body — compare it with ${cfg.release.changelog} by hand.`;
				else if (normalizeReleaseBody(got.out) !== normalizeReleaseBody(bodyOfRecord))
					return {
						text: `release gate FAILED:\n- the ${expectedTag} release body is not the ${cfg.release.changelog} entry for ${manifestVer} — publish the entry as the body: gh release edit ${expectedTag} --title ${expectedTag} --notes-file <(the entry)\n  forge body starts: ${tail(normalizeReleaseBody(got.out), 4)}\n  changelog entry starts: ${tail(normalizeReleaseBody(bodyOfRecord), 4)}`,
						isError: true,
					};
				else bodyNote = `Release ${expectedTag} body matches ${cfg.release.changelog}.`;
			}
		}
	}
	state!.approvals.release = now();
	const tailNote = [
		// a session that shipped from behind: the code it runs is not the code the checkout just released
		state!.staleBuild
			? `stale build acknowledged at release gate: this session ran dev-flow ${state!.staleBuild} — proofs newer than it did not run.`
			: skew.behind
				// #117: the pair (session vs what the disk ships) makes the warning actionable where it prints;
				// a second registered copy is what made the skew confusing on the report — name it too
				? `warning: ${skew.line}.${copyWarning() ? ` ${copyWarning()}` : ""}`
			: "",
		mergeNote,
		openNote,
		ghNote,
		bodyNote,
		artNote,
	].filter(Boolean).join(" ");
	writeState(root, state!);
	return { text: `release recorded as complete${state!.noVersion ? " (unversioned — the changelog entry ships under Unreleased; the next versioned release folds it)" : ""}.${tailNote ? ` ${tailNote}` : ""}\n${nextHint(state!, cfg)}` };
}

async function gateFinish(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg, takeYoloWord } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	if (!state!.approvals.release)
		return { text: `finish closes a released feature — stage is "${state!.stage}" and no release is recorded; run flow release-done first (to abandon an unfinished feature, run flow abort)`, isError: true };
	// after this the flow state is gone: nothing may sit uncommitted or unpushed
	const dirty = await sh("git status --porcelain", root);
	if (dirty.ok && dirty.out.trim()) return { text: `main checkout has uncommitted changes — commit them first (finish deletes .dev-flow/${state!.slug}/):\n${tail(dirty.out)}`, isError: true };
	const origin = await originUrl(root);
	const hasOriginF = origin !== null;
	if (hasOriginF) {
		const pushed = await sh(`git merge-base --is-ancestor HEAD ${sq(`origin/${cfg.defaultBranch}`)}`, root);
		if (!pushed.ok) return { text: `HEAD is not on origin/${cfg.defaultBranch} — push the release (git push origin ${cfg.defaultBranch}) before finish`, isError: true };
	}
	// close-out also syncs the main checkout: a released flow must never leave local
	// <default> trailing origin — the push check above proved nothing local-only remains, so a
	// differing sha means local trails and the fast-forward is safe. never a merge: a diverged
	// or not-checked-out main prints the operator's exact command instead of touching anything
	let syncNote = "";
	if (hasOriginF) {
		const headSha = await sh("git rev-parse HEAD", root);
		const originSha = await sh(`git rev-parse ${sq(`origin/${cfg.defaultBranch}`)}`, root);
		if (headSha.ok && originSha.ok && headSha.out.trim() !== originSha.out.trim()) {
			const onDefault = (await currentBranch(root)) === cfg.defaultBranch;
			const ff = onDefault ? await sh(`git merge --ff-only ${sq(`origin/${cfg.defaultBranch}`)}`, root) : { ok: false, out: "" };
			syncNote = ff.ok
				? ` local ${cfg.defaultBranch} fast-forwarded to origin/${cfg.defaultBranch}.`
				: ` local ${cfg.defaultBranch} trails origin/${cfg.defaultBranch} and did not fast-forward cleanly — sync by hand: git -C ${sq(root)} pull --ff-only`;
		}
	}
	// the cleanup part of closing out: drop the worktree and branch the release consumed
	const wt = worktreeAbs(root, state!);
	let closeNote: string;
	let unmergedNote = "";
	if (wt && existsSync(wt)) {
		const status = await sh(`git -C ${sq(wt)} status --porcelain`, root);
		const unmerged = await sh(`git -C ${sq(wt)} log origin/${cfg.defaultBranch}..HEAD --oneline 2>/dev/null || git -C ${sq(wt)} log ${cfg.defaultBranch}..HEAD --oneline`, root);
		const unmergedLines = unmerged.out.split("\n").filter(Boolean);
		// the refusal names the paths, not just the count — same proof verify and release print (gh#131)
		if (status.out.trim()) return { text: `finish blocked:\n- worktree has uncommitted changes — commit or discard them first:\n${tail(status.out)}`, isError: true };
		if (unmergedLines.length) {
			const policy = cfg.release.merge;
			// "not on the default branch" is only a violation when the ancestry is measurable: with no origin,
			// or a branch that was never pushed, the same count describes a local-only repo, not a squash
			const measurable = hasOriginF && !!state!.branch && (await sh(`git show-ref --quiet --verify ${sq(`refs/remotes/origin/${state!.branch}`)} ${sq(`refs/remotes/origin/${cfg.defaultBranch}`)}`, root)).ok;
			unmergedNote =
				policy && policy !== "merge" && policy !== "any"
					? ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} — expected, the playbook merges with ${policy}.`
					: policy === "merge" && measurable
						? ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} although the playbook says merge = merge — that PR did not land as a merge commit`
						: ` ${unmergedLines.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} (squash merge?)`;
			// under a merge-commit policy this is a violation, not a routine cleanup note: yolo does not
			// answer it, only the operator does
			if (policy === "merge" && measurable && !flag("confirmed")) {
				markPendingAsk(root, state!, "Merge policy violation?");
				return { text: needsOperator(`the playbook says merge = merge, but ${unmergedLines.length} commit(s) of ${state!.slug} are not on ${cfg.defaultBranch} — the PR landed as a squash or a rebase. Ask the operator how to proceed, then re-run with --confirmed`, "Merge policy violation?"), isError: true };
			}
		}
	}
	// a forge release that failed at release-done is still the operator's call — but they must see it before the state vanishes (#63)
	const forgeSkipNote = state!.forgeReleaseSkipped ? ` WARNING: the forge release was not created (${state!.forgeReleaseSkipped}) — recreate it manually or re-run release-done before finishing.` : "";
	// the one finish question — asked after the safety checks so it can never be a wasted question
	// yolo works uniformly at every gate: at Finish? nothing later remains to pre-confirm, the flag just answers this one
	const yoloWord = takeYoloWord(state!);
	if (yoloWord) return { text: yoloWord, isError: true };
	// The closing reflection runs here, before anything is removed: the worker reads this session's
	// transcripts and .dev-flow/<slug>/tmp, and finish is about to drop that folder and the binding — a
	// reflection asked for after finish has nothing bound to run against. Only the operator's explicit
	// --no-reflect skips it; yolo never does (it answers checkpoints, it does not waive the review).
	const skipReflect = flag("no-reflect");
	if (skipReflect && !flag("confirmed")) return { text: "--no-reflect is the operator's word — ask them whether to skip the closing reflection, then re-run with --no-reflect --confirmed", isError: true };
	if (!state!.reflectedAt && !skipReflect) {
		const skipHint = "or — only on the operator's explicit word — flow finish --no-reflect --confirmed";
		if (!o.hooks.reflect) return { text: `finish: no reflection recorded for ${state!.slug} and no reflect worker available here — run flow_stage(op: "reflect") first, ${skipHint}`, isError: true };
		const r = await o.hooks.reflect(state!, flagValue(o.rest, "note") ?? "");
		const cur = readState(root, state!.slug) ?? state!; // the worker stamped reflectedAt on disk
		if (!r.recorded)
			return { text: `finish: the closing reflection did not report — nothing was removed.\n\n${r.text}\n\nNext: re-run flow finish to retry, or review inline (bare flow reflect prints the protocol) and then flow_stage(op: "reflect"), ${skipHint}.`, isError: true };
		if (!r.findings) {
			markPendingAsk(root, cur, "Finish?");
			return { text: needsOperator(`the closing reflection ran before cleanup and found nothing new to fold — nothing was removed yet.\n\n${r.text}\n\nAsk the operator Finish? and run flow finish --confirmed when they answer: the worktree, branch and .dev-flow/${state!.slug}/ go on that run.`, "Finish?"), isError: true };
		}
		markPendingAsk(root, cur, "Fold or drop?");
		return { text: needsOperator(`the closing reflection ran before cleanup — nothing was removed yet.\n\n${r.text}\n\nThe fold/drop answer is the Finish? answer: apply it, then run flow finish --confirmed without asking again — the worktree, branch and .dev-flow/${state!.slug}/ go on that run.`, "Fold or drop?"), isError: true };
	}
	const reflectSkipNote = skipReflect && !state!.reflectedAt ? ` Reflection skipped on the operator's word — nothing re-checked this session or the open reflections.` : "";
	const askPending = !flag("confirmed") && !state!.yolo;
	if (askPending) {
		markPendingAsk(root, state!, "Finish?");
		if (!ui.hasUI) {
			return { text: needsOperator(`finish needs the operator: ask them Finish? in chat, then re-run with --confirmed (or run /flow finish interactively)${forgeSkipNote}`, "Finish?"), isError: true };
		}
		const ok = await ui.confirm("Finish feature", `Finish ${state!.slug}?${unmergedNote}${forgeSkipNote} Removes worktree, branch ${state!.branch || "-"} and .dev-flow/${state!.slug}/.`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "finish declined" };
		}
	}
	if (wt && existsSync(wt)) {
		const rm = await sh(`git worktree remove ${sq(wt)} && git branch -D ${sq(state!.branch)}`, root);
		if (!rm.ok) return { text: `worktree removal failed:\n${rm.out}\nif files are owned by another user (e.g. root-owned docker build output), remove ${state!.worktree} manually and rerun flow finish`, isError: true };
		closeNote = `worktree and branch ${state!.branch} removed`;
	} else {
		await sh("git worktree prune", root);
		closeNote = "worktree already gone";
		if (state!.branch && (await sh(`git rev-parse --verify --quiet refs/heads/${state!.branch}`, root)).ok) {
			const del = await sh(`git branch -d ${sq(state!.branch)}`, root);
			closeNote = del.ok ? `branch ${state!.branch} deleted` : `branch ${state!.branch} kept (not fully merged — git branch -D if sure)`;
		}
	}
	// remote cleanup: origin/<branch> is deleted only on proof it was released — being an ancestor of
	// origin/<default> (merge-commit merges) or a merged PR via gh (squash merges); else it stays.
	let remoteNote = "";
	if (state!.branch && hasOriginF) {
		const br = state!.branch;
		const onRemote = await sh("git ls-remote --heads origin", root);
		if (onRemote.out.split("\n").some((l) => l.endsWith(`\trefs/heads/${br}`))) {
			await sh(`git fetch -q origin ${sq(br)}`, root);
			let merged = (await sh(`git merge-base --is-ancestor origin/${sq(br)} origin/${sq(cfg.defaultBranch)}`, root)).ok;
			// squash merges leave no ancestry — ask the forge (gh/glab); self-hosted stays on ancestry proof
			if (!merged) merged = (await forgeMergeStyle(root, forgeOf(cfg, origin), br)) !== null;
			if (merged) remoteNote = (await sh(`git push origin --delete ${sq(`refs/heads/${br}`)}`, root)).ok
				? ` origin/${br} deleted (verified merged)`
				: ` origin/${br} delete failed — git push origin --delete ${br}`;
			else remoteNote = ` origin/${br} kept — merged state not verifiable from here (git push origin --delete ${br} when sure)`;
		}
	}
	rmSync(featDir(root, state!.slug), { recursive: true, force: true });
	if (sess.slug === state!.slug) sess.bind(null);
	// a feature picked from the backlog closes its own item: check off what `roadmap pick` stamped (slug)
	let roadmapNote = "";
	if (existsSync(roadmapFile(root))) {
		const r = roadmapDoneForSlug(readRoadmap(root), state!.slug, new Date().toISOString().slice(0, 10));
		if (r.count) {
			writeFileSync(roadmapFile(root), r.text);
			roadmapNote = ` roadmap: ${r.count} item(s) marked done.`;
		}
	}
	// finish is the moment between flows: name the fix / tidy suggestion when a rule fires, nothing otherwise
	const nudge = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { between: true });
	const nudgeNote = [nudge.fix, nudge.tidy].filter(Boolean).map((n) => ` ${n} — offer it to the operator.`).join("");
	return { text: `feature ${state!.slug} done — ${closeNote}${remoteNote}; .dev-flow/${state!.slug}/ removed.${roadmapNote}${forgeSkipNote}${reflectSkipNote}${syncNote}${nudgeNote} Re-read flow status before reporting open flows — a sibling feature may have finished while this session ran.` };
}

/** The main-branch guard as a hook body — installed into .git/hooks, or printed for a hook manager to carry. */
const mainHookBody = (branch: string) =>
	`branch=$(git rev-parse --abbrev-ref HEAD)\nif [ "$branch" = "${branch}" ] && [ -z "$DEV_FLOW_ALLOW_MAIN" ]; then\n  echo "dev-flow: direct commits to ${branch} are forbidden — use a feature worktree and a PR" >&2\n  exit 1\nfi\n`;

/** Value tokens of a multi-value flag: everything after `--name` up to the next `--flag`. */
function flagValues(rest: string[], name: string): string[] {
	const i = rest.indexOf(`--${name}`);
	if (i === -1) return [];
	const out: string[] = [];
	for (let j = i + 1; j < rest.length && !rest[j].startsWith("--"); j++) out.push(rest[j]);
	return out;
}

async function gateInit(o: GateCtx): Promise<RunResult> {
	const { root, ui, rest, flag } = o;
	// a recursive mkdir is silent about whether it created anything, and `flow init --write` is the
	// only sanctioned agent path to the playbook: claiming "created" when the folder was already
	// there sends the agent diffing its own config for damage that never happened (#39).
	const dfExisted = existsSync(dfDir(root));
	mkdirSync(dfDir(root), { recursive: true });
	const notes: string[] = dfExisted ? [] : [`.dev-flow/ created in ${root}`];
	// self-ignoring folder with one exception: the playbook is the only file under .dev-flow/ that lives in git
	writeFileSync(path.join(dfDir(root), ".gitignore"), "*\n!project.md\n");
	const mdFile = path.join(dfDir(root), "project.md");
	const head = await sh("git symbolic-ref refs/remotes/origin/HEAD", root);
	const curBr = await currentBranch(root);
	// never propose a feature branch (contains "/") as the default branch
	const branch = (head.ok ? head.out.match(/refs\/remotes\/origin\/(.+)/)?.[1] : undefined) || (curBr.includes("/") ? undefined : curBr) || "main";
	const det = detectProject(root, branch);
	const origin = await originUrl(root);
	det.partial.forge = origin ? detectForge(origin) : undefined; // confirmed or corrected by the operator during setup; absent = no origin to detect from
	const mergeEv = await mergeHistoryEvidence(root, branch); // "what do you actually do when a PR merges", read off the log
	det.partial.merge = mergeEv?.note;
	const tagEv = await tagPatternEvidence(root);
	if (tagEv) {
		det.partial.versionTag = tagEv.pattern;
		det.report.push(`tags: ${tagEv.note} → versionTag = ${tagEv.pattern}`);
	}
	const draftFresh = buildDraft(det);
	const questions = setupQuestions(det, { merge: mergeEv, tag: tagEv });
	if (flag("draft")) return { text: existsSync(mdFile) ? readFileSync(mdFile, "utf8") : draftFresh }; // read path: prints content, writes nothing (and offers no deletions)
	// ghosts: feature dirs whose state.json is gone — inert, invisible to status and guards, and only findable by eye
	const ghosts = ghostFeatureDirs(root);
	if (ghosts.length) {
		if (!ui.hasUI) notes.push(`${ghosts.length} ghost feature dir(s) — a plan/ with no state.json, no flow owns them (${ghosts.join(", ")}); adopt one with flow start <slug> --confirmed, delete them, or run flow init interactively`);
		else if (await ui.confirm("Remove ghost feature dirs?", `${ghosts.map((g) => `${g} — plan/ with no state.json`).join("\n")}\n\nNo flow owns these; their plan/*.md is not recoverable afterwards. To keep one as a new feature's draft, decline and run flow start <slug> --confirmed.`)) {
			for (const g of ghosts) rmSync(path.join(root, g), { recursive: true, force: true });
			notes.push(`removed ${ghosts.length} ghost feature dir(s): ${ghosts.map((g) => g.slice(".dev-flow/".length)).join(", ")}`);
		} else notes.push(`kept ${ghosts.length} ghost feature dir(s) — inert, remove them whenever you like`);
	}
	const current = existsSync(mdFile) ? readFileSync(mdFile, "utf8") : null;
	/** Validate, back up what was there (the operator's rules are not regenerable), write. */
	const writeMd = (text: string): { rej: RunResult } | { warn: string[] } => {
		const parsed = parseProjectMd(text);
		if (parsed.hard.length) return { rej: { text: `project.md REJECTED:\n- ${parsed.hard.join("\n- ")}`, isError: true } };
		if (existsSync(mdFile)) copyFileSync(mdFile, `${mdFile}.bak`);
		writeFileSync(mdFile, text.endsWith("\n") ? text : `${text}\n`);
		return { warn: parsed.warn };
	};
	/** After a write: the playbook belongs in git — commit it on the operator's word, else say how. */
	const afterWrite = async (w: { warn: string[] }, before: string | null, after: string, offer = false): Promise<void> => {
		notes.push(`changes:\n${lineDiff(before ?? "", after)}`);
		if (w.warn.length) notes.push("warnings:", ...w.warn.map((x) => `  ${x}`));
		// the dialog belongs to the human-driven first init only: an agent write (--write/--answers) follows a chat
		// confirmation and must not open a second question — it commits on --track
		const track = flag("track") || (offer && ui.hasUI && (await ui.confirm("Commit project.md?", "The playbook belongs in git. Commit .dev-flow/project.md now (only that file, as a playbook chore)?")));
		if (!track) {
			notes.push(GIT_TRACK_NOTE, "(or re-run the same call with --track on the operator's word)");
			return;
		}
		const c = await sh(`git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -q -m ${sq(before ? "chore: update dev-flow playbook" : "chore: add dev-flow playbook")} -- .dev-flow/project.md`, root, 60_000);
		notes.push(c.ok ? "project.md committed (git add -f + playbook chore)" : `commit failed — ${c.out.split("\n").find(Boolean) ?? "?"}; ${GIT_TRACK_NOTE}`);
	};
	const answerToks = [...flagValues(rest, "answers"), ...(flag("answers-file") ? (() => { const f = flagValues(rest, "answers-file")[0]; return f && existsSync(path.resolve(root, f)) ? readFileSync(path.resolve(root, f), "utf8").split("\n") : [`<missing answers file ${f ?? ""}>`]; })() : [])];
	if (flag("answers") || flag("answers-file")) {
		// the operator's answers, applied as targeted edits onto the draft (first init) or the current file —
		// hand-written lines survive; the result is previewed until the operator's word anchors the write
		const parsed = parseAnswers(answerToks);
		if (parsed.errors.length) return { text: `answers REJECTED:\n- ${parsed.errors.join("\n- ")}`, isError: true };
		if (!parsed.answers.length) return { text: "usage: flow init --answers key=value [key=value …] | --answers-file <path> (one key=value per line)", isError: true };
		const base = current ?? draftFresh;
		const applied = applyAnswers(base, parsed.answers);
		const lint = parseProjectMd(applied.text);
		if (lint.hard.length) return { text: `project.md REJECTED:\n- ${lint.hard.join("\n- ")}`, isError: true };
		const preview = [`${current ? "playbook" : "draft"} with ${parsed.answers.length} answer(s):`, ...applied.changes.map((c) => `  ${c}`), "", mdDigest(applied.text)];
		const ok = flag("confirmed") || (ui.hasUI && (await ui.confirm("Write project.md?", preview.join("\n"))));
		if (!ok) {
			const open = questions.filter((x) => !parsed.answers.some(([k]) => k === x.key || (x.key === "check.<name>" && (k.startsWith("check.") || ["test", "build", "run"].includes(k)))));
			return { text: [...preview, "", `changes:\n${lineDiff(base, applied.text)}`, "", "not written — present this to the operator; on their confirmation re-run the same call with --confirmed", ...(open.length ? ["still unanswered:", ...renderQuestions(open)] : [])].join("\n") };
		}
		const w = writeMd(applied.text);
		if ("rej" in w) return w.rej;
		notes.push(`project.md written with ${parsed.answers.length} answer(s)`);
		await afterWrite(w, current, applied.text);
	} else if (flag("write") || flag("write-file")) {
		let content: string | undefined;
		if (flag("write-file")) {
			const f = flagValues(rest, "write-file")[0];
			if (!f || !existsSync(path.resolve(root, f))) return { text: `usage: flow init --write-file <path> — ${f ? `${f} does not exist` : "no path given"}`, isError: true };
			content = readFileSync(path.resolve(root, f), "utf8");
		} else {
			content = rest[rest.indexOf("--write") + 1];
			if (!content || content.startsWith("--")) return { text: 'usage: flow init --write "<full project.md content>" (or --write-file <path>)', isError: true };
		}
		const w = writeMd(content);
		if ("rej" in w) return w.rej;
		notes.push("project.md written (operator-owned playbook)");
		await afterWrite(w, current, content);
	} else if (!current) {
		// first init: never write silently. The questions come first — a dialog that offered the bare detection
		// draft before them wrote a playbook with the merge style, forge and versioning still unanswered.
		const brief = [
			"setup — project.md not written yet; nothing is drafted to disk until the operator confirms.",
			"detected:",
			...det.report.map((r) => `  ${r}`),
			"questions for the operator (detected value shown; `accept` is the answer that keeps it):",
			...renderQuestions(questions),
			"agent: ask these in chat — group the ones with an `accept` line as \"keep these?\", explain the rest in a line each. Then apply every answer in one call: flow init --answers key=value … (previews the digest and diff, writes nothing); on the operator's confirmation re-run it with --confirmed (add --track to commit the playbook). Free-text additions — checklist items, prose, flow-guard rules — go in through flow init --write-file <path> with the full file (flow init --draft prints the current draft).",
		];
		let wrote = false;
		if (ui.hasUI) {
			const accepts = questions.filter((x) => x.accept).map((x) => x.accept!);
			const withAccepts = applyAnswers(draftFresh, parseAnswers(accepts).answers).text;
			const ok = await ui.confirm("Accept the detected setup?", `${mdDigest(withAccepts)}\n\nWrite this now, keeping every detected value? ${questions.length - accepts.length} question(s) have no detected answer (${questions.filter((x) => !x.accept).map((x) => x.key).join(", ")}) — decline to answer them in chat first.`);
			if (ok) {
				const w = writeMd(withAccepts);
				if ("rej" in w) return w.rej;
				wrote = true;
				notes.push("wrote .dev-flow/project.md from detection with the detected values accepted — change any of them with flow init --answers key=value", ...det.report.map((r) => `  ${r}`));
				const open = questions.filter((x) => !x.accept);
				if (open.length) notes.push("still open (answer any time):", ...renderQuestions(open));
				await afterWrite(w, null, withAccepts, true);
			}
		}
		if (!wrote) notes.push(...brief);
	} else if (flag("force")) {
		// a destructive reset of the operator's own file needs their word: --confirmed for an agent, one dialog for a human
		const ok = flag("confirmed") || (ui.hasUI && (await ui.confirm("Overwrite project.md?", `flow init --force replaces the operator playbook with a fresh detection draft. Hand-written rules, checklist items and guidance are lost (a copy is kept as project.md.bak).`)));
		if (!ok) return { text: "flow init --force overwrites the operator playbook — that needs the operator's word: re-run with --confirmed (the current file is kept as project.md.bak)", isError: true };
		copyFileSync(mdFile, `${mdFile}.bak`);
		writeFileSync(mdFile, draftFresh);
		notes.push("project.md OVERWRITTEN (--force; previous copy kept as project.md.bak):", ...det.report.map((r) => `  ${r}`), GIT_TRACK_NOTE);
	} else {
		// re-init is the doctor's file-level check: findings are printed, the playbook is never regenerated —
		// a draft cannot reproduce hand-written prose, items and keys. Edit the file, or flow init --write.
		const loaded = loadProject(dfDir(root));
		const findings = doctorFindings(root, loaded.cfg, loaded.md);
		notes.push("project.md already exists — kept (edit it directly, flow init --answers key=value for one knob, --write-file to replace it, --force to redraft)", findings.length ? `doctor: ${findings.length} finding(s):` : "doctor: no findings", ...findings.map((x) => `  ${x}`));
	}
	const initCfg = loadProject(dfDir(root)).cfg;
	if (initCfg.mainHook) {
		// a hook manager (husky, lefthook…) points core.hooksPath elsewhere: git never runs .git/hooks then,
		// so a hook installed there would guard nothing — print the lines for the manager's own hook instead
		const hp = await sh("git config --get core.hooksPath", root, 10_000);
		const hooksPath = hp.ok ? hp.out.trim() : ""; // unset exits 1, and sh() then carries the error text
		const hookDir = path.join(root, ".git", "hooks");
		const hook = path.join(hookDir, "pre-commit");
		const body = mainHookBody(initCfg.defaultBranch);
		if (hooksPath && path.resolve(root, hooksPath) !== hookDir) {
			const theirs = path.join(hooksPath, "pre-commit");
			const has = existsSync(path.resolve(root, theirs)) && readFileSync(path.resolve(root, theirs), "utf8").includes("DEV_FLOW_ALLOW_MAIN");
			if (!has) notes.push(`core.hooksPath = ${hooksPath} — git runs hooks from there, not .git/hooks, so dev-flow installed none; to block main commits outside Pi, add to ${theirs}:\n${body}`);
		} else if (existsSync(hookDir) && !existsSync(hook)) {
			writeFileSync(hook, `#!/bin/sh\n# installed by dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden (override: DEV_FLOW_ALLOW_MAIN=1)\n${body}`, { mode: 0o755 });
			notes.push("pre-commit hook installed (blocks commits on main)");
		} else if (existsSync(hook) && !readFileSync(hook, "utf8").includes("installed by dev-flow") && !readFileSync(hook, "utf8").includes("DEV_FLOW_ALLOW_MAIN")) {
			notes.push(`existing pre-commit hook found — dev-flow did not replace it; main commits outside Pi stay unguarded until you add to .git/hooks/pre-commit:\n${body}`);
		}
	}
	return { text: notes.join("\n") };
}

async function gateStart(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, rest, flag, slugArg } = o;
	if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] [--patch|--docs] [--merge=squash|merge|rebase|any] (slug: lowercase, dashes); --ui/--patch/--docs are operator-granted — ask the operator in chat, then add --confirmed", isError: true };
	// a ghost (plan/ but no state.json — typically a spin-off someone wrote by hand) is adopted, never a dead end:
	// "already exists, flow use it" sent the agent to use, which found no state, and doctor offered to delete it
	const ghost = existsSync(featDir(root, slugArg)) && !existsSync(stateFile(root, slugArg)) && existsSync(path.join(featDir(root, slugArg), "plan"));
	if (ghost && !flag("confirmed")) {
		const files = listFiles(path.join(featDir(root, slugArg), "plan"));
		return { text: `.dev-flow/${slugArg}/ is a ghost — plan/ (${files.join(", ") || "empty"}) but no state.json, so no flow owns it. Adopt it as this feature's draft plan: flow start ${slugArg} --confirmed (the operator agrees in chat), or delete the dir to start clean`, isError: true };
	}
	if (existsSync(featDir(root, slugArg)) && !ghost) {
		// --ui on the plan-stage feature this session drives: the operator asked for mockups after the start,
		// so turn the mockup gate on instead of refusing — a UI feature left at ui=false skips the mockup
		// proof at approve and every (ui) checklist item (lettuce rail-ui-fixes shipped 20 ungated mockups)
		const existing = readState(root, slugArg);
		if (flag("ui") && existing && sess.slug === slugArg) {
			if (!flag("confirmed")) return { text: "--ui is operator-granted — it adds a rendered-mockup requirement to the plan gate; ask the operator, then re-run with --confirmed", isError: true };
			if (existing.ui) return { text: `feature ${slugArg} already has the ui flag` };
			if (existing.stage !== "plan") return { text: `feature ${slugArg} is at ${existing.stage} — the ui flag can be set only at plan (the mockup gate is approve's); render the screens anyway and say so in the verify report`, isError: true };
			writeState(root, { ...existing, ui: true });
			return { text: `ui flag set on existing feature ${slugArg} (plan stage): the approve gate now requires rendered mockups under plan/mockups/ (${cfg.mockupGlobs.join(", ")}), each embedded in plan.md, and the (ui) checklist items apply` };
		}
		return { text: `feature ${slugArg} already exists — flow use ${slugArg} to resume it${existing?.stage === "plan" ? `; to add the mockup gate at plan, run flow start ${slugArg} --ui --confirmed from the session bound to it` : ""}`, isError: true };
	}
	// relaxed modes are operator-granted: --confirmed anchors a literal chat grant, same convention as the gate verbs
	if (flag("patch") && flag("docs")) return { text: "--patch and --docs are exclusive — ask the operator which mode they grant", isError: true };
	const mode = flag("patch") ? "patch" : flag("docs") ? "docs" : null;
	if (mode && !flag("confirmed")) return { text: `${mode} mode is operator-granted — the operator must grant it in chat, then re-run with --confirmed`, isError: true };
	// --ui adds the rendered-mockup gate to plan: worth it only when screens change, and the operator says so
	if (flag("ui") && !flag("confirmed")) return { text: "--ui is operator-granted — it adds a rendered-mockup requirement to the plan gate, so use it only when the feature changes screens; ask the operator, then re-run with --confirmed", isError: true };
	// branch discipline: features branch off the default branch — starting from a stale checkout poisons the base
	const curBr = await currentBranch(root);
	if (curBr !== cfg.defaultBranch && !flag("force")) return { text: `main checkout is on ${curBr}, not ${cfg.defaultBranch} — check out ${cfg.defaultBranch} first (git checkout ${cfg.defaultBranch} && git pull) or flow use an unfinished feature; --force to override`, isError: true };
	// --- preflight: is this session running the current build, and is the playbook complete? ---
	const notes: string[] = [];
	const skew = buildSkew(root);
	if (skew.line) notes.push(`warning: ${skew.line}`);
	const dupStart = copyWarning();
	if (dupStart) notes.push(dupStart);
	if (flag("check-upstream")) {
		const newest = await publishedVersion(root);
		notes.push(newest ? `published dev-flow: ${newest} (this build: ${loadedVersion() ?? "?"})${loadedVersion() && newest !== loadedVersion() ? " — an update is available" : ""}` : "could not read the published dev-flow version (offline?)");
	}
	// missing playbook parameters are printed at the moment they start to matter, not promised to a later doctor run
	const gaps = doctorFindings(root, cfg, loadProject(dfDir(root)).md).filter((x) => !x.startsWith("no merge policy"));
	if (gaps.length) notes.push(`playbook gaps (${gaps.length}) — advisory, flow doctor reviews and routes them:\n${gaps.slice(0, 5).map((g) => `  ${g}`).join("\n")}`);
	// the merge policy is the one blocking gap: it decides the shape of the default branch and nobody can
	// reconstruct it afterwards. Ask once in chat (a checkpoint word like any other), write the answer, continue.
	const styleArg = flagValue(rest, "merge");
	const style = styleArg === null ? null : parseMergeStyle(styleArg);
	if (styleArg !== null && !style) return { text: `--merge=${styleArg} is not a policy — use squash, merge, rebase or any`, isError: true };
	if (!cfg.release.merge || (style && style !== cfg.release.merge)) {
		if (!style) {
			const ev = await mergeHistoryEvidence(root, cfg.defaultBranch);
			return {
				text: needsOperator(
					`the playbook has no merge policy — ask the operator how a merged PR should land on ${cfg.defaultBranch}: squash, merge (a merge commit), rebase, or any (no policy).${ev ? ` ${ev.note}${ev.recent ? ` Detected suggestion: ${ev.recent}.` : ""}` : ""} Then re-run: flow start ${slugArg} --merge=<style> --confirmed (the answer is written into .dev-flow/project.md)`,
					"Merge policy?",
				),
				isError: true,
			};
		}
		if (!flag("confirmed")) return { text: `writing merge = ${style} changes the operator playbook — the operator must answer it in chat first, then re-run with --confirmed`, isError: true };
		const written = await writePlaybookMergePolicy(root, style);
		if ("err" in written) return { text: written.err, isError: true };
		// the flow that just wrote the policy must see it: nextHint and the merge guard read this config
		cfg.release.merge = style;
		notes.push(written.note);
	}
	// stamp the dev-flow build that started this feature — a stuck flow can later be read against its tooling.
	// the stamp is what ran, not what the disk claims (that mismatch is the warning above).
	const state = newState(slugArg, flag("ui"), flag("patch"), flag("docs"), loadedVersion() ?? undefined);
	const planDir = path.join(featDir(root, slugArg), "plan");
	if (ghost) notes.push(`adopted ghost .dev-flow/${slugArg}/ — its plan/ (${listFiles(planDir).join(", ") || "empty"}) is this feature's draft`);
	mkdirSync(planDir, { recursive: true });
	// a roadmap item stamped for this slug carries its brief into the plan: the spin-off's context outlives the session that split it
	const picked = roadmapBriefFor(readRoadmap(root), slugArg);
	if (picked) {
		const planMd = path.join(planDir, "plan.md");
		const carried = `> Carried over from the roadmap: ${picked.item}${picked.brief ? `\n>\n${picked.brief.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n")}` : ""}\n`;
		if (!existsSync(planMd)) {
			writeFileSync(planMd, `# ${slugArg} — plan (draft)\n\n${carried}`);
			notes.push(`roadmap item "${picked.item}" seeded plan/plan.md${picked.brief ? " with its brief" : ""} — a draft: plan it out and approve as usual`);
		} else notes.push(`roadmap item "${picked.item}"${picked.brief ? ` — brief:\n${picked.brief}` : ""}`);
	}
	writeState(root, state);
	sess.bind(slugArg);
	sess.rename(slugArg);
	return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}${state.patch ? ", patch" : state.docs ? ", docs" : ""}${state.flowVersion ? `, dev-flow ${state.flowVersion}` : ""}); session renamed to ${slugArg}.${notes.length ? `\n${notes.join("\n")}` : ""}\n${nextHint(state, cfg)}` };
}

async function gateApprove(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, cfg, flag, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	const planDir = path.join(featDir(root, state!.slug), "plan");
	// the embed proofs read the plan document itself: a render that exists on disk but is not
	// embedded in plan.md is one the operator would never be shown
	const planMd = path.join(planDir, "plan.md");
	const planFiles = listFiles(planDir);
	const mockupHtml = planFiles.filter((f) => /^mockups\/.+\.html?$/i.test(f)).map((f) => ({ file: f, html: readFileSync(path.join(planDir, f), "utf8") }));
	const errs = approveGate(state!, cfg, planFiles, existsSync(planMd) ? readFileSync(planMd, "utf8") : undefined, foreignWorktreeLinks(dfDir(root), state!.slug, mockupHtml));
	if (errs.length) return { text: `plan gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
	const planItems = applicableItems(cfg, state!, "plan");
	const audit = flag("confirmed") ? " (confirmed by operator instruction)" : "";
	const askPending = !flag("confirmed");
	if (askPending) {
		markPendingAsk(root, state!, "Approve?");
		if (!ui.hasUI) {
			return { text: needsOperator("plan approval needs the operator: approve interactively, or re-run with --confirmed once the operator answered in chat", "Approve?"), isError: true };
		}
		const ok = await ui.confirm("Approve plan", `Approve ${state!.slug}${state!.ui ? " (UI)" : ""}${state!.patch ? " (patch)" : state!.docs ? " (docs)" : ""}? Creates the worktree.${flag("yolo") ? " YOLO: all later gate questions (Verified?/Release?/Finish?) are pre-confirmed — checks and guardrails stay in place." : ""}`);
		if (!ok) {
			delete state!.pendingAsk;
			writeState(root, state!);
			return { text: "approval declined — keep iterating on the plan" };
		}
	}
	// the operator's word at Approve?, recorded only once given: every later gate question is pre-confirmed; checks and guardrails stay
	if (flag("yolo")) state!.yolo = true;
	if (planItems.length) state!.confirmations = { ...state!.confirmations, plan: { hash: checklistHash(planItems), at: now() } };
	const branch = subst(cfg.branchPattern, state!.slug);
	const wtRel = subst(cfg.worktreeDir, state!.slug);
	const wt = path.resolve(root, wtRel);
	let setupNote = "";
	if (!existsSync(wt)) {
		// branch discipline: features branch off the default branch — never from a stale checkout HEAD
		const base = (await sh(`git rev-parse --verify -q origin/${cfg.defaultBranch}`, root)).ok ? `origin/${cfg.defaultBranch}` : cfg.defaultBranch;
		const res = await sh(`git worktree add ${sq(wt)} -b ${branch} ${base}`, root);
		if (!res.ok) return { text: `worktree creation failed:\n${res.out}`, isError: true };
	}
	// setup is worktree work of a normal feature: a docs flow runs no project command at all (#49),
	// and a worktree left behind by a setup that never succeeded must be retried — "fix it and run
	// approve again" was a silent no-op on the reused directory (#49). setup is expected to be idempotent.
	const setupCmd = state!.docs ? undefined : cfg.commands.setup;
	if (setupCmd && !state!.setupAt) {
		const s = await sh(setupCmd, wt);
		if (!s.ok) return { text: `setup failed in ${wtRel} — fix commands.setup, then run flow approve again (the worktree is kept and setup retried):\n${tail(s.out)}`, isError: true };
		state!.setupAt = now();
		setupNote = `\nsetup ran in the worktree (${setupCmd}).`;
	} else if (state!.docs && cfg.commands.setup) {
		setupNote = "\nsetup skipped (docs mode — no project commands run).";
	}
	state!.branch = branch;
	state!.worktree = wtRel;
	state!.stage = "implement";
	state!.approvals.plan = now();
	delete state!.pendingAsk;
	writeState(root, state!);
	return { text: `plan approved${audit}${state!.yolo ? " — yolo: later gate questions pre-confirmed" : ""}; worktree ${wtRel} on branch ${branch}.${setupNote}\n${nextHint(state!, cfg)}` };
}

async function gateStatus(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, flag, slugArg } = o;
	const df = dfDir(root);
	const { md } = loadProject(df);
	// cheap fs probes only (no git subprocesses) — status is a glance, `flow doctor` is the full list
	const findings = md ? doctorFindings(root, cfg, md) : [];
	// a session running an older build than the disk ships is the one thing a glance must say: every
	// gate proof printed since the drift began belongs to the older code.
	const skew = buildSkew(root);
	const warn = [...(findings.length ? [`⚠ doctor: ${findings.length} finding(s) — run flow doctor`] : []), ...(skew.line ? [`⚠ ${skew.line}`] : []), ...(copyWarning() ? [copyWarning()!] : [])];
	// the backlog nudge belongs to the no-features answer too — that is when a pick is most useful
	const rmap = roadmapOpenCount(readRoadmap(root));
	const rmapLine = rmap ? [`◇ ${rmap} roadmap item(s) open — flow roadmap`] : [];
	const slugs = slugArg ? [slugArg] : unfinishedStates(root).map((s) => s.slug);
	const cur = sess.slug; // only a bound session has a current feature — the lone-unfinished hint would pose unbound sessions as owning it
	if (flag("json")) {
		const sts = slugs.map((s) => readState(root, s)).filter((s): s is FlowState => s !== null);
		return { text: statusJson(sts, cur, cfg) }; // before the prose "no features" answer — an orchestrator must be able to parse the empty case too
	}
	if (!slugs.length) return { text: ["no features — start one: flow start <slug> [--ui] [--patch|--docs --confirmed]", ...warn, ...rmapLine].join("\n") };
	const lines = slugs.flatMap((s) => {
		const st = readState(root, s);
		if (!st) return [];
		return [
			`${s === cur ? "→" : " "} ${s}: stage=${st.stage}${st.ui ? " [ui]" : ""}${st.yolo ? " [yolo]" : ""}${st.noVersion ? " [no-version]" : ""}${st.pendingAsk ? ` 💬 ${st.pendingAsk}` : ""} branch=${st.branch || "-"} worktree=${st.worktree || "-"}${st.flowVersion ? ` flow=${st.flowVersion}` : ""}`,
			`  approvals: ${Object.keys(st.approvals).join(", ") || "none"} | checks: ${Object.entries(st.checks).map(([k, v]) => `${k}:${v.ok ? "ok" : "FAILED"}`).join(", ") || "none"}${st.confirmations?.implement ? " | checklist: confirmed" : ""}`,
			`  next: ${nextHint(st, cfg)}`,
		];
	});
	if (warn.length) lines.push(...warn);
	// which identity this session's state is keyed by: a claim fight is undiagnosable when the key
	// could be a session id or a shared directory and the output does not say which
	lines.push(`session: ${sess.key}${sess.key.startsWith("cwd:") ? " — no session id from pi, so every pi session in this directory shares one dev-flow binding (pass flow use <slug> in each)" : ""}`);
	const refl = readReflections(root);
	if (refl.length) lines.push(`↻ ${refl.length} reflection(s) open — run flow doctor (it reviews and routes them)`);
	lines.push(...rmapLine);
	return { text: lines.join("\n") || "no features" };
}

async function gateReflect(o: GateCtx): Promise<RunResult> {
	const { root, sess, rest, flag } = o;
	// gate flags belong to the state verbs — pasted into the note they read as part of the operator's
	// own sentence in reflections.md (#43). --plugin/--playbook/--both are reflect's own: they state
	// the filing instead of leaving it to a keyword guess.
	const words = rest.filter((a) => !a.startsWith("--"));
	const forced: ReflectTarget | null = flag("plugin") ? "plugin" : flag("code") ? "code" : flag("playbook") || flag("docs") ? "playbook" : null;
	// single words are verbs (roadmap-style); a note merely starting with one stays a note
	if (words.length === 1 && words[0] === "tidy") return reflectTidy(root);
	if (words.length === 1 && words[0] === "list") return await reflectList(root);
	if (words[0] === "move") return reflectMoveNote(root, words.slice(1), forced);
	if (words[0] === "done") return reflectDoneNote(root, sess, words.slice(1));
	if (words.length) return await reflectNote(root, sess, words, forced);
	const self = pluginVersion(import.meta.dirname);
	const upstream = await pluginUpstream(root);
	const refl = readReflections(root);
	const fold = await foldView(root, refl);
	const nudges = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { between: !sess.slug });
	return {
		text: reflectProtocol(refl, isSelfRepo(root), {
			version: self.version,
			upstream,
			bound: !!sess.slug,
			fix: nudges.fix,
			tidy: nudges.tidy,
			ghFold: fold.state === "ok" && fold.open ? { repo: fold.slug, open: fold.open, similar: fold.result.similar.length } : undefined,
		}).join("\n"),
	};
}

async function gateRoadmap(o: GateCtx): Promise<RunResult> {
	const { root, sess, rest } = o;
	// the backlog is advisory — no state, no gating; direct file edits stay allowed like reflections.md
	const words = rest.filter((a) => !a.startsWith("--")); // gate flags are not backlog prose (#43 applies here too)
	const [verb = "list", ...args] = words;
	const text = readRoadmap(root);
	const open = roadmapOpenCount(text);
	const done = doneItemCount(text);
	const save = (next: string) => writeFileSync(roadmapFile(root), next); // .dev-flow/ existence is runFlow's precondition
	const idx = Number(args[0]);
	const validIdx = Number.isInteger(idx) && idx >= 1 && idx <= open;
	switch (verb) {
		case "list": {
			if (!open) return { text: done ? `roadmap: nothing open (${done} done — flow roadmap tidy drops them)` : "roadmap: empty — flow roadmap add \"<future feature>\"" };
			return { text: [`roadmap — ${open} open (${done} done):`, ...openChecklistItems(text).map((l, i) => `  ${i + 1}. ${l.slice(6)}`)].join("\n") };
		}
		case "add": {
			if (!args.length) return { text: 'usage: flow roadmap add "<future feature>" [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]', isError: true };
			// a spin-off: --slug stamps it like pick (flow start finds it), the brief carries what was worked
			// out in chat into the new feature's plan, and a bound session records where it was split from
			const slug = flagValue(rest, "slug");
			if (slug !== null && !validSlug(slug)) return { text: `--slug=${slug} is not a slug (lowercase, dashes)`, isError: true };
			const briefFile = flagValue(rest, "brief-file");
			if (briefFile !== null && !existsSync(path.resolve(root, briefFile))) return { text: `--brief-file=${briefFile} does not exist`, isError: true };
			const brief = briefFile !== null ? readFileSync(path.resolve(root, briefFile), "utf8") : (flagValue(rest, "brief") ?? "");
			const item = [args.join(" "), sess.slug && sess.slug !== slug ? `— split from ${sess.slug}` : "", slug ? `(${slug})` : ""].filter(Boolean).join(" ");
			save(appendRoadmapItem(text, item, brief));
			return { text: `roadmap: added — ${open + 1} open${slug ? `; stamped for ${slug}${brief.trim() ? " with a brief" : ""} — flow start ${slug} seeds its plan from it${sess.slug ? ` (after ${sess.slug} ships)` : ""}` : ""}` };
		}
		case "pick": {
			const slug = args[1] ?? "";
			if (!validIdx) return { text: `pick: open item 1–${open} required — flow roadmap lists them`, isError: true };
			if (!slug || !validSlug(slug)) return { text: `usage: flow roadmap pick <n> <slug> — the slug flow start will use (lowercase, dashes)`, isError: true };
			save(roadmapPick(text, idx, slug)!);
			return { text: `roadmap: item ${idx} picked for ${slug} — now: flow start ${slug} (flow finish checks the item off when it ships)` };
		}
		case "done": {
			if (!validIdx) return { text: `done: open item 1–${open} required — flow roadmap lists them`, isError: true };
			// stamped with date + bound slug, so history says what shipped it
			save(roadmapDone(text, idx, [new Date().toISOString().slice(0, 10), sess.slug].filter(Boolean).join(" "))!);
			return { text: `roadmap: item ${idx} marked done (${open - 1} open)` };
		}
		case "tidy": {
			if (!done) return { text: `roadmap: nothing to tidy (${open} open, 0 done)` };
			save(roadmapTidy(text));
			return { text: `roadmap: dropped ${done} done item(s) — ${open} open` };
		}
		default:
			return { text: "usage: flow roadmap [list|add <text> [--slug=<slug>] [--brief=<notes>|--brief-file=<path>]|pick <n> <slug>|done <n>|tidy]", isError: true };
		}
}

async function gateDoctor(o: GateCtx): Promise<RunResult> {
	const { root, rest } = o;
	// read-only findings on demand — never writes, never asks, safe for agents and CI at any stage
	const df = dfDir(root);
	const loaded = loadProject(df);
	const findings = doctorFindings(root, loaded.cfg, loaded.md);
	findings.push(...(await gitConsistency(root, loaded.cfg)));
	const refl = readReflections(root);
	const fold = await foldView(root, refl);
	if (refl.length) {
		findings.push(`reflection review — ${refl.length} open item(s); doctor never implements: investigate each, present the fix, the operator confirms, then the routed flow implements it:`);
		// labelled from the heading each item sits under — the file is the record, re-guessing from the
		// note text made doctor's table disagree with where the note was actually filed
		reflectionRoutes(refl, isSelfRepo(root)).forEach((r, i) => {
			const link = fold.state === "ok" ? fold.result.linked.find((l) => l.item === i) : undefined;
			findings.push(`  [${r.sections.join("+")}] ${r.text}${link ? linkedTag(link.issue) : ""}\n      → ${r.route}${link ? ` — already upstream (gh#${link.issue}); check off with — filed: gh#${link.issue} once it lands` : ""}`);
		});
	}
	findings.push(...foldRows(fold, isSelfRepo(root)));
	const reflText = readReflectionsText(root);
	const unfiled = reflectUnfiledCount(reflText);
	if (unfiled) findings.push(`  reflections: ${unfiled} open item(s) sit outside ## playbook / ## code — flow reflect list shows them, flow reflect move <n> --playbook|--code files them`);
	findings.push(...legacyPluginRows(reflText, isSelfRepo(root)).map((r) => `  ${r}`));
	const nudges = reflectionNudges(reflText, now().slice(0, 10), { between: !o.sess.slug });
	if (nudges.fix) findings.push(nudges.fix);
	if (nudges.tidy) findings.push(nudges.tidy);
	if (!rest.length) return { text: findings.length ? `doctor: ${findings.length} finding(s)\n${findings.map((f) => `  ${f}`).join("\n")}` : "doctor: no findings — playbook, flow state and git layout are consistent" };
	// flow doctor <note>: a fresh observation gets an investigation brief and a fix route
	return { text: investigationBrief(rest.filter((a) => !a.startsWith("--")).join(" "), isSelfRepo(root)).join("\n") };
}

/** What a gate handler needs from the runFlow preamble. */
interface GateCtx {
	root: string;
	ui: Ui;
	sess: Session;
	cfg: Config;
	rest: string[];
	flag: (name: string) => boolean;
	slugArg?: string;
	takeYoloWord: (state: FlowState) => string | null;
	hooks: FlowHooks;
}

async function gateVersion(o: GateCtx): Promise<RunResult> {
	const { root, flag } = o;
	// the plugin's own version — separate from the project's versioning.file version the release gates use
	const { disk: self, behind } = buildSkew(root);
	const head = self.version ? `dev-flow ${self.version} (pi-dev-flow at ${self.dir})` : `dev-flow version unknown — no pi-dev-flow package.json above ${self.dir}`;
	// in the dev-flow repo head names the checkout, so name where the stale code actually lives
	const from = SELF_BUILD.dir !== self.dir ? ` (from ${SELF_BUILD.dir})` : "";
	const dupNote = copyWarning();
	// --check-upstream is the one that asks the registry; plain flow version stays offline and instant
	if (flag("check-upstream")) {
		const newest = await publishedVersion(root);
		return { text: newest ? `${head} — published: ${newest}${self.version && newest !== self.version ? " (update available)" : ""}` : `${head} — could not read the published version (offline?)` };
	}
	return { text: `${behind ? `${head} — but this session runs ${behind}${from}; /reload to run ${self.version} \u2014 in a shared-process host (pi-web) reload cannot swap loaded code: only a host restart does` : head}${dupNote ? `\n${dupNote}` : ""}` };
}

async function gateTest(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	if (!cfg.commands.test) return { text: "no commands.test configured — add `test = <command>` under ## implement in .dev-flow/project.md", isError: true };
	const res = await sh(cfg.commands.test, gateCwd(root, state!), undefined, featureEnv(root, state!));
	state!.checks.test = { ok: res.ok, at: now() };
	await stampChecks(root, state!, ["test"]);
	writeState(root, state!);
	return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
}

async function gateCheck(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// a docs flow runs no project command anywhere else — pendingChecks, verifyGate and releaseGate all skip
	// it — so running tier-1 here only produced a FAIL that read like a broken deploy in a checkout that
	// never built the binary (#96)
	// shortcut: --docs is the operator's word, nothing checks the changeset is docs-only, so a mislabelled
	// flow now gets no test run at all; the mechanical fix is a diff-scope guard at verify if it ever bites
	if (state!.docs) return { text: "docs mode: project commands skipped — a docs flow runs no tier-1 checks (CI on the tag and the artifact proof still do)" };
	if (!cfg.checkList.length) return { text: 'no tier-1 checks configured — add ```flow blocks / flow-check blocks to ## implement in project.md', isError: true };
	const ran = await runChecks(root, state!, cfg, cfg.checkList);
	return { text: `tier-1 checks:\n${ran.lines.join("\n")}`, isError: ran.failed };
}

async function gateHealth(o: GateCtx): Promise<RunResult> {
	const { root, sess, cfg, slugArg } = o;
	const { state, err } = needState(root, sess, slugArg);
	if (err) return err;
	// commands.health and a flow-check named health are the same probe (healthProbe reads both)
	const probe = healthProbe(cfg);
	if (!probe) return { text: "no health check configured — add `health = <command>` (or a flow-check health block) under ## implement in .dev-flow/project.md", isError: true };
	const res = await probeHealth(root, state!, cfg, probe);
	if ("seedFail" in res) return res.seedFail;
	return { text: `health: ${res.ok ? "PASS" : "FAIL"} (${probe}${triedNote(res.attempts)})\n${tail(res.out)}` };
}

async function gateUse(o: GateCtx): Promise<RunResult> {
	const { root, sess, slugArg } = o;
	if (!slugArg) return { text: "usage: flow use <slug>", isError: true };
	const st = readState(root, slugArg);
	if (!st) {
		const ghost = existsSync(path.join(featDir(root, slugArg), "plan"));
		return { text: ghost ? `.dev-flow/${slugArg}/ is a ghost — plan/ but no state.json, so there is nothing to resume: flow start ${slugArg} --confirmed adopts its plan as a new feature` : `no unfinished feature ${slugArg}`, isError: true };
	}
	const prior = readClaim(root, slugArg);
	const takeover = claimBlocks(prior, sess.key) ? ` — taken over from live session (pid ${prior!.pid})` : "";
	sess.bind(slugArg);
	sess.rename(slugArg);
	// a checkpoint that was still unanswered belongs to whoever asked; a session taking the feature over
	// must not inherit a 💬 for a question it never posed
	if (st.pendingAsk) {
		delete st.pendingAsk;
		writeState(root, st);
	}
	return { text: `this session is now bound to ${slugArg} (stage ${st.stage})${st.worktree ? ` — work in its worktree: ${st.worktree} (branch ${st.branch})` : ""}; session renamed to ${slugArg}${takeover}` };
}

async function gateAbort(o: GateCtx): Promise<RunResult> {
	const { root, ui, sess, flag, slugArg } = o;
	// Unbinds the session only; state and worktree stay for manual recovery.
	const target = slugArg ?? sess.slug;
	if (!target) return { text: "nothing bound — pass a slug", isError: true };
	const st = readState(root, target);
	// a live claim locks the whole feature, not only its gates: aborting it out from under the session
	// that works it erases the plan that session is still writing (same rule needState applies)
	const claim = readClaim(root, target);
	if (claimBlocks(claim, sess.key)) return { text: `${target} is claimed by another live session (pid ${claim!.pid}) — flow use ${target} takes it over explicitly`, isError: true };
	if (st && !st.worktree) {
		// plan-stage abort = drop: no worktree/branch exists, so the state dir would linger
		// as a ghost the doctor flags (a plan/ whose state.json is gone). A written plan is the
		// operator's work too — it is not dropped without their word.
		const written = listFiles(path.join(featDir(root, target), "plan"));
		if (written.length && !flag("confirmed")) {
			const ok = ui.hasUI && (await ui.confirm("Drop plan?", `Abort ${target}? Its plan/ (${written.join(", ")}) is deleted for good.`));
			if (!ok) return { text: needsOperator(`aborting ${target} deletes its written plan (${written.join(", ")}) — ask the operator, then re-run with --confirmed`, "Drop plan?"), isError: true };
		}
		if (sess.slug === target) sess.bind(null);
		rmSync(featDir(root, target), { recursive: true, force: true });
		return { text: `aborted ${target} — feature removed (nothing approved, nothing to recover)` };
	}
	if (sess.slug === target) sess.bind(null);
	// the scratch dir is the bound session's working junk — it does not outlive the binding
	rmSync(featureTmpDir(dfDir(root), target), { recursive: true, force: true });
	if (st?.worktree) { st.aborted = now(); writeState(root, st); } // the doctor skips the removed worktree for stamped states (gh#138)
	return { text: `session unbound from ${target}; state stays at .dev-flow/${target}/` + (st?.aborted ? " (marked aborted — the doctor leaves it alone once you clean the worktree up)" : "") + (st?.worktree ? `\nto remove the worktree and branch:\n  git worktree remove ${st.worktree}\n  git branch -D ${st.branch}` : "") };
}


/** Sessions spawned by flow_stage in this process: they get no [dev-flow] driver context injected
 *  (their brief is their whole context) — the guards still judge them like any session. */
const workerSessions = new Set<string>();

/** Toolset per worker op: an implementer codes, a reviewer reads and runs commands only. */
const WORKER_TOOLS: Record<WorkerOp, string[]> = { implement: ["read", "bash", "edit", "write"], review: ["read", "bash"], reflect: ["read", "bash"] };

/** Test-only timer override: the smoke suite drives the steer, the hard cut and the salvage grace in ms. */
export const workerTiming: { softMs?: number; hardMs?: number; graceMs?: number } = {};

/** The upstream dev-flow repo's issues in every state, for the reflect brief's dedupe — prefetched so
 *  the worker reads a list instead of looping gh searches. null = gh could not answer (the brief then
 *  falls back to the search recipe). */
async function upstreamIssueList(root: string, repo: string): Promise<{ number: number; title: string; state: string }[] | null> {
	if (!repo || process.env.DEV_FLOW_NO_ISSUES) return null;
	const r = await sh(`gh issue list --repo ${sq(repo)} --state all --json number,title,state --limit 200`, root, 15_000);
	if (!r.ok) return null;
	try {
		const a = JSON.parse(r.out) as { number?: unknown; title?: unknown; state?: unknown }[];
		return Array.isArray(a) ? a.filter((i) => Number.isInteger(i?.number)).map((i) => ({ number: Number(i.number), title: String(i.title ?? ""), state: String(i.state ?? "") })) : null;
	} catch {
		return null;
	}
}

/** Seam: the smoke suite stubs the prefetch instead of calling gh against the real upstream. */
export const reflectSeams = { upstreamIssues: upstreamIssueList };

/** Build the reflect worker's transcript digests in the feature's scratch dir (driver first). A
 *  transcript that cannot be read is skipped — the brief still names the raw file. */
function writeTranscriptDigests(root: string, slug: string, files: string[]): { transcript: string; digest: string }[] {
	const dir = path.join(featureTmpDir(dfDir(root), slug), "reflect");
	const out: { transcript: string; digest: string }[] = [];
	for (const f of files) {
		try {
			mkdirSync(dir, { recursive: true });
			const digest = path.join(dir, `${path.basename(f, ".jsonl")}.digest.txt`);
			writeFileSync(digest, digestTranscript(readFileSync(f, "utf8")));
			out.push({ transcript: f, digest });
		} catch { /* unreadable transcript: the raw path stays in the brief */ }
	}
	return out;
}

/** Line 1 of every pi session file in `dir` — the header that names a worker's parent session. A
 *  file is read up to its first newline only (transcripts grow large); unreadable files are skipped. */
function sessionHeaders(dir: string | undefined): SessionHeaderInfo[] {
	if (!dir) return [];
	let names: string[];
	try { names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
	const out: SessionHeaderInfo[] = [];
	for (const n of names) {
		const file = path.join(dir, n);
		try {
			const fd = openSync(file, "r");
			try {
				const buf = Buffer.alloc(16_384);
				const len = readSync(fd, buf, 0, buf.length, 0);
				const first = buf.subarray(0, len).toString("utf8").split("\n")[0];
				const h = JSON.parse(first) as { type?: unknown; parentSession?: unknown };
				if (h?.type === "session") out.push({ file, parentSession: typeof h.parentSession === "string" ? h.parentSession : undefined });
			} finally { closeSync(fd); }
		} catch { /* not a session file, or a header past the read window: skip */ }
	}
	return out;
}

/** What makes a worker show up in pi-web's Agents menu: pi-web classifies a subagent from the
 *  custom entries its own runtime writes into the child's session file (pi-web lib/subagents.ts
 *  readSubagentRun, fed by lib/session-reader.ts). Two placement rules the reader enforces:
 *  the meta entry must be the file's FIRST data entry (the scanner reads header + one line and
 *  calls anything else a fork), and a persisted `running` the host cannot prove live displays as
 *  `interrupted` — so while a worker runs it also claims a slot in pi-web's live run map
 *  (piwebLiveClaim), and the final result entry settles the row after.
 *  Unknown entry types are inert in plain pi, so stamping is unconditional. */
const PIWEB_SUBAGENT = { meta: "pi-web:subagent", status: "pi-web:subagent-status", result: "pi-web:subagent-result" } as const;

interface WorkerSubagentMeta {
	parentId: string;
	parentFile: string;
	toolCallId: string;
	profile: string;
	description: string;
	task: string;
}

/** Only version 1 + the two lineage strings are hard-validated by pi-web's reader; the rest is
 *  display. resourceSnapshot is deliberately absent: its presence pins the tool set strictly when
 *  pi-web reopens the child, and these workers are never resumed by pi-web. */
function piwebWorkerMeta(m: WorkerSubagentMeta): Record<string, unknown> {
	return {
		version: 1,
		parentSessionId: m.parentId,
		parentSessionPath: m.parentFile,
		parentToolCallId: m.toolCallId,
		profile: m.profile,
		description: m.description,
		task: m.task,
		runInBackground: false,
		createdAt: now(),
	};
}

/** Best-effort by contract: a stamp that will not write must never break the worker run —
 *  visibility, not function (same rule as the worker's setSessionName renames). */
function piwebStamp(target: { appendCustomEntry?(customType: string, data?: unknown): unknown } | undefined, customType: string, data: unknown): void {
	try { target?.appendCustomEntry?.(customType, data); } catch { /* visibility only */ }
}

/** pi-web proves a subagent live only from its own in-process tables (rpc-manager.ts
 *  subagentDisplayStatus: its session registry, or globalThis.__piSubagentRuns); anything else with
 *  a persisted `running` reads `interrupted`. pi-web hosts extensions in its server process, so the
 *  worker claims a slot in that map for the run — pi-web's private global, used only when pi-web
 *  created it (never created here: plain pi stays untouched, and a pi-web without it keeps the old
 *  mid-run `interrupted`). Side effects: the driver counts as having an unsettled subagent while the
 *  tool call runs (it is mid-call anyway); Stop/steer from the Agents menu still answer "not running",
 *  since pi-web holds no wrapper for this child — the driver's Stop aborts it. Returns an idempotent
 *  release that drops the slot only if it still holds this claim (pi-web's dropSubagentRun rule). */
function piwebLiveClaim(sm: { getSessionId?(): string; getSessionFile?(): string | undefined } | undefined, m: WorkerSubagentMeta): (status: string) => void {
	try {
		const runs = (globalThis as { __piSubagentRuns?: unknown }).__piSubagentRuns;
		const sessionId = sm?.getSessionId?.();
		if (!(runs instanceof Map) || !sessionId) return () => {};
		let settle: (run: unknown) => void = () => {};
		const run = { sessionId, sessionPath: sm?.getSessionFile?.() ?? "", parentSessionId: m.parentId, parentToolCallId: m.toolCallId, profile: m.profile, description: m.description, task: m.task, runInBackground: false, status: "running", createdAt: now() };
		const stored = { run, completion: new Promise((resolve) => { settle = resolve; }), abortRequested: false, dispatchedAt: Date.now() };
		runs.set(sessionId, stored);
		let released = false;
		return (status) => {
			if (released) return;
			released = true;
			try { if (runs.get(sessionId) === stored) runs.delete(sessionId); settle({ ...run, status, completedAt: now() }); } catch { /* visibility only */ }
		};
	} catch { return () => {}; }
}

/** The worker's display name — the Agents row and the session name: `<glyph> <slug> <what>`. The
 *  model's label often repeats the slug ("flow-list-widget review"), so the slug and stray separators
 *  are cut from it; with nothing left the op names the run. */
function workerName(glyph: string, slug: string, op: string, label: unknown): string {
	const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const what = String(label ?? "").replace(/[\r\n]+/g, " ").replace(new RegExp(esc, "gi"), " ")
		.replace(/^[\s·:|/,-]+|[\s·:|/,-]+$/g, "").replace(/\s{2,}/g, " ").slice(0, 40).trim();
	return `${glyph} ${slug} ${what || op}`;
}

/** Seam that spawns a worker as a real pi session — tests replace `.run`. With the driver's session
 *  file and directory known, the worker's header links back to the driver (`parentSession`), so pi's
 *  picker nests it under the driver, and the pi-web meta lands as the file's first data entry. */
export const stageWorkerSpawn: { run: (o: { work: string; model: unknown; name: string; tools: string[]; parent?: string; dir?: string; subagent?: WorkerSubagentMeta }) => Promise<AgentSession> } = {
	run: async ({ work, model, name, tools, parent, dir, subagent }) => {
		const loader = new DefaultResourceLoader({ cwd: work, agentDir: getAgentDir() });
		await loader.reload();
		const sessionManager = parent && dir ? SessionManager.create(work, dir, { parentSession: parent }) : undefined;
		// The meta must be stamped here — before createAgentSession appends model_change/session_info,
		// because pi-web's scanner classifies the child only from the first data entry after the header.
		if (sessionManager && subagent) piwebStamp(sessionManager, PIWEB_SUBAGENT.meta, piwebWorkerMeta(subagent));
		const { session } = await createAgentSession({ cwd: work, model: model as never, tools, excludeTools: ["flow", "flow_stage"], resourceLoader: loader, sessionManager });
		try { workerSessions.add(session.sessionManager.getSessionId()); } catch { /* an id-less session just gets the default context */ }
		try { session.setSessionName(name); } catch { /* naming is visibility, not function */ }
		return session;
	},
};

/** Per-cwd cache of the main checkout a linked worktree belongs to (null = not a linked worktree) —
 *  every hook resolves its root through flowRoot, so git is asked once per directory. */
const mainCheckoutCache = new Map<string, string | null>();

/** The root whose .dev-flow/ is the flow truth for a session cwd. A feature worktree is a linked git
 *  worktree whose tracked .dev-flow/ holds only project.md — state, claims and plans live in the main
 *  checkout. Judging a session by its own cwd found no features and every guard answered "no active
 *  flow". So a linked worktree resolves to its main checkout when that checkout is initiated. */
async function flowRoot(cwd: string): Promise<string> {
	if (!mainCheckoutCache.has(cwd)) {
		const r = await sh("git rev-parse --path-format=absolute --git-dir --git-common-dir", cwd);
		const [gitDir, common] = r.ok ? r.out.split("\n").map((l) => l.trim()) : [];
		const linked = !!gitDir && !!common && path.resolve(gitDir) !== path.resolve(common);
		mainCheckoutCache.set(cwd, linked ? mainCheckoutRoot(cwd, common) : null);
	}
	const main = mainCheckoutCache.get(cwd);
	return main && initiated(main) ? main : cwd;
}

async function currentBranch(root: string): Promise<string> {
	const r = await sh("git branch --show-current", root);
	return r.ok ? r.out.split("\n")[0] : "";
}

function needState(root: string, sess: Session, slugArg?: string): { state: FlowState | null; err?: RunResult } {
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

function tail(out: string, n = 15): string {
	const lines = out.split("\n").filter(Boolean);
	return lines.length > n ? `…(${lines.length - n} lines)…\n${lines.slice(-n).join("\n")}` : out;
}

// ------------------------------------------------------------------ extension

/** The pi-web chip's current key, per session: the chip's label IS the widget key, so it changes with the
 *  footer text and the previous one must be cleared on every repaint. Per session, not per process — one
 *  pi-web server repaints many sessions (drivers, chats, workers), and a single shared slot let session B's
 *  repaint overwrite A's key, so A's next repaint cleared a key A never had and left its old chip beside
 *  the new one. On globalThis so a /reload or a duplicate copy still knows the chip already painted. */
const WEB_CHIP_KEYS: Map<string, string> = ((globalThis as { __piDevFlowChipKeys?: Map<string, string> }).__piDevFlowChipKeys ??= new Map());

/** Compact footer: bound flow = stage glyph, slug, mode markers, ⚠️ on its failing checks; unbound = the
 *  unfinished-flow count, or `💬 no flows` — an initiated repo always carries the footer. An uninitiated
 *  folder gets nothing: the status is cleared. In pi-web the footer text is not clickable, so there the
 *  footer IS a widget: one chip labelled with the footer text whose panel lists every open flow, one lean
 *  line each (no lines → a plain, non-expandable chip). Pure read — rendering never binds or claims anything. */
function refreshStatus(ctx: ExtensionContext, root: string): void {
	if (!ctx.hasUI) return;
	const web = ctx.mode !== "tui";
	const sk = sessionKey(ctx);
	const setChip = (key: string | undefined, lines?: string[]) => {
		const prev = WEB_CHIP_KEYS.get(sk);
		if (prev !== undefined && prev !== key) ctx.ui.setWidget(prev, undefined);
		if (key === undefined) WEB_CHIP_KEYS.delete(sk);
		else {
			WEB_CHIP_KEYS.set(sk, key);
			ctx.ui.setWidget(key, lines);
		}
	};
	if (!initiated(root)) {
		ctx.ui.setStatus("dev-flow", undefined);
		if (web) setChip(undefined);
		return;
	}
	const un = unfinishedStates(root);
	const bound = boundFeature(root, sessionKey(ctx));
	// TUI keeps the footer as its only surface: a lines-widget there is an always-present block above the
	// editor (no click to collapse), which competes with "the footer is the legend". pi-web shows the footer
	// text once, as the chip itself — a status line beside it would only repeat it.
	if (!web) {
		ctx.ui.setStatus("dev-flow", statusFor(bound, un.length).text);
		return;
	}
	ctx.ui.setStatus("dev-flow", undefined);
	setChip(chipLabel(bound, un.length), widgetLines(bound, un));
}


/** A project confirm rule with no operator present is a block — a hidden confirmation is not a confirmation. */
async function askOperator(ctx: ExtensionContext, what: string, why: string): Promise<string | null> {
	if (!ctx.hasUI) return needsOperator(`${why}: this needs an operator confirmation and no UI is available — ask them, or run it yourself outside Pi`);
	const ok = await ctx.ui.confirm("dev-flow project rule", `${what}\n\n${why}\n\nProceed?`);
	return ok ? null : `operator declined — ${why}`;
}

export default function devFlow(pi: ExtensionAPI) {
	registerCopy(); // which copy of dev-flow this is — see COPIES
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const uiFrom = (ctx: ExtensionContext): Ui => ({
		hasUI: ctx.hasUI,
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
	});

	const sessFor = (ctx: ExtensionContext, root: string): Session => {
		const key = sessionKey(ctx);
		return {
			key,
			slug: bindings.get(key) ?? null,
			bind: (slug) => {
				const prev = bindings.get(key);
				bindings.set(key, slug);
				pi.appendEntry("dev-flow-bind", { slug });
				// claims track the binding: claim what you bind, release what you drop.
				if (prev && prev !== slug && readClaim(root, prev)?.key === key) rmSync(claimFile(root, prev), { force: true });
				if (slug) writeClaim(root, slug, key);
			},
			rename: (slug) => {
				// pi's public session-name API, kept defensive: an older host without it must not fail a gate.
				// Skip the no-op re-bind of the current name — session_info entries would pile up per bind.
				try {
					if (pi.getSessionName?.() !== slug) pi.setSessionName?.(slug);
				} catch {
					/* naming is a courtesy, never a gate precondition */
				}
			},
		};
	};

	/** Restore this session's binding from its branch history (survives resume/fork). */
	const rebuildSession = (ctx: ExtensionContext, root: string) => {
		let slug: string | null = null;
		let sawCore = false;
		let coreStaleHere = false;
		for (const e of ctx.sessionManager?.getBranch() ?? []) {
			// SAFETY: narrow structural view of the SessionEntry union; we only read entries whose type/customType match our own appendEntry writes.
			const ce = e as unknown as { type: string; customType?: string; data?: { slug?: string | null; stale?: boolean } };
			if (ce.type === "custom" && ce.customType === "dev-flow-bind") slug = ce.data?.slug ?? null;
			if (ce.type === "custom" && ce.customType === "dev-flow-skill") {
				sawCore = true;
				coreStaleHere = ce.data?.stale === true; // the newest skill entry decides: a stale one follows a compaction
			}
		}
		const key = sessionKey(ctx);
		bindings.set(key, slug);
		// The branch is the truth about what the restored context holds: a marker means the core is in it
		// (do not pay twice), no marker means the branch was rewound or forked past the injection (give it
		// back), and a stale marker means a compaction summarized it away before the reload (give it back).
		if (sawCore) coreInjected.add(key);
		else coreInjected.delete(key);
		if (coreStaleHere) coreStale.add(key);
		else coreStale.delete(key);
		// A reload ends the old session, which released its claim; the restored one must reclaim what its own
		// branch says it holds, or the repo answers "claimed by another live session" to the session that
		// holds it. A foreign live claim wins — restoring is not a takeover.
		if (slug && readState(root, slug) && !claimBlocks(readClaim(root, slug), key)) writeClaim(root, slug, key);
	};

	/** The run's playbook preamble: the skill's always-on core, once per session. Later runs come back
	 *  empty because the transcript already holds it. The one exception is a compaction that summarized
	 *  it away (see session_compact), which pays it once more — and every real injection records itself,
	 *  so the newest skill entry on the branch is always the truth a reload restores from. */
	const corePreamble = (key: string): string => {
		if (coreInjected.has(key) && !coreStale.has(key)) return "";
		const core = skillCore();
		if (!core) return "";
		coreStale.delete(key);
		coreInjected.add(key);
		pi.appendEntry("dev-flow-skill", { core: true });
		return `${core}\n\n`;
	};

	pi.registerCommand("flow", {
		description: `dev-flow gates: ${GATE_HELP}`,
		handler: async (args, ctx) => {
			const cmd = parse(args);
			const root = await flowRoot(ctx.cwd);
			const res = await runFlow(cmd, root, uiFrom(ctx), sessFor(ctx, root), finishReflectHook("flow-finish", ctx, root));
			// gate output belongs to the conversation, not a toast: display:true renders a [flow] box (TUI + web), no triggerTurn so no model turn fires.
			// bare reflect is the exception: its whole output is instructions for the agent — displayed without a turn, they would never execute.
			const wake = cmd.length === 1 && cmd[0] === "reflect";
			pi.sendMessage({ customType: "flow", content: res.text, display: true }, wake ? { triggerTurn: true } : undefined);
			refreshStatus(ctx, root);
			if (!res.isError) maybeCompactNow(ctx, root);
		},
	});

	const flowTool = defineTool({
		name: "flow",
		label: "Flow",
		description:
			"Drive the dev-flow stage gates for the active feature (plan → implement → pre-release → release → done). Never edit .dev-flow state directly; gates enforce plan/mockup/test/verification criteria and confirm with the operator.",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: 'Gate invocation, e.g. ["status"] or ["start", "my-slug"]' }),
		}),
		execute: async (id, params, signal, onUpdate, ctx) => {
			const root = await flowRoot(ctx.cwd);
			const res = await runFlow(params.args, root, uiFrom(ctx), sessFor(ctx, root), finishReflectHook(id, ctx, root, signal, onUpdate));
			if (!res.isError) maybeCompactNow(ctx, root);
			return { content: [{ type: "text", text: res.text }], details: undefined, isError: res.isError };
		},
	});
	pi.registerTool(flowTool);

	/** Driver sessions with a worker running right now — one worker per session at a time. */
	const runningWorkers = new Set<string>();

	type WorkerResult = { content: { type: "text"; text: string }[]; details: { op: WorkerOp; outcome: string; verdict: string | null; commits: number; findings?: number; recorded?: boolean } | undefined; isError?: boolean };

	/** One fresh-session worker run for a bound flow — the body of flow_stage, shared with flow finish,
	 *  which runs the closing reflection itself before it removes anything (the worker reads the session
	 *  transcripts and .dev-flow/<slug>/tmp, which finish deletes, and the binding finish drops). */
	async function runStageWorker(a: {
		id: string;
		wop: WorkerOp;
		st: FlowState;
		root: string;
		key: string;
		note: string;
		label?: string;
		budgetMin?: number;
		signal?: AbortSignal;
		onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void;
		ctx: ExtensionContext;
	}): Promise<WorkerResult> {
		const { id, wop, st, root, key, signal, onUpdate, ctx } = a;
		const params = { note: a.note, label: a.label, budgetMin: a.budgetMin };
		const err = (text: string): WorkerResult => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });
		// a reflection reviews transcripts, not the branch: it runs in the main checkout, where the
		// worktree may already be gone at finish time
		const work = wop === "reflect" ? root : worktreeAbs(root, st);
		if (!work || !existsSync(work)) return err(`feature ${st.slug} has no worktree on disk — nothing for a worker to work in`);
		if (runningWorkers.has(key)) return err("a worker is already running for this session — wait for it to return");
		runningWorkers.add(key);
		const cfg = loadProject(dfDir(root)).cfg;
		const budgetMin = clampBudgetMin(params.budgetMin, wop);
		const glyph = wop === "implement" ? "🔨" : wop === "review" ? "🔍" : "🪞";
		const name = workerName(glyph, st.slug, wop, params.label);
		const started = Date.now();
		const git = async (cmd: string) => { const r = await sh(cmd, work); return r.ok ? r.out : ""; };
		const headBefore = (await git("git rev-parse HEAD")).trim();
		// the reflect worker runs in the main checkout, which may already carry the operator's edits
		const statusBefore = wop === "reflect" ? (await git("git status --short")).trim() : "";
		let lineage: { id?: string; file?: string; dir?: string } = {};
		try { lineage = { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() ?? undefined, dir: ctx.sessionManager.getSessionDir() ?? undefined }; } catch { /* unbacked driver: the worker is unlinked */ }
		const selfRepo = isSelfRepo(root);
		const brief =
			wop === "reflect"
				? await (async () => {
						const items = readReflections(root);
						const fold = await foldView(root, items);
						const upstream = await pluginUpstream(root);
						const children = lineage.file ? childSessionFiles(lineage.file, sessionHeaders(lineage.dir)) : [];
						return buildReflectBrief({
							slug: st.slug, root, today: now().slice(0, 10),
							driverFile: lineage.file ?? null,
							children,
							digests: lineage.file ? writeTranscriptDigests(root, st.slug, [lineage.file, ...children.map((c) => c.file)]) : [],
							upstreamIssues: (await reflectSeams.upstreamIssues(root, upstream)) ?? undefined,
							budgetMin,
							reflectionsFile: path.join(dfDir(root), "reflections.md"),
							items,
							projectMd: path.join(dfDir(root), "project.md"),
							version: pluginVersion(import.meta.dirname).version,
							upstream,
							selfRepo,
							projectIssues: fold.state === "ok" && !selfRepo ? { repo: fold.slug, issues: fold.result.upstreamOnly.map((i) => ({ number: i.number, title: i.title })) } : undefined,
							note: String(params.note ?? ""),
						});
					})()
				: buildWorkerBrief({
						op: wop, slug: st.slug, workDir: work,
						planFile: ((f) => (existsSync(f) ? f : null))(path.join(featDir(root, st.slug), "plan", "plan.md")),
						defaultBranch: cfg.defaultBranch,
						commits: await git(`git log --oneline ${sq(cfg.defaultBranch)}..HEAD`),
						status: await git("git status --short"),
						checks: cfg.checkList.map((c) => ({ name: c.name, command: c.cmd })),
						note: String(params.note ?? ""),
					});
		// pi-web visibility needs both halves of the lineage: the id the Agents menu links the child
		// to, the file the parentSession header points at — without either the worker stays unlinked.
		const subagent = !lineage.id || !lineage.file ? undefined : { parentId: lineage.id, parentFile: lineage.file, toolCallId: id, profile: `flow-${wop}`, description: name, task: brief };
		let child: AgentSession | undefined;
		let timedOut = false;
		let steered = false;
		let salvaged = false;
		let crash: string | null = null;
		let nudges = 0;
		let report = parseWorkerReport("");
		let modelError: ReturnType<typeof workerTurnError> = null;
		const turnError = () => workerTurnError((child as { messages?: unknown[] } | undefined)?.messages ?? []);
		const abortChild = () => void Promise.resolve(child?.abort()).catch(() => {});
		const hardMs = workerTiming.hardMs ?? budgetMin * 60_000;
		// grace before the cliff (gh#142): steered at 75% to wrap up, so a long run hands back a REPORT
		// instead of being cut mid-thought — the hard timer stays the backstop
		const softTimer = setTimeout(() => {
			steered = true;
			try { void Promise.resolve(child?.steer(workerSteer(wop, budgetMin))).catch(() => {}); } catch { /* the hard cut follows */ }
		}, workerTiming.softMs ?? Math.round(hardMs * WORKER_STEER_AT));
		const timer = setTimeout(() => { timedOut = true; abortChild(); }, hardMs);
		signal?.addEventListener("abort", abortChild);
		let unsub: (() => void) | undefined;
		let releaseLive: (status: string) => void = () => {};
		try {
			child = await stageWorkerSpawn.run({ work, model: ctx.model, name: `⏳ ${name}`, tools: WORKER_TOOLS[wop], parent: lineage.file, dir: lineage.dir, subagent });
			if (subagent) {
				piwebStamp(child.sessionManager, PIWEB_SUBAGENT.status, { version: 1, status: "running" });
				releaseLive = piwebLiveClaim(child.sessionManager, subagent);
			}
			unsub = child.subscribe((ev: unknown) => {
				const e = ev as { type?: string; toolName?: string };
				if (e.type === "tool_execution_start") {
					const min = Math.floor((Date.now() - started) / 60_000);
					onUpdate?.({ content: [{ type: "text", text: `⏳ ${name} — ${min}/${budgetMin} min · ${e.toolName ?? "?"}` }], details: { running: true } });
				}
			});
			await child.prompt(brief);
			report = parseWorkerReport(child.getLastAssistantText() ?? "");
			if (!report.found) modelError = turnError();
			// a turn that ends in prose ("now let me write D4…") ends the session: tell it to keep going —
			// but never a turn that ended in a model error: pi already retried it, a nudge buys one more storm (gh#173)
			while (!report.found && !modelError && !timedOut && !signal?.aborted && nudges < WORKER_NUDGES) {
				nudges++;
				await child.prompt(wop === "implement" ? WORKER_NUDGE : WORKER_NUDGE_READONLY);
				report = parseWorkerReport(child.getLastAssistantText() ?? "");
				if (!report.found) modelError = turnError();
			}
			// cut at the budget without a REPORT: one short, tool-less turn to hand back what it found —
			// an aborted reflection otherwise loses every finding it had already made
			if (!report.found && !modelError && timedOut && !signal?.aborted) {
				salvaged = true;
				const grace = setTimeout(abortChild, workerTiming.graceMs ?? WORKER_SALVAGE_MS);
				try {
					await child.prompt(WORKER_SALVAGE);
					report = parseWorkerReport(child.getLastAssistantText() ?? "");
				} catch {
					/* a failed salvage is still an interrupted run, not a crash */
				} finally {
					clearTimeout(grace);
				}
			}
		} catch (e) {
			crash = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(softTimer);
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortChild);
			unsub?.();
			runningWorkers.delete(key);
		}
		const transcript = (() => { try { return child?.sessionManager.getSessionFile() ?? ""; } catch { return ""; } })();
		const headAfter = (await git("git rev-parse HEAD")).trim();
		const newCommits = headBefore && headAfter && headBefore !== headAfter ? await git(`git log --oneline ${sq(headBefore)}..HEAD`) : "";
		const dirty = (await git("git status --short")).trim();
		const modelLine = modelError ? `model failed: stopReason=${modelError.reason} ${JSON.stringify(modelError.message)} (${modelError.streak} consecutive error turn(s)) — not a stall, ${nudges ? `stopped after ${nudges} nudge(s)` : "nudges skipped"}` : "";
		const outcome = crash
			? `crashed: ${crash}`
			: modelError
				? modelLine
				: timedOut
				? `interrupted at the ${budgetMin}-min budget${steered ? " (steered to wrap up at " + Math.round(WORKER_STEER_AT * 100) + "%)" : ""}${report.found ? " — REPORT salvaged after the cut, treat it as partial" : salvaged ? " — the salvage prompt got no REPORT either" : ""}`
				: report.found
					? `reported${steered ? " (after the wrap-up steer)" : ""}`
					: `ended without REPORT after ${nudges} nudge(s)`;
		// the terminal entry is what settles the Agents menu row (a persisted `running` the host
		// cannot prove live displays as `interrupted`); a no-REPORT run is a failure, not a ✓.
		if (subagent) {
			const doneAt = now();
			const final = crash
				? { version: 1, status: "failed", completedAt: doneAt, error: crash }
				: modelError
					? { version: 1, status: "failed", completedAt: doneAt, error: modelLine }
					: signal?.aborted || (timedOut && !report.found)
					? { version: 1, status: "aborted", completedAt: doneAt }
					: report.found
						? { version: 1, status: "completed", completedAt: doneAt, result: report.body }
						: { version: 1, status: "failed", completedAt: doneAt, error: `ended without REPORT after ${nudges} nudge(s)`, result: report.body };
			piwebStamp(child?.sessionManager, PIWEB_SUBAGENT.result, final);
			// leave the live map only once the result entry is down: the row is never neither
			releaseLive(final.status);
		}
		releaseLive("failed"); // idempotent guard: a throw between claim and result must not leave a live row
		try { if (child) workerSessions.delete(child.sessionManager.getSessionId()); } catch { /* id-less session: nothing was registered */ }
		try { child?.setSessionName(`${report.found && !crash && !signal?.aborted ? (timedOut ? "◐" : "✓") : "✗"} ${name}${report.verdict ? ` · ${report.verdict}` : ""}`); } catch { /* visibility only */ }
		// a dead model is a different failure from a stall, with a different remedy: say which (gh#173)
		const deadModelNote = `no REPORT — the worker's model was failing (${modelError?.message ?? ""}), not stalled: no ${wop === "implement" ? "slice was finished" : wop === "review" ? "review happened" : "reflection happened"}. Take it inline, or retry the delegation later (check the provider) — re-briefing it now hits the same failure.`;
		const parts = [`${glyph} ${wop} worker ${outcome} (${Math.round((Date.now() - started) / 60_000)} min)`];
		let reflected: ReturnType<typeof parseReflectReport> | null = null;
		if (wop === "reflect") {
			reflected = report.found ? parseReflectReport(report.body) : null;
			const rows = reflected && (reflected.findings.length || reflected.open.length || /^\s*F0\b/m.test(report.body)) ? renderReflectFindings(reflected, selfRepo) : null;
			parts.push(rows ? rows.join("\n") : report.found ? `REPORT (rows did not parse — read them yourself):\n${report.body.slice(0, 6000)}` : modelError ? deadModelNote : `no REPORT — last words:\n${report.body}`);
			if (report.found) {
				// the record finish reads: a reflection ran for this flow, so finish goes on to its cleanup
				const cur = readState(root, st.slug);
				if (cur) { cur.reflectedAt = now(); writeState(root, cur); }
			}
			const recurred = reflected?.open.filter((x) => x.status === "recurred").length ?? 0;
			const nudges = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { recurred });
			parts.push(
				"Next: show the operator this numbered list with your recommendation per item and ask fold or drop for each (one answer like 'fold 1,3 drop 2' is fine) — then STOP until they answer. " +
					`Fold docs → flow reflect --playbook "<note>"; fold code → flow reflect --code "<note>"; fold plugin → ${selfRepo ? 'flow reflect --code "<note>" (this is the dev-flow repo)' : 'flow reflect --plugin "<note>" prints the upstream recipe (dedupe search, then gh issue create — the fold answer is the confirmation; never a reflections.md row)'}; drop → record nothing. Open items re-checked as fixed → propose checking them off.`,
			);
			if (nudges.fix) parts.push(`${nudges.fix} — offer it after the fold/drop answer.`);
			if (nudges.tidy) parts.push(`${nudges.tidy} — offer it after the fold/drop answer.`);
			if (newCommits.trim() || dirty !== statusBefore) parts.push("note: the reflect worker changed the tree — inspect the change; it was told to write nothing");
			parts.push(`transcript: ${transcript || "(unknown)"}`);
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: { op: wop, outcome, verdict: null, commits: 0, findings: reflected?.findings.length ?? 0, recorded: report.found } };
		}
		parts.push(
			report.found ? `REPORT:\n${report.body.slice(0, 6000)}` : modelError ? deadModelNote : `no REPORT — last words:\n${report.body}`,
			`new commits:\n${newCommits.trim() || "(none)"}`,
			`uncommitted: ${dirty ? `\n${dirty}` : "clean"}`,
		);
		if (wop === "implement") {
			const check = await runFlow(["check"], root, uiFrom(ctx), sessFor(ctx, root));
			parts.push(`flow check after the worker: ${check.text.replace(/\s+/g, " ").trim().slice(0, 1500)}`);
		} else if (newCommits.trim() || dirty) {
			parts.push("note: the reviewer changed the tree — treat its verdict with suspicion and inspect the change");
		}
		parts.push(`transcript: ${transcript || "(unknown)"}`);
		parts.push(wop === "implement" ? "Next: read the report, decide what is left, and drive the gates yourself." : "Advisory review: fix what is real (inline is fine for small things), then carry on — no gate waits on this verdict.");
		return { content: [{ type: "text", text: parts.join("\n\n") }], details: { op: wop, outcome, verdict: report.verdict, commits: newCommits.trim().split("\n").filter(Boolean).length } };
	}

	/** The hook flow finish calls for its closing reflection: the same reflect worker flow_stage runs. */
	const finishReflectHook = (id: string, ctx: ExtensionContext, root: string, signal?: AbortSignal, onUpdate?: (u: { content: { type: "text"; text: string }[]; details: unknown }) => void): FlowHooks => ({
		reflect: async (st, note) => {
			const r = await runStageWorker({ id, wop: "reflect", st, root, key: sessionKey(ctx), note, label: "finish reflection", signal, onUpdate, ctx });
			return { text: r.content.map((c) => c.text).join("\n"), recorded: !!r.details?.recorded, findings: r.details?.findings ?? 0, failed: !!r.isError };
		},
	});

	const stageWorkerTool = defineTool({
		name: "flow_stage",
		label: "Stage worker",
		description:
			'Optional: hand a slice of work to a fresh pi session so this conversation stays lean. op "implement" (stage implement) — the worker edits and commits a slice on the feature branch; op "review" (implement or pre-release) — a fresh read-only reviewer that returns findings and a PASS/FAIL verdict (advisory: no gate depends on it); op "reflect" (any stage; flow finish runs it itself before cleanup) — a fresh read-only reviewer of this session\'s transcript and every worker transcript that returns classified reflection findings (docs / code / plugin) with a fold-or-drop recommendation each, for the operator to decide. The plan path, branch, commits so far and the project checks are added to the brief automatically — `note` is just the slice: what to do, operator answers and decisions the worker cannot see. The worker holds no flow tool; gates and checkpoints stay with you. Delegate an implement slice when it is in the plan, provable by flow check, needs no operator input mid-slice and is big enough (≈4+ files or heavy reading) to crowd this context; small work, small fixes, mid-debug work, operator-judged work and final integration stay inline (criteria: references/implement.md). In pi-web the worker appears in the session\'s Agents menu as a subagent (running while it works, then its final status); the opened transcript holds its report.',
		promptSnippet: 'flow_stage(op: "implement"|"review"|"reflect", note, label?) — optional fresh-session worker for a big implement slice, an independent review, or a reflection (flow finish runs the closing one itself); gates stay with you; in pi-web workers show up as subagents in the Agents menu',
		parameters: Type.Object({
			op: Type.String({ description: '"implement" (a worker edits + commits a slice), "review" (read-only reviewer, findings + verdict) or "reflect" (read-only reviewer of the session transcripts, reflection findings + fold/drop recommendations)' }),
			note: Type.String({ description: "The slice: what to do and anything from this conversation the worker must know (operator answers, decisions). Facts (plan path, commits, checks) are added for you." }),
			label: Type.Optional(Type.String({ description: "A few words naming this delegation, shown in the worker's session name." })),
			budgetMin: Type.Optional(Type.Number({ description: "Wall-clock budget in minutes (5-180; default 60 implement, 30 review, 20 reflect). Past it the worker is interrupted." })),
		}),
		execute: async (id, params, signal, onUpdate, ctx) => {
			const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });
			const op = String(params.op ?? "").trim().toLowerCase();
			const root = await flowRoot(ctx.cwd);
			if (!initiated(root)) return err("dev-flow is not initiated here — run flow init first");
			const key = sessionKey(ctx);
			const st = boundFeature(root, key);
			if (!st) return err("this session is not bound to a feature — flow start <slug> or flow use <slug> first");
			const why = workerOpError(op, st.stage);
			if (why) return err(why);
			return runStageWorker({ id, wop: op as WorkerOp, st, root, key, note: String(params.note ?? ""), label: params.label, budgetMin: params.budgetMin, signal, onUpdate, ctx });
		},
	});
	pi.registerTool(stageWorkerTool);

	// Agent-run gates refresh at turn_end (tool ctx lacks setStatus; turn_end catches them).
	pi.on("session_start", async (_event, ctx) => {
		if (!guardsAreMine()) return;
		const root = await flowRoot(ctx.cwd);
		rebuildSession(ctx, root);
		refreshStatus(ctx, root);
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (!guardsAreMine()) return;
		rebuildSession(ctx, await flowRoot(ctx.cwd));
	});
	// The session, not the process, owns the binding and the claim: pi-web keeps serving other sessions
	// after one ends, and a stale claim there is a permanent lock (its pid is the server's, always alive).
	pi.on("session_shutdown", async (_event, ctx) => {
		WEB_CHIP_KEYS.delete(sessionKey(ctx)); // the session's UI is gone; a long-lived server must not keep its slot
		if (!guardsAreMine()) return;
		const root = await flowRoot(ctx.cwd);
		if (!existsSync(dfDir(root))) return;
		releaseSession(root, sessionKey(ctx));
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (!guardsAreMine()) return;
		const root = await flowRoot(ctx.cwd);
		refreshStatus(ctx, root);
		// pi checks its compaction threshold between every turn; our safe points must be as frequent.
		maybeCompactNow(ctx, root);
	});
	// Idle backstop: long between-gate runs compact here instead of letting pi hit the threshold mid-work.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!guardsAreMine()) return;
		maybeCompactNow(ctx, await flowRoot(ctx.cwd));
	});
	// pi forcing a threshold compaction while a flow is bound means our safe-point pacing missed — rebuild the
	// summary here with flow-aware instructions and hand it back through the event's custom-compaction channel.
	// Never ctx.compact() from this hook: AgentSession.compact() opens with abort() + waitForIdle(), and the run
	// awaiting this handler can never go idle — the takeover would deadlock the session (no summarize request ever
	// reaches the provider). If our summary fails we return undefined and pi's own compaction proceeds.
	// overflow is never taken over (cancelling it would drop pi's compact-and-retry); manual is the operator's or ours.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!guardsAreMine()) return undefined;
		const root = await flowRoot(ctx.cwd);
		if (!initiated(root)) return undefined;
		const key = sessionKey(ctx);
		const st = boundFeature(root, key);
		if (!shouldTakeOverCompaction({ reason: event.reason, bound: !!st, inFlight: compacting.has(key) })) return undefined;
		const model = ctx.model;
		if (!model) return undefined;
		compacting.add(key);
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			// ProviderHeaders allows null values; compact() takes plain string headers
			const headers = auth.headers ? (Object.fromEntries(Object.entries(auth.headers).filter(([, v]) => v !== null)) as Record<string, string>) : undefined;
			// same function pi itself calls — same split-turn merge, file lists and prompts, just flow-aware instructions
			const result = await compactionTakeover.run(event.preparation, model, auth.apiKey, headers, flowCompactInstructions(st!), event.signal, undefined, undefined, auth.env);
			// re-read: the summarize call took a while, and the block must state the disk as it is now
			const now = readState(root, st!.slug) ?? st!;
			return { compaction: { ...result, summary: result.summary + compactionStateBlock(now, loadProject(dfDir(root)).cfg) } };
		} catch {
			return undefined; // pi's default compaction proceeds untouched
		} finally {
			compacting.delete(key);
		}
	});
	// Whatever the reason, the summary replaced the transcript — the core the first run injected is gone
	// from context, so the next run pays it once more (manual compactions included: our own safe-point
	// compaction is the common one). Durable too: a branch whose newest skill entry is stale tells a
	// reloaded session to pay the core again.
	pi.on("session_compact", async (_event, ctx) => {
		if (!guardsAreMine()) return;
		if (!initiated(await flowRoot(ctx.cwd))) return;
		coreStale.add(sessionKey(ctx));
		pi.appendEntry("dev-flow-skill", { core: true, stale: true });
	});

	// A bash call every guard let through runs with TMPDIR in its bound feature's scratch dir
	// (.dev-flow/<slug>/tmp/): mktemp, os.tmpdir() and test fixtures land there and flow finish removes
	// them. Prefixed only after the verdict, so no guard ever judges the prefix.
	pi.on("tool_call", async (event, ctx) => {
		const verdict = await guardToolCall(event, ctx);
		if (verdict || !isToolCallEventType("bash", event) || !guardsAreMine() || !initiated(ctx.cwd)) return verdict;
		const root = await flowRoot(ctx.cwd);
		const bound = boundFeature(root, sessionKey(ctx));
		if (!bound) return undefined;
		const dir = featureTmpDir(dfDir(root), bound.slug);
		mkdirSync(dir, { recursive: true });
		event.input.command = withTmpDir(String(event.input.command ?? ""), dir);
		return undefined;
	});

	async function guardToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (!guardsAreMine()) return undefined; // election: only the newest loaded copy judges
		// pi kills a shell call only when a timeout was passed, and the model omits it in ~75% of
		// calls (observed hangs: hours). Deterministic class defaults, clamped ceilings — runs for
		// every session that loads this package, flow-bound or not.
		const shellInput = isToolCallEventType("bash", event) || isToolCallEventType("powershell", event) ? (event.input as { command?: unknown; timeout?: unknown }) : undefined;
		const shellCmd = shellInput ? String(shellInput.command ?? "") : "";
		const explicitTimeout = typeof shellInput?.timeout === "number" ? shellInput.timeout : undefined;
		const noDf = !initiated(ctx.cwd);
		// in an initiated repo the silent default stays armed either way: it is the safety net for an
		// `inject` project and the number the refusal quotes; an uninitiated folder is not touched at all
		if (shellCmd && shellInput && !noDf) shellInput.timeout = bashTimeout(shellCmd, explicitTimeout);
		// an uninitiated folder hears nothing from dev-flow at all — flow init is the opt-in that arms
		// the guards, the no-playbook bash-timeout default included
		if (noDf) return undefined;
		// flow truth lives in the main checkout even when the session runs inside a feature worktree
		const guardRoot = await flowRoot(ctx.cwd);
		const cfg = loadProject(dfDir(guardRoot)).cfg;
		const mustStateTimeout = shellCmd !== "" && explicitTimeout === undefined && cfg.bashTimeout === "require";
		// for bash this verdict waits behind the operator's own deny/confirm rules further down;
		// powershell meets no project rules at all, so it is answered here
		if (mustStateTimeout && !isToolCallEventType("bash", event)) return { block: true, reason: requireTimeout(shellCmd)! };
		const key = sessionKey(ctx);

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const abs = path.resolve(ctx.cwd, String(event.input.path ?? ""));
			const feats = featureRefs(guardRoot);
			const bound = boundFeature(guardRoot, key);
			// operator safety rules from project.md run first — as in the bash guard, the operator's deny outranks flow discipline
			const pv = guardPath(abs, ctx.cwd, cfg.guard);
			if (pv.block) return { block: true, reason: pv.block };
			if (pv.confirm) {
				const why = await askOperator(ctx, `Editing ${path.relative(ctx.cwd, abs) || abs}`, pv.confirm);
				if (why) return { block: true, reason: why };
			}
			// only an unbound session's main-checkout write ever reads it — ask git just then (gh#175)
			const ignored = !bound && (await sh(`git check-ignore -q -- ${sq(abs)}`, guardRoot)).ok; // outside the repo: git exits 128, not ignored
			const reason = writeGuard({ abs, dfDir: dfDir(guardRoot), features: feats, boundSlug: bound?.slug ?? null, repoRoot: ctx.cwd, ignored });
			// a stale green is caught where it matters: verify and release fingerprint the worktree (freshenChecks)
			return reason ? { block: true, reason } : undefined;
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (stateTamper(command)) return { block: true, reason: "flow state under .dev-flow/ is dev-flow-owned — advance stages with the flow tool only" };
			if (playbookTamper(command)) return { block: true, reason: "project.md is the operator playbook — change it with flow init --write or inside a docs/patch flow's worktree" };
			// project safety rules first: they cover docker/gh/npm and everything else, not only git,
			// and the operator's deny outranks dev-flow's own stage verdicts
			const gv = guardBash(command, cfg.guard);
			if (gv.block) return { block: true, reason: gv.block };
			for (const r of gv.confirms) {
				const why = await askOperator(ctx, command, r.why || `project rule ${r.pattern}`);
				if (why) return { block: true, reason: why };
			}
			// `flow` in a shell is a 127 with no pointer, so the mistake repeated — name the call that works
			if (flowShellInvocation(command)) return { block: true, reason: FLOW_SHELL_HINT };
			// the operator's rules had their say — now the timeout must be stated
			if (mustStateTimeout) return { block: true, reason: requireTimeout(command)! };
			// a forced push rewrites history CI and other sessions already have. dev-flow asks the operator
			// itself so a project never needs a blunt `--force` deny of its own (#82, #83)
			if (forcePushInvocation(command)) {
				const why = await askOperator(ctx, command, `a forced push rewrites a pushed branch — CI and other sessions lose these commits (with the operator's word, prefix the push with ${ALLOW_REWRITE})`);
				if (why) return { block: true, reason: why };
			}
			// the playbook's merge style is enforced where the decision is actually made: gh/glab merging the PR.
			// An explicit contradiction is a hard block, a merge with no style flag (the forge default decides)
			// is a confirmation. No policy in the playbook → no new verdicts at all.
			const mv = mergeStyleInvocation(command, cfg.release.merge);
			if (mv.block) return { block: true, reason: mv.block };
			if (mv.confirm) {
				const why = await askOperator(ctx, command, mv.confirm);
				if (why) return { block: true, reason: why };
			}
			// shipping on the forge (PR merge, release page) is release-stage work for a bound feature
			if (/\b(?:gh|glab)\b/.test(command)) {
				const ro = releaseOrderInvocation(command, boundFeature(guardRoot, key)?.stage ?? null);
				if (ro) return { block: true, reason: ro };
			}
			const inv = gitInvocation(command);
			if (!inv.subs.length) return undefined; // git is not invoked as a command — nothing to guard
			const bound = boundFeature(guardRoot, key);
			// judge EACH git segment by the branch of the directory it runs in — a chain may cd across
			// directories; one last-cd-wins verdict misattributed mixed-dir chains and blocked legit worktree commits
			const branchCache = new Map<string, string>();
			const branchOf = async (dir: string | null): Promise<string> => {
				const at = dir ? path.resolve(ctx.cwd, dir) : ctx.cwd;
				if (!branchCache.has(at)) {
					// no session-cwd fallback: when the probe could not answer (a path that resolved nowhere, a
					// detached HEAD) it reported the session's branch, and a worktree commit got the main rule
					const br = await sh(`git -C ${sq(at)} branch --show-current`, ctx.cwd);
					branchCache.set(at, (br.ok ? br.out : "").trim().split("\n")[0]);
				}
				return branchCache.get(at)!;
			};
			const worktrees = featureRefs(guardRoot).map((f) => f.worktreeAbs).filter((w): w is string => !!w);
			for (const g of inv.gitSegs) {
				const gitDir = g.dir ? path.resolve(ctx.cwd, g.dir) : ctx.cwd;
				const seg = gitInvocation(g.seg); // parsed once per segment — this runs on every bash call of every session
				const branch = await branchOf(g.dir);
				let pushRefs: PushRef[] | undefined;
				const gp = seg.pushes;
				if (gp.length) {
					// push targets are judged by ref; bare names disambiguated against that repo's own tags (read-only probe)
					pushRefs = await Promise.all(
						parsePushRefs(gp).map(async (r) => {
							if (r.kind !== "branch" || !r.name || r.name === "*") return r;
							const tag = await sh(`git rev-parse --verify -q refs/tags/${sq(r.name)}`, gitDir);
							return tag.ok ? { kind: "tag" as const, name: r.name } : r;
						}),
					);
				}
				// the playbook tracking chore: when the playbook is this checkout's only change, a commit here
				// can only contain it — setup, not feature work, so it needs no flow (#53)
				let playbookChore = false;
				if (seg.subs.includes("commit") && branch === cfg.defaultBranch && bound?.stage !== "release") {
					const dirty = await sh(`git -C ${sq(gitDir)} status --porcelain`, ctx.cwd);
					playbookChore = dirty.ok && playbookOnlyChange(dirty.out);
				}
				const reason = bashFlowGuard({ command: g.seg, branch, stage: bound?.stage ?? null, defaultBranch: cfg.defaultBranch, pushRefs, playbookChore, dir: gitDir, attribution: bound ? undefined : `not attributed to a bound feature (session ${key}; dev-flow ${loadedVersion() ?? "?"} at ${SELF_BUILD.dir}) — run flow use <slug> here if a binding is missing` });
				if (reason) return { block: true, reason };
				// A feature worktree stays on its feature branch: a side branch cut inside it repurposes the
				// worktree (and leaves it off its branch for the next gate); out-of-flow fixes get their own flow.
				const co = checkoutInvocation(g.seg);
				if (!co) continue;
				const homeWt = worktrees.find((w) => gitDir === w || gitDir.startsWith(w + path.sep));
				if (co.creates && homeWt) return { block: true, reason: `a feature worktree stays on its own branch — not creating ${co.target} in ${homeWt}; an unrelated fix is its own flow (flow start <slug> --patch --confirmed)` };
				// Branch discipline: feature branches live in their worktree — never checked out or created (-b) in the main checkout
				if (!homeWt && co.target.startsWith(featureBranchPrefix(cfg)))
					return { block: true, reason: `branch ${co.target} belongs to a feature worktree, not the main checkout — flow use <slug> and run git inside ${featureBranchPrefix(cfg)}…'s worktree` };
			}
		}
		return undefined;
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!guardsAreMine()) return undefined;
		// One [dev-flow] line per run, whatever number of copies of this package are installed. The same
		// package can reach one runtime twice (a project pin beside the npm install) and pi dedupes
		// extensions by file path only; equal-version copies both pass the election, so the first pass
		// claims the run (pi hands every handler of a run the same ctx object) and the rival stays silent.
		const run = ctx as unknown as Record<symbol, boolean | undefined>;
		if (run[CONTEXT_EMITTED]) return undefined;
		run[CONTEXT_EMITTED] = true;
		// repaint the footer at the start of every run: the session_start push can land before a web
		// client attaches, and this is the earliest point the client is certainly listening
		const root = await flowRoot(ctx.cwd);
		refreshStatus(ctx, root);
		if (!initiated(root)) return undefined;
		try { if (workerSessions.has(ctx.sessionManager.getSessionId())) return undefined; } catch { /* not a worker */ }
		const key = sessionKey(ctx);
		// The playbook core rides along on the message this run writes anyway — once per session.
		const core = corePreamble(key);
		const cfg = loadProject(dfDir(root)).cfg;
		const state = boundFeature(root, key);
		if (!state) {
			// Default posture for an unbound session in a dev-flow repo (guards make it stick; this makes it understood).
			let content = "[dev-flow] no flow bound. Every request goes through flow. New work: flow start <slug>; unfinished feature: flow use <slug>.";
			const cb = claimBlocker(root, key);
			if (cb) content += ` Also: ${cb.state.slug} is claimed by another live session (pid ${cb.claim.pid}) — flow use ${cb.state.slug} takes it over explicitly.`;
			const curBr = await currentBranch(root);
			if (curBr && curBr !== cfg.defaultBranch) content += ` Also: main checkout is on ${curBr}, not ${cfg.defaultBranch} — surface this to the operator before starting work.`;
			const refl0 = readReflections(root);
			if (refl0.length) {
				// between flows is the moment to fix them: the nudge names the docs/patch split when a rule fires
				const nudge = reflectionNudges(readReflectionsText(root), now().slice(0, 10), { between: true });
				content += ` Also: ${refl0.length} reflection(s) open — ${nudge.fix ? `${nudge.fix}; mention it to the operator` : "run flow doctor"}.`;
				if (nudge.tidy) content += ` Also: ${nudge.tidy}.`;
			}
			const rmap0 = roadmapOpenCount(readRoadmap(root));
			if (rmap0) content += ` Also: ${rmap0} roadmap item(s) open — flow roadmap lists them, flow roadmap pick <n> <slug> hands one to flow start.`;
			content += ` Also: the playbook map is ${path.join(SKILL_DIR, "SKILL.md")} — per-stage detail sits in references/ beside it (start: flow init, modes, ownership).`;
			return { message: { customType: "dev-flow-context", display: false, content: `${core}${content}` } };
		}
		const guidance: string[] = [];
		if (state.yolo) guidance.push("YOLO mode: the operator pre-confirmed every gate question from here on (Verified?/Release?/Finish?) — run the remaining gates (verify → release → release-done → finish) back to back without stopping to ask; guidance the operator attached to the yolo word (e.g. patch bump, no tag) is a binding directive for the chain; checks and guardrails stay fully enforced.");
		// The one playbook file this stage needs, named outright: the model reads it instead of
		// guessing what a stage asks of it, and it pays for itself the first time a gate is refused.
		const ref = stageReference(state.stage);
		if (ref) guidance.push(`Stage playbook: read ${path.join(SKILL_DIR, ref)} before gate work in this stage.`);
		const prose = stageGuidance(cfg, state.stage);
		if (prose) guidance.push(`Stage guidance (${prose.source}): ${prose.text}`);
		guidance.push("Stage reports: open every report with the stage line (statusbar glyph + slug + provenance-marked decision fields); close a checkpoint with an event title and `Done:` / `Next steps:` on own lines — italic verbs, recommended first, yolo last. See Stage reports in the ground rules.");
		const pend = checklistPending(cfg, state, state.stage);
		if (pend) guidance.push(`Tier-2 checklist NOT yet confirmed (${pend} item(s)): ${applicableItems(cfg, state, state.stage).map((i) => i.text).join(" | ")}${state.stage === "release" ? " — release-stage items close with the operator's Finish? answer; no earlier gate records them" : ""}`);
		// mid-feature is the wrong moment to divert into old reflections — they surface at the release
		// stage (finish runs the reflection), between flows, and in status/doctor
		if (state.stage === "release") {
			const refl = readReflections(root);
			if (refl.length) guidance.push(`↻ ${refl.length} reflection(s) open — flow finish runs the closing reflection over them before cleanup; fix them only on the operator's word.`);
		}
		const rmap = roadmapOpenCount(readRoadmap(root));
		if (rmap) guidance.push(`◇ ${rmap} roadmap item(s) open — flow roadmap lists them (pick only on the operator's word).`);
		return {
			message: {
				customType: "dev-flow-context",
				display: false,
				content: `${core}[dev-flow] this session is bound to: ${state.slug}${state.patch ? " (patch)" : state.docs ? " (docs)" : ""} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
${guidance.length ? guidance.join("\n") + "\n" : ""}Rules: follow the dev-flow skill playbook; gates run through the flow tool only — \`flow\` is not a shell command, and the operator answers words in chat, never commands: you run the gate. \`/flow\` is the operator's manual override, not yours. Stage guards block out-of-stage edits and main-branch git ops — do not work around them.`,
			},
		};
	});
}
