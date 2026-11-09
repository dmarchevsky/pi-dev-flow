/** dev-flow runtime — Dev deploy, health probes, tier-1 checks and branch facts. Moved out of extensions/dev-flow.ts as is (exports added). */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { freemem } from "node:os";
import path from "node:path";
import { checkFingerprint, DEFAULTS, freshenChecks, healthProbe, listFiles, needsOperator, newestTaggedVersion, parseVersion, sq, validSlug, formatSize, sideBySide, type BranchState, type Config, type DevSlot, type FlowState, type StageCheck } from "../core.ts";
import { loadProject } from "../projectmd.ts";
import { agentText, presentGate, type GateView, type StageFacts } from "../present.ts";
import { atomicWrite, boundFeature, dfDir, featDir, featureEnv, flagValue, gateCwd, initiated, mergeBase, now, originUrl, readState, runHealthProbe, sh, tail, worktreeAbs, writeState } from "./base.ts";
import { type GateCtx } from "./gates.ts";

/** The port this flow's dev deploy uses: the operator's pick for it, else the playbook default. */
export const devPortOf = (state: FlowState, cfg: Config): number | undefined => state.devPort ?? cfg.devPort;

/** featureEnv plus where this flow's dev instance lives: $DEV_FLOW_PORT, $DEV_FLOW_INSTANCE (the slug) and
 *  $DEV_FLOW_SUFFIX — "" on the default port, "-<slug>" on another — for a compose project name or container
 *  prefix that must not collide with the instance already running. */
export function devEnv(root: string, state: FlowState, cfg: Config): Record<string, string> {
	const port = devPortOf(state, cfg);
	const side = state.devPort !== undefined && state.devPort !== cfg.devPort;
	return { ...featureEnv(root, state), ...(port !== undefined ? { DEV_FLOW_PORT: String(port) } : {}), DEV_FLOW_INSTANCE: state.slug, DEV_FLOW_SUFFIX: side ? `-${state.slug}` : "" };
}

// ---------------------------------------------------------------- dev stack registry
// One machine, one dev port, several flows: who deployed last is what decides whether a verify may
// redeploy there or must ask first. Keyed by port ("default" when the playbook names none).
export const devPortsFile = (root: string) => path.join(dfDir(root), "dev-ports.json");
export const slotKey = (port: number | undefined) => (port === undefined ? "default" : String(port));

/** Live slots only: a slot whose flow finished (state.json gone) or was aborted holds nothing. */
export function readDevPorts(root: string): Record<string, DevSlot> {
	let raw: Record<string, DevSlot>;
	try {
		raw = JSON.parse(readFileSync(devPortsFile(root), "utf8")) as Record<string, DevSlot>;
	} catch {
		return {};
	}
	return Object.fromEntries(
		Object.entries(raw).filter(([, v]) => {
			const st = v?.slug ? readState(root, v.slug) : null;
			return !!st && !st.aborted;
		}),
	);
}

export function writeDevPorts(root: string, reg: Record<string, DevSlot>): void {
	atomicWrite(devPortsFile(root), `${JSON.stringify(reg, null, "\t")}\n`);
}

export function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once("error", () => resolve(false));
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
	});
}

export async function nextFreePort(from: number, taken: Set<number>): Promise<number | null> {
	for (let p = from + 1; p < Math.min(from + 50, 65536); p++) if (!taken.has(p) && (await portFree(p))) return p;
	return null;
}

/** MemAvailable (what a new process can really get) where Linux reports it, else the OS free figure. */
export function memAvailable(): number | null {
	try {
		const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s*kB/m);
		if (m) return Number(m[1]) * 1024;
	} catch {
		/* not Linux */
	}
	const f = freemem();
	return Number.isFinite(f) ? f : null;
}

export function diskFreeAt(dir: string): number | null {
	try {
		const st = statfsSync(dir);
		return Number(st.bavail) * Number(st.bsize);
	} catch {
		return null;
	}
}

