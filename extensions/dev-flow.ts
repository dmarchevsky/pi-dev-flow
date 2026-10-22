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
 *     where it is and which gate comes next.
 *
 * The stage logic lives in src/core.ts (unit-tested); this file is pi wiring.
 * Inactive (fully pass-through) in repos without a .dev-flow/ directory.
 */
import { exec } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { compact, defineTool, isToolCallEventType, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ALLOW_REWRITE,
	approveGate,
	applicableItems,
	appendReflection,
	appendRoadmapItem,
	bashFlowGuard,
	changelogEntry,
	changelogVersionsBetween,
	normalizeReleaseBody,
	pendingEntryLines,
	pickReleaseNotes,
	checklistHash,
	checklistPending,
	checkoutTarget,
	claimBlocks,
	classifyMergeHistory,
	cmpVersions,
	cleanupAssess,
	compactionReflectionLine,
	detectForge,
	featureBranchPrefix,
	FLOW_SHELL_HINT,
	flowShellInvocation,
	forcePushInvocation,
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
	reflectProtocol,
	reflectSections,
	reflectionLine,
	reflectionRoutes,
	sessionRunsOlderBuild,

	listFiles,
	looksLikeShellError,
	needsOperator,
	newestTaggedVersion,
	newState,
	nextHint,
	openChecklistItems,
	openReflections,
	releaseGate,
	parseVersion,
	roadmapDone,
	roadmapDoneCount,
	roadmapDoneForSlug,
	roadmapOpenCount,
	roadmapPick,
	roadmapTidy,
	shouldSelfCompact,
	shouldTakeOverCompaction,
	stateTamper,
	statusCompact,
	statusJson,
	subst,
	sq,
	tagNotesCommand,
	validSlug,
	verifyGate,
	versionTagGate,
	writeGuard,
	type BranchState,
	type Config,
	type FeatureRef,
	type FlowState,
	type StageCheck,
	type PushRef,
	type SessionClaim,
} from "../src/core.ts";
import { buildDraft, doctorFindings, ghostFeatureDirs, loadProject, mdDigest, parseProjectMd, setPlaybookKey } from "../src/projectmd.ts";
import { bashTimeout, requireTimeout } from "../src/timeouts.ts";
import { detectProject } from "../src/detect.ts";

const execAsync = promisify(exec);

/** The dev-flow build this session actually loaded — see sessionRunsOlderBuild. Read at call time, and
 * DEV_FLOW_LOADED_VERSION can stand in for it (the smoke suite runs gates in-process and needs to
 * pretend it is an old session): the override can only ever make a gate more cautious — it never
 * lifts a proof, it turns a release into a warn-and-ask. */
function loadedVersion(): string | null {
	return process.env.DEV_FLOW_LOADED_VERSION?.trim() || pluginVersion(import.meta.dirname).version;
}

interface Ui {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
	/** Multi-line review/edit dialog where the client has one (TUI); undefined elsewhere. */
	editor?: (title: string, prefill?: string) => Promise<string | undefined>;
}

const now = () => new Date().toISOString();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** A `--merge=squash` style flag, or null when absent. Returned as the raw string: the caller validates it
 *  with parseMergeStyle so a typo is reported instead of ignored. */
