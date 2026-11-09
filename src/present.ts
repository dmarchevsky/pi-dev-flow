/**
 * Presentation: how a gate's result reaches the two readers it has.
 *
 * Every gate returns one text written for the agent — what happened, what is missing, what to run next.
 * The operator sees the same result in the transcript, and raw agent instructions ("ask the operator
 * Verified? and run flow verify --confirmed") are exactly what made sessions read as "please type this
 * command". So the result is split:
 *
 *  - the **user view**: a header, the stage line, the facts, and the one question waiting on the operator
 *    — never a flow command (the smoke suite asserts this for every gate it drives);
 *  - the **agent part**: every instruction, untouched, still in the tool result the model reads.
 *
 * Gates mark agent-only lines with `↪ `; anything else that names a flow command is split clause by clause,
 * so a refusal like "test has not passed — run flow check" shows the operator "test has not passed".
 *
 * The stage line is written here, from state, so it is the same every time — the model pastes it instead of
 * rebuilding glyphs and provenance marks from memory.
 */
import { AGENT_MARK, applicableItems, checklistPending, NEEDS_OPERATOR, STAGE_EMOJI, type Config, type FlowState } from "./core.ts";

export { AGENT_MARK };

const FLOW_VERBS = "start|use|approve|verify|check|test|release-done|release|finish|abort|init|doctor|reflect|roadmap|status|version|help";

/** Text that tells someone to run dev-flow machinery: a flow verb, a gate flag, the worker tool, the slash command. */
export const OPERATOR_COMMAND_RE = new RegExp(`(?:^|[\\s\`'"(*_])/?flow (?:${FLOW_VERBS})\\b|(?:^|\\s)--[a-z][a-z-]*\\b|\\bflow_stage\\b|(?:^|\\s)/flow\\b`);

export const commandish = (s: string): boolean => OPERATOR_COMMAND_RE.test(s);

