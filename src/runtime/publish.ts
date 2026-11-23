/** dev-flow runtime — the release stage, run by the gate. After Release? is answered the agent used to push,
 *  open the PR, watch CI, merge in the playbook's style, tag and push the tag by hand; most of release.md was a
 *  list of past mistakes in those steps. `flow release` now runs them itself on GitHub. Every step first asks
 *  the forge whether it is already done, so a re-run resumes and a step done by hand is accepted. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { newestTaggedVersion, parseVersion, pickReleaseNotes, prepOnlyChange, releaseCallProof, sq } from "../core.ts";
import type { Config, FlowState } from "../core.ts";
import { featDir, gateCwd, mergeBase, releaseTags, sh, tail, writeState } from "./base.ts";

/** How long the gate waits on a PR's CI; a seam so tests run in milliseconds (same shape as artifactWait). */
export const publishWait = {
	budgetMs: 30 * 60_000,
	pollMs: 20_000,
	/** a PR opened seconds ago may have no check yet: look this long before deciding the repo has none */
	appearMs: 60_000,
	sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
	clock: () => Date.now(),
	checks: (pr: number, cwd: string): Promise<PrCheck[] | null> => prChecks(pr, cwd),
	/** the CI runs a commit started — the merge commit, before it is tagged (gh#271) */
	commitChecks: (sha: string, cwd: string, branch?: string): Promise<PrCheck[] | null> => commitRuns(sha, cwd, branch),
	/** gh#275: a check pending this long has its Actions job asked directly — GitHub can leave a check run
	 *  `in_progress` for good after its job concluded */
	staleMs: 5 * 60_000,
	/** the bucket of the Actions job or run behind a check's link once it has concluded; null while it runs or when
	 *  the link is not an Actions one */
	probe: (link: string, cwd: string): Promise<string | null> => actionsConclusion(link, cwd),
};

/** gh#275: the Actions job (or run) a check links to — its own conclusion, which GitHub sets even when the check
 *  run shown on the PR is stuck at in_progress. */
async function actionsConclusion(link: string, cwd: string): Promise<string | null> {
	const m = /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link);
	if (!m) return null;
	const api = m[4] ? `repos/${m[1]}/${m[2]}/actions/jobs/${m[4]}` : `repos/${m[1]}/${m[2]}/actions/runs/${m[3]}`;
	const r = await sh(`gh api ${sq(api)} --jq '.conclusion // ""'`, cwd, 60_000);
	const k = r.ok ? r.out.trim() : "";
	return /^[a-z_]+$/.test(k) ? checkBucket({ status: "COMPLETED", conclusion: k.toUpperCase() }) : null;
}

/** Workflow runs of one commit as checks; [] when none started, null when gh cannot say. */
async function commitRuns(sha: string, cwd: string, branch?: string): Promise<PrCheck[] | null> {
	const r = await sh(`gh run list --commit ${sha} --limit 50 --json status,conclusion,name,url,headBranch`, cwd, 60_000);
	if (!r.ok) return null;
	const rows = jsonArray<{ status?: string; conclusion?: string; name?: string; url?: string; headBranch?: string }>(r.out);
	if (rows === null) return r.out.trim() ? null : [];
	// the merge commit's own CI ran on the default branch: a run a tag push started on the same commit is the
	// release's publish job, not a check on the merge — a refused tag's red run must not hold the next tag back
	return rows.filter((x) => !branch || !x.headBranch || x.headBranch === branch).map((x) => ({ name: x.name ?? "run", bucket: checkBucket({ status: (x.status ?? "").toUpperCase(), conclusion: (x.conclusion ?? "").toUpperCase() }), link: x.url ?? "" }));
}

export interface PrCheck { name: string; bucket: string; link: string }
interface Pr { number: number; state: string; url: string; headRefOid: string; mergeCommit: { oid: string } | null }

