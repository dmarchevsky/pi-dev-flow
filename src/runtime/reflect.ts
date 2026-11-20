/** dev-flow runtime — Reflections and the upstream issue fold. Moved out of extensions/dev-flow.ts as is (exports added). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureReflectIds as ensureReflectIdsFor, appendReflection, doneItemCount, githubSlug, pluginVersion, guessReflectSections, reflectItems, reflectMove, reflectDone, reflectRow, reflectLegacyPluginCount, reflectionNudges, pluginIssueRecipe, reflectionLine, reflectionsTidy, openChecklistItems, parseRowIds, reflectSame, reflectReopen, closedRowsBySection, archiveAppend, archiveTake, reflectFixPlan, rowId, type ReflectTarget, type ReflectItem, type ReflectSection, type FlowState } from "../core.ts";
import { dedupeReflections, linkedTag, parseGhIssues, similarNote, type FoldResult, type GhIssue } from "../fold.ts";
import { dfDir, now, originUrl, readState, writeState, readReflectArchive, readReflections, readReflectionsText, reflectArchiveFile, sh } from "./base.ts";
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
export async function reflectNote(root: string, sess: Session, note: string[], forced: ReflectTarget | null, evidence = ""): Promise<RunResult> {
	const file = path.join(dfDir(root), "reflections.md");
	const text = readReflectionsText(root);
	const guess = guessReflectSections(note.join(" "));
	const self = isSelfRepo(root);
	const target = forced ?? guess.target;
	const why = forced ? "as told" : guess.why;
	const date = now().slice(0, 10);
	if (target === "plugin" && !self) return { text: [...pluginIssueRecipe(note.join(" "), await pluginUpstream(root), sess.slug, date), ...(forced ? [] : [`(filed as plugin: ${why} — a project note: flow reflect --playbook|--code "<note>")`])].join("\n") };
	const section: ReflectSection = target === "plugin" ? "code" : target;
	const line = reflectionLine(note.join(" "), sess.slug, date, evidence);
	const appended = appendReflection(text, [section], line);
	if (appended === text) {
		const body = reflectItems(line)[0]?.body;
		const same = reflectItems(text).find((it) => it.body === body);
		return { text: `already reflected (duplicate)${same ? ` as r${same.n} — a recurrence is flow reflect --same r${same.n} "<evidence>"` : ""}: ${line}` };
	}
	const next = ensureIds(root, appended);
	writeFileSync(file, next);
	const id = reflectItems(next).find((it) => it.line.endsWith(line.slice(6)))?.n;
	// queueing is exactly when the operator hears about the checked-off pile — nudge only once it is worth a tidy
	const { tidy } = reflectionNudges(next, date);
	return { text: `reflected${id ? ` as r${id}` : ""} (${section} — ${target === "plugin" ? "dev-flow repo: plugin feedback is this project's code" : why}): ${line}` + (tidy ? `\n${tidy}` : "") };
}

const ensureIds = (root: string, text: string) => ensureReflectIdsFor(text, readReflectArchive(root));

/** `flow reflect --same <id> [evidence]` (gh#263 follow-up): the reflect worker reports a finding as `dup: r<id>` —
 *  the recurrence lands on that row as `· seen again <date> <slug>[: evidence]`, and the count ranks it, instead
 *  of a fourth copy of the same defect in its own row. */
export function reflectSameNote(root: string, sess: Session, args: string[]): RunResult {
	const [id] = parseRowIds(args[0] ?? "");
	if (!Number.isInteger(id)) return { text: 'usage: flow reflect --same <id> ["<evidence>"] — the id is the r<n> flow reflect list prints', isError: true };
	const text = readReflectionsText(root);
	const stamp = [now().slice(0, 10), sess.slug].filter(Boolean).join(" ");
	const next = reflectSame(text, id, stamp, args.slice(1).join(" "));
	if (next === null) return { text: `same: ${noOpenRow(text, id, reflectItems(text))}`, isError: true };
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const it = reflectItems(next).find((x) => x.n === id)!;
	return { text: `reflect: r${id} seen again — now hit ${it.hits}× — ${it.body}` };
}

