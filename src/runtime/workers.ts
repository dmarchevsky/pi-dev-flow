/** dev-flow runtime — Fresh-session workers (flow_stage): transcripts, pi-web metadata, spawning. Moved out of extensions/dev-flow.ts as is (exports added). */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { digestTranscript, sq, featureTmpDir, type SessionHeaderInfo, type WorkerOp } from "../core.ts";
import { dfDir, now, sh } from "./base.ts";

/** Sessions spawned by flow_stage in this process: they get no [dev-flow] driver context injected
 *  (their brief is their whole context) — the guards still judge them like any session. */
export const workerSessions = new Set<string>();

/** Toolset per worker op: an implementer codes, a reviewer reads and runs commands only. */
export const WORKER_TOOLS: Record<WorkerOp, string[]> = { implement: ["read", "bash", "edit", "write"], review: ["read", "bash"], reflect: ["read", "bash"] };

/** Test-only timer override: the smoke suite drives the steer, the hard cut and the salvage grace in ms. */
export const workerTiming: { softMs?: number; hardMs?: number; graceMs?: number } = {};

/** The upstream dev-flow repo's issues in every state, for the reflect brief's dedupe — prefetched so
 *  the worker reads a list instead of looping gh searches. null = gh could not answer (the brief then
 *  falls back to the search recipe). */
export async function upstreamIssueList(root: string, repo: string): Promise<{ number: number; title: string; state: string }[] | null> {
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
export function writeTranscriptDigests(root: string, slug: string, files: string[]): { transcript: string; digest: string }[] {
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
export function sessionHeaders(dir: string | undefined): SessionHeaderInfo[] {
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
export const PIWEB_SUBAGENT = { meta: "pi-web:subagent", status: "pi-web:subagent-status", result: "pi-web:subagent-result" } as const;

export interface WorkerSubagentMeta {
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
export function piwebWorkerMeta(m: WorkerSubagentMeta): Record<string, unknown> {
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
export function piwebStamp(target: { appendCustomEntry?(customType: string, data?: unknown): unknown } | undefined, customType: string, data: unknown): void {
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
export function piwebLiveClaim(sm: { getSessionId?(): string; getSessionFile?(): string | undefined } | undefined, m: WorkerSubagentMeta): (status: string) => void {
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
export function workerName(glyph: string, slug: string, op: string, label: unknown): string {
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