/** The first JSON array in a CLI's output — sh() folds stderr in, and gh exits non-zero on pending checks. */
function jsonArray<T>(out: string): T[] | null {
	const at = out.indexOf("[");
	if (at < 0) return null;
	for (let end = out.lastIndexOf("]"); end > at; end = out.lastIndexOf("]", end - 1)) {
		try {
			const v = JSON.parse(out.slice(at, end + 1)) as unknown;
			if (Array.isArray(v)) return v as T[];
		} catch {
			/* a shorter slice may parse */
		}
	}
	return null;
}

/** One entry of GitHub's status rollup: a check run (Actions, apps) or a commit status (older CI). */
interface RollupItem { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }

/** A rollup entry as pass | fail | cancel | skipping | pending. */
export function checkBucket(c: RollupItem): string {
	if (c.__typename === "StatusContext" || (c.state && !c.status)) {
		const st = (c.state ?? "").toUpperCase();
		return st === "SUCCESS" ? "pass" : st === "FAILURE" || st === "ERROR" ? "fail" : "pending";
	}
	if ((c.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
	const k = (c.conclusion ?? "").toUpperCase();
	if (k === "SUCCESS") return "pass";
	if (k === "SKIPPED" || k === "NEUTRAL") return "skipping";
	if (k === "CANCELLED") return "cancel";
	return "fail"; // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
}

/** The PR's checks; [] when the forge reports none, null when gh cannot say. `gh pr view --json
 *  statusCheckRollup` and not `gh pr checks --json`: older gh builds have no --json on pr checks. */
async function prChecks(pr: number, cwd: string): Promise<PrCheck[] | null> {
	const r = await sh(`gh pr view ${pr} --json statusCheckRollup`, cwd, 60_000);
	if (!r.ok) return null;
	try {
		const rows = (JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)) as { statusCheckRollup?: RollupItem[] | null }).statusCheckRollup;
		return (rows ?? []).map((c) => ({ name: c.name ?? c.context ?? "check", bucket: checkBucket(c), link: c.detailsUrl ?? c.targetUrl ?? "" }));
	} catch {
		return null;
	}
}

export type CiVerdict = { state: "green" | "none"; note: string } | { state: "red" | "running" | "unknown"; why: string };

/** Wait (bounded) for the PR's checks to settle. */
export const awaitPrChecks = (pr: number, cwd: string): Promise<CiVerdict> =>
	awaitChecks(() => publishWait.checks(pr, cwd), cwd, {
		who: `PR #${pr}`,
		read: `gh pr view ${pr} --json statusCheckRollup`,
		none: "no CI checks on the PR",
		green: "CI green",
		stuck: "a check whose job already finished on GitHub but still shows in_progress is a stale check run: pushing a new commit to the branch clears it",
	});

/** gh#271: wait (bounded) for the CI the merge commit started — a tag publishes from it, so it is cut on green only. */
export const awaitCommitChecks = (sha: string, cwd: string, branch?: string): Promise<CiVerdict> =>
	awaitChecks(() => publishWait.commitChecks(sha, cwd, branch), cwd, { who: `merge commit ${sha.slice(0, 9)}`, read: `gh run list --commit ${sha}`, none: "no CI ran on the merge commit", green: "merge-commit CI green" });

