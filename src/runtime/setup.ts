/** dev-flow runtime — flow init's setup questions and repo evidence. Moved out of extensions/dev-flow.ts as is (exports added). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Detection } from "../detect.ts";
import { AGENT_MARK } from "../present.ts";
import { sh } from "./base.ts";

/** Is this checkout the dev-flow repo itself? Plugin reflections are fixable in-repo only here. */
export function isSelfRepo(root: string): boolean {
	try {
		return (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown }).name === "pi-dev-flow";
	} catch {
		return false;
	}
}

/** Which tag convention the repo already uses — read off its newest tags, like the merge style is read off
 *  its history. null = no version-like tags yet (the v{version} default stands, and is asked about). */
export async function tagPatternEvidence(root: string): Promise<{ pattern: string; note: string } | null> {
	const r = await sh("git tag --list --sort=-creatordate", root, 10_000);
	if (!r.ok) return null;
	const tags = r.out.split("\n").map((t) => t.trim()).filter((t) => /\d+\.\d+\.\d+/.test(t)).slice(0, 20);
	if (!tags.length) return null;
	const prefix = (t: string) => t.slice(0, t.search(/\d+\.\d+\.\d+/));
	const counts = new Map<string, number>();
	for (const t of tags) counts.set(prefix(t), (counts.get(prefix(t)) ?? 0) + 1);
	const [top] = [...counts.entries()].sort((x, y) => y[1] - x[1]);
	return { pattern: `${top[0]}{version}`, note: `${tags.length} version tag(s), newest ${tags[0]}${counts.size > 1 ? ` (mixed prefixes: ${[...counts.keys()].map((k) => k || "none").join(", ")})` : ""}` };
}

/** One setup question: what to ask, what detection found, why it matters, and the answer that accepts it. */
export interface SetupQuestion {
	key: string;
	ask: string;
	detected?: string;
	/** `flow init --answers` token(s) that accept the detected/suggested value */
	accept?: string;
	why: string;
}

/** The questions `flow init` asks before writing a playbook — detection fills what it can, the operator
 *  answers the rest (the agent relays them). Every question says why it matters and what skipping costs,
 *  so it is answerable without reading docs/playbook.md first. */
