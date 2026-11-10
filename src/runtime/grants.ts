/** dev-flow runtime — `--confirmed` means "the operator said it in chat" (gh#190). The gates cannot read the
 *  chat, so on its own the flag is the agent's word: a refused `start --ui` came straight back with
 *  `--confirmed`, and a plain start was upgraded to `--ui --confirmed` with nobody asked. The flow tool can
 *  count the operator's messages in the session, which is enough to refuse the two shapes seen:
 *
 *  A. a gate asked for the operator's word (NEEDS-OPERATOR, or an "operator-granted" refusal) and the same
 *     gate is re-run with --confirmed before any operator message arrived;
 *  B. a feature started in this session gets a mode flag (--ui/--patch/--docs) granted with --confirmed
 *     before any operator message arrived after the start.
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
const MODE_FLAGS = ["--ui", "--patch", "--docs"];
const slugOf = (args: readonly string[]) => args.slice(1).find((a) => !a.startsWith("--")) ?? "";

/** The refusal for a `--confirmed` no operator message stands behind, or null when the call may run. */
export function grantCheck(args: readonly string[], key: string, users: number | null, ledger: GrantLedger): string | null {
	if (users === null || !args.includes("--confirmed")) return null;
	const sub = args[0] ?? "";
	const asked = ledger.asked.get(key);
	if (asked && asked.sub === sub && users <= asked.users)
		return `${NEEDS_OPERATOR} no operator message since flow ${sub} asked for their word — --confirmed records the operator's answer in chat, it is not yours to give: ask in chat, stop, and re-run with --confirmed once they reply (gh#190)`;
	if (sub === "start" && args.some((a) => MODE_FLAGS.includes(a))) {
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
