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
 * The stage logic lives in src/core.ts (unit-tested), the runtime in src/runtime/; this file is pi wiring.
 * Inactive (fully pass-through) in repos without a .dev-flow/ directory.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { compact, defineTool, isToolCallEventType, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI, type ToolCallEvent, type ToolCallEventResult, type TurnEndEvent, type TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { ALLOW_REWRITE, applicableItems, openItemsNote, bashFlowGuard, checklistPending, checkoutInvocation, claimBlocks, featureBranchPrefix, FLOW_SHELL_HINT, flowShellInvocation, forcePushInvocation, freshenChecks, gitInvocation, guardBash, guardPath, mergeStyleInvocation, parsePushRefs, playbookTamper, playbookOnlyChange, pluginVersion, reflectionNudges, buildReflectBrief, parseReflectReport, renderReflectFindings, childSessionFiles, workerSteer, WORKER_STEER_AT, WORKER_SALVAGE, WORKER_SALVAGE_MS, WORKER_NUDGE_READONLY, stageReference, needsOperator, NEEDS_OPERATOR, nextHint, roadmapOpenCount, shouldTakeOverCompaction, stageGuidance, stateTamper, statusFor, sq, featureTmpDir, compactionStateBlock, withTmpDir, widgetLines, chipLabel, writeGuard, buildWorkerBrief, clampBudgetMin, parseWorkerReport, workerTurnError, hollowStop, hollowStopNote, workerOpError, WORKER_NUDGE, WORKER_NUDGES, releaseOrderInvocation, type WorkerOp, type FlowState, type PushRef } from "../src/core.ts";
import { loadProject } from "../src/projectmd.ts";
import { bashTimeout, requireTimeout, timeoutClass } from "../src/timeouts.ts";
import { AGENT_MARK, operatorCommandAsks, operatorCommandCorrection, viewHeader, askLine, type GateView } from "../src/present.ts";
import { Text } from "@earendil-works/pi-tui";
import { CONTEXT_EMITTED, COPIES, GATE_HELP, SELF_BUILD, SKILL_DIR, type Ui, WEB_CHIP_KEYS, LEGACY_CHIP_KEYS, nextChipKeys, baseSeams, bindings, boundFeature, claimBlocker, claimFile, compacting, compactionTakeover, coreInjected, coreStale, currentBranch, dfDir, featDir, featureRefs, flowCompactInstructions, flowRoot, guardsAreMine, initiated, lastContext, loadedVersion, maybeCompactNow, noteFriction, now, readClaim, readReflections, readReflectionsText, readRoadmap, readState, registerCopy, releaseSession, sessionKey, sh, skillCore, unfinishedStates, worktreeAbs, writeClaim, writeState } from "../src/runtime/base.ts";
import { type Session, presentRun } from "../src/runtime/checks.ts";
import { isSelfRepo } from "../src/runtime/setup.ts";
import { foldView, pluginUpstream } from "../src/runtime/reflect.ts";
import { type FlowHooks, runFlow } from "../src/runtime/gates.ts";
import { grantCheck, grantRecord, newGrantLedger, operatorMessageCount } from "../src/runtime/grants.ts";
import { PIWEB_SUBAGENT, WORKER_TOOLS, piwebLiveClaim, piwebStamp, piwebWorkerMeta, reflectSeams, sessionHeaders, stageWorkerSpawn, workerName, workerSessions, workerTiming, writeTranscriptDigests } from "../src/runtime/workers.ts";
export { compactionTakeover } from "../src/runtime/base.ts";
export { reflectSeams, stageWorkerSpawn, workerTiming } from "../src/runtime/workers.ts";

/** Test seam: the smoke suite cannot load a second copy of this module, so it plants registry
 * entries and asserts the warnings the real duplicate would print. */
export const testSeams = { ...baseSeams, piweb: { meta: piwebWorkerMeta, stamp: piwebStamp, liveClaim: piwebLiveClaim, workerName } };

/** Compact footer: bound flow = stage glyph, slug, mode markers, ⚠️ on its failing checks; unbound = the
 *  unfinished-flow count, or `💬 no flows` — an initiated repo always carries the footer. An uninitiated
 *  folder gets nothing: the status is cleared. In pi-web the footer text is not clickable, so there the
 *  footer IS a widget: one chip labelled with the footer text whose panel lists every open flow, one lean
 *  line each (no lines → a plain, non-expandable chip). Pure read — rendering never binds or claims anything. */
function refreshStatus(ctx: ExtensionContext, root: string): void {
	if (!ctx.hasUI) return;
	const web = ctx.mode !== "tui";
	const sk = sessionKey(ctx);
	// Old keys are cleared on EVERY repaint, not once — a clear the browser missed while its event stream
	// was down (pi-web never re-syncs widgets on reconnect) is re-sent until the history ages it out.
	const setChip = (key: string | undefined, lines?: string[]) => {
		let prev = WEB_CHIP_KEYS.get(sk);
		if (prev === undefined) {
			const legacy = LEGACY_CHIP_KEYS?.get(sk);
			LEGACY_CHIP_KEYS?.delete(sk);
			prev = legacy === undefined ? [] : [legacy];
		}
		const next = nextChipKeys(prev, key);
		for (const k of next.clear) ctx.ui.setWidget(k, undefined);
		if (next.keys.length) WEB_CHIP_KEYS.set(sk, next.keys);
		else WEB_CHIP_KEYS.delete(sk);
		if (key !== undefined) ctx.ui.setWidget(key, lines);
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

/** What a kill by dev-flow's own timeout tells the agent (and the operator reading the transcript). */
export function timeoutKillNote(armed: { s: number; cls: string }): string {
	const why = armed.cls.startsWith("its own timeout")
		? `the command's ${armed.cls.replace(/^its own /, "")} plus a 15s margin — it outlived its own timer`
		: `dev-flow's default for ${armed.cls} commands, armed because the call stated no timeout`;
	return `[dev-flow] stopped at ${armed.s}s: ${why}. If it needs longer, rerun with an explicit timeout (seconds) on the call.`;
}

export default function devFlow(pi: ExtensionAPI) {
	registerCopy(); // which copy of dev-flow this is — see COPIES
	/** Parse "flow <sub> [slug] [--flags]" args shared by command and tool. */
	const parse = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.map(String);
		return String(input ?? "").trim().split(/\s+/).filter(Boolean);
	};

	const NO_DIALOGS: Ui = { hasUI: false, confirm: async () => false };
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

	/** Which gate asked for the operator's word, and when features started — per session (gh#190). */
	const grantLedger = newGrantLedger();

	/** A flow_stage worker: registered in this module's set, or — for a worker pi-web hosts, whose extension
	 *  instance never saw the registration — stamped with pi-web's subagent entry. */
	const isWorkerSession = (ctx: ExtensionContext): boolean => {
		try {
			if (workerSessions.has(ctx.sessionManager.getSessionId())) return true;
			// SAFETY: narrow structural view of the SessionEntry union; only the custom entry's type is read
			return (ctx.sessionManager?.getBranch() ?? []).some((e) => {
				const ce = e as unknown as { type: string; customType?: string };
				return ce.type === "custom" && ce.customType === PIWEB_SUBAGENT.meta;
			});
		} catch {
			return false;
		}
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
		lastContext.delete(key); // a restored branch may not hold the last note — hand the next run the full one
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
			// the operator typed a command, so the full text (commands included) is theirs to read; the header and
			// stage line give it the same shape as an agent-run gate
			const { view } = await presentRun(cmd, root, sessionKey(ctx), res);
			const shown = [`**${viewHeader(view)}**`, ...(view.stageLine ? [view.stageLine] : []), "", res.text.split("\n").map((l) => (l.startsWith(AGENT_MARK) ? l.slice(AGENT_MARK.length) : l)).join("\n")].join("\n");
			pi.sendMessage({ customType: "flow", content: wake ? res.text : shown, display: true }, wake ? { triggerTurn: true } : undefined);
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
			// the agent's call never opens a dialog (#181): a dialog inside a tool call blocks the turn, so nobody
			// can talk to the agent while it waits, and the agent cannot see who answered. Gates answer with the
			// chat word to ask instead; the /flow slash command (a human at the keyboard) keeps its dialogs.
			// gh#190: --confirmed stands for the operator's chat answer — refuse it when no operator message came after the question
			const users = operatorMessageCount((() => { try { return ctx.sessionManager?.getBranch(); } catch { return null; } })());
			const selfGrant = grantCheck(params.args, sessionKey(ctx), users, grantLedger);
			const res = selfGrant ? { text: selfGrant, isError: true } : await runFlow(params.args, root, NO_DIALOGS, sessFor(ctx, root), finishReflectHook(id, ctx, root, signal, onUpdate));
			grantRecord(params.args, sessionKey(ctx), users, res, grantLedger);
			if (!res.isError) maybeCompactNow(ctx, root);
			// two readers: the model gets every instruction, the operator's row renders the view (renderResult) —
			// facts, the stage line and the question waiting on them, never a command to type
			// a refusal (not a question for the operator) is friction the closing reflection should look at
			if (res.isError && (!res.text.startsWith(NEEDS_OPERATOR) || selfGrant) && initiated(root)) noteFriction(root, sessionKey(ctx));
			// a start that bound a feature takes over the refusals this session hit before it existed
			else if (!res.isError && params.args[0] === "start" && initiated(root)) noteFriction(root, sessionKey(ctx), 0);
			const { agent, view } = await presentRun(params.args, root, sessionKey(ctx), res);
			return { content: [{ type: "text", text: agent }], details: { view }, isError: res.isError };
		},
		renderResult: (result, options, theme) => {
			const view = (result.details as { view?: GateView } | undefined)?.view;
			if (!view) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const color = view.ask ? "warning" : view.ok ? "success" : "error";
			const out = [theme.fg(color, theme.bold(viewHeader(view)))];
			if (view.stageLine) out.push(theme.fg("muted", view.stageLine.replace(/\*\*/g, "").replace(/`/g, "")));
			const body = options.expanded ? view.lines : view.lines.slice(0, 12);
			if (body.length) out.push(...body.map((l) => theme.fg("text", l)));
			if (!options.expanded && view.lines.length > body.length) out.push(theme.fg("dim", `… ${view.lines.length - body.length} more line(s)`));
			if (view.ask) out.push(theme.fg("warning", askLine(view.ask).replace(/\*\*/g, "")));
			if (options.expanded && view.agent.length) out.push(...view.agent.map((l) => theme.fg("dim", `agent: ${l}`)));
			return new Text(out.join("\n"), 0, 0);
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
						preamble: cfg.workerPreamble,
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
		hollowStreak.delete(sessionKey(ctx));
		if (!guardsAreMine()) return;
		const root = await flowRoot(ctx.cwd);
		if (!existsSync(dfDir(root))) return;
		releaseSession(root, sessionKey(ctx));
	});
	pi.on("turn_end", async (event, ctx) => {
		if (!guardsAreMine()) return;
		const root = await flowRoot(ctx.cwd);
		refreshStatus(ctx, root);
		// pi checks its compaction threshold between every turn; our safe points must be as frequent.
		maybeCompactNow(ctx, root);
		return commandAskCorrection(event, ctx, root) ?? hollowStopResume(event, ctx, root);
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
		lastContext.delete(sessionKey(ctx));
		pi.appendEntry("dev-flow-skill", { core: true, stale: true });
	});

	// A bash call every guard let through runs with TMPDIR in its bound feature's scratch dir
	// (.dev-flow/<slug>/tmp/): mktemp, os.tmpdir() and test fixtures land there and flow finish removes
	// them. Prefixed only after the verdict, so no guard ever judges the prefix.
	pi.on("tool_call", async (event, ctx) => {
		const verdict = await guardToolCall(event, ctx);
		// a guard block is friction the closing reflection should look at
		if (verdict?.block && guardsAreMine() && initiated(ctx.cwd)) noteFriction(await flowRoot(ctx.cwd), sessionKey(ctx));
		if (verdict || !isToolCallEventType("bash", event) || !guardsAreMine() || !initiated(ctx.cwd)) return verdict;
		const root = await flowRoot(ctx.cwd);
		const bound = boundFeature(root, sessionKey(ctx));
		if (!bound) return undefined;
		const dir = featureTmpDir(dfDir(root), bound.slug);
		mkdirSync(dir, { recursive: true });
		event.input.command = withTmpDir(String(event.input.command ?? ""), dir);
		return undefined;
	});

	// A kill by dev-flow's silent default must say so: the transcript shows the call without a timeout, so
	// "Command timed out after 30 seconds" otherwise reads like pi misbehaving, and the agent cannot tell a
	// policy cap from a hang. Keyed by tool call id; a call blocked before it ran never reports, so the map
	// is bounded rather than trusted to drain.
	const armedTimeouts = new Map<string, { s: number; cls: string }>();
	const rememberArmed = (id: string, v: { s: number; cls: string }) => {
		armedTimeouts.set(id, v);
		if (armedTimeouts.size > 500) armedTimeouts.delete(armedTimeouts.keys().next().value as string);
	};
	pi.on("tool_result", async (event) => {
		const armed = armedTimeouts.get(event.toolCallId);
		if (!armed) return undefined;
		armedTimeouts.delete(event.toolCallId);
		if (!event.isError) return undefined;
		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const m = text.match(/timed out after (\d+) seconds/);
		if (!m || Number(m[1]) !== armed.s) return undefined;
		return { content: [...event.content, { type: "text" as const, text: `\n${timeoutKillNote(armed)}` }] };
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
		if (shellCmd && shellInput && !noDf) {
			// the e2e test shortens only the silent default — an explicit timeout is never touched
			const cls = explicitTimeout === undefined && testSeams.bashTimeout.cap !== undefined ? { ...timeoutClass(shellCmd), s: testSeams.bashTimeout.cap } : timeoutClass(shellCmd);
			shellInput.timeout = explicitTimeout === undefined ? cls.s : bashTimeout(shellCmd, explicitTimeout);
			// the armed value never reaches the transcript (the call records what the model wrote), so a kill
			// by it would read as a mystery hang — remember it, and the tool_result hook names it on a kill
			if (explicitTimeout === undefined) rememberArmed(event.toolCallId, cls);
		}
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

	/** The model's final answer handed the operator a dev-flow command to type: the operator answers in
	 *  words, so the next run carries a hidden correction. It never re-runs the turn (no continue) — the
	 *  answer already reached the operator; the point is that the next one does not repeat it. */
	const commandAskCorrection = (event: TurnEndEvent, ctx: ExtensionContext, root: string): TurnEndEventResult | undefined => {
		const e = event as { outcome?: string; toolResults?: unknown[]; message?: { role?: string; content?: unknown }; entries?: unknown[] };
		if (!initiated(root) || e.outcome !== "completed" || (e.toolResults?.length ?? 0) > 0 || e.message?.role !== "assistant") return undefined;
		if (isWorkerSession(ctx)) return undefined;
		const parts = Array.isArray(e.message.content) ? (e.message.content as { type?: string; text?: string }[]) : [];
		const text = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
		const hits = operatorCommandAsks(text);
		if (!hits.length) return undefined;
		// SAFETY: a custom_message draft is one of the documented boundary entry types; the draft union is not re-exported
		return { entries: [...event.entries, { type: "custom_message", customType: "dev-flow-correction", content: operatorCommandCorrection(hits), display: false } as unknown as TurnEndEvent["entries"][number]] };
	};

	/** Hollow stops in a row per session: one resume, then stop resuming so a broken model cannot loop. */
	const hollowStreak = new Map<string, number>();

	/** The model ended its reply as a normal stop with no answer and no tool call (a provider that closed the
	 *  stream inside the reasoning). pi would go idle and a bound flow would sit mid-stage with nothing for the
	 *  operator to answer, so dev-flow appends a visible note and asks pi for one more request. Only when a flow
	 *  is bound in this session and it is not a stage worker (workers have their own nudge loop). */
	const hollowStopResume = (event: TurnEndEvent, ctx: ExtensionContext, root: string): TurnEndEventResult | undefined => {
		const e = event as { outcome?: string; toolResults?: unknown[]; message?: unknown };
		const key = sessionKey(ctx);
		const hollow = e.outcome === "completed" && (e.toolResults?.length ?? 0) === 0 ? hollowStop(e.message) : null;
		if (!hollow) {
			hollowStreak.delete(key);
			return undefined;
		}
		if (!initiated(root) || !boundFeature(root, key)) return undefined;
		if (isWorkerSession(ctx)) return undefined;
		const streak = (hollowStreak.get(key) ?? 0) + 1;
		hollowStreak.set(key, streak);
		const resume = streak === 1;
		const content = resume ? hollowStopNote(hollow) : "[dev-flow] The model ended with no answer again after one resume, so dev-flow stopped resuming. Say continue to retry, or check the provider.";
		// SAFETY: a custom_message draft is one of the documented boundary entry types; the draft union is not re-exported
		const entry = { type: "custom_message", customType: "dev-flow-resume", content, display: true } as unknown as TurnEndEvent["entries"][number];
		return resume ? { entries: [...event.entries, entry], continue: true } : { entries: [...event.entries, entry] };
	};

	/** The full note when it changed (or the core was just re-sent), else the one-line reminder. */
	const sameAsLast = (key: string, full: string, short: string): string => {
		if (lastContext.get(key) === full) return short;
		lastContext.set(key, full);
		return full;
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!guardsAreMine()) return undefined;
		hollowStreak.delete(sessionKey(ctx)); // a new prompt earns a fresh resume
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
			return { message: { customType: "dev-flow-context", display: false, content: `${core}${sameAsLast(key, content, `[dev-flow] no flow bound — unchanged since the last [dev-flow] note (playbook map is ${path.join(SKILL_DIR, "SKILL.md")}).`)}` } };
		}
		const guidance: string[] = [];
		if (state.yolo) guidance.push("YOLO mode: the operator pre-confirmed every gate question from here on (Verified?/Release?/Finish?) — run the remaining gates (verify → release → release-done → finish) back to back without stopping to ask; guidance the operator attached to the yolo word (e.g. patch bump, no tag) is a binding directive for the chain; checks and guardrails stay fully enforced.");
		// The one playbook file this stage needs, named outright: the model reads it instead of
		// guessing what a stage asks of it, and it pays for itself the first time a gate is refused.
		const ref = stageReference(state.stage);
		if (ref) guidance.push(`Stage playbook: read ${path.join(SKILL_DIR, ref)} before gate work in this stage.`);
		const prose = stageGuidance(cfg, state.stage);
		if (prose) guidance.push(`Stage guidance (${prose.source}): ${prose.text}`);
		guidance.push("Stage reports: open with the stage line the last gate returned, pasted as is; a checkpoint closes with `Done:` / `Next steps:` (see the ground rules).");
		const pend = checklistPending(cfg, state, state.stage);
		if (pend) guidance.push(`Tier-2 checklist NOT yet confirmed — ${openItemsNote(cfg, state, state.stage)}${state.stage === "release" ? " — release-stage items close with the operator's Finish? answer; no earlier gate records them" : ""}`);
		// mid-feature is the wrong moment to divert into old reflections — they surface at the release
		// stage (finish runs the reflection), between flows, and in status/doctor
		if (state.stage === "release") {
			const refl = readReflections(root);
			if (refl.length) guidance.push(`↻ ${refl.length} reflection(s) open — flow finish runs the closing reflection over them before cleanup; fix them only on the operator's word.`);
		}
		const rmap = roadmapOpenCount(readRoadmap(root));
		if (rmap) guidance.push(`◇ ${rmap} roadmap item(s) open — flow roadmap lists them (pick only on the operator's word).`);
		const stageNote = `[dev-flow] this session is bound to: ${state.slug}${state.patch ? " (patch)" : state.docs ? " (docs)" : ""} — stage: ${state.stage}${state.ui ? " (UI)" : ""}${state.worktree ? `, worktree: ${state.worktree} (branch ${state.branch})` : ""}.
Next: ${nextHint(state, cfg)}.
${guidance.length ? guidance.join("\n") + "\n" : ""}Rules: gates run through the flow tool only; the operator answers words in chat — never ask them to type a flow command.`;
		const short = `[dev-flow] still bound to ${state.slug} at ${state.stage} — unchanged since the last [dev-flow] note; follow it.`;
		return { message: { customType: "dev-flow-context", display: false, content: `${core}${sameAsLast(key, stageNote, short)}` } };
	});
}