function flagValue(rest: string[], name: string): string | null {
	for (const a of rest) {
		const m = a.match(new RegExp(`^--${name}=(.+)$`));
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
async function runHealthProbe(cmd: string, cwd: string, waitSec: number): Promise<{ ok: boolean; out: string; attempts: number }> {
	const { attempts, delayMs } = healthRetry(waitSec);
	const deadline = Date.now() + waitSec * 1000; // the budget is wall time: a slow probe must not multiply it by its own duration
	let res = { ok: false, out: "" };
	for (let i = 1; ; i++) {
		res = await sh(cmd, cwd);
		if (res.ok || i >= attempts || Date.now() >= deadline) return { ...res, attempts: i };
		await sleep(delayMs);
	}
}

/** Tags to judge a release against: what origin holds — a clone that has not fetched must not get to
 *  decide what is already tagged (#52). Local tags only when there is no remote to ask; null when an
 *  origin exists but could not be asked (offline, no ssh agent) — then local tags must not stand in. */
async function releaseTags(root: string): Promise<string[] | null> {
	if (!(await sh("git remote get-url origin", root)).ok) return (await sh("git tag --sort=-creatordate", root)).out.split("\n").filter(Boolean);
	const remote = await sh("git ls-remote --tags origin", root);
	if (!remote.ok) return null;
	return parseLsRemoteTags(remote.out);
}

const GATE_HELP =
	"help [--json] | init [--force|--draft|--write <text>] | reflect [<note>] | roadmap [add <text>|pick <n> <slug>|done <n>|tidy] | doctor [<issue note>] | status [slug] [--json] | start <slug> [--ui] [--force] [--patch|--docs --confirmed] [--merge=squash|merge|rebase|any] [--check-upstream] | use <slug> | test | check | health | approve [--yolo] | verify [--yolo] | release [--yolo|--no-version|--no-fold-check] | release-done [--no-artifact-check|--no-release-create] | finish [--yolo] [slug] | abort [slug] | version [--check-upstream] — start preflights the playbook before creating anything: it prints playbook gaps and warns when the session runs an older dev-flow build, and it refuses until a merge policy is set (ask the operator squash / merge / rebase / any in chat, then re-run with --merge=<style> --confirmed — the answer is written into project.md and enforced from then on: gh/glab merges that contradict it are blocked, and release-done proves what actually landed); version prints the loaded build (--check-upstream also asks the registry for the published one) — reflect <note> queues a suggestion in reflections.md (gate flags like --confirmed are ignored there); bare reflect prints the full session-reflection protocol (review the session log, re-check open items against shipped fixes and newer dev-flow versions, dedupe and report new findings, put the fix decision to the operator); roadmap manages .dev-flow/roadmap.md, the gitignored backlog of future features (bare lists open items; add appends one; pick <n> <slug> stamps open item <n> with the slug a later flow start uses — flow finish checks it off when that feature ships; done <n> checks off by hand; tidy drops done items); bare doctor reviews structure, git consistency and open reflections (routes each fix to a flow; it never writes); doctor <note> prints an investigation brief for a fresh observation; state gates take [slug] and --confirmed (the operator already answered in chat); --patch/--docs likewise need --confirmed (the operator granted the mode); --yolo on any state gate (approve/verify/release/finish) = the operator said \"yolo\" at that checkpoint: it answers that question and pre-confirms every later one (needs --confirmed; checks and guardrails stay); release --no-fold-check = operator-granted escape from the changelog fold proofs (the entries pending before the release are not line-checked; the entry heading and the 'this branch touched the changelog' proofs stay); release --no-version = this flow ships merge + changelog only — no bump, tag or forge release; the entry rides under Unreleased until the next versioned release folds it (default: versioned); when the session runs an older dev-flow build than the checkout, release names both builds, lists what the running code can no longer prove, and asks the operator update (/reload) or proceed with the old release — an operator decision recorded in state and repeated by release-done, never a block";
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

/** Seam for the takeover's summarize call (pi's own compact()); tests replace `.run` — mutable object stands in for ESM mocking. */
export const compactionTakeover: { run: typeof compact } = { run: compact };

/** Marks the before_agent_start pass that already wrote this run's [dev-flow] line — see the claim in that handler. */
const CONTEXT_EMITTED = Symbol.for("pi-dev-flow.context-emitted");

function unfinishedStates(root: string): FlowState[] {
	if (!existsSync(dfDir(root))) return [];
	return readdirSync(dfDir(root), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => readState(root, d.name))
		.filter((s): s is FlowState => !!s && s.stage !== "done");
}

/** Open items of the agent's suggestion queue (.dev-flow/reflections.md). */
const readReflections = (root: string): string[] => {
	const f = path.join(dfDir(root), "reflections.md");
	return existsSync(f) ? openReflections(readFileSync(f, "utf8")) : [];
};

const roadmapFile = (root: string) => path.join(dfDir(root), "roadmap.md");
const readRoadmap = (root: string): string => {
	const f = roadmapFile(root);
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** The session's feature: explicit binding, else the single unfinished feature — auto-bind unless another live session claims it. */
function boundFeature(root: string, key: string): FlowState | null {
	const bound = bindings.get(key);
	if (bound) {
		const s = readState(root, bound);
		if (s && s.stage !== "done") return s;
	}
	const un = unfinishedStates(root);
	if (un.length !== 1) return null;
	const claim = readClaim(root, un[0].slug);
	// shortcut: liveness is pid-only — pid reuse can read "live" and force an explicit flow use; friction only, never a wrong commit.
	if (claimBlocks(claim, key)) return null;
	if (claim?.key !== key) writeClaim(root, un[0].slug, key);
	return un[0];
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
	if (!existsSync(dfDir(root))) return;
	for (const d of readdirSync(dfDir(root), { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		if (readClaim(root, d.name)?.key === key) rmSync(claimFile(root, d.name), { force: true });
	}
}

/** The auto-bind this session was denied by another live session's claim — lets the unbound-context message name the feature. */
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
function maybeCompactNow(ctx: ExtensionContext): void {
	if (!existsSync(dfDir(ctx.cwd))) return;
	const u = ctx.getContextUsage?.(); // minimal/fake contexts may lack usage info — treat as unknown
	if (!u || u.tokens === null) return;
	const key = sessionKey(ctx);
	const st = boundFeature(ctx.cwd, key);
	if (!st) return;
	let reserve: number;
	try {
		const settings = SettingsManager.create(ctx.cwd); // throws on a malformed compaction setting — pi surfaces that itself; we just stay out
		if (!settings.getCompactionEnabled()) return; // operator turned auto-compaction off — don't do it behind their back
		reserve = settings.getCompactionReserveTokens(ctx.model);
	} catch {
		return;
	}
	const cfg = loadProject(dfDir(ctx.cwd)).cfg;
	const decision = {
		tokens: u.tokens,
		contextWindow: u.contextWindow,
		stage: st.stage,
		planFiles: listFiles(path.join(featDir(ctx.cwd, st.slug), "plan")).length,
		checklistPending: checklistPending(cfg, st, st.stage),
		compacting: compacting.has(key),
	};
	if (!shouldSelfCompact(decision, reserve)) return;
			compacting.add(key);
			const done = () => compacting.delete(key);
			try {
				ctx.compact({
					customInstructions: flowCompactInstructions(st),
					onComplete: done,
					onError: done,
				});
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
	for (const f of feats) if (f.worktree && !existsSync(path.resolve(root, f.worktree))) out.push(`feature ${f.slug} (${f.stage}) has no worktree at ${f.worktree}`);
	// the playbook belongs in git — an untracked project.md is invisible to teammates and lost on machine changes
	if (existsSync(path.join(root, ".dev-flow", "project.md")) && !(await sh("git ls-files --error-unmatch -- .dev-flow/project.md", root)).ok)
		out.push('.dev-flow/project.md is not tracked in git — track it: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md" (force: a root .gitignore may exclude .dev-flow/ wholesale; the env prefix is for the installed hook — dev-flow allows a main commit whose only change is the playbook)');
	return out;
}

/** Where feature commands run: the feature worktree once it exists (that is where the
 *  code under test lives), else the main checkout. Keeps gates off the main branch. */

/** Lines the current project.md has that a regenerated draft cannot reproduce. */
function droppableLines(current: string, draft: string): string[] {
	const keep = new Set(draft.split("\n").map((l) => l.trim()).filter(Boolean));
	return current.split("\n").map((l) => l.trim()).filter((l) => l && !keep.has(l));
}

function gateCwd(root: string, state: FlowState): string {
	const wt = worktreeAbs(root, state);
	return wt && existsSync(wt) ? wt : root;
}

/** Tier-1 checks the gate still has to see green. Entering a stage — and every edit of the worktree —
 * clears the records, so "run flow check first" cost three round trips to say what one could (#84).
 * `health` is left to the post-deploy probe when there is a deploy to prove: probing twice only waits twice. */
function pendingChecks(state: FlowState, cfg: Config): StageCheck[] {
	if (state.docs) return [];
	return cfg.checkList.filter((c) => !state.checks[c.name]?.ok && !(c.name === "health" && cfg.commands.dev && healthProbe(cfg)));
}

/** Run tier-1 checks in the feature cwd and record each result (health seeds first, as `flow health` does). */
async function runChecks(root: string, state: FlowState, cfg: Config, checks: StageCheck[]): Promise<{ lines: string[]; failed: boolean }> {
	const lines: string[] = [];
	let failed = false;
	for (const c of checks) {
		if (c.name === "health" && cfg.commands.seedData) {
			const seed = await sh(cfg.commands.seedData, gateCwd(root, state));
			if (!seed.ok) {
				lines.push(`seedData FAILED:\n${tail(seed.out)}`);
				failed = true;
				break;
			}
		}
		const res = await sh(c.cmd, gateCwd(root, state));
		state.checks[c.name] = { ok: res.ok, at: now() };
		lines.push(`${c.name}: ${res.ok ? "PASS" : "FAIL"} (${c.cmd})${res.ok ? "" : `\n${tail(res.out)}`}`);
		if (!res.ok) failed = true;
	}
	writeState(root, state);
	return { lines, failed };
}

/** Commits the feature branch holds over its merge base with the default branch, plus how many
 *  paths sit uncommitted: verify's proof that there is a committed state behind the operator's
 *  question. Local refs only — same offline-safe stance as the changelog proof — and an
 *  unanswerable merge base reports null instead of refusing on a measurement failure. */
async function branchState(cwd: string, defaultBranch: string): Promise<BranchState> {
	const mb = await sh(`git merge-base origin/${sq(defaultBranch)} HEAD 2>/dev/null || git merge-base ${sq(defaultBranch)} HEAD 2>/dev/null || true`, cwd);
	const base = mb.out.trim();
	if (!mb.ok || !base) return { commitsAhead: null, uncommitted: 0 };
	const ahead = await sh(`git rev-list --count ${sq(base)}..HEAD`, cwd);
	const n = Number.parseInt(ahead.out.trim(), 10);
	const dirty = await sh("git status --porcelain", cwd);
	return {
		commitsAhead: Number.isFinite(n) ? n : null,
		uncommitted: dirty.ok ? dirty.out.split("\n").filter((l) => l.trim()).length : 0,
	};
}

function describeBranchState(b: BranchState, defaultBranch: string): string {
	return b.commitsAhead === null
		? `commits: unknown (no merge base with ${defaultBranch} — the commit proof is skipped)`
		: `commits: ${b.commitsAhead} ahead of ${defaultBranch}, ${b.uncommitted} uncommitted path(s)`;
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
}

/** Is this checkout the dev-flow repo itself? Plugin reflections are fixable in-repo only here. */
function isSelfRepo(root: string): boolean {
	try {
		return (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown }).name === "pi-dev-flow";
	} catch {
		return false;
	}
}

/** The questions `flow init` asks before writing a playbook — detection fills what it can, the operator answers the rest (the agent relays them). */
function setupQuestions(det: { partial: { defaultBranch: string; versioning?: { file: string }; forge?: string; merge?: string }; missing: string[] }): string[] {
	const q = [det.partial.forge ? `git forge: detected "${det.partial.forge}" from the origin URL — github, gitlab or self-hosted? (global key forge)` : "git forge: no origin remote to detect from — github, gitlab or self-hosted? (global key forge)"];
	q.push(det.partial.versioning ? `version manifest: detected ${det.partial.versioning.file} — keep it? tag pattern v{version}?` : "versioning: no manifest found — which file holds the version (VERSION recommended), and the tag pattern?");
	// the merge style is inferable from history and worth asking with that evidence: a repo almost always has one
	q.push(`${det.partial.merge ? `${det.partial.merge} —` : "merge history: nothing to read a style from —"} how should a merged PR land on the default branch: squash, merge (a merge commit), rebase, or any (no policy)? it is written as merge = <style> under ## release and the gates enforce it.`);
	q.push("releases: should release-done create the forge release automatically via gh/glab (releases = yes), or is publishing manual (no)?");
	q.push("artifacts: do you publish anything to a registry (e.g. a container image to Docker Hub)? then release.artifact needs a verify command (e.g. docker buildx imagetools inspect <image>:{version}); the push itself belongs to ## release prose.");
	q.push(`tier-1 checks: ${det.missing.length ? `not detected: ${det.missing.join(", ")} —` : "detected test/build/run —"} which commands run tests, the build? any lint/typecheck? each extra becomes a flow-check block under ## implement.`);
	q.push("runtime: does the app expose a health endpoint (commands.health) and is there a dev deploy (commands.dev) the operator reviews before verify?");
	q.push("manual checks: any per-stage items the operator must tick off (tier-2 checklist) or standing guidance (prose)?");
	return q;
}

const GIT_TRACK_NOTE = 'the playbook belongs in git: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md" (force-add: a root .gitignore may exclude .dev-flow/ entirely — tracked once, the ignore stops mattering; the env prefix is for the pre-commit hook, dev-flow itself lets a main commit whose only change is the playbook)';

/** `flow reflect <note>` — advisory queue, operator decides. The note lands in the
 *  playbook and/or plugin section of reflections.md, chosen from its wording. */
function reflectNote(root: string, sess: Session, note: string[]): RunResult {
	const file = path.join(dfDir(root), "reflections.md");
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const sections = reflectSections(note.join(" "));
	const line = reflectionLine(note.join(" "), sess.slug, now().slice(0, 10));
	const next = appendReflection(text, sections, line);
	if (next === text) return { text: `already reflected (duplicate): ${line}` };
	writeFileSync(file, next);
	return { text: `reflected (${sections.join(" + ")}): ${line}` };
}

/** Single runner for both the /flow command and the flow tool. */
async function runFlow(args: string[], root: string, ui: Ui, sess: Session): Promise<RunResult> {
	const [sub = "status", ...rest] = args;
	// help and version are questions about the plugin, not the repo: answerable with no .dev-flow/ at all
	if (sub === "help" || sub === "--help" || sub === "-h") return { text: rest.includes("--json") ? gateHelpJson(GATE_HELP, loadedVersion()) : `usage: flow <sub> — ${GATE_HELP}` };
	if (!existsSync(dfDir(root)) && sub !== "init" && sub !== "version") return { text: "no .dev-flow/ in this repo — run flow init first", isError: true };
	const cfg = loadProject(dfDir(root)).cfg;
	const flag = (name: string) => rest.includes(`--${name}`);
	const slugArg = rest.find((a) => !a.startsWith("--"));

	switch (sub) {
		case "init": {
			// a recursive mkdir is silent about whether it created anything, and `flow init --write` is the
			// only sanctioned agent path to the playbook: claiming "created" when the folder was already
			// there sends the agent diffing its own config for damage that never happened (#39).
			const dfExisted = existsSync(dfDir(root));
			mkdirSync(dfDir(root), { recursive: true });
			const notes: string[] = dfExisted ? [] : [`.dev-flow/ created in ${root}`];
			// self-ignoring folder with one exception: the playbook is the only file under .dev-flow/ that lives in git
			writeFileSync(path.join(dfDir(root), ".gitignore"), "*\n!project.md\n");
			rmSync(path.join(dfDir(root), ".current"), { force: true }); // migrate away the legacy repo-global pointer
			const mdFile = path.join(dfDir(root), "project.md");
			const head = await sh("git symbolic-ref refs/remotes/origin/HEAD", root);
			const curBr = await currentBranch(root);
			// never propose a feature branch (contains "/") as the default branch
			const branch = (head.ok ? head.out.match(/refs\/remotes\/origin\/(.+)/)?.[1] : undefined) || (curBr.includes("/") ? undefined : curBr) || "main";
			const det = detectProject(root, branch);
			const origin = await sh("git remote get-url origin", root);
			det.partial.forge = origin.ok && origin.out.trim() ? detectForge(origin.out) : undefined; // confirmed or corrected by the operator during setup; absent = no origin to detect from
			det.partial.merge = (await mergeHistoryEvidence(root, branch))?.note; // "what do you actually do when a PR merges", read off the log
			const loaded = loadProject(dfDir(root));
			const draftFresh = buildDraft(det);
			const draftRefresh = buildDraft(det, loaded.cfg);
			const editHint = "to change anything: edit .dev-flow/project.md directly (flow init = doctor revalidates), or from an agent session: flow init --draft → discuss → --write";
			if (flag("draft")) return { text: existsSync(mdFile) ? readFileSync(mdFile, "utf8") : draftFresh }; // read path: prints content, writes nothing (and offers no deletions)
			// ghosts: feature dirs whose state.json is gone — inert, invisible to status and guards, and only findable by eye
			const ghosts = ghostFeatureDirs(root);
			if (ghosts.length) {
				if (!ui.hasUI) notes.push(`${ghosts.length} ghost feature dir(s) — a plan/ with no state.json, no flow owns them (${ghosts.join(", ")}); delete them or run flow init interactively`);
				else if (await ui.confirm("Remove ghost feature dirs?", `${ghosts.map((g) => `${g} — plan/ with no state.json`).join("\n")}\n\nNo flow owns these; their plan/*.md is not recoverable afterwards.`)) {
					for (const g of ghosts) rmSync(path.join(root, g), { recursive: true, force: true });
					notes.push(`removed ${ghosts.length} ghost feature dir(s): ${ghosts.map((g) => g.slice(".dev-flow/".length)).join(", ")}`);
				} else notes.push(`kept ${ghosts.length} ghost feature dir(s) — inert, remove them whenever you like`);
			}
			const writeMd = (text: string): RunResult | null => {
				const parsed = parseProjectMd(text);
				if (parsed.hard.length) return { text: `project.md REJECTED:\n- ${parsed.hard.join("\n- ")}`, isError: true };
				// the operator's rules are not regenerable — keep what was there before any overwrite
				if (existsSync(mdFile)) copyFileSync(mdFile, `${mdFile}.bak`);
				writeFileSync(mdFile, text.endsWith("\n") ? text : `${text}\n`);
				return null;
			};
			if (flag("write")) {
				const content = rest[rest.indexOf("--write") + 1];
				if (!content || content.startsWith("--")) return { text: 'usage: flow init --write "<full project.md content>"', isError: true };
				const parsed = parseProjectMd(content);
				const rej = writeMd(content);
				if (rej) return rej;
				notes.push("project.md written (operator-owned playbook)", GIT_TRACK_NOTE);
				if (parsed.warn.length) notes.push("warnings:", ...parsed.warn.map((w) => `  ${w}`));
			} else if (!existsSync(mdFile)) {
				// first init: never write silently. The setup brief lists what detection could not decide;
				// the agent relays the questions to the operator and applies the answers via flow init --write
				// (validated) after presenting the digest; an interactive init may confirm the draft right here.
				const brief = [
					"setup — project.md not written yet; nothing is drafted to disk until the operator confirms.",
					...det.report.map((r) => `  ${r}`),
					"questions for the operator (one per unclear knob, with the detected default):",
					...setupQuestions(det).map((line, i) => `  ${i + 1}. ${line}`),
					"agent: ask these in chat, fill the draft (flow init --draft), then apply with flow init --write \"<content>\" (hard-validated) — present the digest and get the operator's confirmation before writing.",
					GIT_TRACK_NOTE,
				];
				if (ui.hasUI) {
					const ok = await ui.confirm("Write project.md draft?", `${mdDigest(draftFresh)}\n\nWrite this detection draft now? Declining leaves the setup questions open for chat clarification.`);
					if (ok) {
						const rej = writeMd(draftFresh);
						if (rej) return rej;
						notes.push("wrote .dev-flow/project.md from detection — review it and adjust as needed", GIT_TRACK_NOTE);
					} else notes.push("draft not written — answer the setup questions, then flow init --write");
				}
				notes.push(...brief);
			} else if (flag("force")) {
				// a destructive reset of the operator's own file needs their word: --confirmed for an agent, one dialog for a human
				const ok = flag("confirmed") || (ui.hasUI && (await ui.confirm("Overwrite project.md?", `flow init --force replaces the operator playbook with a fresh detection draft. Hand-written rules, checklist items and guidance are lost (a copy is kept as project.md.bak).`)));
				if (!ok) return { text: "flow init --force overwrites the operator playbook — that needs the operator's word: re-run with --confirmed (the current file is kept as project.md.bak)", isError: true };
				copyFileSync(mdFile, `${mdFile}.bak`);
				writeFileSync(mdFile, draftFresh);
				notes.push("project.md OVERWRITTEN (--force; previous copy kept as project.md.bak):", ...det.report.map((r) => `  ${r}`), GIT_TRACK_NOTE);
			} else if (!ui.hasUI) {
				// the CI/agent path: the doctor's findings have to be printed, not just promised
				const findings = doctorFindings(root, loaded.cfg, loaded.md);
				notes.push("project.md already exists — kept (flow init --force to overwrite, --write to edit)", findings.length ? `doctor: ${findings.length} finding(s):` : "doctor: no findings", ...findings.map((x) => `  ${x}`));
			} else if (existsSync(mdFile)) {
				// doctor mode: cheap consistency probes only — never runs project commands
				const findings = doctorFindings(root, loaded.cfg, loaded.md);
				findings.push(...(await gitConsistency(root, loaded.cfg)));
				// a repo that never said how a PR merges gets the evidence next to the finding, so the answer is a choice and not a guess
				if (!loaded.cfg.release.merge) {
					const ev = await mergeHistoryEvidence(root, loaded.cfg.defaultBranch);
					if (ev?.recent) findings.push(`${ev.note} — write it into the playbook: merge = ${ev.recent} under ## release (or let the next flow start ask and write it)`);
				}
				for (const l of readReflections(root)) findings.push(`open reflection: ${l.slice(6)}`);
				if (!findings.length) notes.push("doctor: project.md OK — no drift, no inconsistencies");
				else {
					// a refresh is regenerated from detection + config: lines it cannot reproduce are
					// hand-written (prose, checklist items, hand-set keys) and would vanish silently.
					const dropped = droppableLines(readFileSync(mdFile, "utf8"), draftRefresh);
					let edited: string | undefined;
					if (dropped.length)
						notes.push(`doctor: refresh refused — a regenerated draft would drop ${dropped.length} hand-written line(s):`, ...dropped.slice(0, 8).map((l) => `  ${l}`), ...(dropped.length > 8 ? [`  …(${dropped.length - 8} more)`] : []));
					else
						edited = ui.editor
							? await ui.editor(`flow init — doctor: ${findings.length} finding(s) — edit & save to apply, Esc skips`, draftRefresh)
							: (await ui.confirm(`flow init — doctor: ${findings.length} finding(s)`, `${findings.join("\n")}

Write refreshed project.md? Your file; cancel writes nothing.
${mdDigest(draftRefresh)}`))
								? draftRefresh
								: undefined;
					if (edited === undefined) notes.push(dropped.length ? "findings — fix them by editing the file:" : "declined — project.md unchanged", ...findings.map((f) => `  ${f}`));
					else {
						const rej = writeMd(edited);
						if (rej) return rej;
						notes.push("project.md refreshed — findings addressed:", ...findings.map((f) => `  ${f}`), editHint);
					}
				}
			}
			const initCfg = loadProject(dfDir(root)).cfg;
			if (initCfg.mainHook) {
				const hookDir = path.join(root, ".git", "hooks");
				const hook = path.join(hookDir, "pre-commit");
				if (existsSync(hookDir) && !existsSync(hook)) {
					writeFileSync(
						hook,
						`#!/bin/sh\n# installed by dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden (override: DEV_FLOW_ALLOW_MAIN=1)\nbranch=$(git rev-parse --abbrev-ref HEAD)\nif [ "$branch" = "${initCfg.defaultBranch}" ] && [ -z "$DEV_FLOW_ALLOW_MAIN" ]; then\n  echo "dev-flow: direct commits to ${initCfg.defaultBranch} are forbidden — use a feature worktree and a PR" >&2\n  exit 1\nfi\n`,
						{ mode: 0o755 },
					);
					notes.push("pre-commit hook installed (blocks commits on main)");
				} else if (existsSync(hook) && !readFileSync(hook, "utf8").includes("installed by dev-flow")) {
					notes.push("existing pre-commit hook found — dev-flow hook NOT installed; main commits outside Pi are unguarded");
				}
			}
			return { text: notes.join("\n") };
		}

		case "start": {
			if (!slugArg || !validSlug(slugArg)) return { text: "usage: flow start <slug> [--ui] [--patch|--docs] [--merge=squash|merge|rebase|any] (slug: lowercase, dashes); --patch/--docs are operator-granted modes — ask the operator in chat, then add --confirmed", isError: true };
			if (existsSync(featDir(root, slugArg))) return { text: `feature ${slugArg} already exists`, isError: true };
			// relaxed modes are operator-granted: --confirmed anchors a literal chat grant, same convention as the gate verbs
			if (flag("patch") && flag("docs")) return { text: "--patch and --docs are exclusive — ask the operator which mode they grant", isError: true };
			const mode = flag("patch") ? "patch" : flag("docs") ? "docs" : null;
			if (mode && !flag("confirmed")) return { text: `${mode} mode is operator-granted — the operator must grant it in chat, then re-run with --confirmed`, isError: true };
			// branch discipline: features branch off the default branch — starting from a stale checkout poisons the base
			const curBr = await currentBranch(root);
			if (curBr !== cfg.defaultBranch && !flag("force")) return { text: `main checkout is on ${curBr}, not ${cfg.defaultBranch} — check out ${cfg.defaultBranch} first (git checkout ${cfg.defaultBranch} && git pull) or flow use an unfinished feature; --force to override`, isError: true };
			// --- preflight: is this session running the current build, and is the playbook complete? ---
			const notes: string[] = [];
			const self = pluginVersion(import.meta.dirname);
			const behind = sessionRunsOlderBuild(loadedVersion(), self.version);
			if (behind) notes.push(`warning: this session runs dev-flow ${behind}, the checkout has ${self.version} — /reload before trusting what a gate prints`);
			if (flag("check-upstream")) {
				const pub = await sh("npm view pi-dev-flow version", root);
				const newest = pub.ok ? pub.out.trim().split("\n").pop() : "";
				notes.push(newest ? `published dev-flow: ${newest} (this build: ${self.version ?? "?"})${self.version && newest !== self.version ? " — an update is available" : ""}` : "could not read the published dev-flow version (offline?)");
			}
			// missing playbook parameters are printed at the moment they start to matter, not promised to a later doctor run
			const gaps = doctorFindings(root, cfg, loadProject(dfDir(root)).md).filter((x) => !x.startsWith("no merge policy"));
			if (gaps.length) notes.push(`playbook gaps (${gaps.length}) — advisory, flow doctor reviews and routes them:\n${gaps.slice(0, 5).map((g) => `  ${g}`).join("\n")}`);
			// the merge policy is the one blocking gap: it decides the shape of the default branch and nobody can
			// reconstruct it afterwards. Ask once in chat (a checkpoint word like any other), write the answer, continue.
			const styleArg = flagValue(rest, "merge");
			const style = styleArg === null ? null : parseMergeStyle(styleArg);
			if (styleArg !== null && !style) return { text: `--merge=${styleArg} is not a policy — use squash, merge, rebase or any`, isError: true };
			// with no playbook at all there is nothing to ask about: writing the playbook is `flow init`'s job, and
			// a repo that never ran init must not be refused a feature by a merge-policy question
			const hasPlaybook = existsSync(path.join(dfDir(root), "project.md"));
			if (!hasPlaybook) notes.push("no .dev-flow/project.md yet — flow init writes the playbook (it now asks for the merge policy too)");
			if (hasPlaybook && (!cfg.release.merge || (style && style !== cfg.release.merge))) {
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
			// stamp the dev-flow build that started this feature — a stuck flow can later be read against its tooling
			const state = newState(slugArg, flag("ui"), flag("patch"), flag("docs"), self.version ?? undefined);
			mkdirSync(path.join(featDir(root, slugArg), "plan"), { recursive: true });
			writeState(root, state);
			sess.bind(slugArg);
			return { text: `feature ${slugArg} started at stage plan (ui=${state.ui}${state.patch ? ", patch" : state.docs ? ", docs" : ""}${self.version ? `, dev-flow ${self.version}` : ""}).${notes.length ? `\n${notes.join("\n")}` : ""}\n${nextHint(state, cfg)}` };
		}

		case "status": {
			const df = dfDir(root);
			const { md } = loadProject(df);
			// cheap fs probes only (no git subprocesses) — status is a glance, `flow doctor` is the full list
			const findings = md ? doctorFindings(root, cfg, md) : [];
			const warn = findings.length ? [`⚠ doctor: ${findings.length} finding(s) — run flow doctor`] : [];
			// the backlog nudge belongs to the no-features answer too — that is when a pick is most useful
			const rmap = roadmapOpenCount(readRoadmap(root));
			const rmapLine = rmap ? [`◇ ${rmap} roadmap item(s) open — flow roadmap`] : [];
			const slugs = slugArg ? [slugArg] : existsSync(df) ? (await listDirs(df)).filter((s) => readState(root, s)) : [];
			const un0 = unfinishedStates(root);
			const cur = sess.slug ?? (un0.length === 1 ? un0[0].slug : null);
			if (flag("json")) {
				const sts = slugs.map((s) => readState(root, s)).filter((s): s is FlowState => s !== null);
				return { text: statusJson(sts, cur, cfg) }; // before the prose "no features" answer — an orchestrator must be able to parse the empty case too
			}
			if (!slugs.length) return { text: ["no features — start one: flow start <slug> [--ui] [--patch|--docs --confirmed]", ...warn, ...rmapLine].join("\n") };
			const lines = slugs.flatMap((s) => {
				const st = readState(root, s);
				if (!st) return [];
				return [
					`${s === cur ? "→" : " "} ${s}: stage=${st.stage}${st.ui ? " [ui]" : ""}${st.yolo ? " [yolo]" : ""}${st.noVersion ? " [no-version]" : ""} branch=${st.branch || "-"} worktree=${st.worktree || "-"}${st.flowVersion ? ` flow=${st.flowVersion}` : ""}`,
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

		case "reflect": {
			// gate flags belong to the state verbs — pasted into the note they read as part of the operator's
			// own sentence in reflections.md (#43)
			const words = rest.filter((a) => !a.startsWith("--"));
			if (words.length) return reflectNote(root, sess, words);
			// upstream for the update probe: the manifest's repository field; the dev-flow checkout itself falls back to its origin
			const self = pluginVersion(import.meta.dirname);
			const upstream = self.repo || (isSelfRepo(root) ? githubSlug((await sh("git remote get-url origin", root)).out) : "");
			return { text: reflectProtocol(readReflections(root), isSelfRepo(root), { version: self.version, upstream }).join("\n") };
		}

		case "roadmap": {
			// the backlog is advisory — no state, no gating; direct file edits stay allowed like reflections.md
			const words = rest.filter((a) => !a.startsWith("--")); // gate flags are not backlog prose (#43 applies here too)
			const [verb = "list", ...args] = words;
			const text = readRoadmap(root);
			const open = roadmapOpenCount(text);
			const done = roadmapDoneCount(text);
			const save = (next: string) => writeFileSync(roadmapFile(root), next); // .dev-flow/ existence is runFlow's precondition
			const idx = Number(args[0]);
			const validIdx = Number.isInteger(idx) && idx >= 1 && idx <= open;
			switch (verb) {
				case "list": {
					if (!open) return { text: done ? `roadmap: nothing open (${done} done — flow roadmap tidy drops them)` : "roadmap: empty — flow roadmap add \"<future feature>\"" };
					return { text: [`roadmap — ${open} open (${done} done):`, ...openChecklistItems(text).map((l, i) => `  ${i + 1}. ${l.slice(6)}`)].join("\n") };
				}
				case "add": {
					if (!args.length) return { text: 'usage: flow roadmap add "<future feature>"', isError: true };
					save(appendRoadmapItem(text, args.join(" ")));
					return { text: `roadmap: added — ${open + 1} open` };
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
					return { text: "usage: flow roadmap [list|add <text>|pick <n> <slug>|done <n>|tidy]", isError: true };
				}
			}

		case "doctor": {
			// read-only findings on demand — never writes, never asks, safe for agents and CI at any stage
			const df = dfDir(root);
			const loaded = loadProject(df);
			const findings = doctorFindings(root, loaded.cfg, loaded.md);
			findings.push(...(await gitConsistency(root, loaded.cfg)));
			const refl = readReflections(root);
			if (refl.length) {
				findings.push(`reflection review — ${refl.length} open item(s); doctor never implements: investigate each, present the fix, the operator confirms, then the routed flow implements it:`);
				for (const r of reflectionRoutes(refl, isSelfRepo(root))) findings.push(`  [${r.sections.join("+")}] ${r.text}\n      → ${r.route}`);
			}
			if (!rest.length) return { text: findings.length ? `doctor: ${findings.length} finding(s)\n${findings.map((f) => `  ${f}`).join("\n")}` : "doctor: no findings — playbook, flow state and git layout are consistent" };
			// flow doctor <note>: a fresh observation gets an investigation brief and a fix route
			return { text: investigationBrief(rest.filter((a) => !a.startsWith("--")).join(" "), isSelfRepo(root)).join("\n") };
		}

		case "version": {
			// the plugin's own version — separate from the project's versioning.file version the release gates use
			const self = pluginVersion(import.meta.dirname);
			const behind = sessionRunsOlderBuild(loadedVersion(), self.version);
			const head = self.version ? `dev-flow ${self.version} (pi-dev-flow at ${self.dir})` : `dev-flow version unknown — no pi-dev-flow package.json above ${self.dir}`;
			// --check-upstream is the one that asks the registry; plain flow version stays offline and instant
			if (flag("check-upstream")) {
				const pub = await sh("npm view pi-dev-flow version", root);
				const newest = pub.ok ? pub.out.trim().split("\n").pop() : "";
				return { text: newest ? `${head} — published: ${newest}${self.version && newest !== self.version ? " (update available)" : ""}` : `${head} — could not read the published version (offline?)` };
			}
			return { text: behind ? `${head} — but this session runs ${behind}; /reload to run ${self.version}` : head };
		}

		case "approve": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = approveGate(state!, cfg, listFiles(path.join(featDir(root, state!.slug), "plan")));
			if (errs.length) return { text: `plan gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			const planItems = applicableItems(cfg, state!, "plan");
			if (flag("yolo")) state!.yolo = true; // operator's word at Approve? — every later gate question is pre-confirmed; checks and guardrails stay
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : "";
			if (!flag("confirmed")) {
				if (!ui.hasUI) return { text: needsOperator("plan approval needs the operator: approve interactively, or re-run with --confirmed once the operator answered in chat", "Approve?"), isError: true };
				const ok = await ui.confirm("Approve plan", `Approve ${state!.slug}${state!.ui ? " (UI)" : ""}${state!.patch ? " (patch)" : state!.docs ? " (docs)" : ""}? Creates the worktree.${flag("yolo") ? " YOLO: all later gate questions (Verified?/Release?/Finish?) are pre-confirmed — checks and guardrails stay in place." : ""}`);
				if (!ok) return { text: "approval declined — keep iterating on the plan" };
			}
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
			writeState(root, state!);
			return { text: `plan approved${audit}${state!.yolo ? " — yolo: later gate questions pre-confirmed" : ""}; worktree ${wtRel} on branch ${branch}.${setupNote}\n${nextHint(state!, cfg)}` };
		}

		case "test": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.test) return { text: "no commands.test configured — add `test = <command>` under ## implement in .dev-flow/project.md", isError: true };
			const res = await sh(cfg.commands.test, gateCwd(root, state!));
			state!.checks.test = { ok: res.ok, at: now() };
			writeState(root, state!);
			return { text: `test: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.test})\n${tail(res.out)}` };
		}

		case "verify": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const items = applicableItems(cfg, state!, "implement");
			const branch = await branchState(gateCwd(root, state!), cfg.defaultBranch);
			const branchLine = describeBranchState(branch, cfg.defaultBranch);
			// a check with no record is run here, not asked for: entering the stage — and every edit since —
			// cleared it, and telling the agent to run flow check cost three round trips (#84)
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
			if (state!.docs) {
				// docs mode's contract: no tier-1 work happens, so a docs flow neither builds, deploys nor probes (#43 #49)
				did.push("docs mode: project commands skipped (build/dev/health)");
			} else {
				if (cfg.commands.build) {
					const res = await sh(cfg.commands.build, gateCwd(root, state!));
					state!.checks.build = { ok: res.ok, at: now() };
					writeState(root, state!);
					if (!res.ok) return { text: `build FAILED (${cfg.commands.build}):\n${tail(res.out)}`, isError: true };
					did.push(`build ran (${cfg.commands.build})`);
				}
				// deploy to dev before asking — the operator reviews the running dev app, not a promise
				if (cfg.commands.dev) {
					const res = await sh(cfg.commands.dev, gateCwd(root, state!));
					state!.checks.dev = { ok: res.ok, at: now() };
					writeState(root, state!);
					if (!res.ok) return { text: `dev deploy FAILED (${cfg.commands.dev}):\n${tail(res.out)}`, isError: true };
					did.push(`dev ran (${cfg.commands.dev})`);
					// the deploy is what must be proven, not just run: a container that came back unhealthy, or
					// still serves the previous build, must not pass on a health PASS recorded before it was
					// recreated. What "the expected version" means is the project's business — the probe runs in
					// the worktree cwd, so it can compare the served build stamp with `git rev-parse HEAD`.
					const probe = healthProbe(cfg);
					if (!probe) did.push("health: none configured");
					else {
						if (cfg.commands.seedData) {
							const seed = await sh(cfg.commands.seedData, gateCwd(root, state!));
							state!.checks.seedData = { ok: seed.ok, at: now() };
							writeState(root, state!);
							if (!seed.ok) return { text: `seedData FAILED (${cfg.commands.seedData}):\n${tail(seed.out)}`, isError: true };
						}
						const probed = await runHealthProbe(probe, gateCwd(root, state!), cfg.healthWait);
						state!.checks.health = { ok: probed.ok, at: now() };
						writeState(root, state!);
						// a probe that needed the wait budget says so — "it passed on the 9th try" is the operator's business (#42)
						const tried = probed.attempts > 1 ? `, ${probed.attempts} attempts` : "";
						if (!probed.ok) return { text: `post-deploy probe FAILED (${probe}) — the deploy is not healthy / not serving this build (gave up after ${probed.attempts} attempt(s), healthWait ${cfg.healthWait}s):\n${tail(probed.out)}`, isError: true };
						did.push(`health: PASS (${probe}${tried})`);
					}
				} else did.push("dev: none configured");
			}
			const ran = [branchLine, ...did].join("; ");
			// yolo is the operator's word at Verified? — answers this question and pre-confirms the later ones; --confirmed anchors it, checks and guardrails stay
			if (flag("yolo")) {
				if (!state!.yolo && !flag("confirmed")) return { text: "yolo is the operator's word — the operator must have said it in chat, then re-run with --yolo --confirmed", isError: true };
				state!.yolo = true;
			}
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
			if (!flag("confirmed") && !state!.yolo) {
				// these commands already ran — say so even on the way out
				if (!ui.hasUI) return { text: `${needsOperator("verification needs the operator: confirm interactively, or re-run with --confirmed once the operator answered in chat.", "Verified?")}\n${ran}`, isError: true };
				const ok = await ui.confirm("Operator verification", `Verified? All checks green${cfg.commands.dev && !state!.docs ? `; dev deploy is up for review (${cfg.commands.dev})` : ""} \u2014 does it work?`);
				if (!ok) return { text: "verification declined — stay in implement and fix what failed" };
			}
			state!.confirmations = { ...state!.confirmations, implement: { hash: checklistHash(items), at: now() } };
			const final = verifyGate(state!, cfg, branch);
			if (final.length) return { text: `verify gate FAILED:\n- ${final.join("\n- ")}`, isError: true };
			state!.approvals.verify = now();
			state!.stage = "pre-release";
			writeState(root, state!);
			return { text: `verified${audit} — entering pre-release stage.\n${ran}\n${nextHint(state!, cfg)}` };
		}

		case "check": {
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

		case "health": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!cfg.commands.health) return { text: "no commands.health configured — add `health = <command>` (or a flow-check health block) under ## implement in .dev-flow/project.md", isError: true };
			if (cfg.commands.seedData) {
				const seed = await sh(cfg.commands.seedData, gateCwd(root, state!));
				state!.checks.seedData = { ok: seed.ok, at: now() };
				writeState(root, state!);
				if (!seed.ok) return { text: `seedData FAILED:\n${tail(seed.out)}`, isError: true };
			}
			const res = await runHealthProbe(cfg.commands.health, gateCwd(root, state!), cfg.healthWait);
			state!.checks.health = { ok: res.ok, at: now() };
			writeState(root, state!);
			const tried = res.attempts > 1 ? `, ${res.attempts} attempts` : "";
			return { text: `health: ${res.ok ? "PASS" : "FAIL"} (${cfg.commands.health}${tried})\n${tail(res.out)}` };
		}

		case "release": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const items = applicableItems(cfg, state!, "pre-release");
			if (flag("no-version")) state!.noVersion = true; // operator's word at Release?: this flow ships without a version bump or tag
			// yolo is the operator's word at Release? — answers this question and pre-confirms Finish?; publishing guardrails stay enforced
			if (flag("yolo")) {
				if (!state!.yolo && !flag("confirmed")) return { text: "yolo is the operator's word — the operator must have said it in chat, then re-run with --yolo --confirmed", isError: true };
				state!.yolo = true;
			}
			// prep evidence is read from the worktree: the bump and changelog entry exist on the branch before the PR merges
			const wtCwd = gateCwd(root, state!);
			const manifestVer = cfg.versioning.file && existsSync(path.join(wtCwd, cfg.versioning.file))
				? parseVersion(cfg.versioning.file, readFileSync(path.join(wtCwd, cfg.versioning.file), "utf8"))
				: null;
			// tags are only needed on the versioned path; a project without versioning must not be held up by an offline origin
			const remoteTags = cfg.versioning.file && !state!.noVersion ? await releaseTags(root) : [];
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
				const mb = await sh(`git merge-base origin/${sq(cfg.defaultBranch)} HEAD 2>/dev/null || git merge-base ${sq(cfg.defaultBranch)} HEAD 2>/dev/null || true`, wtCwd);
				const mbRef = mb.ok ? mb.out.trim() : "";
				// proof the branch touched the changelog: local refs only, so the check stays offline-safe
				if (mbRef) {
					const changes = await sh(`git diff --name-only ${sq(mbRef)} -- ${p} 2>/dev/null; git ls-files --others --exclude-standard -- ${p}`, wtCwd);
					changelogChanged = changes.out.split("\n").some((l) => l.trim());
				}
				const newest = !state!.noVersion && cfg.versioning.file ? newestTaggedVersion(cfg.versioning.pattern, remoteTags) : null;
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
			const prep = { manifestVersion: manifestVer, remoteTags, changelog, changelogChanged, changelogBase, noFoldCheck: flag("no-fold-check") };
			// tier-2 pre-release confirmation is recorded by this very command, so it is excluded here
			const preGate = preReleaseGate({ ...state!, confirmations: { ...state!.confirmations, "pre-release": { hash: checklistHash(items), at: now() } } }, cfg, prep);
			if (preGate.length) return { text: `release gate FAILED:\n- ${preGate.join("\n- ")}`, isError: true };
			// a stale session build is the operator's decision, never a block: publishing under an older gate is a
			// legitimate choice (hotfix, offline reload), and refusing would close exactly the emergency the relaxed
			// modes exist for. The gate names both builds, lists what the running code is missing, and folds the
			// update-or-proceed question into the Release? checkpoint — the operator's word, recorded in state.
			const selfBuild = pluginVersion(import.meta.dirname);
			const behind = sessionRunsOlderBuild(loadedVersion(), selfBuild.version);
			// truly behind, not merely different: a session whose loaded build is NEWER than the checkout's manifest
			// has every proof the checkout would run, and asking about it would be noise.
			const stale = !!behind && !!selfBuild.version && cmpVersions(behind, selfBuild.version) < 0;
			let staleAsk = "";
			let staleNote = "";
			if (stale) {
				const clPath = path.join(selfBuild.dir, "CHANGELOG.md");
				const missing = existsSync(clPath) && selfBuild.version ? changelogVersionsBetween(readFileSync(clPath, "utf8"), behind, selfBuild.version) : [];
				staleAsk =
					` This session runs dev-flow ${behind}, the checkout ships ${selfBuild.version ?? "?"} — gate proofs shipped between the two will NOT run. ` +
					(missing.length
						? `Shipped since ${behind}: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` …(${missing.length} total)` : ""} — see ${clPath}. `
						: `What shipped between them is not readable from the checkout's CHANGELOG.md — read it before deciding. `) +
					`Update (/reload, then re-run flow release on the current build) or proceed with the old release?`;
				staleNote = `released under dev-flow ${behind} (checkout ${selfBuild.version ?? "?"}) by operator choice — proofs newer than ${behind} did not run`;
			}
			const audit = flag("confirmed") ? " (confirmed by operator instruction)" : state!.yolo ? " (yolo: pre-confirmed)" : "";
			if (!flag("confirmed") && !state!.yolo) {
				if (!ui.hasUI) return { text: needsOperator(`release confirmation needs the operator: confirm interactively, or re-run with --confirmed once the operator answered 'Release?' in chat${stale ? ` — the operator must also answer the stale-build question: ${staleAsk}` : ""}`, "Release?"), isError: true };
				const ok = await ui.confirm("Enter release", `Release ${state!.slug}${manifestVer ? ` v${manifestVer}` : ""}${state!.noVersion ? " (unversioned — merge + changelog entry only: no bump, no tag for this flow)" : ""}? Publishing starts: PR, merge${state!.noVersion ? "" : ", tag"} — release-done afterwards needs no further answer.${staleAsk ? `\n\n${staleAsk}` : ""}`);
				if (!ok) return { text: "release declined — keep preparing in pre-release" };
			}
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
			if (stale) state!.staleBuild = `${behind} (checkout ${selfBuild.version ?? "?"})`;
			writeState(root, state!);
			return { text: `release approved${audit}${state!.noVersion ? " — unversioned: no bump or tag; your changelog entry rides under Unreleased until the next versioned release folds it" : ""} — entering release stage.${manifestVer ? ` Version ${manifestVer}.` : ""}${foldNote}${staleNote ? ` ${staleNote}.` : ""}\n${nextHint(state!, cfg)}` };
		}

		case "release-done": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			const errs = releaseGate(state!);
			let manifestVer: string | null = state!.releaseVersion ?? null;
			if (cfg.versioning.file && !state!.noVersion && !manifestVer) {
				// a flow approved before releaseVersion existed: the worktree copy is what the release gate
				// validated, the main checkout is the last resort (#52)
				for (const dir of [gateCwd(root, state!), root]) {
					const p = path.join(dir, cfg.versioning.file);
					if (!existsSync(p)) continue;
					manifestVer = parseVersion(cfg.versioning.file, readFileSync(p, "utf8"));
					if (manifestVer) break;
				}
				if (!manifestVer) errs.push(`versioning.file "${cfg.versioning.file}" has no parsable version — fix the playbook`);
			}
			const expectedTag = manifestVer ? cfg.versioning.pattern.replace("{version}", manifestVer) : null;
			const hasOrigin = (await sh("git remote get-url origin", root)).ok;
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
				const forgeProof = cfg.forge || detectForge((await sh("git remote get-url origin", root)).out);
				const proof = mergeShapeProof(cfg.release.merge, { ancestor, forgeStyle: ancestor === false ? await forgeMergeStyle(gateCwd(root, state!), forgeProof, br) : null, branch: br, defaultBranch: cfg.defaultBranch });
				if (proof.errors.length) errs.push(...proof.errors);
				else mergeNote = proof.note;
			}
			if (errs.length) return { text: `release gate FAILED:\n- ${errs.join("\n- ")}`, isError: true };
			// no checkpoint here — the operator's Release? answer covered the whole publication; everything left is objective checks
			const releasesWanted = !!manifestVer && !flag("no-release-create") && cfg.release.releases !== false;			let ghNote = "";
			let bodyOfRecord: string | null = null; // the changelog entry the forge body must match (#97)
			let bodyNote = "";
			const forgeName = cfg.forge || detectForge((await sh("git remote get-url origin", root)).out);
			if (manifestVer && flag("no-release-create")) ghNote = "Forge release skipped (--no-release-create).";
			else if (manifestVer && !releasesWanted) ghNote = "no forge release created (release.releases = false — the playbook says publication is manual; a stale key is how a repo ends up with tags and an empty Releases page #85).";
			else if (manifestVer && releasesWanted) {
				// forge release for the verified tag — gh for GitHub, glab for GitLab. A failed create is no
				// longer the end of the story: the proof below asks the forge whether anything is there (#63, #85)
				const tag = expectedTag!;
				const forge = forgeName;
				if (forge === "self") ghNote = "Forge release skipped (forge=self — publication stays manual).";
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
					const cmd = forge === "gitlab"
						? `glab release create ${sq(tag)} --name ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`
						: `gh release create ${sq(tag)} --title ${sq(tag)}${notes ? ` --notes ${sq(notes)}` : ""}`;
					const gr = await sh(cmd, root);
					// a failed create is the operator's call to decline, never a choice we make for them — stamp it so finish names it (#63)
					if (gr.ok) delete state!.forgeReleaseSkipped; // a successful retry lifts the stamp
					else state!.forgeReleaseSkipped = tail(gr.out);
					ghNote = gr.ok ? `${forge} release ${tag} created. ${notesNote}`.trim() : `${forge} release skipped: ${tail(gr.out)}`;
				}
			}
			const behind = sessionRunsOlderBuild(loadedVersion(), pluginVersion(import.meta.dirname).version);
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
					: behind
						? `warning: this session runs dev-flow ${behind}, not the build in the checkout — /reload before trusting what it printed.`
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

		case "finish": {
			const { state, err } = needState(root, sess, slugArg);
			if (err) return err;
			if (!state!.approvals.release)
				return { text: `finish closes a released feature — stage is "${state!.stage}" and no release is recorded; run flow release-done first (to abandon an unfinished feature, run flow abort)`, isError: true };
			// after this the flow state is gone: nothing may sit uncommitted or unpushed
			const dirty = await sh("git status --porcelain", root);
			if (dirty.ok && dirty.out.trim()) return { text: `main checkout has uncommitted changes — commit them first (finish deletes .dev-flow/${state!.slug}/):\n${tail(dirty.out)}`, isError: true };
			const hasOriginF = (await sh("git remote get-url origin", root)).ok;
			if (hasOriginF) {
				const pushed = await sh(`git merge-base --is-ancestor HEAD ${sq(`origin/${cfg.defaultBranch}`)}`, root);
				if (!pushed.ok) return { text: `HEAD is not on origin/${cfg.defaultBranch} — push the release (git push origin ${cfg.defaultBranch}) before finish`, isError: true };
			}
			// the cleanup part of closing out: drop the worktree and branch the release consumed
			const wt = worktreeAbs(root, state!);
			let closeNote: string;
			let unmergedNote = "";
			if (wt && existsSync(wt)) {
				const status = await sh(`git -C ${sq(wt)} status --porcelain`, root);
				const unmerged = await sh(`git -C ${sq(wt)} log origin/${cfg.defaultBranch}..HEAD --oneline 2>/dev/null || git -C ${sq(wt)} log ${cfg.defaultBranch}..HEAD --oneline`, root);
				const assess = cleanupAssess(status.out, unmerged.out.split("\n"));
				if (assess.errors.length) return { text: `finish blocked:\n- ${assess.errors.join("\n- ")}`, isError: true };
				if (assess.unmerged.length) {
					const policy = cfg.release.merge;
					// "not on the default branch" is only a violation when the ancestry is measurable: with no origin,
					// or a branch that was never pushed, the same count describes a local-only repo, not a squash
					const measurable = hasOriginF && !!state!.branch && (await sh(`git show-ref --quiet --verify ${sq(`refs/remotes/origin/${state!.branch}`)} ${sq(`refs/remotes/origin/${cfg.defaultBranch}`)}`, root)).ok;
					unmergedNote =
						policy && policy !== "merge" && policy !== "any"
							? ` ${assess.unmerged.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} — expected, the playbook merges with ${policy}.`
							: policy === "merge" && measurable
								? ` ${assess.unmerged.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} although the playbook says merge = merge — that PR did not land as a merge commit`
								: ` ${assess.unmerged.length} commit(s) in ${state!.worktree} are not on ${cfg.defaultBranch} (squash merge?)`;
					// under a merge-commit policy this is a violation, not a routine cleanup note: yolo does not
					// answer it, only the operator does
					if (policy === "merge" && measurable && !flag("confirmed"))
						return { text: needsOperator(`the playbook says merge = merge, but ${assess.unmerged.length} commit(s) of ${state!.slug} are not on ${cfg.defaultBranch} — the PR landed as a squash or a rebase. Ask the operator how to proceed, then re-run with --confirmed`, "Merge policy violation?"), isError: true };
				}
			}
			// a forge release that failed at release-done is still the operator's call — but they must see it before the state vanishes (#63)
			const forgeSkipNote = state!.forgeReleaseSkipped ? ` WARNING: the forge release was not created (${state!.forgeReleaseSkipped}) — recreate it manually or re-run release-done before finishing.` : "";
			// the one finish question — asked after the safety checks so it can never be a wasted question
			// yolo works uniformly at every gate: at Finish? nothing later remains to pre-confirm, the flag just answers this one
			if (flag("yolo")) {
				if (!state!.yolo && !flag("confirmed")) return { text: "yolo is the operator's word — the operator must have said it in chat, then re-run with --yolo --confirmed", isError: true };
				state!.yolo = true;
			}
			if (!flag("confirmed") && !state!.yolo) {
				if (!ui.hasUI) return { text: needsOperator(`finish needs the operator: ask them Finish? in chat, then re-run with --confirmed (or run /flow finish interactively)${forgeSkipNote}`, "Finish?"), isError: true };
				const ok = await ui.confirm("Finish feature", `Finish ${state!.slug}?${unmergedNote}${forgeSkipNote} Removes worktree, branch ${state!.branch || "-"} and .dev-flow/${state!.slug}/.`);
				if (!ok) return { text: "finish declined" };
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
			if (state!.branch && (await sh("git remote get-url origin", root)).ok) {
				const br = state!.branch;
				const onRemote = await sh("git ls-remote --heads origin", root);
				if (onRemote.out.split("\n").some((l) => l.endsWith(`\trefs/heads/${br}`))) {
					await sh(`git fetch -q origin ${sq(br)}`, root);
					let merged = (await sh(`git merge-base --is-ancestor origin/${sq(br)} origin/${sq(cfg.defaultBranch)}`, root)).ok;
					if (!merged) {
						// squash merges leave no ancestry — ask the forge: gh pr list, or the GitLab API via glab; self-hosted stays on ancestry proof
						const originUrl = await sh("git remote get-url origin", root);
						const forge = cfg.forge || detectForge(originUrl.out);
						if (forge === "gitlab") {
							const mr = await sh(`glab api ${sq(`projects/:id/merge_requests?source_branch=${br}&state=merged&per_page=1`)}`, root);
							merged = mr.ok && mr.out.trim() !== "[]";
						} else if (forge === "github") {
							const pr = await sh(`gh pr list --state merged --head ${sq(br)} --json number --jq length`, root);
							merged = pr.ok && pr.out.trim() !== "0";
						}
					}
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
			return { text: `feature ${state!.slug} done — ${closeNote}${remoteNote}; .dev-flow/${state!.slug}/ removed.${roadmapNote}${forgeSkipNote}` };
		}

		case "use": {
			if (!slugArg) return { text: "usage: flow use <slug>", isError: true };
			const st = readState(root, slugArg);
			if (!st || st.stage === "done") return { text: `no unfinished feature ${slugArg}`, isError: true };
			const prior = readClaim(root, slugArg);
			const takeover = claimBlocks(prior, sess.key) ? ` — taken over from live session (pid ${prior!.pid})` : "";
			sess.bind(slugArg);
			return { text: `this session is now bound to ${slugArg} (stage ${st.stage})${st.worktree ? ` — work in its worktree: ${st.worktree} (branch ${st.branch})` : ""}${takeover}` };
		}

		case "abort": {
			// Unbinds the session only; state and worktree stay for manual recovery.
			const target = slugArg ?? sess.slug;
			if (!target) return { text: "nothing bound — pass a slug", isError: true };
			const st = readState(root, target);
			if (sess.slug === target) sess.bind(null);
			if (st && !st.worktree) {
				// plan-stage abort = drop: no worktree/branch exists, so the state dir is a ghost that
				// the one-unfinished-feature auto-bind would resurrect into every unbound session
				rmSync(featDir(root, target), { recursive: true, force: true });
				return { text: `aborted ${target} — feature removed (nothing approved, nothing to recover)` };
			}
			return { text: `session unbound from ${target}; state stays at .dev-flow/${target}/` + (st?.worktree ? `\nto remove the worktree and branch:\n  git worktree remove ${st.worktree}\n  git branch -D ${st.branch}` : "") };
		}

		default:
			return { text: `unknown subcommand "${sub}" — ${GATE_HELP}`, isError: true };
	}
}

async function currentBranch(root: string): Promise<string> {
	const r = await sh("git branch --show-current", root);
	return r.ok ? r.out.split("\n")[0] : "";
}

function needState(root: string, sess: Session, slugArg?: string): { state: FlowState | null; err?: RunResult } {
	let slug = slugArg ?? sess.slug;
	if (!slug) {
		const un = unfinishedStates(root);
		if (un.length === 1) slug = un[0].slug;
		else if (!un.length) return { state: null, err: { text: "no unfinished features — flow start <slug> [--ui]", isError: true } };
		else return { state: null, err: { text: `multiple unfinished features (${un.map((s) => s.slug).join(", ")}) — flow use <slug> or pass an explicit slug`, isError: true } };
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

async function listDirs(dir: string): Promise<string[]> {
	const { readdirSync } = await import("node:fs");
	return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function tail(out: string, n = 15): string {
	const lines = out.split("\n").filter(Boolean);
	return lines.length > n ? `…(${lines.length - n} lines)…\n${lines.slice(-n).join("\n")}` : out;
}

// ------------------------------------------------------------------ extension

/** Compact footer status: stage glyph, slug, mode markers, ⚠️ on failing checks; cleared when no active feature. */
function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const st = existsSync(dfDir(ctx.cwd)) ? boundFeature(ctx.cwd, sessionKey(ctx)) : null;
	if (!st || st.stage === "done") {
		ctx.ui.setStatus("dev-flow", undefined);
		return;
	}
	const { text, failed } = statusCompact(st);
	ctx.ui.setStatus("dev-flow", failed ? `${text} ⚠️` : text);
}


/** A project confirm rule with no operator present is a block — a hidden confirmation is not a confirmation. */
async function askOperator(ctx: ExtensionContext, what: string, why: string): Promise<string | null> {
	if (!ctx.hasUI) return needsOperator(`${why}: this needs an operator confirmation and no UI is available — ask them, or run it yourself outside Pi`);
	const ok = await ctx.ui.confirm("dev-flow project rule", `${what}\n\n${why}\n\nProceed?`);
	return ok ? null : `operator declined — ${why}`;
}

export default function devFlow(pi: ExtensionAPI) {
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const uiFrom = (ctx: ExtensionContext): Ui => ({
		hasUI: ctx.hasUI,
		confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
		editor: ctx.mode === "tui" ? (title: string, prefill?: string) => ctx.ui.editor(title, prefill) : undefined,
	});

	const sessFor = (ctx: ExtensionContext): Session => {
		const key = sessionKey(ctx);
		return {
			key,
			slug: bindings.get(key) ?? null,
			bind: (slug) => {
				const prev = bindings.get(key);
				bindings.set(key, slug);
				pi.appendEntry("dev-flow-bind", { slug });
				// claims track the binding: claim what you bind, release what you drop.
				if (prev && prev !== slug && readClaim(ctx.cwd, prev)?.key === key) rmSync(claimFile(ctx.cwd, prev), { force: true });
				if (slug) writeClaim(ctx.cwd, slug, key);
			},
		};
	};

	/** Restore this session's binding from its branch history (survives resume/fork). */
	const rebuildSession = (ctx: ExtensionContext) => {
		let slug: string | null = null;
		for (const e of ctx.sessionManager?.getBranch() ?? []) {
			// SAFETY: narrow structural view of the SessionEntry union; we only read entries whose type/customType match our own appendEntry writes.
			const ce = e as unknown as { type: string; customType?: string; data?: { slug?: string | null } };
			if (ce.type === "custom" && ce.customType === "dev-flow-bind") slug = ce.data?.slug ?? null;
		}
		const key = sessionKey(ctx);
		bindings.set(key, slug);
		// A reload ends the old session, which released its claim; the restored one must reclaim what its own
		// branch says it holds, or the repo answers "claimed by another live session" to the session that
		// holds it. A foreign live claim wins — restoring is not a takeover.
		if (slug && readState(ctx.cwd, slug) && !claimBlocks(readClaim(ctx.cwd, slug), key)) writeClaim(ctx.cwd, slug, key);
	};

	pi.registerCommand("flow", {
		description: `dev-flow gates: ${GATE_HELP}`,
		handler: async (args, ctx) => {
			const cmd = parse(args);
			const res = await runFlow(cmd, ctx.cwd, uiFrom(ctx), sessFor(ctx));
			// gate output belongs to the conversation, not a toast: display:true renders a [flow] box (TUI + web), no triggerTurn so no model turn fires.
			// bare reflect is the exception: its whole output is instructions for the agent — displayed without a turn, they would never execute.
			const wake = cmd.length === 1 && cmd[0] === "reflect";
			pi.sendMessage({ customType: "flow", content: res.text, display: true }, wake ? { triggerTurn: true } : undefined);
			refreshStatus(ctx);
			if (!res.isError) maybeCompactNow(ctx);
		},
	});

	const flowTool = defineTool({
		name: "flow",
		label: "Flow",
		description:
			"Drive the dev-flow stage gates for the active feature (plan → implement → pre-release → release → done). Never edit .dev-flow state directly; gates enforce plan/mockup/test/verification criteria and confirm with the operator.",
		parameters: Type.Object({
			args: Type.Array(Type.String(), { description: 'Gate invocation, e.g. ["status"] or ["start", "my-slug", "--ui"]' }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const res = await runFlow(params.args, ctx.cwd, uiFrom(ctx), sessFor(ctx));
			if (!res.isError) maybeCompactNow(ctx);
			return { content: [{ type: "text", text: res.text }], details: undefined, isError: res.isError };
		},
	});
	pi.registerTool(flowTool);

	// Agent-run gates refresh at turn_end (tool ctx lacks setStatus; turn_end catches them).
	pi.on("session_start", async (_event, ctx) => {
		rebuildSession(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => rebuildSession(ctx));
	// The session, not the process, owns the binding and the claim: pi-web keeps serving other sessions
	// after one ends, and a stale claim there is a permanent lock (its pid is the server's, always alive).
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return;
		releaseSession(ctx.cwd, sessionKey(ctx));
	});
	pi.on("turn_end", async (_event, ctx) => {
		refreshStatus(ctx);
		// pi checks its compaction threshold between every turn; our safe points must be as frequent.
		maybeCompactNow(ctx);
	});
	// Idle backstop: long between-gate runs compact here instead of letting pi hit the threshold mid-work.
	pi.on("agent_settled", async (_event, ctx) => maybeCompactNow(ctx));
	// pi forcing a threshold compaction while a flow is bound means our safe-point pacing missed — rebuild the
	// summary here with flow-aware instructions and hand it back through the event's custom-compaction channel.
	// Never ctx.compact() from this hook: AgentSession.compact() opens with abort() + waitForIdle(), and the run
	// awaiting this handler can never go idle — the takeover would deadlock the session (no summarize request ever
	// reaches the provider). If our summary fails we return undefined and pi's own compaction proceeds.
	// overflow is never taken over (cancelling it would drop pi's compact-and-retry); manual is the operator's or ours.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const key = sessionKey(ctx);
		const st = boundFeature(ctx.cwd, key);
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
			return { compaction: result };
		} catch {
			return undefined; // pi's default compaction proceeds untouched
		} finally {
			compacting.delete(key);
		}
	});
	// pi forcing its own compaction while a flow is bound means the pacing was wrong — park a note for the operator.
	pi.on("session_compact", async (event, ctx) => {
		if (!existsSync(dfDir(ctx.cwd)) || event.reason === "manual") return;
		const st = boundFeature(ctx.cwd, sessionKey(ctx));
		if (!st) return;
		const f = path.join(dfDir(ctx.cwd), "reflections.md");
		const text = existsSync(f) ? readFileSync(f, "utf8") : "";
		const line = compactionReflectionLine(st.slug, st.stage, event.reason, new Date().toISOString().slice(0, 10));
		writeFileSync(f, appendReflection(text, ["plugin"], line));
	});

	pi.on("tool_call", async (event, ctx) => {
		// pi kills a shell call only when a timeout was passed, and the model omits it in ~75% of
		// calls (observed hangs: hours). Deterministic class defaults, clamped ceilings — runs for
		// every session that loads this package, flow-bound or not.
		const shellInput = isToolCallEventType("bash", event) || isToolCallEventType("powershell", event) ? (event.input as { command?: unknown; timeout?: unknown }) : undefined;
		const shellCmd = shellInput ? String(shellInput.command ?? "") : "";
		const explicitTimeout = typeof shellInput?.timeout === "number" ? shellInput.timeout : undefined;
		// the silent default stays armed either way: it is the safety net for an `inject` project and the number the refusal quotes
		if (shellCmd && shellInput) shellInput.timeout = bashTimeout(shellCmd, explicitTimeout);
		const noDf = !existsSync(dfDir(ctx.cwd));
		// with no playbook to opt out, the hard default rules: the model must say its own timeout
		if (shellCmd && noDf) {
			const why = requireTimeout(shellCmd, explicitTimeout);
			if (why) return { block: true, reason: why };
		}
		if (noDf) return undefined;
		const cfg = loadProject(dfDir(ctx.cwd)).cfg;
		const mustStateTimeout = shellCmd !== "" && explicitTimeout === undefined && cfg.bashTimeout === "require";
		// for bash this verdict waits behind the operator's own deny/confirm rules further down;
		// powershell meets no project rules at all, so it is answered here
		if (mustStateTimeout && !isToolCallEventType("bash", event)) return { block: true, reason: requireTimeout(shellCmd)! };
		const key = sessionKey(ctx);

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const abs = path.resolve(ctx.cwd, String(event.input.path ?? ""));
			const feats = featureRefs(ctx.cwd);
			const bound = boundFeature(ctx.cwd, key);
			// operator safety rules from project.md run first — as in the bash guard, the operator's deny outranks flow discipline
			const pv = guardPath(abs, ctx.cwd, cfg.guard);
			if (pv.block) return { block: true, reason: pv.block };
			if (pv.confirm) {
				const why = await askOperator(ctx, `Editing ${path.relative(ctx.cwd, abs) || abs}`, pv.confirm);
				if (why) return { block: true, reason: why };
			}
			const reason = writeGuard({ abs, dfDir: dfDir(ctx.cwd), features: feats, boundSlug: bound?.slug ?? null });
			if (reason) return { block: true, reason };
			// Editing a worktree invalidates that feature's tier-1 checks and tier-2 confirmation until they rerun.
			const owner = feats.find((f) => f.worktreeAbs && abs.startsWith(f.worktreeAbs + path.sep));
			if (owner && (owner.state.stage === "implement" || owner.state.stage === "pre-release") && (Object.keys(owner.state.checks).length || owner.state.confirmations?.implement)) {
				owner.state.checks = {};
				delete owner.state.confirmations?.implement;
				writeState(ctx.cwd, owner.state);
			}
			return undefined;
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
			const inv = gitInvocation(command);
			if (!inv.subs.length) return undefined; // git is not invoked as a command — nothing to guard
			const bound = boundFeature(ctx.cwd, key);
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
			const worktrees = featureRefs(ctx.cwd).map((f) => f.worktreeAbs).filter((w): w is string => !!w);
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
				const reason = bashFlowGuard({ command: g.seg, branch, stage: bound?.stage ?? null, defaultBranch: cfg.defaultBranch, pushRefs, playbookChore, dir: gitDir });
				if (reason) return { block: true, reason };
				// Branch discipline: feature branches live in their worktree — never checked out or created (-b) in the main checkout
				const target = checkoutTarget(g.seg);
				if (target && target.startsWith(featureBranchPrefix(cfg))) {
					const inWorktree = worktrees.some((w) => gitDir === w || gitDir.startsWith(w + path.sep));
					if (!inWorktree) return { block: true, reason: `branch ${target} belongs to a feature worktree, not the main checkout — flow use <slug> and run git inside ${featureBranchPrefix(cfg)}…'s worktree` };
				}
			}
		}
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// One [dev-flow] line per run, whatever number of copies of this package are installed.
		// The same package reaches one runtime twice all the time (a project pin beside the npm install,
		// or this checkout's .pi/extensions pointer beside it) and pi dedupes extensions by file path
		// only, so both copies answer and the line lands twice in the prompt. pi hands every handler of
		// a run the same ctx object, so the first pass claims the run and the rival stays silent.
		const run = ctx as unknown as Record<symbol, boolean | undefined>;
		if (run[CONTEXT_EMITTED]) return undefined;
		run[CONTEXT_EMITTED] = true;
		if (!existsSync(dfDir(ctx.cwd))) return undefined;
		const cfg = loadProject(dfDir(ctx.cwd)).cfg;
		const state = boundFeature(ctx.cwd, sessionKey(ctx));
		if (!state || state.stage === "done") {
			// Default posture for an unbound session in a dev-flow repo (guards make it stick; this makes it understood).
			let content = "[dev-flow] no flow bound. Every request goes through flow. New work: flow start <slug>; unfinished feature: flow use <slug>.";
			const cb = claimBlocker(ctx.cwd, sessionKey(ctx));
			if (cb) content += ` Also: ${cb.state.slug} is claimed by another live session (pid ${cb.claim.pid}) — flow use ${cb.state.slug} takes it over explicitly.`;
			const curBr = await currentBranch(ctx.cwd);
			if (curBr && curBr !== cfg.defaultBranch) content += ` Also: main checkout is on ${curBr}, not ${cfg.defaultBranch} — surface this to the operator before starting work.`;
			const refl0 = readReflections(ctx.cwd);
			if (refl0.length) content += ` Also: ${refl0.length} reflection(s) open — run flow doctor.`;
			const rmap0 = roadmapOpenCount(readRoadmap(ctx.cwd));
			if (rmap0) content += ` Also: ${rmap0} roadmap item(s) open — flow roadmap lists them, flow roadmap pick <n> <slug> hands one to flow start.`;
			return { message: { customType: "dev-flow-context", display: false, content } };
		}
		const guidance: string[] = [];
		if (state.yolo) guidance.push("YOLO mode: the operator pre-confirmed every gate question from here on (Verified?/Release?/Finish?) — run the remaining gates (verify → release → release-done → finish) back to back without stopping to ask; guidance the operator attached to the yolo word (e.g. patch bump, no tag) is a binding directive for the chain; checks and guardrails stay fully enforced.");
		if (cfg.prose[state.stage]) guidance.push(`Stage guidance (project.md): ${cfg.prose[state.stage]}`);
		const pend = checklistPending(cfg, state, state.stage);
		if (pend) guidance.push(`Tier-2 checklist NOT yet confirmed (${pend} item(s)): ${applicableItems(cfg, state, state.stage).map((i) => i.text).join(" | ")}${state.stage === "release" ? " — release-stage items close with the operator's Finish? answer; no earlier gate records them" : ""}`);
		const refl = readReflections(ctx.cwd);
		if (refl.length) guidance.push(`↻ ${refl.length} reflection(s) open — mention to the operator; run flow doctor to review and route them (fold in only on request).`);
		const rmap = roadmapOpenCount(readRoadmap(ctx.cwd));
		if (rmap) guidance.push(`◇ ${rmap} roadmap item(s) open — flow roadmap lists them (pick only on the operator's word).`);
		return {
			message: {
				customType: "dev-flow-context",
				display: false,
				content: `[dev-flow] this session is bound to: ${state.slug}${state.patch ? " (patch)" : state.docs ? " (docs)" : ""} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
${guidance.length ? guidance.join("\n") + "\n" : ""}Rules: follow the dev-flow skill playbook; gates run through the flow tool only — \`flow\` is not a shell command, and the operator answers words in chat, never commands: you run the gate. \`/flow\` is the operator's manual override, not yours. Stage guards block out-of-stage edits and main-branch git ops — do not work around them.`,
			},
		};
	});
}
