/** dev-flow runtime — the release stage, run by the gate. After Release? is answered the agent used to push,
 *  open the PR, watch CI, merge in the playbook's style, tag and push the tag by hand; most of release.md was a
 *  list of past mistakes in those steps. `flow release` now runs them itself on GitHub. Every step first asks
 *  the forge whether it is already done, so a re-run resumes and a step done by hand is accepted. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pickReleaseNotes, prepOnlyChange, sq } from "../core.ts";
import type { Config, FlowState } from "../core.ts";
import { gateCwd, mergeBase, releaseTags, sh, tail, writeState } from "./base.ts";

/** How long the gate waits on a PR's CI; a seam so tests run in milliseconds (same shape as artifactWait). */
export const publishWait = {
	budgetMs: 30 * 60_000,
	pollMs: 20_000,
	/** a PR opened seconds ago may have no check yet: look this long before deciding the repo has none */
	appearMs: 60_000,
	sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
	clock: () => Date.now(),
	checks: (pr: number, cwd: string): Promise<PrCheck[] | null> => prChecks(pr, cwd),
};

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

/** The PR's checks; [] when the forge reports none, null when gh cannot say. */
async function prChecks(pr: number, cwd: string): Promise<PrCheck[] | null> {
	const r = await sh(`gh pr checks ${pr} --json name,bucket,link`, cwd, 60_000);
	const rows = jsonArray<PrCheck>(r.out);
	if (rows) return rows;
	return /no checks reported/i.test(r.out) ? [] : null;
}

export type CiVerdict = { state: "green" | "none"; note: string } | { state: "red" | "running" | "unknown"; why: string };

/** Wait (bounded) for the PR's checks to settle. */
export async function awaitPrChecks(pr: number, cwd: string): Promise<CiVerdict> {
	const start = publishWait.clock();
	const mins = () => `${Math.max(1, Math.round((publishWait.clock() - start) / 60_000))} min`;
	for (;;) {
		const rows = await publishWait.checks(pr, cwd);
		const elapsed = publishWait.clock() - start;
		if (rows === null) return { state: "unknown", why: `cannot read the checks of PR #${pr} (gh pr checks ${pr})` };
		if (!rows.length) {
			if (elapsed >= publishWait.appearMs) return { state: "none", note: "no CI checks on the PR" };
		} else {
			const failed = rows.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
			if (failed.length) return { state: "red", why: `PR #${pr} checks failed — ${failed.map((c) => `${c.name}: ${c.bucket}${c.link ? ` (${c.link})` : ""}`).join(", ")}` };
			const pending = rows.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
			if (!pending.length) return { state: "green", note: `CI green (${rows.length} check${rows.length === 1 ? "" : "s"}${elapsed >= 60_000 ? `, waited ${mins()}` : ""})` };
			if (elapsed >= publishWait.budgetMs) return { state: "running", why: `PR #${pr} checks still running after ${mins()} (${pending.map((c) => c.name).join(", ")})` };
		}
		await publishWait.sleep(publishWait.pollMs);
	}
}

/** Does the gate publish this flow itself? Only on GitHub with a working gh, and unless the playbook says manual. */
export async function gatePublishes(cfg: Config, forgeName: string, root: string): Promise<boolean> {
	if (cfg.release.publish === "manual" || forgeName !== "github") return false;
	return (await sh("gh --version", root, 15_000)).ok;
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

/** Body for the PR: the changelog entry of the version being released, else the branch's commit subjects. */
async function prBody(cwd: string, cfg: Config, state: FlowState): Promise<string> {
	const file = cfg.release.changelog ? path.join(cwd, cfg.release.changelog) : "";
	const entry = pickReleaseNotes({ changelog: file && existsSync(file) ? readFileSync(file, "utf8") : null, version: state.releaseVersion ?? null, annotation: "" }).notes;
	if (entry) return entry;
	const base = await mergeBase(cwd, cfg.defaultBranch);
	const log = await sh(`git log -n 30 --format='- %s' ${base ? `${sq(base)}..HEAD` : "HEAD"}`, cwd);
	return log.ok ? log.out.trim() : "";
}

export type PublishResult = { ok: true; log: string } | { ok: false; text: string };

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
			const body = await prBody(wt, cfg, state);
			const create = await sh(`gh pr create --head ${sq(br)} --base ${sq(cfg.defaultBranch)} --title ${sq(await prTitle(wt, cfg, state.slug))} --body ${sq(body || state.slug)}`, wt);
			if (!create.ok) return stop(`opening the PR failed:\n${tail(create.out, 8)}`, "open the PR yourself");
			found = await find();
			pr = found?.open;
			if (!pr) return stop("the PR was created but gh pr list does not show it yet", "wait a moment");
			steps.push(`PR #${pr.number} opened`);
		}
		state.publish = { ...state.publish, pr: pr.number };
		writeState(root, state);
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
	if (state.releaseVersion && !state.noVersion) {
		const tag = cfg.versioning.pattern.replace("{version}", state.releaseVersion);
		const tags = await releaseTags(root);
		if (tags === null) return stop("cannot list tags on origin", "check the network and git credentials");
		if (tags.includes(tag)) steps.push(`tag ${tag} already on origin`);
		else {
			if (!oid) return stop(`PR #${merged.number} shows no merge commit to tag`, `tag what shipped yourself (git tag -a ${tag}) and push it`);
			if (!(await sh(`git cat-file -e ${sq(`${oid}^{commit}`)}`, root)).ok) return stop(`the merge commit ${oid.slice(0, 9)} of PR #${merged.number} is not in this clone after a fetch`, `git fetch origin ${cfg.defaultBranch}`);
			if (!(await sh(`git rev-parse -q --verify ${sq(`refs/tags/${tag}`)}`, root)).ok) {
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