async function awaitChecks(read: () => Promise<PrCheck[] | null>, cwd: string, l: { who: string; read: string; none: string; green: string; stuck?: string }): Promise<CiVerdict> {
	const start = publishWait.clock();
	const mins = () => `${Math.max(1, Math.round((publishWait.clock() - start) / 60_000))} min`;
	// gh#275: when each check was first seen pending, and what its job concluded once asked — a check run GitHub left
	// at in_progress after its job finished burned three 30-min waits; it is taken at its job's word instead
	const since = new Map<string, number>();
	const settled = new Map<string, string>();
	const stale: string[] = [];
	for (;;) {
		const raw = await read();
		const elapsed = publishWait.clock() - start;
		const rows = raw?.map((c) => {
			if (c.bucket !== "pending") return c;
			const key = `${c.name}\u0000${c.link}`;
			const b = settled.get(key);
			return b ? { ...c, bucket: b } : c;
		}) ?? null;
		for (const c of rows ?? []) {
			if (c.bucket !== "pending" || !c.link) continue;
			const key = `${c.name}\u0000${c.link}`;
			const first = since.get(key) ?? elapsed;
			since.set(key, first);
			if (elapsed - first < publishWait.staleMs) continue;
			const b = await publishWait.probe(c.link, cwd);
			if (!b || b === "pending") continue;
			settled.set(key, b);
			stale.push(`${c.name}: its job concluded ${b} while the check still said in_progress`);
			c.bucket = b;
		}
		const staleNote = stale.length ? `; ${stale.join(", ")}` : "";
		if (rows === null) return { state: "unknown", why: `cannot read the checks of ${l.who} (${l.read})` };
		if (!rows.length) {
			if (elapsed >= publishWait.appearMs) return { state: "none", note: l.none };
		} else {
			const failed = rows.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
			if (failed.length) return { state: "red", why: `${l.who} checks failed — ${failed.map((c) => `${c.name}: ${c.bucket}${c.link ? ` (${c.link})` : ""}`).join(", ")}${staleNote}` };
			const pending = rows.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
			if (!pending.length) return { state: "green", note: `${l.green} (${rows.length} check${rows.length === 1 ? "" : "s"}${elapsed >= 60_000 ? `, waited ${mins()}` : ""}${staleNote})` };
			if (elapsed >= publishWait.budgetMs) return { state: "running", why: `${l.who} checks still running after ${mins()} (${pending.map((c) => c.name).join(", ")})${l.stuck ? ` — ${l.stuck}` : ""}` };
		}
		await publishWait.sleep(publishWait.pollMs);
	}
}

/** Does the gate publish this flow itself? Only on GitHub with a working gh, and unless the playbook says manual. */
export async function gatePublishes(cfg: Config, forgeName: string, root: string): Promise<boolean> {
	if (cfg.release.publish === "manual" || forgeName !== "github") return false;
	return (await sh("gh --version", root, 15_000)).ok;
}