/** `flow reflect reopen <id> [why]`: a row closed by mistake comes back open, its history on the row. A row already
 *  tidied into the archive is taken back from there, under its section. */
export function reflectReopenNote(root: string, sess: Session, args: string[]): RunResult {
	const [id] = parseRowIds(args[0] ?? "");
	if (!Number.isInteger(id)) return { text: 'usage: flow reflect reopen <id> ["<why>"]', isError: true };
	const file = path.join(dfDir(root), "reflections.md");
	let text = readReflectionsText(root);
	const stamp = [now().slice(0, 10), sess.slug].filter(Boolean).join(" ");
	const why = args.slice(1).join(" ");
	let from = "";
	if (!reflectRow(text, id)) {
		const taken = archiveTake(readReflectArchive(root), id);
		if (!taken) return { text: `reopen: no row r${id} in reflections.md or its archive`, isError: true };
		writeFileSync(reflectArchiveFile(root), taken.archive);
		const section = taken.row.section === "playbook" || taken.row.section === "code" ? (taken.row.section as ReflectSection) : "playbook";
		text = appendReflection(text || "", [section], taken.row.line);
		from = " (taken back from the archive)";
	}
	const next = reflectReopen(text, id, stamp, why);
	if (next === null) return { text: `reopen: r${id} is open already`, isError: true };
	writeFileSync(file, next);
	return { text: `reflect: r${id} reopened${from} — ${reflectItems(next).find((x) => x.n === id)?.body ?? ""}` };
}

/** `flow reflect defer <id> "<why>"`: a row linked to the bound flow that this flow does not fix after all — it stays
 *  open with the reason on it, and finish leaves it alone. Every linked row is either fixed (closed at finish) or
 *  deferred with a reason: the ledger never again reads "30 open" after the flow that fixed them shipped. */
export function reflectDeferNote(root: string, sess: Session, args: string[]): RunResult {
	const [id] = parseRowIds(args[0] ?? "");
	const why = args.slice(1).join(" ").trim();
	if (!Number.isInteger(id) || !why) return { text: 'usage: flow reflect defer <id> "<why this flow does not fix it>"', isError: true };
	if (!sess.slug) return { text: "defer: no flow bound — a row is deferred by the flow it was linked to (flow start --reflections)", isError: true };
	const state = readState(root, sess.slug);
	const link = state?.reflections?.find((r) => r.id === id);
	if (!state || !link) return { text: `defer: r${id} is not linked to ${sess.slug} — linked: ${(state?.reflections ?? []).map((r) => `r${r.id}`).join(", ") || "none"}`, isError: true };
	link.deferred = why;
	writeState(root, state);
	const text = readReflectionsText(root);
	const row = reflectRow(text, id);
	if (row?.open) {
		const lines = text.split("\n");
		lines[row.index] = `${lines[row.index].trimEnd()} · deferred by ${sess.slug} ${now().slice(0, 10)}: ${why}`;
		writeFileSync(path.join(dfDir(root), "reflections.md"), lines.join("\n"));
	}
	return { text: `reflect: r${id} deferred by ${sess.slug} — it stays open (${why}); finish closes the rest of the linked rows as fixed` };
}

/** Close the rows a flow was linked to and did not defer — finish's half of the link. Returns the ids closed. */
export function closeLinkedReflections(root: string, state: FlowState, prNote: string): number[] {
	const linked = (state.reflections ?? []).filter((r) => !r.deferred);
	if (!linked.length) return [];
	let text = readReflectionsText(root);
	const closed: number[] = [];
	for (const r of linked) {
		const next = reflectDone(text, r.id, `${now().slice(0, 10)} ${state.slug} — fixed by this flow${prNote}`);
		if (next !== null) { text = next; closed.push(r.id); }
	}
	if (closed.length) writeFileSync(path.join(dfDir(root), "reflections.md"), text);
	return closed;
}

/** `flow reflect plan`: the open rows grouped into flows — shared files and code names make a group, the playbook
 *  rows one docs flow — ranked by how often their rows were hit, each with the start command that links its rows. */