export function ago(iso: string): string {
	const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(min)) return "at an unknown time";
	return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

export const portLabel = (port: number | undefined) => (port === undefined ? "the dev stack" : `port ${port}`);

/** Before a verify deploys: is the stack it would replace held by another live flow? Applies the
 *  operator's `--port=<n>` / `--replace` answer, or asks — with the measured resources — which to do. */
export async function devSlotCheck(o: GateCtx, state: FlowState): Promise<RunResult | { note: string }> {
	const { root, cfg, flag, rest } = o;
	const portArg = flagValue(rest, "port");
	if (portArg !== null) {
		const n = Number(portArg);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return { text: `--port=${portArg} is not a port`, isError: true };
		if (cfg.devPort === undefined) return { text: "--port needs a default `port` in the playbook's ## implement flow block — dev-flow exports the chosen one to dev/health as $DEV_FLOW_PORT", isError: true };
		if (n === cfg.devPort) delete state.devPort;
		else state.devPort = n;
		writeState(root, state);
	}
	const port = devPortOf(state, cfg);
	const reg = readDevPorts(root);
	const slot = reg[slotKey(port)];
	if (!slot || slot.slug === state.slug) return { note: "" };
	if (flag("replace")) return { note: `dev: replaced ${slot.slug}'s deploy on ${portLabel(port)} (operator's answer)` };
	const other = readState(root, slot.slug);
	const taken = new Set(Object.keys(reg).map(Number).filter(Number.isFinite));
	const nextPort = port !== undefined ? await nextFreePort(port, taken) : null;
	const mem = memAvailable();
	const disk = diskFreeAt(root);
	const side = sideBySide({ cfg, nextPort, memAvail: mem, diskFree: disk });
	const res = [
		`RAM available ${mem !== null ? formatSize(mem) : "unknown"}${cfg.instanceMem !== undefined ? ` (one instance needs ${formatSize(cfg.instanceMem)})` : ""}`,
		`disk free ${disk !== null ? formatSize(disk) : "unknown"}${cfg.instanceDisk !== undefined ? ` (one instance needs ${formatSize(cfg.instanceDisk)})` : ""}`,
	].join(", ");
	const caveat = side.ok
		? cfg.parallelDev === undefined
			? " The playbook does not say whether two instances can share this machine (parallelDev = yes|no) — tell the operator that when you ask."
			: ""
		: ` Running alongside is not offered: ${side.why.join("; ")}.`;
	const opts = [
		...(side.ok ? [`run alongside on port ${nextPort}: flow verify --port=${nextPort}`] : []),
		`replace ${slot.slug}'s deploy: flow verify --replace`,
		`wait until ${slot.slug} is done with it`,
	];
	const held = `${portLabel(port)} is serving ${slot.slug} (stage ${other?.stage ?? "?"}${other?.pendingAsk ? `, waiting on ${other.pendingAsk}` : ""}, ${slot.head.slice(0, 7)}, deployed ${ago(slot.at)})`;
	return { text: needsOperator(`${held} — this verify would replace it. Resources: ${res}.${caveat} Ask the operator which: ${opts.join(" | ")} — nothing was built or deployed yet.`, "Dev port?"), isError: true };
}

/** Before a review deploy: bring the branch up to date with the default branch, so the operator reviews
 *  the tree that will ship. Rebases a clean branch that is behind; refuses on a conflict (aborted, branch
 *  untouched) or on uncommitted work. With the operator's answer in hand (--confirmed) it never rewrites
 *  history: a default branch that moved since the review deploy sends the flow back to `flow verify`. */