/** Clause separators that keep a refusal's fact apart from its instruction. */
const CLAUSE_SPLIT = /(\s+—\s+|;\s+|(?<=[.!?])\s+(?=[A-Z`(])|,\s+then\s+|\s+\(or\s+)/;

/** One gate line → the part the operator should read and the clauses only the agent needs. */
export function splitLine(line: string): { user: string; agent: string[] } {
	if (line.startsWith(AGENT_MARK)) return { user: "", agent: [line.slice(AGENT_MARK.length)] };
	if (!commandish(line)) return { user: line, agent: [] };
	const parts = line.split(CLAUSE_SPLIT);
	const agent: string[] = [];
	let user = "";
	for (let i = 0; i < parts.length; i += 2) {
		const clause = parts[i];
		if (!clause.trim()) continue;
		if (commandish(clause)) agent.push(clause.trim());
		else user += (user ? (parts[i - 1] ?? " ") : "") + clause;
	}
	user = user.replace(/[\s:;,—(-]+$/, "");
	// a bullet whose every clause was an instruction leaves only its marker
	if (/^\s*[-*]?\s*$/.test(user)) user = "";
	return { user, agent };
}

/** The operator's checkpoint word a result is waiting on, if any. */
export function askOf(text: string, state: FlowState | null): string | undefined {
	const m = new RegExp(`${NEEDS_OPERATOR}(?: ([A-Z][\\w -]*\\?))?`).exec(text);
	if (m) return m[1] ?? "your decision";
	return state?.pendingAsk;
}

const GATE_TITLES: Record<string, string> = {
	init: "Playbook",
	start: "Start",
	use: "Session bound",
	status: "Status",
	approve: "Plan approval",
	check: "Checks",
	test: "Checks",
	verify: "Verification",
	release: "Release",
	"release-done": "Release record",
	finish: "Finish",
	abort: "Abort",
	doctor: "Doctor",
	reflect: "Reflections",
	roadmap: "Roadmap",
	version: "Version",
	help: "Help",
	"--help": "Help",
	"-h": "Help",
};

export const gateTitle = (sub: string): string => GATE_TITLES[sub] ?? sub.charAt(0).toUpperCase() + sub.slice(1);

/** Cheap facts a gate can add to the stage line beyond what state holds (git counts, the plan file). */
export interface StageFacts {
	plan?: "missing" | "draft" | "written";
	mockups?: { rendered: number; total: number };
	ahead?: number;
	uncommitted?: number;
	head?: string;
	manifest?: string | null;
}

function checksSummary(state: FlowState): string {
	const entries = Object.entries(state.checks);
	if (!entries.length) return "`none run` ?";
	return entries.map(([k, v]) => `${k} ${v.ok ? "✓" : "✗"}`).join(" ");
}

/** The stage line: stage glyph, slug, mode glyphs, then provenance-marked decision fields.
 *  `✓` operator · `✓playbook` rule/default · `~` agent-assumed · `?` waiting on the operator. */
export function stageLine(state: FlowState, cfg: Config, f: StageFacts = {}): string {
	const marks = [state.patch ? "⚡" : state.docs ? "📚" : "", state.yolo ? "🎱" : ""].filter(Boolean).join("");
	const fields: string[] = [];
	fields.push(state.patch ? "`patch` ✓" : state.docs ? "`docs` ✓" : "`normal` ✓playbook");
	fields.push(state.ui ? "ui `on` ✓" : "ui `off` ✓playbook");
	const stage = state.stage;
	if (stage === "plan") {
		if (!state.patch && !state.docs) fields.push(`plan \`${f.plan ?? "missing"}\` ${f.plan === "written" ? "~" : "?"}`);
		if (state.ui && f.mockups) fields.push(`mockups \`${f.mockups.rendered}/${f.mockups.total}\` ${f.mockups.total && f.mockups.rendered === f.mockups.total ? "~" : "?"}`);
	}
	if (stage === "implement" || stage === "pre-release") {
		if (f.ahead !== undefined) fields.push(`commits \`${f.ahead} ahead, ${f.uncommitted ?? 0} uncommitted\``);
		if (!state.docs) fields.push(`checks ${checksSummary(state)}`);
		const items = applicableItems(cfg, state, stage).length;
		const pend = checklistPending(cfg, state, stage);
		if (pend) fields.push(`tier-2 \`${pend} open\` ?`);
		else if (items) fields.push("tier-2 `confirmed` ✓");
	}
	if (stage === "pre-release" || stage === "release") {
		const version = state.noVersion ? "version `no-version` ✓" : state.releaseVersion ? `version \`${state.releaseVersion}\` ✓` : f.manifest ? `version \`${f.manifest}\` ~` : "version `pending` ?";
		fields.push(version);
		const merge = cfg.release.merge;
		fields.push(merge ? `merge \`${merge}\` ✓playbook` : "merge `unset` ?");
	}
	if (stage === "release") {
		fields.push(state.approvals.release ? "release `recorded` ✓" : "release `publishing` ~");
		if (state.forgeReleaseSkipped) fields.push("forge release `skipped` ?");
	}
	if (f.head && state.branch) fields.push(`\`${state.branch}@${f.head.slice(0, 7)}\``);
	if (state.pendingAsk) fields.push(`waiting on you \`${state.pendingAsk}\` ?`);
	return `**${STAGE_EMOJI[stage]} ${stage} · \`${state.slug}\`${marks ? ` ${marks}` : ""}** — ${fields.join(" · ")}`;
}

/** What the renderer and the /flow command show, plus the agent's own lines. */
export interface GateView {
	ok: boolean;
	title: string;
	slug?: string;
	stageLine?: string;
	lines: string[];
	ask?: string;
	agent: string[];
}

