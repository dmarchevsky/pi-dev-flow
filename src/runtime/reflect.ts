/** dev-flow runtime — Reflections and the upstream issue fold. Moved out of extensions/dev-flow.ts as is (exports added). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendReflection, doneItemCount, githubSlug, pluginVersion, guessReflectSections, reflectItems, reflectMove, reflectDone, reflectRow, reflectLegacyPluginCount, reflectionNudges, pluginIssueRecipe, reflectionLine, reflectionsTidy, openChecklistItems, type ReflectTarget, type ReflectItem, type ReflectSection } from "../core.ts";
import { dedupeReflections, linkedTag, parseGhIssues, similarNote, type FoldResult, type GhIssue } from "../fold.ts";
import { dfDir, now, originUrl, readReflections, readReflectionsText, sh } from "./base.ts";
import { type RunResult, type Session } from "./checks.ts";
import { isSelfRepo } from "./setup.ts";
import { AGENT_MARK } from "../present.ts";

/** The dev-flow repo plugin notes are filed against: the manifest's repository field; the dev-flow
 *  checkout itself falls back to its origin. */
export async function pluginUpstream(root: string): Promise<string> {
	return pluginVersion(import.meta.dirname).repo || (isSelfRepo(root) ? githubSlug((await originUrl(root)) ?? "") : "");
}

/** `flow reflect <note>` — this project's queue, operator decides. `--playbook` / `--code` states the
 *  section (the agent knows what its own note is about); `--plugin` is dev-flow feedback, which never
 *  lands in a project's file — it prints the upstream issue recipe instead (in the dev-flow repo itself
 *  plugin IS code, so it files under `## code`). With no flag the wording guesses and the echo prints why. */