export async function catchUp(root: string, state: FlowState, cfg: Config, confirmed: boolean): Promise<RunResult | { note: string }> {
	const cwd = gateCwd(root, state);
	if (cwd === root) return { note: "" };
	const d = cfg.defaultBranch;
	const hasOrigin = !!(await originUrl(root));
	let fetchNote = "";
	if (hasOrigin && !(await sh(`git fetch -q origin ${sq(d)}`, cwd, 60_000)).ok) fetchNote = ` (fetch of origin/${d} failed — compared with the last fetched state)`;
	const base = hasOrigin && (await sh(`git rev-parse --verify -q ${sq(`refs/remotes/origin/${d}`)}`, cwd)).ok ? `origin/${d}` : d;
	const r = await sh(`git rev-list --count HEAD..${sq(base)}`, cwd);
	const behind = Number.parseInt(r.out.trim(), 10);
	if (!r.ok || !Number.isFinite(behind)) return { note: `behind ${base}: unknown${fetchNote}` };
	if (behind === 0) return { note: fetchNote ? `up to date with ${base}${fetchNote}` : "" };
	if (confirmed)
		return { text: `verify gate FAILED:\n- ${base} moved ${behind} commit(s) past this branch — the operator's answer would cover a tree that is not the one that ships. Run flow verify (it rebases and redeploys for review), then ask Verified? again`, isError: true };
	// untracked build output (a deploy's artifacts) does not stop a rebase; uncommitted tracked edits do
	const dirty = await sh("git status --porcelain --untracked-files=no", cwd);
	if (dirty.ok && dirty.out.trim()) return { text: `verify gate FAILED:\n- the branch is ${behind} commit(s) behind ${base} and has uncommitted changes — commit them, then re-run flow verify (it rebases before the review deploy)`, isError: true };
	const rb = await sh(`git rebase ${sq(base)}`, cwd, 120_000);
	if (!rb.ok) {
		const conflicts = (await sh("git diff --name-only --diff-filter=U", cwd)).out.split("\n").filter(Boolean);
		await sh("git rebase --abort", cwd);
		return { text: `verify gate FAILED:\n- the branch is ${behind} commit(s) behind ${base} and the rebase stopped on conflicts${conflicts.length ? ` (${conflicts.join(", ")})` : ""} — aborted, the branch is as it was. Rebase by hand in ${state.worktree} (git rebase ${base}), resolve, then re-run flow verify\n${tail(rb.out)}`, isError: true };
	}
	const pushed = hasOrigin && state.branch && (await sh(`git rev-parse --verify -q ${sq(`refs/remotes/origin/${state.branch}`)}`, cwd)).ok;
	return { note: `rebased onto ${base} (was ${behind} commit(s) behind)${fetchNote}${pushed ? ` — origin/${state.branch} now differs: the next push needs --force-with-lease (dev-flow asks the operator)` : ""}` };
}

/** Tier-1 checks the gate still has to see green. Entering a stage — and every edit of the worktree —
 * clears the records, so "run flow check first" cost three round trips to say what one could (#84).
 * `health` is left to the post-deploy probe when there is a deploy to prove: probing twice only waits twice. */
export function pendingChecks(state: FlowState, cfg: Config): StageCheck[] {
	if (state.docs) return [];
	return cfg.checkList.filter((c) => !state.checks[c.name]?.ok && !(c.name === "health" && healthRerunsAfterDeploy(cfg)));
}