export function reflectPlanNote(root: string): RunResult {
	const items = readReflections(root).filter((i) => i.section !== "plugin");
	if (!items.length) return { text: "reflections: nothing open to plan" };
	const { groups, singles } = reflectFixPlan(items);
	const ids = (g: { ids: number[] }) => g.ids.map((n) => `r${n}`).join(",");
	const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);
	const out = [`fix plan — ${items.length} open, ${groups.length + singles.length} flow(s), most-hit first:`];
	groups.forEach((g, i) => {
		const docs = g.section === "playbook";
		out.push(`  ${i + 1}. ${docs ? "playbook — one docs flow" : `code · ${g.topic}`} (${g.ids.length} row(s), hit ${g.hits}×): ${ids(g)}`);
		for (const b of g.bodies.slice(0, 4)) out.push(`       · ${clip(b)}`);
		if (g.bodies.length > 4) out.push(`       · … ${g.bodies.length - 4} more`);
		out.push(`${AGENT_MARK}start: flow start ${docs ? "fold-playbook" : `fix-${g.topic}`} ${docs ? "--docs" : "--patch"} --reflections=${ids(g)}`);
	});
	if (singles.length) {
		out.push(`single code rows (no shared file with another row) — ${singles.length}:`);
		for (const g of singles) out.push(`  r${g.ids[0]} (hit ${g.hits}×) ${clip(g.bodies[0])}`);
		out.push(`${AGENT_MARK}a single row is its own patch flow (flow start fix-<topic> --patch --reflections=r<id>), or rides with a group above when it touches the same code`);
	}
	out.push(`${AGENT_MARK}--reflections links the rows to the flow: finish closes them as fixed by it; one the flow does not fix is flow reflect defer <id> "<why>"`);
	return { text: out.join("\n") };
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

/** `flow reflect list` — the queue numbered, so `move <n>` can address an item (same numbering as
 *  `flow roadmap`). Upstream items ride below the local queue as gh#N — never numbered, never
 *  addressable by move: each item keeps the home it is resolved in. */