/** gh#240: the repo's own pull-request template, when it has one (GitHub's single-file locations). */
export function prTemplate(cwd: string): string | null {
	for (const rel of [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE.md"])
		if (existsSync(path.join(cwd, rel))) return rel;
	return null;
}

/** The PR body the agent authored for the gate to open the PR with (gh#240). */
export const prBodyFile = (root: string, slug: string) => path.join(featDir(root, slug), "pr-body.md");

/** gh#240: a repo with a PR template keeps its gate list there — what changed, who verified it, over which
 *  commit. Synthesizing the body from the changelog dropped all of it, and the merged PR had to be patched
 *  afterwards. With a template and no authored body the gate refuses before the PR exists; null when fine. */
export function prBodyOwed(root: string, state: FlowState): string | null {
	const tpl = prTemplate(gateCwd(root, state));
	if (!tpl || existsSync(prBodyFile(root, state.slug))) return null;
	return `this repo has a pull-request template (${tpl}) and no PR body is written — flow release opens the PR itself, and a body synthesized from the changelog drops the template's sections. Write .dev-flow/${state.slug}/pr-body.md from ${tpl} (every section filled; the changelog entry, and the commit the operator's Verified? was given over), then re-run`;
}

async function prsFor(branch: string, cwd: string): Promise<Pr[] | null> {
	const r = await sh(`gh pr list --head ${sq(branch)} --state all --limit 20 --json number,state,url,headRefOid,mergeCommit`, cwd, 60_000);
	return r.ok ? jsonArray<Pr>(r.out) ?? (r.out.trim() ? null : []) : null;
}

/** Title for the PR: the newest commit on the branch that is more than release prep. */
async function prTitle(cwd: string, cfg: Config, slug: string): Promise<string> {
	const base = await mergeBase(cwd, cfg.defaultBranch);
	const log = await sh(`git log -n 30 --format=%H%x09%s ${base ? `${sq(base)}..HEAD` : "HEAD"}`, cwd);
	const rows = log.ok ? log.out.split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
	for (const [sha, subject] of rows) {
		const files = (await sh(`git diff-tree --no-commit-id --name-only -r ${sq(sha)}`, cwd)).out.split("\n").filter(Boolean);
		if (!prepOnlyChange(cfg, files)) return subject;
	}
	return rows[0]?.[1] ?? slug;
}

/** Body for the PR: the authored .dev-flow/<slug>/pr-body.md (gh#240), else the changelog entry of the version
 *  being released, else the branch's commit subjects. */
async function prBody(root: string, cwd: string, cfg: Config, state: FlowState): Promise<string> {
	const authored = prBodyFile(root, state.slug);
	if (existsSync(authored)) return readFileSync(authored, "utf8").trim();
	const file = cfg.release.changelog ? path.join(cwd, cfg.release.changelog) : "";
	const entry = pickReleaseNotes({ changelog: file && existsSync(file) ? readFileSync(file, "utf8") : null, version: state.releaseVersion ?? (cfg.versioning.file ? await versionAt("HEAD", cfg.versioning.file, cwd) : null), annotation: "" }).notes;
	if (entry) return entry;
	const base = await mergeBase(cwd, cfg.defaultBranch);
	const log = await sh(`git log -n 30 --format='- %s' ${base ? `${sq(base)}..HEAD` : "HEAD"}`, cwd);
	return log.ok ? log.out.trim() : "";
}

/** The version `file` says at `ref`, or null when it is not there. */
async function versionAt(ref: string, file: string, cwd: string): Promise<string | null> {
	const r = await sh(`git show ${sq(`${ref}:${file}`)} 2>/dev/null`, cwd);
	return r.ok && r.out.trim() ? parseVersion(file, r.out) : null;
}

/** The release call against the version `file` says at `ref` — what the tag would be — counted from the newest
 *  tag. Null when it holds (or there is no call to prove); `version` is what `ref` carries. */
async function callAt(ref: string, base: string | null, state: FlowState, cfg: Config, tags: string[], cwd: string): Promise<{ version: string | null; bad: { error: string; want?: string } | null }> {
	const file = cfg.versioning.file!;
	const version = await versionAt(ref, file, cwd);
	const newest = newestTaggedVersion(cfg.versioning.pattern, tags);
	const baseVer = base ? await versionAt(base, file, cwd) : null;
	const bad = state.versionChoice ? releaseCallProof(state.versionChoice, version, newest ? cfg.versioning.pattern.replace("{version}", newest) : null, baseVer, file) : null;
	return { version, bad };
}

export type PublishResult = { ok: true; log: string } | { ok: false; text: string };

/** gh#259: the files a merge of `HEAD` into `origin/<default>` would conflict in, from a fresh fetch — [] when it
 *  merges clean, null when this git cannot say (merge-tree --write-tree needs git 2.38) or origin is unreachable.
 *  A conflict was found by gh pr merge after the whole CI wait, though it was true before the push. */
export async function mergeConflicts(wt: string, defaultBranch: string): Promise<string[] | null> {
	if (!(await sh(`git fetch -q origin ${sq(defaultBranch)}`, wt, 5 * 60_000)).ok) return null;
	const r = await sh(`git merge-tree --write-tree --name-only --no-messages ${sq(`origin/${defaultBranch}`)} HEAD`, wt);
	if (r.ok) return [];
	// exit 1 with a tree id on the first line is "conflicts"; anything else (an old git, a bad ref) is not an answer
	const lines = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!/^[0-9a-f]{40,64}$/.test(lines[0] ?? "")) return null;
	return [...new Set(lines.slice(1))];
}

/** GitHub's own verdict on an open PR: CONFLICTING is the one that stops; UNKNOWN (still computing) does not. */
async function prConflicting(pr: number, cwd: string): Promise<boolean> {
	const r = await sh(`gh pr view ${pr} --json mergeable`, cwd, 60_000);
	return r.ok && /"mergeable"\s*:\s*"CONFLICTING"/.test(r.out);
}

/** Push, PR, CI, merge, tag — each step skipped when the forge already shows it done. On success the caller
 *  records the release (release-done's proofs). A refusal starts with `publish stopped —` (something to fix)
 *  or `publish waiting —` (CI still running: re-run to keep waiting). */
export async function publishRelease(root: string, state: FlowState, cfg: Config): Promise<PublishResult> {
	const wt = gateCwd(root, state);
	const br = state.branch;
	const steps: string[] = [];
	const stop = (why: string, next: string): PublishResult => ({ ok: false, text: `publish stopped — ${why}${steps.length ? `\ndone so far: ${steps.join(" · ")}` : ""}\n↪ next: ${next}; then re-run flow release — it resumes where it stopped` });
	if (!br) return stop("the feature has no branch on record", "check flow status");
	const head = (await sh("git rev-parse HEAD", wt)).out.trim();
	const find = async (): Promise<{ merged?: Pr; open?: Pr } | null> => {
		const prs = await prsFor(br, wt);
		if (!prs) return null;
		// a slug used before has an old merged PR under the same branch name: only a PR of this head counts
		return { merged: prs.find((p) => p.state === "MERGED" && p.headRefOid === head), open: prs.find((p) => p.state === "OPEN") };
	};
	let found = await find();
	if (!found) return stop(`cannot list the pull requests of ${br} (gh pr list)`, "check gh auth status");
	let merged = found.merged;
	if (merged) steps.push(`PR #${merged.number} already merged`);
	else {
		// gh#259: a conflict with the default branch is known before the push — never spend the CI wait to learn it
		const d = cfg.defaultBranch;
		const conflicts = await mergeConflicts(wt, d);
		// the call, proven on what would merge: a flow that released since Release? moves the number, and the branch
		// must say so before anything is pushed — never a tag that disagrees with the version file it lands on
		const versioned = !state.noVersion && !!cfg.versioning.file;
		const tagsNow = versioned ? await releaseTags(root) : [];
		if (tagsNow === null) return stop("cannot list tags on origin", "check the network and git credentials");
		const atHead = versioned ? await callAt("HEAD", await mergeBase(wt, d), state, cfg, tagsNow, wt) : null;
		const want = atHead?.bad?.want ? ` and set ${cfg.versioning.file} to ${atHead.bad.want} (the release call, ${state.versionChoice}, counted from the newest tag)${cfg.release.changelog ? ` with its ${cfg.release.changelog} heading` : ""}` : "";
		const resolve = `merge origin/${d} into ${br} in the worktree (git merge origin/${d}), resolve the conflicts — keep both sides' changelog lines${want || (versioned ? "; the version file stays one step of the release call past the newest tag" : "")} — and commit`;
		if (conflicts?.length) return stop(`${br} conflicts with origin/${d} in ${conflicts.join(", ")} — the merge would be refused after the CI wait, so nothing was pushed`, resolve);
		if (atHead?.bad) return stop(`${atHead.bad.error} — nothing was merged`, atHead.bad.want ? `set ${cfg.versioning.file} to ${atHead.bad.want}${cfg.release.changelog ? ` and its ${cfg.release.changelog} heading` : ""} on ${br} (merge origin/${d} first if it moved) and commit` : "fix the version on the branch and commit");
		const remote = await sh(`git ls-remote origin ${sq(`refs/heads/${br}`)}`, wt, 60_000);
		if (!remote.ok) return stop(`cannot reach origin:\n${tail(remote.out, 5)}`, "check the network and git credentials");
		if (remote.out.split(/\s/)[0] === head) steps.push("branch already on origin");
		else {
			const push = await sh(`git push -u origin ${sq(br)}`, wt);
			if (!push.ok) return stop(`pushing ${br} failed:\n${tail(push.out, 8)}`, `push the branch yourself (a branch rebased after an earlier push needs git push --force-with-lease origin ${br})`);
			steps.push("branch pushed");
		}
		let pr = found.open;
		if (pr) steps.push(`PR #${pr.number} already open`);
		else {
			const owed = prBodyOwed(root, state);
			if (owed) return stop(owed, `write .dev-flow/${state.slug}/pr-body.md`);
			const authored = existsSync(prBodyFile(root, state.slug));
			const body = await prBody(root, wt, cfg, state);
			const create = await sh(`gh pr create --head ${sq(br)} --base ${sq(cfg.defaultBranch)} --title ${sq(await prTitle(wt, cfg, state.slug))} --body ${sq(body || state.slug)}`, wt);
			if (!create.ok) return stop(`opening the PR failed:\n${tail(create.out, 8)}`, "open the PR yourself");
			found = await find();
			pr = found?.open;
			if (!pr) return stop("the PR was created but gh pr list does not show it yet", "wait a moment");
			steps.push(`PR #${pr.number} opened (body: ${authored ? "your pr-body.md" : "the changelog entry"})`);
		}
		state.publish = { ...state.publish, pr: pr.number };
		writeState(root, state);
		// the forge's view too: the default branch can move between the local check and the PR
		if (await prConflicting(pr.number, wt)) return stop(`PR #${pr.number} has merge conflicts with ${d} — the merge would be refused after the CI wait`, resolve);
		const ci = await awaitPrChecks(pr.number, wt);
		if (!("why" in ci)) steps.push(ci.note);
		else if (ci.state === "running") return { ok: false, text: `publish waiting — ${ci.why}${steps.length ? `\ndone so far: ${steps.join(" · ")}` : ""}\n↪ next: re-run flow release to keep waiting — do not end the turn on a promise to watch` };
		else if (ci.state === "red") return stop(ci.why, "fix it on the branch (commit, flow release pushes it) or re-run the failed job");
		else return stop(ci.why, "check gh auth status, or merge the PR yourself once CI is green");
		const policy = cfg.release.merge && cfg.release.merge !== "any" ? [cfg.release.merge] : (["merge", "squash", "rebase"] as const);
		let mergeOut = "";
		let style = "";
		for (const s of policy) {
			const m = await sh(`gh pr merge ${pr.number} --${s}`, wt);
			if (m.ok) {
				style = s;
				break;
			}
			mergeOut = m.out;
		}
		if (!style) return stop(`merging PR #${pr.number} failed${policy.length === 1 ? ` (--${policy[0]})` : ""}:\n${tail(mergeOut, 8)}`, `get the PR merged (a required review or a merge queue is the forge's rule, not the gate's)`);
		// the forge may take a moment to report the merge commit
		for (let i = 0; i < 6 && !merged; i++) {
			merged = (await find())?.merged;
			if (!merged?.mergeCommit?.oid) {
				merged = undefined;
				await publishWait.sleep(2_000);
			}
		}
		if (!merged) return stop(`PR #${pr.number} was merged but the forge does not show its merge commit yet`, "wait a moment");
		steps.push(`merged (${style})`);
	}
	const oid = merged.mergeCommit?.oid ?? "";
	state.publish = { ...state.publish, pr: merged.number, merged: oid };
	writeState(root, state);
	await sh(`git fetch -q origin ${sq(cfg.defaultBranch)}`, root, 5 * 60_000);
	if (!state.noVersion && cfg.versioning.file) {
		const tags = await releaseTags(root);
		if (tags === null) return stop("cannot list tags on origin", "check the network and git credentials");
		// the version of record is the merged tree's own: read now, never pinned at Release? (a merge of the default
		// branch after it may have re-bumped), and held to the release call once more before anything is tagged
		if (!oid) return stop(`PR #${merged.number} shows no merge commit to tag`, "tag what shipped yourself (git tag -a <tag>) and push it");
		if (!(await sh(`git cat-file -e ${sq(`${oid}^{commit}`)}`, root)).ok) return stop(`the merge commit ${oid.slice(0, 9)} of PR #${merged.number} is not in this clone after a fetch`, `git fetch origin ${cfg.defaultBranch}`);
		const atMerge = await callAt(oid, `${oid}^1`, state, cfg, tags, root);
		if (!atMerge.version) return stop(`${cfg.versioning.file} has no parsable version at the merge commit ${oid.slice(0, 9)} — the tag was not cut`, "fix it forward on the default branch, then tag by hand");
		const tag = cfg.versioning.pattern.replace("{version}", atMerge.version);
		if (tags.includes(tag)) {
			// a resume finds its own tag on the merge commit; the same name on another commit is another flow's release
			const at = await sh(`git ls-remote origin ${sq(`refs/tags/${tag}`)} ${sq(`refs/tags/${tag}^{}`)}`, root, 60_000);
			const rows = at.out.split("\n").map((l) => l.split(/\s+/)).filter((r) => r.length >= 2);
			const sha = (rows.find((r) => r[1].endsWith("^{}")) ?? rows[0])?.[0] ?? "";
			if (at.ok && sha && sha !== oid) return stop(`merged, but the tag was not cut: ${tag} is already on origin at ${sha.slice(0, 9)}, not on the merge commit ${oid.slice(0, 9)} — another release took that number`, "tell the operator; fix the version forward in a new flow");
			state.releaseVersion = atMerge.version;
			steps.push(`tag ${tag} already on origin`);
		} else {
			if (atMerge.bad) return stop(`merged, but the tag was not cut: ${atMerge.bad.error} (at the merge commit ${oid.slice(0, 9)})`, "tell the operator — a release landed since this branch was checked; fix the version forward in a new flow, or tag by hand on their word");
			state.releaseVersion = atMerge.version;
			// gh#271: the tag publishes from the merge commit — wait for that commit's own CI before cutting it, so a
			// playbook rule "test green on the merge commit before the tag" is something this gate can honour
			if (oid && cfg.release.tagWait !== "none") {
				const ci = await awaitCommitChecks(oid, root, cfg.defaultBranch);
				if (!("why" in ci)) steps.push(ci.note);
				else if (ci.state === "running") return { ok: false, text: `publish waiting — ${ci.why}; the tag waits for it${steps.length ? `\ndone so far: ${steps.join(" · ")}` : ""}\n↪ next: re-run flow release to keep waiting — do not end the turn on a promise to watch` };
				else if (ci.state === "red")
					return stop(`${ci.why} — merged, but the tag was not cut: it would publish a red build`, `tell the operator. A flaky job: re-run it (gh run rerun --failed <run>), then re-run flow release, which tags on green. A real failure is fixed forward in a new flow, and the tag goes on the fix by the operator's word (or tagWait = none under ## release for a project whose tag publishes nothing)`);
				else return stop(ci.why, "check gh auth status, or tag the merge commit yourself once its CI is green");
			}
			const local = await sh(`git rev-parse -q --verify ${sq(`refs/tags/${tag}^{commit}`)}`, root);
			if (local.ok && local.out.trim() !== oid) return stop(`a local tag ${tag} points at ${local.out.trim().slice(0, 9)}, not the merge commit ${oid.slice(0, 9)}`, `git tag -d ${tag} if it is a leftover`);
			if (!local.ok) {
				// the merge commit by sha, not origin/<default>: a parallel flow that landed after it stays out of the tag
				const mk = await sh(`git tag -a ${sq(tag)} -m ${sq(tag)} ${sq(oid)}`, root);
				if (!mk.ok) return stop(`creating tag ${tag} failed:\n${tail(mk.out, 5)}`, "fix what git reports");
			}
			const pushTag = await sh(`git push origin ${sq(`refs/tags/${tag}`)}`, root);
			if (!pushTag.ok) return stop(`pushing tag ${tag} failed:\n${tail(pushTag.out, 5)}`, `git push origin ${tag}`);
			steps.push(`tag ${tag} pushed`);
		}
		state.publish = { ...state.publish, tag };
		writeState(root, state);
	}
	return { ok: true, log: `published: ${steps.join(" · ")}` };
}