/** Split one gate result into the operator's view and the agent's instructions. */
export function presentGate(sub: string, text: string, isError: boolean, state: FlowState | null, cfg: Config, facts?: StageFacts): GateView {
	const base = { ok: !isError, title: gateTitle(sub), slug: state?.slug, stageLine: state ? stageLine(state, cfg, facts) : undefined };
	// machine output and the command reference are for the agent; the operator sees what they are, not their body
	if (/^\s*[[{]/.test(text)) return { ...base, lines: ["machine-readable output (for the agent)"], agent: [] };
	if (sub === "help" || sub === "--help" || sub === "-h") return { ...base, lines: ["dev-flow command reference (for the agent — you answer in words)"], agent: [] };
	const lines: string[] = [];
	const agent: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.startsWith(NEEDS_OPERATOR) ? raw.replace(new RegExp(`^${NEEDS_OPERATOR}(?: [A-Z][\\w -]*\\?)?\\s*—?\\s*`), "") : raw;
		const s = splitLine(line);
		if (s.user.trim()) lines.push(s.user);
		agent.push(...s.agent);
	}
	const ask = askOf(text, state);
	return {
		ok: !isError || ask !== undefined,
		title: gateTitle(sub),
		slug: state?.slug,
		stageLine: state ? stageLine(state, cfg, facts) : undefined,
		lines: trimBlank(lines),
		ask,
		agent,
	};
}

function trimBlank(lines: string[]): string[] {
	const out = [...lines];
	while (out.length && !out[0].trim()) out.shift();
	while (out.length && !out.at(-1)!.trim()) out.pop();
	return out;
}

/** Header glyph: done, refused, or parked on the operator. */
export function viewGlyph(v: GateView): string {
	if (v.ask) return "💬";
	return v.ok ? "✅" : "❌";
}

export function viewHeader(v: GateView): string {
	return `${viewGlyph(v)} ${v.title}${v.ok || v.ask ? "" : " refused"}${v.slug ? ` · ${v.slug}` : ""}`;
}

/** The question line: the checkpoint word, said in chat — never a command. */
export function askLine(ask: string): string {
	const word = /\?$/.test(ask) ? `**${ask}**` : ask;
	return /^(Approve|Verified|Release|Finish)\?$/.test(ask) ? `Your call: ${word} — answer in chat (yes / no with a reason / yolo)` : `Your call: ${word} — answer in chat`;
}

/** Plain markdown of the user view — the /flow command's message and the fallback for hosts with no renderer. */
export function renderPlain(v: GateView): string {
	const out = [`**${viewHeader(v)}**`];
	if (v.stageLine) out.push(v.stageLine);
	if (v.lines.length) out.push("", ...v.lines);
	if (v.ask) out.push("", askLine(v.ask));
	return out.join("\n");
}

/** The agent's copy: its original text, with the stage line it must open its report with. */
export function agentText(text: string, v: GateView): string {
	return v.stageLine ? `${text}\n${AGENT_MARK}stage line for your report (paste as is): ${v.stageLine}` : text;
}

/** Sentences in an assistant message that hand the operator a dev-flow command to type. */
export function operatorCommandAsks(message: string): string[] {
	const hits: string[] = [];
	// fenced code is command output being shown, not a request
	const prose = message.replace(/```[\s\S]*?```/g, "");
	for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
		if (!commandish(sentence)) continue;
		// addressed to the operator: an imperative or a "you can / please" form around the command
		if (/\b(you (can|could|may|should|need to|might)|please|type|run|enter|use|try|send|invoke)\b/i.test(sentence) && !/\bI('ll| will| am going to| ran|'m running| run)\b/.test(sentence)) hits.push(sentence.trim());
	}
	return hits;
}

/** The hidden correction the session gets after an answer that asked the operator to type a command. */
export function operatorCommandCorrection(hits: string[]): string {
	return `[dev-flow] Your last message asked the operator to run a dev-flow command (${hits.map((h) => `"${h.slice(0, 120)}"`).join("; ")}). The operator answers in words — you run the flow tool. From now on ask the checkpoint word (Approve? / Verified? / Release? / Finish?) or a plain question, and run the gate yourself once they answer. Do not apologise for this note; just follow it next time.`;
}