export async function reflectList(root: string): Promise<RunResult> {
	const items = readReflections(root);
	const fold = await foldView(root, items);
	const local = items.length
		? [
				`reflections — ${items.length} open (r<n> is a row's id: it never changes, whatever is closed, tidied or moved):`,
				...items.map((it, i) => {
					const link = fold.state === "ok" ? fold.result.linked.find((l) => l.item === i) : undefined;
					return `  r${it.n}. [${it.section}]${(it.hits ?? 1) > 1 ? ` hit ${it.hits}×` : ""} ${it.line.replace(/^- \[ \] /, "").replace(/^\[r\d+\]\s*/, "")}${link ? linkedTag(link.issue) : ""}`;
				}),
				// gh#220: the command that closes a row has to be in front of the session that is about to hand-edit the file
				`${AGENT_MARK}close fixed rows with flow reflect done <id>[,<id>…] "<what fixed it>" — never by editing reflections.md; a recurrence is flow reflect --same <id> "<evidence>"; flow reflect plan groups the open rows into flows`,
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
export function reflectMoveNote(root: string, args: string[], forced: ReflectTarget | null): RunResult {
	if (forced === "plugin") return { text: "move: plugin notes are not kept in reflections.md — file the item upstream (flow reflect --plugin \"<note>\" prints the recipe), then check the row off '— filed: gh#NNN' (in the dev-flow repo itself: move <n> --code)", isError: true };
	if (!forced) return { text: "usage: flow reflect move <n> --playbook | --code", isError: true };
	const section = forced;
	const [n] = parseRowIds(args[0] ?? "");
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	const it = items.find((x) => x.n === n);
	if (!it) return { text: `move: ${noOpenRow(text, n, items)}`, isError: true };
	if (it.section === section) return { text: `reflect: r${n} is already under ## ${section}` };
	// the same note open under both headings (an old --both filing): the move merges it, it does not copy it
	const twin = items.some((x) => x !== it && x.section === section && x.body === it.body);
	const next = reflectMove(text, n, section);
	if (next === null) return { text: `move: ${noOpenRow(text, n, items)}`, isError: true };
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const note = it.line.replace(/^- \[ \] /, "");
	return { text: twin ? `reflect: r${n} was already recorded under ## ${section} — the duplicate is gone (${note})` : `reflect: r${n} re-filed under ## ${section} — ${note}` };
}

/** Why `<n>` names no open row (gh#197): a row already checked off says which note it holds, so a batch that
 *  drifted shows the mismatch instead of closing the wrong line. */
function noOpenRow(text: string, n: number, items: readonly ReflectItem[]): string {
	const row = Number.isInteger(n) && n > 0 ? reflectRow(text, n) : null;
	if (row && !row.open) return `r${n} is already checked off (${row.line.replace(/^-\s*\[[xX]\]\s*/, "")}) — flow reflect list shows the open ones; flow reflect reopen r${n} "<why>" if it was closed by mistake`;
	return items.length ? `no open row r${Number.isNaN(n) ? "?" : n} — open: ${items.map((i) => `r${i.n}`).join(", ")} (flow reflect list prints them)` : "nothing open in reflections.md";
}

/** `flow reflect done <n> [what fixed it]` — check a folded/fixed item off, so doctor stops re-reporting it (#165).
 *  `<n>` is the stable row number (gh#197): closing one leaves every other number where `list` printed it. */
export function reflectDoneNote(root: string, sess: Session, args: string[]): RunResult {
	const text = readReflectionsText(root);
	const items = reflectItems(text);
	// gh#220: a fold closes several rows with one fix — `done 3,4,7 "<what>"` checks them off together. Checking a
	// row off leaves the other numbers as they are, so the batch is all or nothing: one bad number closes none.
	const nums = parseRowIds(args[0] ?? "");
	if (!nums.length) return { text: 'usage: flow reflect done <id>[,<id>…] "<what fixed it>"', isError: true };
	const picked = nums.map((n) => ({ n, it: items.find((x) => x.n === n) }));
	const bad = picked.filter((p) => !p.it);
	if (bad.length) return { text: `done: ${bad.map((p) => noOpenRow(text, p.n, items)).join("; ")}${nums.length > 1 ? " — nothing was checked off" : ""}`, isError: true };
	const stamp = [now().slice(0, 10), sess.slug].filter(Boolean).join(" ");
	const what = args.slice(1).join(" ").trim();
	let next = text;
	for (const n of nums) {
		const closed = reflectDone(next, n, what ? `${stamp} — ${what}` : stamp);
		// every id was proven open above and a close moves no other row — a miss here is a bug, never a silent skip
		if (closed === null) return { text: `done: r${n} could not be checked off — nothing was changed`, isError: true };
		next = closed;
	}
	writeFileSync(path.join(dfDir(root), "reflections.md"), next);
	const { tidy } = reflectionNudges(next, now().slice(0, 10));
	const head = nums.length === 1
		? `reflect: r${nums[0]} checked off — ${picked[0].it!.body}${what ? ` — fixed: ${what}` : ""}`
		: `reflect: ${nums.length} items checked off${what ? ` — fixed: ${what}` : ""}\n${picked.map((p) => `  r${p.n}. ${p.it!.body}`).join("\n")}`;
	return { text: head + (tidy ? `\n${tidy}` : "") };
}

/** `flow reflect tidy` — move the closed (`- [x]`) items to reflections-archive.md. Deleting them lost the
 *  `— fixed:` note and, after a mistaken close, the row itself (gh#263); archived, a row can be reopened and its
 *  id is never handed out again. */
export function reflectTidy(root: string): RunResult {
	const file = path.join(dfDir(root), "reflections.md");
	if (!existsSync(file)) return { text: "reflections: nothing to tidy (no queue yet)" };
	const text = readReflectionsText(root);
	const closed = doneItemCount(text);
	const open = openChecklistItems(text).length;
	if (!closed) return { text: `reflections: nothing to tidy (${open} open, 0 closed)` };
	writeFileSync(reflectArchiveFile(root), archiveAppend(readReflectArchive(root), closedRowsBySection(text), now().slice(0, 10)));
	writeFileSync(file, reflectionsTidy(text));
	return { text: `reflections: moved ${closed} closed item(s) to .dev-flow/reflections-archive.md — ${open} open; ids are unchanged (flow reflect reopen <id> brings one back)` };
}