export function setupQuestions(det: Detection, ev: { merge?: { note: string; recent: string | null } | null; tag?: { pattern: string; note: string } | null }): SetupQuestion[] {
	const sug = (k: string) => det.suggestions.filter((x) => x.key === k);
	const q: SetupQuestion[] = [];
	const forge = det.partial.forge;
	q.push({ key: "forge", ask: "Where is the repo hosted: github, gitlab or self (plain git)?", detected: forge ? `${forge} (from the origin URL)` : "no origin remote", accept: forge ? `forge=${forge}` : undefined, why: "decides who creates the release and how dev-flow proves a PR really merged (gh/glab); self = git only, no automatic releases" });
	const vf = det.partial.versioning?.file;
	q.push({ key: "versionFile", ask: vf ? `Version lives in ${vf} — keep it?` : "Which file holds the version? (VERSION recommended for non-package repos; or answer that releases carry no version)", detected: vf, accept: vf ? `versionFile=${vf}` : undefined, why: "a release bumps this file and the tag must match it; without one, every release is merge-only (no bump, no tag)" });
	const tag = ev.tag?.pattern ?? "v{version}";
	q.push({ key: "versionTag", ask: `Tag pattern: ${tag}?`, detected: ev.tag ? `${ev.tag.note}` : "no version tags yet — default v{version}", accept: `versionTag=${tag}`, why: "release tags and the manifest are checked against each other; a pattern that differs from your existing tags breaks the last-release lookup" });
	q.push({ key: "merge", ask: "How should a merged PR land on the default branch: squash, merge (a merge commit), rebase, or any (no policy)?", detected: ev.merge?.note ?? "no history to read a style from", accept: ev.merge?.recent ? `merge=${ev.merge.recent}` : undefined, why: "the guard blocks a PR merge in a different style and release-done proves what landed; flow start refuses until this is answered" });
	q.push({ key: "releases", ask: "Should release-done create the forge release automatically (gh/glab release from the changelog entry)?", detected: forge === "self" ? "forge = self: no CLI to create one" : undefined, accept: forge === "self" ? "releases=false" : "releases=true", why: "off = the tag is pushed and publishing the release page stays your manual step" });
	const art = sug("artifact");
	q.push({ key: "artifact", ask: art.length ? "Verify the published artifact after release with this command?" : "Do you publish anything to a registry (npm, crates.io, a container image)? If so, which command proves the version is out?", detected: art.map((a) => a.why).join("; ") || undefined, accept: art[0] ? `artifact=${art[0].value}` : undefined, why: "release-done refuses to finish until the artifact is really there — catches a CI publish that silently failed; none = no check" });
	const pre = sug("preflight");
	if (pre.length) q.push({ key: "preflight", ask: `Run \`${pre[0].value}\` before anything ships?`, detected: pre[0].why, accept: `preflight=${pre[0].value}`, why: "flow release runs it in the worktree first — a build the tag would trigger, proven before the tag exists" });
	const checks = det.partial.checks ?? {};
	q.push({
		key: "check.<name>",
		ask: `Tier-1 checks: ${det.missing.length ? `not detected: ${det.missing.join(", ")}` : "test/build/run detected"}${Object.keys(checks).length ? `; drafted extra checks: ${Object.keys(checks).join(", ")}` : ""}. Correct? Anything CI runs that is missing (lint, typecheck, e2e)?`,
		detected: Object.entries(det.partial.commands).filter(([k]) => k !== "setup").map(([k, v]) => `${k}: ${v}`).join(" · ") || undefined,
		why: "flow check runs every one of these and the gates refuse while any fails — a check missing here is a failure only CI will see; answer test=… / build=… / check.<name>=<cmd> (empty value removes)",
	});
	const dev = sug("dev");
	q.push({ key: "health", ask: `Does the app expose a health probe (e.g. curl -fs localhost:PORT/healthz)?${dev.length ? ` And use \`${dev[0].value}\` as the dev deploy reviewed before verify?` : " Is there a dev deploy reviewed before verify?"}`, detected: dev[0]?.why, accept: dev[0] ? `dev=${dev[0].value}` : undefined, why: "verify proves the running build is healthy only with a probe; none is fine for libraries and CLIs" });
	if (det.partial.changelog === "") q.push({ key: "changelog", ask: "No changelog found — create CHANGELOG.md, or run without one?", accept: "changelog=", why: "the release gates fold the branch's entry into the version heading; empty = no changelog checks at all" });
	q.push({ key: "guard", ask: `Any commands the agent must never run, or files it must never touch?${det.partial.guards?.length ? ` (drafted from disk: ${det.partial.guards.map((g) => g.split(" :: ")[0].replace(/\s+/g, " ")).join(", ")})` : ""}`, why: "flow-guard rules are hard blocks or operator confirmations on every shell call and edit; added with flow init --write-file (free text)" });
	q.push({ key: "checklist", ask: "Anything you want to tick off by hand per stage (e.g. 'migration tested on a prod copy'), or standing guidance the agent should read at a stage?", why: "checklist items are confirmed as a set at the gate; prose is injected when the stage begins — both are free text: flow init --write-file" });
	return q;
}

export function renderQuestions(qs: SetupQuestion[]): string[] {
	const out: string[] = [];
	qs.forEach((x, i) => {
		out.push(`  ${i + 1}. [${x.key}] ${x.ask}`);
		if (x.detected) out.push(`     detected: ${x.detected}`);
		if (x.accept) out.push(`     accept: ${x.accept}`);
		out.push(`     why: ${x.why}`);
	});
	return out;
}

export const GIT_TRACK_NOTE = AGENT_MARK + 'the playbook belongs in git: git add -f .dev-flow/project.md && DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md" (force-add: a root .gitignore may exclude .dev-flow/ entirely — tracked once, the ignore stops mattering; the env prefix is for the pre-commit hook, dev-flow itself lets a main commit whose only change is the playbook)';
