/** dev-flow runtime — `--confirmed` means "the operator said it in chat" (gh#190). The gates cannot read the
 *  chat, so on its own the flag is the agent's word: a refused `start --ui` came straight back with
 *  `--confirmed`, and a plain start was upgraded to `--ui --confirmed` with nobody asked. The flow tool can
 *  count the operator's messages in the session, which is enough to refuse the two shapes seen:
 *
 *  A. a gate asked for the operator's word (NEEDS-OPERATOR, or an "operator-granted" refusal) and the same
 *     gate is re-run with --confirmed before any operator message arrived;
 *  B. a feature started in this session has its mockup gate dropped (--no-ui) with --confirmed before any
 *     operator message arrived after the start. (--patch/--docs need no grant at start: the Approve? answer
 *     grants them, and rule A binds that.)
 *
 *  --confirmed is not the only answer a gate takes: `Dev port?` is answered with --replace or --port=<n>
 *  (gh#203), and those bind the same way — a re-run of the gate that asked, carrying any of them, needs
 *  an operator message after the question.
 *
 *  It never decides what the operator meant — one message after the question is all it asks for. A
 *  session it cannot read (no session manager) is not checked. Pure module: no pi imports. */
import { NEEDS_OPERATOR } from "../core.ts";

/** Operator messages in a session branch, or null when the branch cannot be read. */
export function operatorMessageCount(entries: readonly unknown[] | null | undefined): number | null {
	if (!Array.isArray(entries)) return null;
	let n = 0;
	for (const e of entries) {
		// SAFETY: narrow structural view of the SessionEntry union; only a user message is counted
		const m = e as { type?: string; message?: { role?: string } };
		if (m.type === "message" && m.message?.role === "user") n++;
	}
	return n;
}

export interface GrantLedger {
	/** per session: the gate that last asked for the operator's word, and the operator-message count then */
	asked: Map<string, { sub: string; users: number }>;
	/** per session + slug: the operator-message count when start created the feature */
	started: Map<string, number>;
}

export const newGrantLedger = (): GrantLedger => ({ asked: new Map(), started: new Map() });

const ASKS_FOR_WORD = /operator-granted|operator's (?:explicit )?word|the operator must grant/;
/** Mode flags that loosen a gate and need a grant of their own. --ui only tightens one; --patch and --docs
 *  are granted by the Approve? answer, which rule A already binds; --no-ui (dropping the mockup gate) is the one left. */
const MODE_FLAGS = ["--no-ui"];
/** Flags that carry the operator's answer to the question a gate asked — `--confirmed`, and the
 *  `Dev port?` answers (gh#203). */
export function answerFlags(args: readonly string[]): string[] {
	return args.filter((a) => a === "--confirmed" || a === "--replace" || a.startsWith("--port="));
}
const slugOf = (args: readonly string[]) => args.slice(1).find((a) => !a.startsWith("--")) ?? "";

/** The refusal for a `--confirmed` no operator message stands behind, or null when the call may run. */
export function grantCheck(args: readonly string[], key: string, users: number | null, ledger: GrantLedger): string | null {
	const answers = answerFlags(args);
	if (users === null || !answers.length) return null;
	const sub = args[0] ?? "";
	const asked = ledger.asked.get(key);
	if (asked && asked.sub === sub && users <= asked.users)
		return `${NEEDS_OPERATOR} no operator message since flow ${sub} asked for their word — ${answers.join(" ")} records the operator's answer in chat, it is not yours to give. A word given before the question does not count, so re-running now is refused again: ask in chat, stop, and re-run once they reply (gh#190)`;
	if (sub === "start" && args.includes("--confirmed") && args.some((a) => MODE_FLAGS.includes(a))) {
		const at = ledger.started.get(`${key}\u0000${slugOf(args)}`);
		if (at !== undefined && users <= at)
			return `${NEEDS_OPERATOR} ${args.filter((a) => MODE_FLAGS.includes(a)).join(" ")} on ${slugOf(args)} is operator-granted, and the operator has said nothing since it started — ask them in chat whether to turn it on, stop, and re-run with --confirmed once they reply (gh#190)`;
	}
	return null;
}

/** Note what a flow call's result means for later grants. */
export function grantRecord(args: readonly string[], key: string, users: number | null, res: { text: string; isError?: boolean }, ledger: GrantLedger): void {
	if (users === null) return;
	const sub = args[0] ?? "";
	if (res.isError && (res.text.startsWith(NEEDS_OPERATOR) || ASKS_FOR_WORD.test(res.text))) {
		ledger.asked.set(key, { sub, users });
		return;
	}
	if (!res.isError && ledger.asked.get(key)?.sub === sub) ledger.asked.delete(key);
	if (!res.isError && sub === "start" && /\bstarted at stage\b/.test(res.text)) ledger.started.set(`${key}\u0000${slugOf(args)}`, users);
}

/** A refusal that is the work failing, not the process: a red test, a broken build, a deploy that did not come up. */
const WORK_FAILURE = /check run at the gate failed|\bbuild FAILED\b|dev deploy FAILED|probe FAILED|served-build check FAILED|after-merge check "[^"]*" failed|has not passed|publish stopped — PR #\d+ checks failed/;
/** The release gate still waiting on CI: re-running it is the instruction, never a sign the agent is stuck. */
const WAITING = /(?:^|\n)publish waiting —/;
/** `flow check|test|health` reporting a red run — the answer those tools exist to give. A refusal from them that
 *  is not a run (nothing configured, no feature bound) stays friction. */
const RED_RUN = /^(?:tier-1 checks:|test: FAIL|health: FAIL)/;
const CHECK_SUBS = new Set(["check", "test", "health"]);

/** Refusals in a row per session and gate — the second one in a row is what makes a work failure friction. */
export type RefusalStreak = Map<string, { sub: string; n: number }>;

/** Is this flow result friction the closing reflection should look at? A question for the operator is not, and
 *  neither is a failing check: finding red tests is what `flow check` is for, and counting it made nearly every
 *  flow "have friction", so the reflection worker ran on flows that had none. Friction is a self-granted
 *  answer, a process refusal (wrong stage, missing plan, a proof that does not hold), or the same gate
 *  refusing twice in a row whatever the cause — the agent is stuck on it. */
export function isFriction(args: readonly string[], key: string, res: { text: string; isError?: boolean }, selfGrant: boolean, streak: RefusalStreak): boolean {
	const sub = args[0] ?? "";
	if (selfGrant) return true;
	if (!res.isError) {
		if (streak.get(key)?.sub === sub) streak.delete(key);
		return false;
	}
	if (res.text.startsWith(NEEDS_OPERATOR) || WAITING.test(res.text)) return false;
	if (CHECK_SUBS.has(sub) && RED_RUN.test(res.text)) return false;
	const prev = streak.get(key);
	const n = prev?.sub === sub ? prev.n + 1 : 1;
	streak.set(key, { sub, n });
	return n >= 2 || !WORK_FAILURE.test(res.text);
}