/** Run tier-1 checks in the feature cwd and record each result (health seeds first, as `flow health` does). */
export async function runChecks(root: string, state: FlowState, cfg: Config, checks: StageCheck[]): Promise<{ lines: string[]; failed: boolean }> {
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
export const healthRerunsAfterDeploy = (cfg: Config) => !!cfg.commands.dev && !!healthProbe(cfg);

/** Seed pre-existing data before a health probe, recording the step (`flow health` and the verify
 *  deploy probe both do this). Returns an error result on failure, null when seeded or not configured. */
export async function seedStep(root: string, state: FlowState, cfg: Config): Promise<{ text: string; isError: true } | null> {
	if (!cfg.commands.seedData) return null;
	const seed = await sh(cfg.commands.seedData, gateCwd(root, state), undefined, devEnv(root, state, cfg));
	state.checks.seedData = { ok: seed.ok, at: now() };
	writeState(root, state);
	return seed.ok ? null : { text: `seedData FAILED (${cfg.commands.seedData}):\n${tail(seed.out)}`, isError: true };
}

export type HealthRun = { ok: boolean; out: string; attempts: number } | { seedFail: RunResult };

/** Seed (when configured), then run the health probe within the playbook's wait budget. */
export async function seededProbe(root: string, state: FlowState, cfg: Config, probe: string): Promise<HealthRun> {
	const seedFail = await seedStep(root, state, cfg);
	return seedFail ? { seedFail } : runHealthProbe(probe, gateCwd(root, state), cfg.healthWait, devEnv(root, state, cfg));
}

/** seededProbe, recorded and stamped as the `health` check — `flow health` and both verify probes. */
export async function probeHealth(root: string, state: FlowState, cfg: Config, probe: string): Promise<HealthRun> {
	const res = await seededProbe(root, state, cfg, probe);
	if ("seedFail" in res) return res;
	state.checks.health = { ok: res.ok, at: now() };
	await stampChecks(root, state, ["health"]);
	writeState(root, state);
	return res;
}

/** A probe that needed the wait budget says so — "it passed on the 9th try" is the operator's business (#42). */
export const triedNote = (attempts: number) => (attempts > 1 ? `, ${attempts} attempts` : "");

/** Fingerprint of the working-tree state the checks ran against: paths (`status --porcelain`),
 *  tracked content (a hash of the uncommitted diff) and HEAD. Null when git cannot answer — a
 *  measurement failure must never mark a green record stale (see freshenChecks). */
export async function worktreeFingerprint(cwd: string): Promise<string | null> {
	const st = await sh("git status --porcelain", cwd);
	if (!st.ok) return null;
	const diff = await sh("git diff HEAD --no-color | git hash-object --stdin", cwd);
	const head = await sh("git rev-parse HEAD", cwd);
	if (!diff.ok || !head.ok) return null;
	return checkFingerprint(`${st.out}\n${diff.out}`, head.out);
}

/** Stamp freshly recorded checks with the tree they ran against — taken AFTER the run, so a check
 *  that rewrites tracked files (a formatter, codegen) does not mark itself stale the moment it passes. */
export async function stampChecks(root: string, state: FlowState, names: string[]): Promise<void> {
	const fp = await worktreeFingerprint(gateCwd(root, state));
	if (!fp) return;
	for (const n of names) if (state.checks[n]) state.checks[n].wt = fp;
}

/** Commits the feature branch holds over its merge base with the default branch, plus how many
 *  paths sit uncommitted: verify's proof that there is a committed state behind the operator's
 *  question. Local refs only — same offline-safe stance as the changelog proof — and an
 *  unanswerable merge base reports null instead of refusing on a measurement failure. */
export async function branchState(cwd: string, defaultBranch: string): Promise<BranchState> {
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
export async function unreleasedOnMain(cwd: string, pattern: string): Promise<{ count: number | null; since: string | null }> {
	const tags = await sh("git tag --list", cwd);
	const newest = tags.ok ? newestTaggedVersion(pattern, tags.out.split("\n").map((t) => t.trim()).filter(Boolean)) : null;
	const since = newest ? pattern.replace("{version}", newest) : null;
	const r = await sh(since ? `git rev-list --count ${sq(since)}..HEAD` : "git rev-list --count HEAD", cwd);
	const n = Number.parseInt(r.out.trim(), 10);
	return { count: r.ok && Number.isFinite(n) ? n : null, since };
}

/** Gates whose result carries the feature's stage line (the rest answer about the repo, not one feature). */
export const STAGE_LINE_GATES = new Set(["start", "use", "approve", "check", "test", "verify", "release", "release-done", "finish"]);

/** Cheap facts for the stage line: the plan file and mockups at plan, commit counts and HEAD once a
 *  worktree exists, the manifest version at pre-release. Measurement failures leave a field out. */
export async function stageFacts(root: string, state: FlowState, cfg: Config): Promise<StageFacts> {
	const f: StageFacts = {};
	if (state.stage === "plan") {
		const planDir = path.join(featDir(root, state.slug), "plan");
		const planMd = path.join(planDir, "plan.md");
		f.plan = existsSync(planMd) ? (/\bdraft\b/i.test(readFileSync(planMd, "utf8").slice(0, 400)) ? "draft" : "written") : "missing";
		if (state.ui) {
			const files = listFiles(planDir);
			const html = files.filter((x) => x.startsWith("mockups/") && x.endsWith(".html"));
			const rendered = html.filter((h) => files.some((x) => x.startsWith(h.replace(/\.html$/, "-")) && x.endsWith(".png"))).length;
			f.mockups = { rendered, total: html.length };
		}
		return f;
	}
	const wt = worktreeAbs(root, state);
	if (wt && existsSync(wt) && (state.stage === "implement" || state.stage === "pre-release")) {
		const b = await branchState(wt, cfg.defaultBranch);
		if (b.commitsAhead !== null) {
			f.ahead = b.commitsAhead;
			f.uncommitted = b.uncommitted;
		}
		const head = await sh("git rev-parse HEAD", wt, 10_000);
		if (head.ok) f.head = head.out.trim();
		if (state.stage === "pre-release" && cfg.versioning.file && existsSync(path.join(wt, cfg.versioning.file))) {
			try {
				f.manifest = parseVersion(cfg.versioning.file, readFileSync(path.join(wt, cfg.versioning.file), "utf8"));
			} catch {
				/* the version field stays pending */
			}
		}
	}
	return f;
}

/** A gate result as both readers need it: the agent's text (with its stage line) and the operator's view. */
export async function presentRun(args: string[], root: string, key: string, res: RunResult): Promise<{ agent: string; view: GateView }> {
	const sub = args[0] ?? "status";
	const cfg = initiated(root) ? loadProject(dfDir(root)).cfg : DEFAULTS;
	let state: FlowState | null = null;
	if (STAGE_LINE_GATES.has(sub) && initiated(root)) {
		const slugArg = args.slice(1).find((a) => !a.startsWith("--"));
		state = boundFeature(root, key) ?? (slugArg && validSlug(slugArg) ? readState(root, slugArg) : null);
	}
	let facts: StageFacts | undefined;
	try {
		facts = state ? await stageFacts(root, state, cfg) : undefined;
	} catch {
		facts = undefined;
	}
	const view = presentGate(sub, res.text, !!res.isError, state, cfg, facts);
	return { agent: agentText(res.text, view), view };
}

export function describeBranchState(b: BranchState, defaultBranch: string): string {
	if (b.commitsAhead === null) return `commits: unknown (no merge base with ${defaultBranch} — the commit proof is skipped)`;
	const line = `commits: ${b.commitsAhead} ahead of ${defaultBranch}, ${b.uncommitted} uncommitted path(s)`;
	return b.commitsAhead === 0 && (b.unreleased?.count ?? 0) > 0
		? `${line} — release-only flow: ${b.unreleased!.count} unreleased commit(s) on ${defaultBranch}${b.unreleased!.since ? ` since ${b.unreleased!.since}` : " (nothing tagged yet)"}; verify proves that tree, the version bump is the pre-release commit`
		: line;
}

// ---------------------------------------------------------------- gate runner

export interface RunResult {
	text: string;
	isError?: boolean;
}

export interface Session {
	slug: string | null;
	key: string;
	bind: (slug: string | null) => void;
	/** Name the pi session after a slug (one session = one feature: the picker shows the feature). */
	rename: (slug: string) => void;
}