export async function reflectNote(root: string, sess: Session, note: string[], forced: ReflectTarget | null): Promise<RunResult> {
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
export const ghFoldCache = new Map<string, { at: number; issues: GhIssue[] }>();
export const GH_FOLD_TTL_MS = 5 * 60_000;

/** Open GitHub issues of the repo's own origin — the channel external parties can file through.
 *  Three outcomes, only the third ever speaks: absent (no GitHub remote — not every repo has one,
 *  say nothing), skipped (gh missing / unauthenticated / offline / DEV_FLOW_NO_ISSUES — one line
 *  with the reason, never a guess), ok (the parsed list). */
export async function fetchUpstream(root: string): Promise<{ slug: string; issues: GhIssue[] } | { skipped: string } | { absent: true }> {
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

export type FoldView = { state: "absent" } | { state: "skipped"; why: string } | { state: "ok"; slug: string; result: FoldResult; open: number };

export async function foldView(root: string, items: ReflectItem[]): Promise<FoldView> {
	const up = await fetchUpstream(root);
	if ("absent" in up) return { state: "absent" };
	if ("skipped" in up) return { state: "skipped", why: up.skipped };
	return { state: "ok", slug: up.slug, result: dedupeReflections(items, up.issues), open: up.issues.length };
}

/** The fold block shared by flow doctor and flow reflect list: header, one row per unmatched
 *  issue with its route, then the unmerged near-miss hints. Local rows carry their ⟷ gh#N tag
 *  at the call site — the fold lists upstream items, it never re-numbers the local queue. */
export function foldRows(fold: FoldView, selfRepo: boolean, items: readonly ReflectItem[] = []): string[] {
	if (fold.state === "absent") return [];
	if (fold.state === "skipped") return [`upstream issues: skipped (${fold.why})`];
	if (!fold.open) return [];
	const rows = [`upstream on ${fold.slug} — ${fold.open} open issue(s) on GitHub (canonical there — close on GitHub, never here; this is a fold, not a copy):`];
	for (const i of fold.result.upstreamOnly) rows.push(`  gh#${i.number} ${i.title} → ${selfRepo ? "fix in a flow here (patch flow if small)" : "fix in a flow here, or close won't-fix on GitHub"}`);
	for (const s of fold.result.similar) rows.push(`  ${similarNote(s, items[s.item]?.n ?? s.item + 1)}`);
	return rows;
}

/** gh#263: what each row number named when this session was last shown the queue (`list`, the reflect brief).
 *  Numbers are positions in one file every session of the repo shares: another session's tidy or move shifts
 *  them, and a batch read before it closed the neighbours of every row it meant — seven open defects closed,
 *  then tidied away. A number is only trusted while it still names the row it named when it was printed. */
const shownRows = new Map<string, Map<number, string>>();

/** Record the numbering a session was just shown. */
export function noteShownRows(key: string, items: readonly ReflectItem[]): void {
	shownRows.set(key, new Map(items.map((it) => [it.n, it.body])));
}

const clipBody = (s: string) => (s.length > 70 ? `${s.slice(0, 69)}…` : s);

/** The refusal for numbers that no longer name the row this session was shown, or null. Judged by the row's
 *  text, not the file's revision: an append elsewhere leaves the numbers good, and a renumbering — another
 *  session's tidy, or this session's own tidy or move — is caught on exactly the numbers it shifted. A number
 *  the session was never shown is judged on the file as it stands, as before. */
export function staleRows(key: string, nums: readonly number[], items: readonly ReflectItem[]): string | null {
	const s = shownRows.get(key);
	if (!s) return null;
	const now_ = (n: number) => items.find((x) => x.n === n)?.body;
	// a number the last list showed that names another row now, or one it did not show that a shift made open
	const moved = nums.filter((n) => (s.has(n) ? now_(n) !== s.get(n) : now_(n) !== undefined));
	if (!moved.length) return null;
	const was = (n: number) => (s.has(n) ? `"${clipBody(s.get(n)!)}"` : "not open");
	return `the queue changed since this session listed it (a tidy or move here or in another session), so these numbers name different rows now — ${moved.map((n) => `${n} was ${was(n)}, now ${now_(n) ? `"${clipBody(now_(n)!)}"` : "no open row"}`).join("; ")}. Run flow reflect list again and use its numbers; nothing was changed`;
}

/** `flow reflect list` — the queue numbered, so `move <n>` can address an item (same numbering as
 *  `flow roadmap`). Upstream items ride below the local queue as gh#N — never numbered, never
 *  addressable by move: each item keeps the home it is resolved in. */
export async function reflectList(root: string, sess?: Session): Promise<RunResult> {
	const items = readReflections(root);
	if (sess) noteShownRows(sess.key, items);
	const fold = await foldView(root, items);
	const local = items.length
		? [
				`reflections — ${items.length} open (numbers are row numbers: checking one off leaves the others as they are; tidy and move renumber):`,
				...items.map((it, i) => {
					const link = fold.state === "ok" ? fold.result.linked.find((l) => l.item === i) : undefined;
					return `  ${it.n}. [${it.section}] ${it.line.replace(/^- \[ \] /, "")}${link ? linkedTag(link.issue) : ""}`;
				}),
				// gh#220: the command that closes a row has to be in front of the session that is about to hand-edit the file
				`${AGENT_MARK}close fixed rows with flow reflect done <n>[,<n>…] "<what fixed it>" — never by editing reflections.md`,
			]
		: fold.state === "absent" || fold.state === "skipped"
			? ["reflections: nothing open"]
			: ["reflections: nothing open locally"];
	return { text: [...local, ...legacyPluginRows(readReflectionsText(root), isSelfRepo(root)), ...foldRows(fold, isSelfRepo(root), items)].join("\n") };
}

/** Open rows still under the legacy `## plugin` heading: they belong on GitHub, not in a project's queue. */
export function legacyPluginRows(text: string, selfRepo: boolean): string[] {
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
export function reflectMoveNote(root: string, args: string[], forced: ReflectTarget | null, sess?: Session): RunResult {
	if (forced === "plugin") return { text: "move: plugin notes are not kept in reflections.md — file the item upstream (flow reflect --plugin \"<note>\" prints the recipe), then check the row off '— filed: gh#NNN' (in the dev-flow repo itself: move <n> --code)", isError: true };
	if (!forced) return { text: "usage: flow reflect move <n> --playbook | --code", isError: true };
	const section = forced;
	const n = Number(args[0]);
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	const stale = sess ? staleRows(sess.key, [n], items) : null;
	if (stale) return { text: `move: ${stale}`, isError: true };
	const it = items.find((x) => x.n === n);
	if (!it) return { text: `move: ${noOpenRow(text, n, items)}`, isError: true };
	if (it.section === section) return { text: `reflect: item ${n} is already under ## ${section}` };
	// the same note open under both headings (an old --both filing): the move merges it, it does not copy it
	const twin = items.some((x) => x !== it && x.section === section && x.body === it.body);
	const next = reflectMove(text, n, section);
	if (next === null) return { text: `move: ${noOpenRow(text, n, items)}`, isError: true };
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const note = it.line.replace(/^- \[ \] /, "");
	return { text: `${twin ? `reflect: item ${n} was already recorded under ## ${section} — the duplicate is gone (${note})` : `reflect: item ${n} re-filed under ## ${section} — ${note}`}\n${RENUMBERED}` };
}

const RENUMBERED = "the row numbers changed — run flow reflect list before the next done or move";

/** Why `<n>` names no open row (gh#197): a row already checked off says which note it holds, so a batch that
 *  drifted shows the mismatch instead of closing the wrong line. */
function noOpenRow(text: string, n: number, items: readonly ReflectItem[]): string {
	const row = Number.isInteger(n) && n > 0 ? reflectRow(text, n) : null;
	if (row && !row.open) return `item ${n} is already checked off (${row.line.replace(/^-\s*\[[xX]\]\s*/, "")}) — flow reflect list shows the open ones`;
	return items.length ? `no open item ${n} — open: ${items.map((i) => i.n).join(", ")} (flow reflect list numbers them)` : "nothing open in reflections.md";
}

/** `flow reflect done <n> [what fixed it]` — check a folded/fixed item off, so doctor stops re-reporting it (#165).
 *  `<n>` is the stable row number (gh#197): closing one leaves every other number where `list` printed it. */
export function reflectDoneNote(root: string, sess: Session, args: string[]): RunResult {
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	// gh#220: a fold closes several rows with one fix — `done 3,4,7 "<what>"` checks them off together. Checking a
	// row off leaves the other numbers as they are, so the batch is all or nothing: a number that names no open
	// row, or (gh#263) a different row from the one this session was shown, closes none.
	const nums = [...new Set(String(args[0] ?? "").split(",").map((p) => p.trim()).filter(Boolean).map(Number))];
	if (!nums.length) return { text: 'usage: flow reflect done <n>[,<n>…] "<what fixed it>"', isError: true };
	const stale = staleRows(sess.key, nums, items);
	if (stale) return { text: `done: ${stale}`, isError: true };
	const picked = nums.map((n) => ({ n, it: items.find((x) => x.n === n) }));
	const bad = picked.filter((p) => !p.it);
	if (bad.length) return { text: `done: ${bad.map((p) => noOpenRow(text, p.n, items)).join("; ")}${nums.length > 1 ? " — nothing was checked off" : ""}`, isError: true };
	const stamp = [now().slice(0, 10), sess.slug].filter(Boolean).join(" ");
	const what = args.slice(1).join(" ").trim();
	let next = text;
	for (const n of nums) {
		const closed = reflectDone(next, n, what ? `${stamp} — ${what}` : stamp);
		// every number was proven open above and closing one renumbers nothing — a miss here is a bug, never a skip
		if (closed === null) return { text: `done: row ${n} could not be checked off — nothing was changed`, isError: true };
		next = closed;
	}
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const { tidy } = reflectionNudges(next, now().slice(0, 10));
	const head = nums.length === 1
		? `reflect: item ${nums[0]} checked off — ${picked[0].it!.body}${what ? ` — fixed: ${what}` : ""}`
		: `reflect: ${nums.length} items checked off${what ? ` — fixed: ${what}` : ""}\n${picked.map((p) => `  ${p.n}. ${p.it!.body}`).join("\n")}`;
	return { text: head + (tidy ? `\n${tidy}` : "") };
}

/** `flow reflect tidy` — drop the closed (`- [x]`) items; the `— fixed:` note already recorded the outcome. */
export function reflectTidy(root: string): RunResult {
	const file = path.join(dfDir(root), "reflections.md");
	if (!existsSync(file)) return { text: "reflections: nothing to tidy (no queue yet)" };
	const text = readFileSync(file, "utf8");
	const closed = doneItemCount(text);
	const open = openChecklistItems(text).length;
	if (!closed) return { text: `reflections: nothing to tidy (${open} open, 0 closed)` };
	writeFileSync(file, reflectionsTidy(text));
	return { text: `reflections: dropped ${closed} closed item(s) — ${open} open; ${RENUMBERED}` };
}
