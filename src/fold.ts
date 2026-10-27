/**
 * The read-time fold between the local reflection queue and open GitHub issues.
 * Pure — no I/O: the extension fetches `gh issue list --json` output and hands it here.
 * A fold merges the VIEW only: a local item lives in reflections.md (checked off there),
 * an upstream item lives on GitHub (closed there). Nothing is copied into the other home,
 * so an item never has two statuses to keep in sync.
 */

export interface GhIssue {
	number: number;
	title: string;
	body: string;
}

/** Parse `gh issue list --json number,title,body` output. Junk (gh's own error text, a
 *  truncated stream) is null — the caller decides what to report; a clean empty list is []. */
export function parseGhIssues(out: string): GhIssue[] | null {
	const s = out.trim();
	if (!s.startsWith("[")) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(s);
	} catch {
		return null;
	}
	if (!Array.isArray(raw)) return null;
	const out_: GhIssue[] = [];
	for (const e of raw as Partial<GhIssue>[]) {
		const n = Number(e?.number);
		if (!Number.isInteger(n) || n < 1) continue;
		out_.push({
			number: n,
			title: typeof e?.title === "string" ? e.title : "",
			body: typeof e?.body === "string" ? e.body : "",
		});
	}
	return out_;
}

/** Comparison identity: lowercase, every non-alphanumeric run collapsed to one space —
 *  backticks, quotes and the two kinds of dash never decide whether a title matches. */
export const normKey = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The text a filed issue carries before the `— reflection from …` tail the filing convention
 *  appends — by convention exactly the reflection's own text, on whichever line it sits. */
export function issueBodyTails(issue: GhIssue): string[] {
	const keys: string[] = [];
	for (const line of issue.body.split("\n")) {
		const m = /^(.+?)\breflection from\b/i.exec(line.trim().replace(/^#+\s*/, ""));
		if (m) {
			const k = normKey(m[1]);
			if (k) keys.push(k);
		}
	}
	return keys;
}

/** Issue numbers a local item references by hand (`gh#120`, bare `#120`) — the explicit link
 *  the agent or operator left when filing or checking off. */
export function referencedIssues(line: string): number[] {
	const nums: number[] = [];
	for (const m of line.matchAll(/gh#(\d+)|#(\d+)/gi)) {
		const n = Number(m[1] ?? m[2]);
		if (Number.isInteger(n) && n >= 1 && !nums.includes(n)) nums.push(n);
	}
	return nums;
}

const STOPWORDS = new Set(
	"a an and are as at be but by can could do does for from here his her i in into is it its no not of on or our per than that the then there they this to up via we were what when where which who will with would you your".split(
		" ",
	),
);

/** Content words for the similarity hint: normalized words minus stopwords and strays. */
export function contentTokens(text: string): Set<string> {
	return new Set(normKey(text).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
};

/** A near-miss worth a human glance, never an auto-merge. */
export interface FoldSimilar {
	item: number;
	issue: number;
	score: number;
}
export interface FoldLink {
	item: number;
	issue: number;
	via: "ref" | "title" | "body";
}
export interface FoldResult {
	/** Exact matches, in local-item order: the queue row carries `⟷ gh#N` instead of duplicating. */
	linked: FoldLink[];
	/** Token-similarity hints over the UNLINKED pairs — advisory, the operator decides. */
	similar: FoldSimilar[];
	/** Issues nothing matched, ascending — these render as upstream rows. */
	upstreamOnly: GhIssue[];
}

export interface FoldItemInput {
	body: string;
	line: string;
}

/** Minimum content words per side before a Jaccard score is trusted as a hint. */
const SIM_MIN_TOKENS = 5;
const SIM_THRESHOLD = 0.6;

/** Match the open local items against open GitHub issues: explicit `#N` references first, then
 *  exact normalized equality against the issue title, then against the body's `reflection from`
 *  tail. One link per item and per issue (first exact hit wins, local order decides). */
export function dedupeReflections(items: FoldItemInput[], issues: GhIssue[]): FoldResult {
	const byNumAsc = [...issues].sort((a, b) => a.number - b.number);
	const byNum = new Map(byNumAsc.map((i) => [i.number, i]));
	const used = new Set<number>();
	const linked: FoldLink[] = [];
	const linkedItems = new Set<number>();
	items.forEach((it, idx) => {
		const free = (i: GhIssue) => !used.has(i.number);
		const nk = normKey(it.body);
		const ref = referencedIssues(it.line).find((n) => byNum.has(n) && free(byNum.get(n)!));
		const title = nk && byNumAsc.find((i) => free(i) && normKey(i.title) === nk);
		const body = nk && byNumAsc.find((i) => free(i) && issueBodyTails(i).includes(nk));
		const hit = ref !== undefined ? { issue: byNum.get(ref)!, via: "ref" as const } : title ? { issue: title, via: "title" as const } : body ? { issue: body, via: "body" as const } : null;
		if (!hit) return;
		used.add(hit.issue.number);
		linkedItems.add(idx);
		linked.push({ item: idx, issue: hit.issue.number, via: hit.via });
	});
	const similar: FoldSimilar[] = [];
	items.forEach((it, idx) => {
		if (linkedItems.has(idx)) return;
		const itTok = contentTokens(it.body);
		if (itTok.size < SIM_MIN_TOKENS) return;
		for (const i of byNumAsc) {
			if (used.has(i.number)) continue;
			const score = jaccard(itTok, contentTokens(i.title));
			if (score >= SIM_THRESHOLD) similar.push({ item: idx, issue: i.number, score });
		}
	});
	similar.sort((a, b) => b.score - a.score || a.issue - b.issue);
	return { linked, similar, upstreamOnly: byNumAsc.filter((i) => !used.has(i.number)) };
}

/** The tag a linked local row carries. */
export const linkedTag = (issue: number) => ` ⟷ gh#${issue}`;

/** One similarity hint line — an unmerged near-miss the operator has to judge. */
export const similarNote = (s: FoldSimilar, itemNumber: number) =>
	`~ gh#${s.issue} may duplicate local item ${itemNumber} (${Math.round(s.score * 100)}% similar) — verify before fixing the same thing twice`;
