import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildConfig } from "./util/config.ts";
import { mdToConfig, parseProjectMd } from "../src/projectmd.ts";
import {
	applyAnswer,
	appendReflection,
	approveGate,
	foreignWorktreeLinks,
	bashSegments,
	bashFlowGuard,
	featureTmpDir,
	featureTmpEnv,
	withTmpDir,
	checklistHash,
	checkoutInvocation,
	claimBlocks,
	classifyMergeHistory,
	mergeShapeProof,
	mergeStyleInvocation,
	parseMergeStyle,
	changelogEntry,
	cmpVersions,
	DEFAULTS,
	detectForge,
	featureBranchPrefix,
	FLOW_SHELL_HINT,
	flowShellInvocation,
	forcePushInvocation,
	freshenChecks,
	checkFingerprint,
	gateHelpJson,
	gitInvocation,
	githubSlug,
	guardBash,
	guardPath,
	type GuardRules,
	healthRetry,
	investigationBrief,
	looksLikeShellError,
	maskQuoted,
	needsOperator,
	nextHint,
	applicableItems,
	checklistPending,
	parsePushRefs,
	playbookTamper,
	pluginVersion,
	preReleaseGate,
	unreleasedPending,
	pendingEntryLines,
	missingFoldedLines,
	normalizeEntryLine,
	normalizeReleaseBody,
	pickReleaseNotes,
	newState,
	newestTaggedVersion,
	parseLsRemoteTags,
	parseVersion,
	pidAlive,
	playbookOnlyChange,
	sessionRunsOlderBuild,
	changelogVersionsBetween,
	inScratchDir,
	mainCheckoutRoot,
	parseWorkerReport,
	workerTurnError,
	workerOpError,
	clampBudgetMin,
	tagCreates,
	releaseOrderInvocation,
	guessReflectSections,
	reflectItems,
	reflectMove,
	reflectProtocol,
	reflectUnfiledCount,
	reflectionLine,
	reflectionRoutes,
	releaseGate,
	shouldSelfCompact,
	shouldTakeOverCompaction,
	stateTamper,
	statusCompact,
	statusFor,
	statusJson,
	stripHeredocBodies,
	DF_ADVISORY_FILES,
	sq,
	tagNotesCommand,
	openChecklistItems,
	doneItemCount,
	reflectionsTidy,
	reflectionsTidyHint,
	reflectionNudges,
	reflectLegacyPluginCount,
	pluginIssueRecipe,
	REFLECT_HEADER,
	childSessionFiles,
	buildReflectBrief,
	buildWorkerBrief,
	digestTranscript,
	conflictMarkerLines,
	reflectDone,
	workerSteer,
	parseReflectReport,
	renderReflectFindings,
	appendRoadmapItem,
	roadmapBriefFor,
	roadmapDone,
	roadmapDoneForSlug,
	roadmapOpenCount,
	roadmapPick,
	roadmapTidy,
	verifyGate,
	versionTagGate,
	widgetLines,
	chipLabel,
	writeGuard,
	stageGuidance,
	DEFAULT_STAGE_GUIDANCE,
	extractSkillCore,
	stageReference,
	SKILL_CORE_START,
	SKILL_CORE_END,
	formatSize,
	parseSize,
	servedBuildMatches,
	sideBySide,
} from "../src/core.ts";

const cfg = structuredClone(DEFAULTS);

test("buildConfig fills defaults and merges partial overrides", () => {
	const c = buildConfig({ defaultBranch: "master", commands: { test: "bun test" }, release: { changelog: "CHANGELOG.md" } });
	assert.equal(c.defaultBranch, "master");
	assert.equal(c.commands.test, "bun test");
	assert.equal(c.commands.build, undefined);
	assert.equal(c.release.changelog, "CHANGELOG.md");
	assert.equal(c.release.review, "/flow-review"); // kept from defaults
	assert.equal(buildConfig(null).defaultBranch, "main");
});

test("stageGuidance: the built-in implement discipline, operator prose replaces it", () => {
	assert.ok(stageGuidance(cfg, "implement"), "implement ships a built-in default");
	assert.equal(stageGuidance(cfg, "implement")!.source, "dev-flow default");
	assert.ok(DEFAULT_STAGE_GUIDANCE.implement!.includes("shortcut:"), "the default carries the shortcut marker convention flow-review honors");
	for (const stage of ["plan", "pre-release", "release"] as const)
		assert.equal(stageGuidance(cfg, stage), undefined, `${stage} has no built-in discipline`);
	const owned = structuredClone(DEFAULTS);
	owned.prose = { implement: "mind the vendored code" };
	assert.equal(stageGuidance(owned, "implement")!.text, "mind the vendored code", "operator prose replaces the default");
	assert.equal(stageGuidance(owned, "implement")!.source, "project.md");
});

test("extractSkillCore: the block between the markers, nothing else", () => {
	const md = `---\nname: dev-flow\n---\n\n${SKILL_CORE_START}\n\n# rules\n\nflow is a tool\n\n${SKILL_CORE_END}\n\n## map\n\nnot injected\n`;
	assert.equal(extractSkillCore(md), "# rules\n\nflow is a tool", "front matter and the stage map stay out of the injection");
	assert.equal(extractSkillCore("# a skill with no markers"), null, "no markers means inject nothing");
	assert.equal(extractSkillCore(`${SKILL_CORE_END}\nupside down\n${SKILL_CORE_START}`), null, "reversed markers are not a core");
	assert.equal(extractSkillCore(`${SKILL_CORE_START}\n   \n${SKILL_CORE_END}`), null, "an empty core injects nothing");
});

test("stageReference: every stage names its own playbook file", () => {
	assert.equal(stageReference("plan"), "references/plan.md");
	assert.equal(stageReference("implement"), "references/implement.md");
	assert.equal(stageReference("pre-release"), "references/pre-release.md");
	assert.equal(stageReference("release"), "references/release.md", "the release stage reads release.md, which hands over to finish.md");
});

test("healthRetry: the wait budget becomes attempts at the probe interval (#42)", () => {
	assert.deepEqual(healthRetry(0), { attempts: 1, delayMs: 2000 }, "healthWait 0 keeps the single shot");
	assert.deepEqual(healthRetry(30), { attempts: 16, delayMs: 2000 }, "the default: one shot plus a retry every 2s");
	assert.deepEqual(healthRetry(5), { attempts: 4, delayMs: 2000 });
	assert.deepEqual(healthRetry(60, 5), { attempts: 13, delayMs: 5000 });
	assert.deepEqual(healthRetry(-3), { attempts: 1, delayMs: 2000 }, "a junk budget is a single shot");
});

test("healthWait: playbook knob reaches the config", () => {
	assert.equal(DEFAULTS.healthWait, 30, "default: the gate waits, so a booting service is not a failing one");
	assert.equal(buildConfig({ healthWait: 45 }).healthWait, 45);
	assert.equal(buildConfig({ healthWait: "45" }).healthWait, 45, "project.md values arrive as strings");
	assert.equal(buildConfig({ healthWait: "soon" }).healthWait, 30, "junk falls back to the default");
});

test("newState stamps the dev-flow build when supplied", () => {
	assert.equal(newState("f", false, false, false, "1.2.3").flowVersion, "1.2.3");
	assert.equal("flowVersion" in newState("f", false), false, "no stamp supplied → field absent");
});

test("approveGate requires plan.md, rendered mockups when ui", () => {
	const s = newState("f", false);
	assert.ok(approveGate(s, cfg, []).length > 0);
	assert.ok(approveGate(s, cfg, ["pre-plan.md", "direction.md"]).some((e) => /plan\.md/.test(e)), "a pre-plan/direction file is not the plan — the gate names plan.md");
	assert.equal(approveGate(s, cfg, ["plan.md"]).length, 0);
	const su = newState("f", true);
	assert.ok(approveGate(su, cfg, ["plan.md"]).length > 0, "ui feature without a render must not pass");
	assert.ok(approveGate(su, cfg, ["plan.md", "mockups/screen.html"]).length > 0, "html source alone is not evidence of a render");
	assert.equal(approveGate(su, cfg, ["plan.md", "mockups/screen-390.png"]).length, 0, "no planDoc passed → embed proofs stay back-compat skipped");
	const doc = "# plan\n![screen — phone](mockups/screen-390.png)\n";
	assert.equal(approveGate(su, cfg, ["plan.md", "mockups/screen-390.png"], doc).length, 0);
	assert.ok(approveGate(su, cfg, ["plan.md", "mockups/screen-390.png"], "# plan\nno images here").some((e) => /screen-390\.png/.test(e)), "a render nobody embedded was never shown to the operator");
	assert.equal(approveGate(su, cfg, ["plan.md", "mockups/screen-390.PNG"], '![s](mockups/screen-390.PNG "t")').length, 0, "case-insensitive glob and embed; an optional title is tolerated");
	assert.ok(approveGate(su, cfg, ["plan.md", "mockups/screen.html", "mockups/other-390.png"], "![o](mockups/other-390.png)").some((e) => /screen\.html/.test(e)), "screen.html without a screen-* shot is an unrendered mockup");
	const doc2 = doc + "![screen — desktop](mockups/screen-1280.png)\n";
	assert.equal(approveGate(su, cfg, ["plan.md", "mockups/screen.html", "mockups/screen-390.png", "mockups/screen-1280.png"], doc2).length, 0, "every screen rendered and embedded passes");
	const htmlCfg = buildConfig({ mockupGlobs: ["*.html"] });
	assert.equal(approveGate(su, htmlCfg, ["plan.md", "mockups/screen.html"]).length, 0, "configured glob overrides the png default");
	const done = { ...s, stage: "release" as const };
	assert.ok(approveGate(done, cfg, ["plan.md"]).length > 0, "wrong stage must not pass");
});

test("verifyGate requires green test check when configured", () => {
	const s = { ...newState("f", false), stage: "implement" as const };
	assert.ok(verifyGate(s, cfg).length === 0, "no test command configured → gate open (ui confirm covers)");
	const c2 = buildConfig({ commands: { test: "x" } });
	assert.ok(verifyGate(s, c2).length > 0);
	s.checks.test = { ok: true, at: "" };
	assert.equal(verifyGate(s, c2).length, 0);
	s.checks.test = { ok: false, at: "" };
	assert.ok(verifyGate(s, c2).length > 0);
});

test("verifyGate refuses a branch with nothing committed — checks describe the working tree, not a commit", () => {
	const s = { ...newState("f", false), stage: "implement" as const };
	assert.match(verifyGate(s, cfg, { commitsAhead: 0, uncommitted: 3 }).join(" "), /nothing committed on the feature branch/);
	assert.equal(verifyGate(s, cfg, { commitsAhead: 1, uncommitted: 3 }).length, 0, "one commit with a dirty tree passes: the iterate-and-re-verify loop stays cheap");
	assert.equal(verifyGate(s, cfg).length, 0, "no branch state measured → nothing claimed");
	assert.equal(verifyGate(s, cfg, { commitsAhead: null, uncommitted: 0 }).length, 0, "an unanswerable merge base must not refuse the gate");
});

test("verifyGate: an empty branch on a versioned project with unreleased work on main is a release-only flow (#161)", () => {
	const s = { ...newState("r", false), stage: "implement" as const };
	const vc = buildConfig({ versioning: { file: "VERSION" } });
	assert.equal(verifyGate(s, vc, { commitsAhead: 0, uncommitted: 0, unreleased: { count: 4, since: "v1.2.0" } }).length, 0, "main's unreleased work is what this flow releases");
	assert.match(verifyGate(s, vc, { commitsAhead: 0, uncommitted: 0, unreleased: { count: 0, since: "v1.2.0" } }).join(" "), /nothing landed on the default branch since v1\.2\.0 — there is nothing to verify or release/);
	assert.match(verifyGate(s, vc, { commitsAhead: 0, uncommitted: 0, unreleased: { count: null, since: null } }).join(" "), /nothing committed on the feature branch yet/, "an unanswerable probe keeps the old refusal");
	assert.match(verifyGate(s, cfg, { commitsAhead: 0, uncommitted: 0, unreleased: { count: 4, since: null } }).join(" "), /nothing committed/, "no versioning file: no release-only path");
});

test("releaseGate requires verify approval and release stage", () => {
	const s = newState("f", false);
	assert.ok(releaseGate(s).length === 2);
	s.approvals.verify = "now";
	assert.ok(releaseGate(s).length === 1, "still wrong stage");
});

test("preReleaseGate: stage, re-greened checks, bumped version, changelog mention", () => {
	const s = { ...newState("f", false), stage: "pre-release" as const };
	const c2 = buildConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const prep = { manifestVersion: "1.2.0", remoteTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0\n- shipped\n" }, changelogChanged: true };
	assert.ok(preReleaseGate(s, c2, prep).some((e) => e.includes("flow check")), "checks must be rerun after prep edits");
	s.checks.test = { ok: true, at: "" };
	assert.equal(preReleaseGate(s, c2, prep).length, 0);
	assert.ok(preReleaseGate({ ...s, stage: "implement" as const }, c2, prep).length > 0, "wrong stage");
	assert.ok(preReleaseGate(s, c2, { ...prep, remoteTags: ["v1.2.0"] }).some((e) => e.includes("already tagged")), "version not bumped past the last tag");
	assert.ok(preReleaseGate(s, c2, { ...prep, manifestVersion: null }).some((e) => e.includes("no parsable version")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: null }).some((e) => e.includes("does not exist")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: { file: "CHANGELOG.md", content: "## 1.1.0" } }).some((e) => e.includes("has no entry heading")));
	// unversioned flow (--no-version granted): bump/tag rules off, but the changelog entry is owed
	const uPrep = { manifestVersion: "9.9.9", remoteTags: ["v1.2.0"], changelog: { file: "CHANGELOG.md", content: "## [Unreleased]\n- entry" }, changelogChanged: false };
	assert.ok(preReleaseGate({ ...s, noVersion: true }, c2, uPrep).some((e) => e.includes("unchanged on this branch")));
	assert.equal(preReleaseGate({ ...s, noVersion: true }, c2, { ...uPrep, changelogChanged: true }).length, 0, "unversioned: no bump/tag rules, a changed changelog passes");
	assert.ok(preReleaseGate({ ...s, noVersion: true }, c2, { ...uPrep, changelog: null }).some((e) => e.includes("does not exist")));
	// versioning unset and changelog explicitly cleared: only the check matters
	assert.equal(preReleaseGate({ ...newState("f", false), stage: "pre-release" as const, checks: { test: { ok: true, at: "" } } }, buildConfig({ commands: { test: "x" }, release: { changelog: "" } }), prep).length, 0);
	// release.changelog ships on by default — a bare playbook still owes changelog prep
	assert.equal(buildConfig({}).release.changelog, "CHANGELOG.md");
});

test("preReleaseGate: versioned release folds the Unreleased backlog (--no-version entries)", () => {
	const s = { ...newState("f", false), stage: "pre-release" as const, checks: { test: { ok: true, at: "" } } };
	const c2 = buildConfig({ commands: { test: "x" }, versioning: { file: "package.json" } });
	const base = { manifestVersion: "1.2.0", remoteTags: ["v1.1.0"], changelogChanged: true };
	const cl = (content: string) => ({ ...base, changelog: { file: "CHANGELOG.md", content } });
	assert.ok(preReleaseGate(s, c2, cl("# Changelog\n\n## [Unreleased]\n\n- left by a --no-version flow\n\n## [1.1.0] - 2026\n")).some((e) => e.includes("fold them under the v1.2.0 heading")));
	assert.equal(preReleaseGate(s, c2, cl("# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026\n- done\n")).length, 0, "empty Unreleased passes");
	assert.equal(preReleaseGate(s, c2, cl("## 1.2.0\n- done\n")).length, 0, "no Unreleased section: vacuously clean");
	assert.ok(unreleasedPending("## Unreleased\n- entry"));
	assert.ok(unreleasedPending("## [Unreleased]\n### Added\n- entry\n## [1.0.0]\n"), "entries under a nested sub-heading still count");
	assert.ok(!unreleasedPending("prose mentions Unreleased in passing\n## 1.0.0"));
	assert.ok(!unreleasedPending("## [Unreleased]\n\n## 1.0.0"));
});

test("bashFlowGuard: an unattributed refusal admits it never found the feature", () => {
	const base = { branch: "main", stage: null as "plan" | null, defaultBranch: "main" };
	assert.match(bashFlowGuard({ ...base, command: 'git merge --ff-only up', attribution: "not attributed to a bound feature (session sid:ghost)" }) ?? "", /requires stage "release" — not attributed to a bound feature \(session sid:ghost\)/, "the refusal carries why the stage was unknown");
	assert.ok(!(bashFlowGuard({ ...base, stage: "plan", command: "git merge feat/x", attribution: "not attributed" }) ?? "").includes("not attributed"), "a real stage verdict never carries the attribution note");
	assert.match(bashFlowGuard({ ...base, command: "git push origin main", attribution: "no binding" }) ?? "", /\(verified feature\) — no binding/);
});

test("bashFlowGuard: main protection and release-stage release", () => {
	const base = { branch: "main", stage: null as "plan" | null, defaultBranch: "main" };
	assert.ok(bashFlowGuard({ ...base, command: "git commit -m x" }));
	assert.match(bashFlowGuard({ ...base, command: "git commit -m x", dir: "/home/me/wt/x" })!, /judged in \/home\/me\/wt\/x/, "the refusal names the directory the verdict came from, so a cd misjudgment reads as one");
	assert.equal(bashFlowGuard({ ...base, branch: "feat/x", command: "git commit -m x" }), null);
	assert.equal(bashFlowGuard({ ...base, stage: "release", command: "git commit -m x" }), null, "release chores may commit in the main checkout");
	assert.ok(bashFlowGuard({ ...base, command: "git push origin main" }));
	assert.equal(bashFlowGuard({ ...base, stage: "release", command: "git push origin main" }), null);
	// ref-aware: tag writes never touch branches — stage-free
	assert.equal(bashFlowGuard({ ...base, command: "git push --tags" }), null);
	assert.equal(bashFlowGuard({ ...base, command: "git push origin v0.9.0", pushRefs: [{ kind: "tag", name: "v0.9.0" }] }), null);
	assert.equal(bashFlowGuard({ ...base, command: "git push origin --delete feat/x", pushRefs: [{ kind: "branch", name: "feat/x" }] }), null);
	assert.equal(bashFlowGuard({ ...base, command: "git push origin v0.9.0" }), null, "unresolved bare name is only dangerous if it names the default branch");
	assert.ok(bashFlowGuard({ ...base, command: "git push" }), "bare push on default branch needs release");
	assert.equal(bashFlowGuard({ ...base, branch: "feat/x", command: "git push" }), null, "bare push off default is the feature branch");
	assert.equal(bashFlowGuard({ ...base, command: "gh pr create -B main && git push origin feat/x" }), null, "no substring false positives anymore");
	assert.equal(bashFlowGuard({ ...base, stage: "release", branch: "feat/x", command: "git push --tags" }), null);
	assert.equal(bashFlowGuard({ ...base, branch: "feat/x", command: "git push origin feat/x" }), null);
	assert.ok(bashFlowGuard({ ...base, command: "git push --mirror" }), "mirror rewrites everything — worst case");
	assert.ok(bashFlowGuard({ ...base, command: "git merge feat/x" }));
	assert.equal(bashFlowGuard({ ...base, stage: "release", command: "git merge feat/x" }), null);
	assert.ok(bashFlowGuard({ ...base, stage: "pre-release" as const, command: "git push origin main" }), "pre-release cannot push the default branch");
	assert.ok(bashFlowGuard({ ...base, stage: "pre-release" as const, command: "git merge feat/x" }), "pre-release cannot merge into main");
	assert.equal(bashFlowGuard({ ...base, command: "git status" }), null);
});

test("bashFlowGuard: only real git invocations are judged", () => {
	const base = { branch: "main", stage: null as "plan" | null, defaultBranch: "main" };
	// reading .git paths or messages must not read as a commit
	assert.equal(bashFlowGuard({ ...base, command: "cat .git/hooks/pre-commit" }), null);
	assert.equal(bashFlowGuard({ ...base, command: "git log --oneline --grep=commit" }), null);
	assert.equal(bashFlowGuard({ ...base, command: "git branch --show-current" }), null);
	// real invocations still bite, including path prefixes and env wrappers
	assert.ok(bashFlowGuard({ ...base, command: "/usr/bin/git commit -m x" }));
	assert.ok(bashFlowGuard({ ...base, command: "FOO=1 git commit -m x" }));
	assert.ok(bashFlowGuard({ ...base, command: "echo hi && git commit -m x" }));
	assert.ok(bashFlowGuard({ ...base, command: "git -c user.name=x commit -m y" }));
});

test("gitInvocation: subcommands and effective directory", () => {
	assert.deepEqual(gitInvocation("cat .git/hooks/pre-commit"), { subs: [], pushes: [], gitSegs: [] });
	assert.deepEqual(gitInvocation("git commit -m x"), { subs: ["commit"], pushes: [], gitSegs: [{ seg: "git commit -m x", dir: null }] });
	assert.deepEqual(gitInvocation("cd .dev-flow/f/worktree && git commit -m x"), { subs: ["commit"], pushes: [], gitSegs: [{ seg: "git commit -m x", dir: ".dev-flow/f/worktree" }] });
	assert.deepEqual(gitInvocation("git -C /tmp/wt push origin feat/x"), { subs: ["push"], pushes: [["origin", "feat/x"]], gitSegs: [{ seg: "git -C /tmp/wt push origin feat/x", dir: "/tmp/wt" }] });
	assert.deepEqual(gitInvocation("git -C=/tmp/wt commit"), { subs: ["commit"], pushes: [], gitSegs: [{ seg: "git -C=/tmp/wt commit", dir: "/tmp/wt" }] });
	assert.deepEqual(gitInvocation("/usr/bin/git branch --show-current"), { subs: ["branch"], pushes: [], gitSegs: [{ seg: "/usr/bin/git branch --show-current", dir: null }] });
	assert.deepEqual(gitInvocation("cd wt; git status; git push"), { subs: ["status", "push"], pushes: [[]], gitSegs: [{ seg: "git status", dir: "wt" }, { seg: "git push", dir: "wt" }] });
	assert.deepEqual(gitInvocation("sudo git commit -m x"), { subs: ["commit"], pushes: [], gitSegs: [{ seg: "sudo git commit -m x", dir: null }] });
	assert.deepEqual(gitInvocation("cd wt && git commit -m x && cd main && git pull").gitSegs.map((g) => [g.seg.split(" ")[1], g.dir]), [["commit", "wt"], ["pull", "main"]], "per-segment dirs: last-cd must not leak into earlier segments");
	const home = process.env.HOME || "/home/me";
	assert.equal(gitInvocation("cd ~/wt && git commit -m x").gitSegs[0].dir, `${home}/wt`, "the shell expands ~ before git runs; an unexpanded one resolved against the session cwd and main got the blame");
	assert.equal(gitInvocation("git -C $HOME/wt commit").gitSegs[0].dir, `${home}/wt`, "$HOME is expanded the same way");
	assert.equal(gitInvocation("cd $WT/wt && git commit -m x").gitSegs[0].dir, "$WT/wt", "any other var stays literal — a guess is worse than a literal");
});

test("forcePushInvocation: the verb carries the flag, not any git command (#82)", () => {
	assert.ok(forcePushInvocation("git push --force origin feat/x"));
	assert.ok(forcePushInvocation("git push -f"), "short flag");
	assert.ok(forcePushInvocation("git push -uf origin feat/x"), "short flag cluster");
	assert.ok(forcePushInvocation("git push --force-with-lease=feat/x origin"), "a value-carrying lease flag still forces");
	assert.ok(forcePushInvocation("cd wt && git push -f"), "a cd does not hide the verb");
	assert.equal(forcePushInvocation("git filter-branch --force --index-filter 'git rm --cached --ignore-unmatch k' main..HEAD"), false, "a local rewrite is not a push");
	assert.equal(forcePushInvocation("git show -f"), false, "a flag that means something else on another verb");
	assert.equal(forcePushInvocation("gh pr comment --body 'ask them to git push --force'"), false, "quoted prose is not a command");
	assert.equal(forcePushInvocation("git push origin feat/x"), false, "an ordinary push asks nobody");
	assert.equal(forcePushInvocation("DEV_FLOW_ALLOW_REWRITE=1 git push -f origin feat/x"), false, "the operator's word, spelled on the command");
	assert.ok(forcePushInvocation("sudo git push -f origin feat/x"), "a wrapper is neither an authorisation nor an escape");
	assert.ok(forcePushInvocation("git push -f origin main # DEV_FLOW_ALLOW_REWRITE=1"), "a mention is not a prefix — the word must be on the command");
});

test("parsePushRefs: what does each push actually write", () => {
	assert.deepEqual(parsePushRefs([[]]), [{ kind: "current", name: "" }]);
	assert.deepEqual(parsePushRefs([["origin"]]), [{ kind: "current", name: "" }]);
	assert.deepEqual(parsePushRefs([["origin", "main"]]), [{ kind: "branch", name: "main" }]);
	assert.deepEqual(parsePushRefs([["origin", "HEAD:refs/tags/v1.0"]]), [{ kind: "tag", name: "v1.0" }]);
	assert.deepEqual(parsePushRefs([["origin", "refs/tags/v1.0"]]), [{ kind: "tag", name: "v1.0" }]);
	assert.deepEqual(parsePushRefs([["--delete", "origin", "feat/x"]]), [{ kind: "branch", name: "feat/x" }]);
	assert.deepEqual(parsePushRefs([["origin", "main:"]]), [{ kind: "branch", name: "main" }], "src: deletes remote src — judged by src");
	assert.deepEqual(parsePushRefs([["origin", "HEAD"]]), [{ kind: "current", name: "" }]);
	assert.deepEqual(parsePushRefs([["--tags"]]), [{ kind: "tag", name: "*" }]);
	assert.deepEqual(parsePushRefs([["--mirror", "origin"]]), [{ kind: "branch", name: "*" }]);
	assert.deepEqual(parsePushRefs([["origin", "v1.0", "v1.1"]]), [{ kind: "branch", name: "v1.0" }, { kind: "branch", name: "v1.1" }]);
});

test("stateTamper catches direct state.json writes", () => {
	assert.ok(stateTamper("echo x > .dev-flow/f/state.json"));
	assert.ok(stateTamper("rm .dev-flow/f/state.json"));
	assert.equal(stateTamper("cat .dev-flow/f/state.json"), false);
	assert.equal(stateTamper("git status"), false);
});

test("playbookTamper catches direct project.md writes; reads and flow init --write pass", () => {
	assert.ok(playbookTamper("echo x > .dev-flow/project.md"));
	assert.ok(playbookTamper("sed -i s/a/b/ .dev-flow/project.md"));
	assert.ok(playbookTamper("cp tmp.md .dev-flow/playbook-loop/worktree/.dev-flow/project.md"), "a worktree copy is still the playbook");
	assert.equal(playbookTamper("cat .dev-flow/project.md"), false);
	assert.equal(playbookTamper('flow init --write "# dev-flow"'), false);
	assert.equal(playbookTamper("git status"), false);
});

test("flowShellInvocation: a bash command named flow is a mistake, everything that only mentions it is not", () => {
	assert.ok(flowShellInvocation("flow status"));
	assert.ok(flowShellInvocation("flow approve --confirmed"));
	assert.ok(flowShellInvocation("cd .. && flow use my-slug"), "any segment of the chain");
	assert.ok(flowShellInvocation("DEV_FLOW_ALLOW_MAIN=1 flow status"), "env-prefixed still invokes flow");
	assert.ok(flowShellInvocation("./flow status"), "a local copy is still the same mistake");
	assert.equal(flowShellInvocation('git commit -m "flow approve landed"'), false, "quoted prose is an argument");
	assert.equal(flowShellInvocation("grep flow status"), false, "flow as an argument");
	assert.equal(flowShellInvocation("cat skills/dev-flow/SKILL.md"), false);
	assert.equal(flowShellInvocation("echo flow-guard"), false);
	assert.equal(flowShellInvocation("myflow status"), false);
	assert.ok(FLOW_SHELL_HINT.includes("flow tool"), "the refusal names the call that works");
});

test("playbookTamper reads and backups are not changes; targets still are (#53)", () => {
	assert.equal(playbookTamper("cp .dev-flow/project.md /tmp/project.md.bak"), false, "the safety copy the old guard refused");
	assert.equal(playbookTamper("grep -e health .dev-flow/project.md"), false, "the bare -e in the old verb list matched any --exclude-style flag");
	assert.equal(playbookTamper("git ls-files --error-unmatch .dev-flow/project.md"), false);
	assert.equal(playbookTamper("ls .dev-flow/fix-x/"), false);
	assert.equal(
		playbookTamper("cat > /tmp/issue.md <<'EOF'\nthe guard blocks .dev-flow/project.md reads\nEOF"),
		false,
		"a heredoc that only mentions the path is not a write to it",
	);
	assert.ok(playbookTamper("cp /tmp/project.md.bak .dev-flow/project.md"), "restoring a backup IS a write to the playbook");
	assert.ok(playbookTamper("printf '%s' x >> .dev-flow/project.md"));
	assert.ok(playbookTamper('python -c "open(\'.dev-flow/project.md\',\'w\')"'), "scripted writes stay blocked");
	assert.equal(playbookTamper("sed -n 1,10p .dev-flow/project.md"), false, "sed as a printer is a read");
});

test("playbookTamper: a redirect elsewhere is not a write to the playbook (0.45.0 release blocker)", () => {
	// the fallback used to match a bare `>`, so this — the exact shape of a release PR call — was refused
	assert.equal(
		playbookTamper('gh pr create --title "t" --body "the guard protects .dev-flow/project.md" 2>&1 | tail -1'),
		false,
		"stderr redirection next to prose about the playbook is not a write",
	);
	assert.equal(playbookTamper("cat notes.md > /tmp/out.log; echo done .dev-flow/project.md"), false, "a redirect to another file stays harmless");
	assert.equal(playbookTamper("grep -rn health .dev-flow/project.md > /dev/null 2>&1"), false, "a read whose output is discarded");
	// the real writes still land
	assert.ok(playbookTamper("echo x > .dev-flow/project.md"), "redirect into the playbook");
	assert.ok(playbookTamper("echo x >> '.dev-flow/project.md'"), "quoted target");
	assert.ok(playbookTamper('sh -c "echo x > .dev-flow/project.md"'), "a re-exec wrapper payload is still code");
	assert.ok(playbookTamper("tee .dev-flow/project.md"), "tee");
	assert.ok(playbookTamper("truncate -s 0 .dev-flow/project.md"), "truncate");
});

test("playbookOnlyChange: the lane for the tracking chore (#53)", () => {
	assert.equal(playbookOnlyChange("A  .dev-flow/project.md"), true);
	assert.equal(playbookOnlyChange("M  .dev-flow/project.md"), true);
	assert.equal(playbookOnlyChange(""), false, "nothing staged, nothing to grant");
	assert.equal(playbookOnlyChange("A  .dev-flow/project.md\nM  src/app.ts"), false, "any other dirty path closes the lane");
	assert.equal(playbookOnlyChange("M  README.md"), false);
});

test("bashFlowGuard: the playbook tracking chore may land on the default branch (#53)", () => {
	const base = { command: 'DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"', branch: "main", stage: null, defaultBranch: "main" };
	assert.match(bashFlowGuard(base) ?? "", /direct commits to main/);
	assert.equal(bashFlowGuard({ ...base, playbookChore: true }), null, "its only content is the operator's playbook");
	assert.ok(bashFlowGuard({ ...base, playbookChore: true, command: "git push origin main" }), "the lane is commits, not pushes");
	assert.match(bashFlowGuard({ ...base, playbookChore: true, command: "git commit --amend --no-edit" }) ?? "", /direct commits to main/, "amending the default branch is not a tracking chore");
});

test("detectForge: the origin URL decides", () => {
	assert.equal(detectForge("git@github.com:u/r.git"), "github");
	assert.equal(detectForge("https://gitlab.example.com/u/r.git"), "gitlab");
	assert.equal(detectForge("https://git.internal/u/r.git"), "self");
	assert.equal(detectForge(""), "self");
});

/** One open reflections.md item as the section-aware reader returns it — the heading is the filing. */
const rItem = (note: string, section: "playbook" | "code" | "plugin" = "playbook") => reflectItems("## " + section + "\n\n- [ ] " + note + "\n")[0];

test("reflectionRoutes route from the section an item is filed under, not from its wording", () => {
	const [p] = reflectionRoutes([rItem("the checklist item about seeded data is stale")], false);
	assert.equal(p.mode, "docs");
	assert.match(p.route, /docs flow/);
	const [c] = reflectionRoutes([rItem("the seed script skips users", "code")], false);
	assert.equal(c.mode, "code", "a code item is a patch flow");
	assert.match(c.route, /patch flow/);
	const [x] = reflectionRoutes([rItem("the gate prompt asks twice", "plugin")], false);
	assert.equal(x.mode, "upstream", "a legacy ## plugin row in someone else's repo belongs on GitHub");
	assert.match(x.route, /legacy ## plugin row — belongs on GitHub/);
	assert.match(x.route, /filed: gh#NNN/);
	const [s] = reflectionRoutes([rItem("the gate prompt asks twice", "plugin")], true);
	assert.equal(s.mode, "code", "in the dev-flow repo a legacy plugin item is code");
	assert.match(s.route, /move <n> --code/);
	const [home] = reflectionRoutes([rItem("the gate prompt asks twice", "playbook")], false);
	assert.equal(home.mode, "docs", "the heading is the record — re-guessing from the wording re-routed items out of the section they live in");
	const brief = investigationBrief("the gate prompt asks twice", true);
	assert.match(brief.join(" "), /gate prompt asks twice/);
	assert.match(brief.join(" "), /patch flow/);
	assert.match(brief.join(" "), /## code \("gate" names dev-flow itself\)/, "in the dev-flow repo a plugin-shaped note is told it lands under ## code");
	const foreign = investigationBrief("the gate prompt asks twice", false).join(" ");
	assert.match(foreign, /dev-flow feedback \("gate" names dev-flow itself\) — an upstream issue, not a local row/);
	assert.match(foreign, /flow reflect --plugin/);
});

test("writeGuard: path attribution + session binding rules", () => {
	const df = "/repo/.dev-flow";
	const plan = newState("a", false);
	const impl = { ...newState("b", false), stage: "implement" as const, worktree: ".worktrees/b" };
	const wtB = "/repo/.worktrees/b";
	const feats = [{ state: plan, worktreeAbs: null }, { state: impl, worktreeAbs: wtB }];
	assert.match(writeGuard({ abs: "/repo/src/app.ts", dfDir: df, features: feats, boundSlug: null }) ?? "", /flow use/);
	assert.ok(writeGuard({ abs: "/repo/src/app.ts", dfDir: df, features: feats, boundSlug: "a" }));
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/a/plan/plan.md", dfDir: df, features: feats, boundSlug: "a" }), null);
	// gh#175: a path git ignores is writable unbound (never a commit, never a dirty checkout) — the caller asks git
	assert.equal(writeGuard({ abs: "/repo/.pi/local-secrets/pw.md", dfDir: df, features: feats, boundSlug: null, ignored: true }), null);
	assert.match(writeGuard({ abs: "/repo/.pi/local-secrets/pw.md", dfDir: df, features: feats, boundSlug: null }) ?? "", /\.git\/info\/exclude/, "the refusal names the exemption");
	assert.match(writeGuard({ abs: "/repo/.dev-flow/scratch.md", dfDir: df, features: feats, boundSlug: null, ignored: true }) ?? "", /holds flow state/, ".dev-flow/ (itself ignored) keeps its own rule");
	assert.match(writeGuard({ abs: "/repo/x.log", dfDir: df, features: feats, boundSlug: "b", ignored: true }) ?? "", /edit its worktree/, "a bound implement session is still sent to its worktree");
	assert.match(writeGuard({ abs: "/repo/.dev-flow/b/plan/plan.md", dfDir: df, features: feats, boundSlug: "a" }) ?? "", /write only inside its own/, "one session may not write another feature's plan");
	assert.ok(writeGuard({ abs: "/repo/wt-a/x.ts", dfDir: df, features: [{ state: plan, worktreeAbs: "/repo/wt-a" }], boundSlug: "b" }), "plan-owned worktree stays closed even when bound elsewhere");
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/a/worktree/x.ts", dfDir: df, features: [{ state: plan, worktreeAbs: "/repo/.dev-flow/a/worktree" }], boundSlug: null }), "default worktreeDir inside .dev-flow is still stage-gated by its owner");
	assert.equal(writeGuard({ abs: `${wtB}/src/app.ts`, dfDir: df, features: feats, boundSlug: "a" }), null, "b implement worktree open even when bound to a");
	assert.ok(writeGuard({ abs: "/repo/CHANGELOG.md", dfDir: df, features: feats, boundSlug: "b" }), "implement-bound session confined to its worktree");
	const rel = { ...impl, stage: "release" as const };
	assert.equal(writeGuard({ abs: "/repo/CHANGELOG.md", dfDir: df, features: [{ state: rel, worktreeAbs: wtB }], boundSlug: "b" }), null, "release chores may touch main checkout");
	const pre = { ...impl, stage: "pre-release" as const };
	assert.ok(writeGuard({ abs: "/repo/CHANGELOG.md", dfDir: df, features: [{ state: pre, worktreeAbs: wtB }], boundSlug: "b" }), "pre-release-bound session stays confined to its worktree");
	assert.equal(writeGuard({ abs: `${wtB}/CHANGELOG.md`, dfDir: df, features: [{ state: pre, worktreeAbs: wtB }], boundSlug: "b" }), null, "pre-release worktree is the working area");
	assert.match(writeGuard({ abs: "/repo/src/app.ts", dfDir: df, features: [], boundSlug: null }) ?? "", /no active flow/, "flow-by-default: clean repo still requires a flow");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/reflections.md", dfDir: df, features: [], boundSlug: null }), null, "reflections.md is the agent's queue — editable even with no flow bound");
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/a/state.json", dfDir: df, features: [], boundSlug: null }));
	assert.match(writeGuard({ abs: "/repo/.dev-flow/a/claim.json", dfDir: df, features: [], boundSlug: null }) ?? "", /claim\.json is dev-flow-owned/, "the claim is the concurrency lock — dev-flow owns it, flow use takes over");
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/notes.md", dfDir: df, features: [], boundSlug: null }), "an unbound session may not drop files into .dev-flow/");
	assert.match(writeGuard({ abs: "/repo/.dev-flow/project.md", dfDir: df, features: [], boundSlug: null }) ?? "", /operator playbook/, "the main-checkout playbook is never an agent edit target");
	const docsF = { state: { ...newState("d", false, false, true), stage: "implement" as const, worktree: ".wt/d" }, worktreeAbs: "/repo/.wt/d" };
	const normF = { state: { ...newState("n", false), stage: "implement" as const, worktree: ".wt/n" }, worktreeAbs: "/repo/.wt/n" };
	assert.equal(writeGuard({ abs: "/repo/.wt/d/.dev-flow/project.md", dfDir: df, features: [docsF], boundSlug: "d" }), null, "a docs flow edits the playbook in its worktree");
	assert.ok(writeGuard({ abs: "/repo/.wt/n/.dev-flow/project.md", dfDir: df, features: [normF], boundSlug: "n" }), "a normal feature cannot touch the playbook");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/roadmap.md", dfDir: df, features: [], boundSlug: null }), null, "the roadmap backlog is the agent's too");
	assert.deepEqual([...DF_ADVISORY_FILES].sort(), ["reflections.md", "roadmap.md"], "the writable set is exactly these two");
	assert.match(writeGuard({ abs: "/repo/.dev-flow/COMMUNICATION-PLAN.md", dfDir: df, features: [], boundSlug: null }) ?? "", /advisory files/, "the folder gitignores everything — it is not an untracked scratch dir for an unbound session");
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/notes/x.md", dfDir: df, features: [], boundSlug: null }), "and that reaches nested paths too");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/notes/x.md", dfDir: df, features: feats, boundSlug: "b" }), null, "a bound session keeps the folder as it had it — flow-owned paths inside it are refused by their own rules");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/notes/x.md", dfDir: df, features: [{ state: { ...impl, stage: "release" as const }, worktreeAbs: wtB }], boundSlug: "b" }), null, "release chores keep the folder");
	// a spin-off is parked in the roadmap — a hand-made feature dir is a ghost no gate can pick up
	assert.match(writeGuard({ abs: "/repo/.dev-flow/spin/plan/plan.md", dfDir: df, features: feats, boundSlug: "b" }) ?? "", /flow roadmap add "<title>" --slug=spin/, "an implement session may not hand-make another feature's plan dir");
	assert.match(writeGuard({ abs: "/repo/.dev-flow/a/notes.md", dfDir: df, features: feats, boundSlug: "b" }) ?? "", /not this session's feature \(b\)/, "nor write into another live feature's dir");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/b/plan/plan.md", dfDir: df, features: feats, boundSlug: "b" }), null, "its own plan stays writable at implement");
	assert.equal(writeGuard({ abs: "/repo/.dev-flow/roadmap.md", dfDir: df, features: feats, boundSlug: "b" }), null, "the roadmap is where the spin-off goes");
	assert.deepEqual(checkoutInvocation("git checkout feat/x"), { target: "feat/x", creates: false });
	assert.deepEqual(checkoutInvocation("git switch -c feat/y && make"), { target: "feat/y", creates: true });
	assert.deepEqual(checkoutInvocation("git checkout -f feat/z"), { target: "feat/z", creates: false }, "a leading flag does not hide the branch");
	assert.equal(checkoutInvocation("git checkout -- src/app.ts"), null, "paths after -- are not a branch");
	assert.equal(checkoutInvocation("git commit -m x"), null);
	assert.equal(featureBranchPrefix({ ...DEFAULTS, branchPattern: "feat/{slug}" }), "feat/");
});

test("writeGuard: a throwaway outside the repo is stage-free, a repo that lives in the temp dir is not", () => {
	// the reflection: a mechanical multi-file rewrite had nowhere to keep /tmp/split_skill.py
	const parent = mkdtempSync(path.join(tmpdir(), "df-scratch-"));
	const repo = path.join(parent, "repo");
	mkdirSync(path.join(repo, "src"), { recursive: true });
	const df = path.join(repo, ".dev-flow");
	const impl = { ...newState("b", false), stage: "implement" as const, worktree: ".wt/b" };
	const feats = [{ state: impl, worktreeAbs: path.join(repo, ".wt", "b") }];
	const bound = (abs: string, slug: string | null = "b") => writeGuard({ abs, dfDir: df, features: feats, boundSlug: slug, repoRoot: repo });
	assert.equal(bound(path.join(parent, "split_skill.py")), null, "scratch beside the repo is not a repo write");
	assert.equal(bound(path.join(tmpdir(), "loose-throwaway.py"), null), null, "and it is stage-free even with no flow bound");
	assert.match(bound(path.join(repo, "src", "app.ts")) ?? "", /edit its worktree/, "the checkout itself stays confined to its worktree");
	assert.match(bound(path.join(df, "b", "state.json")) ?? "", /dev-flow-owned/, "state.json is never scratch");
	// every smoke-test repo lives under the temp dir: the exclusion is what keeps those rules alive
	assert.ok(inScratchDir(path.join(repo, "src", "app.ts"), repo) === false, "inside the repo root is never scratch");
	assert.ok(inScratchDir(path.join(parent, "x.py"), repo), "outside it, inside the temp dir, is");
	// a symlink out of the temp dir must not smuggle a write back into the guarded checkout
	const link = path.join(parent, "link");
	symlinkSync(repo, link);
	assert.match(bound(path.join(link, "src", "app.ts")) ?? "", /edit its worktree/, "a symlink into the repo is judged as the repo path it writes");
	// owner attribution beats the scratch allow: a worktreeDir parked in the temp dir is still owned
	const wtTmp = path.join(parent, "wt-plan");
	const planFeat = [{ state: { ...newState("c", false), stage: "plan" as const, worktree: "wt-plan" }, worktreeAbs: wtTmp }];
	assert.match(
		writeGuard({ abs: path.join(wtTmp, "x.ts"), dfDir: df, features: planFeat, boundSlug: "b", repoRoot: repo }) ?? "",
		/is in plan/,
		"a worktree in the temp dir is owned space, never free scratch",
	);
});

test("writeGuard: a symlink in the worktree is judged where the bytes land", () => {
	// the audit finding: writeGuard compared paths lexically, so a symlink out of the worktree
	// laundered a main-checkout write past the stage rule (guardPath already realpaths — this is parity)
	const repo = path.join(mkdtempSync(path.join(tmpdir(), "df-esc-")), "repo");
	const df = path.join(repo, ".dev-flow");
	const wt = path.join(repo, "wt");
	mkdirSync(path.join(repo, "src"), { recursive: true });
	mkdirSync(df, { recursive: true });
	mkdirSync(wt, { recursive: true });
	symlinkSync(path.join(repo, "src"), path.join(wt, "linked"));
	const impl = { ...newState("e", false), stage: "implement" as const, worktree: "wt", branch: "feat/e" };
	const feats = [{ state: impl, worktreeAbs: wt }];
	const g = (abs: string) => writeGuard({ abs, dfDir: df, features: feats, boundSlug: "e", repoRoot: repo });
	assert.match(g(path.join(wt, "linked", "app.ts")) ?? "", /edit its worktree/, "bytes written through the link land in the main checkout — the link's path must not launder them");
	assert.equal(g(path.join(wt, "app.ts")), null, "a plain worktree path stays the working area");
	// and the main-checkout dev-flow files stay owned through a link too
	symlinkSync(df, path.join(wt, "dflink"));
	assert.match(g(path.join(wt, "dflink", "e", "state.json")) ?? "", /dev-flow-owned/, "state.json reached through a symlink is still state.json");
});

test("openChecklistItems: unchecked items only", () => {
	assert.deepEqual(openChecklistItems("# h\n- [ ] (playbook) a\n- [x] done\n  - [ ] indented\n"), ["- [ ] (playbook) a", "- [ ] indented"]);
	assert.deepEqual(openChecklistItems(""), []);
});

test("roadmap: append mints the header once and adds open items", () => {
	const one = appendRoadmapItem("", "dark mode");
	assert.match(one, /^# dev-flow roadmap/);
	assert.equal(roadmapOpenCount(one), 1);
	const two = appendRoadmapItem(one, "  roadmap tidy  \n");
	assert.ok(two.includes("- [ ] roadmap tidy\n"), "text is trimmed into the item");
	assert.equal(roadmapOpenCount(two), 2);
	assert.equal(doneItemCount(two), 0);
});

test("roadmap: pick stamps the nth open item, idempotent per slug", () => {
	const src = "# r\n- [ ] a\n- [x] gone\n- [ ] b\n";
	assert.equal(roadmapPick(src, 2, "my-slug"), "# r\n- [ ] a\n- [x] gone\n- [ ] b (my-slug)\n");
	assert.equal(roadmapPick(roadmapPick(src, 2, "s")!, 2, "s"), "# r\n- [ ] a\n- [x] gone\n- [ ] b (s)\n", "re-pick does not double-stamp");
	assert.equal(roadmapPick(src, 3, "x"), null, "only open items are numberable");
	// odd spacing is no item anywhere: counting and editing must never disagree
	assert.equal(roadmapOpenCount("-  [ ] loose\n"), 0);
	assert.equal(roadmapPick("-  [ ] loose\n", 1, "s"), null);
});

test("roadmap: done checks the nth open item with a stamp", () => {
	const src = "- [ ] a\n- [x] old\n- [ ] b\n";
	assert.match(roadmapDone(src, 2, "2025-10-19 fin")!, /- \[x\] b — done: 2025-10-19 fin/);
	assert.equal(roadmapDone(src, 3, "x"), null);
	assert.equal(doneItemCount(roadmapDone(src, 1, "d")!), 2);
});

test("roadmap: finish hook checks off every item stamped (slug)", () => {
	const src = "- [ ] pick me (fin)\n- [ ] also (fin) and more\n- [ ] other (later)\n- [x] history (fin)\n";
	const r = roadmapDoneForSlug(src, "fin", "2025-10-19");
	assert.equal(r.count, 2);
	assert.ok(r.text.includes("- [x] pick me (fin) — done: 2025-10-19"));
	assert.ok(r.text.includes("- [ ] other (later)"), "unstamped items stay open");
	assert.equal(roadmapDoneForSlug(src, "nobody", "x").count, 0);
});

test("roadmap: a brief rides under its item as quoted lines — never counted, found by slug, tidied with it", () => {
	const one = appendRoadmapItem("", "channel visibility — split from tg (mcv)", "scope: per-channel\n- [ ] not an item\n");
	assert.match(one, /- \[ \] channel visibility — split from tg \(mcv\)\n  > scope: per-channel\n  > - \[ \] not an item\n$/);
	const two = appendRoadmapItem(one, "next");
	assert.equal(roadmapOpenCount(two), 2, "brief lines are not backlog items");
	assert.deepEqual(roadmapBriefFor(two, "mcv"), { item: "channel visibility — split from tg (mcv)", brief: "scope: per-channel\n- [ ] not an item" });
	assert.deepEqual(roadmapBriefFor(two, "next"), null, "an unstamped item is not found by slug");
	assert.equal(roadmapBriefFor(appendRoadmapItem("", "x (s)"), "s")?.brief, "", "no brief → empty");
	const tidied = roadmapTidy(roadmapDone(two, 1, "d")!);
	assert.ok(!tidied.includes("> scope") && tidied.includes("- [ ] next"), "a done item's brief leaves with it");
	assert.ok(roadmapTidy(two).includes("  > scope"), "an open item's brief stays");
});

test("roadmap: tidy drops done items and keeps preamble and open items", () => {
	const src = "# r\n\n<!-- note -->\n\n- [ ] keep\n- [x] drop — done: 2025-01-01\n\n- [ ] keep too\n";
	const out = roadmapTidy(src);
	assert.ok(out.includes("<!-- note -->") && out.includes("- [ ] keep\n") && out.includes("- [ ] keep too"));
	assert.ok(!out.includes("[x]"));
});

test("reflections: closed count; tidy drops closed items and headings left empty", () => {
	assert.equal(doneItemCount("# h\n## playbook\n\n- [ ] open\n- [x] done — fixed: v1\n## plugin\n\n- [X] gone\n"), 2);
	assert.equal(doneItemCount(""), 0);
	const src = "# dev-flow reflections\n\n<!-- note -->\n\n## playbook\n\n- [ ] keep me — a 2025-01-01\n- [x] done — fixed: v1\n\n## plugin \n\n- [x] all gone — fixed: v2\n";
	const out = reflectionsTidy(src);
	assert.ok(out.includes("- [ ] keep me — a 2025-01-01\n"), "open item stays verbatim");
	assert.ok(out.includes("<!-- note -->"), "preamble verbatim");
	assert.ok(out.includes("## playbook"), "a section with an open item stays");
	assert.ok(!out.includes("## plugin"), "a section emptied by the tidy loses its heading (heading whitespace tolerated)");
	assert.ok(!out.includes("[x]"), "closed items are gone");
	assert.equal(reflectionsTidy(out), out, "tidy is idempotent");
	// legacy flat file: items above every heading, no heading to drop
	const flat = "# dev-flow reflections\n\n<!-- n -->\n- [x] closed\n- [ ] open\n";
	assert.deepEqual(reflectionsTidy(flat).split("\n").filter((l) => l.startsWith("- [")), ["- [ ] open"]);
	// the hint every surface shares
	assert.match(reflectionsTidyHint(3), /↻ 3 closed reflection\(s\) — flow reflect tidy drops them/);
});

const reflectTarget = (note: string) => guessReflectSections(note).target;

test("guessReflectSections: one home, named signals, the attribution tail never classified", () => {
	assert.equal(reflectTarget("the gate prompt asks twice, that is wrong"), "plugin");
	assert.equal(reflectTarget("the checklist item about seeded data is stale"), "playbook");
	// a note that names dev-flow's own surface is a plugin issue even when it also mentions project.md
	assert.equal(reflectTarget("the verify gate should read the health command from project.md"), "plugin");
	assert.equal(guessReflectSections("the verify gate should read the health command from project.md").why, '"gate" names dev-flow itself');
	assert.equal(reflectTarget("typo in the readme"), "playbook", "unclear notes land where the operator reads them");
	assert.match(guessReflectSections("the banner tagline is wrong").why, /flow reflect move <n> --code/, "a filing that was only a guess says so");
	assert.equal(reflectTarget("the test command drifted, npm test no longer works"), "playbook", "a drifted project command is a playbook issue, not a plugin one");
	for (const note of ["doctor prints the same finding twice", "flow doctor lists a finding twice", "flow release tags the wrong commit", "state.json loses the yolo flag"])
		assert.equal(reflectTarget(note), "plugin", note);
	assert.equal(reflectTarget("our repo's commit hook rejects rebases"), "playbook", "a project git hook is the playbook's business");
	assert.equal(reflectTarget("the deploy gate in CI is flaky"), "playbook", "a CI gate is the project's own gate");
	for (const note of ["notes drifted, the plan doc is stale", "the gate prompt asks twice", "release notes should list contributors"]) {
		const lined = reflectionLine(note, "fix-versioning-guard", "2026-10-24");
		assert.equal(guessReflectSections(lined).target, reflectTarget(note), `${note}: the slug tail moved the verdict`);
	}
});

test("pluginIssueRecipe: dedupe search first, then an issue whose body carries the fold tail", () => {
	const r = pluginIssueRecipe("- [ ] the gate prompt asks \"twice\" — s 2026-11-01", "dmarchevsky/dev-flow", "my-slug", "2026-11-03").join("\n");
	assert.match(r, /not written to reflections\.md/);
	assert.match(r, /gh issue list --repo dmarchevsky\/dev-flow --state all --search/);
	assert.match(r, /gh issue create --repo dmarchevsky\/dev-flow --title "the gate prompt asks 'twice'"/);
	assert.match(r, /— reflection from my-slug 2026-11-03/);
	assert.ok(r.indexOf("gh issue list") < r.indexOf("gh issue create"), "search before create");
	const blind = pluginIssueRecipe("a note", "", null, "2026-11-03").join("\n");
	assert.match(blind, /upstream repo unknown — ask the operator/);
	assert.match(blind, /— reflection from 2026-11-03/);
});

test("reflectItems: every open item carries the heading that owns it", () => {
	const text = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] drift — s 2026-10-01\n- [x] handled — fixed: v1\n\n## code\n\n- [ ] seed skips users — s 2026-10-02\n\n## plugin\n\n- [ ] doctor double-prints — s 2026-10-02\n";
	const items = reflectItems(text);
	assert.deepEqual(items.map((i) => [i.section, i.body]), [
		["playbook", "drift"],
		["code", "seed skips users"],
		["plugin", "doctor double-prints"],
	]);
	assert.equal(reflectUnfiledCount(text), 0);
	assert.equal(reflectLegacyPluginCount(text), 1, "a legacy ## plugin row is counted so doctor can ask for it upstream");
	const legacy = "# dev-flow reflections\n\n- [ ] flat legacy note — s 2026-10-01\n\n## code\n\n- [ ] placed\n\n## Plugin notes\n\n- [ ] orphan\n";
	assert.deepEqual(reflectItems(legacy).map((i) => i.section), ["unfiled", "code", "unfiled"]);
	assert.equal(reflectUnfiledCount(legacy), 2);
	assert.equal(reflectUnfiledCount(""), 0);
	assert.deepEqual(reflectItems("##code\n\n- [ ] a heading without the space still owns its item\n").map((i) => i.section), ["code"], "spacing does not hide a section");
	assert.deepEqual(reflectItems("## playbook\n\n### triage on Fridays\n\n- [ ] under a sub-heading\n").map((i) => i.section), ["unfiled"], "a sub-heading places nothing — doctor names it instead of inheriting ## playbook");
});

test("reflectMove re-files an item under the other section", () => {
	const src = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] seed skips users — s 2026-10-01\n\n## code\n\n- [ ] real code thing — s 2026-10-02\n";
	const out = reflectMove(src, 1, "code");
	assert.match(out ?? "", /## code\n\n- \[ \] real code thing — s 2026-10-02\n- \[ \] seed skips users — s 2026-10-01\n$/);
	assert.ok(!(out ?? "").includes("## playbook"), "a section emptied by a move loses its heading");
	assert.deepEqual(reflectItems(out ?? "").map((i) => i.section), ["code", "code"]);
	assert.equal(reflectMove(src, 3, "playbook"), null, "item 3 of 2 is out of range");
	const flat = "# dev-flow reflections\n\n- [ ] seed skips users — s 2026-10-01\n";
	assert.match(reflectMove(flat, 1, "code") ?? "", /## code\n\n- \[ \] seed skips users — s 2026-10-01\n$/);
	// a legacy ## plugin row moves out to ## code (the dev-flow repo's own migration)
	const old = "## plugin\n\n- [ ] doctor double-prints — s 1\n";
	assert.match(reflectMove(old, 1, "code") ?? "", /^# dev-flow reflections[\s\S]*## code\n\n- \[ \] doctor double-prints — s 1\n$/);
	const both = "## playbook\n\n- [ ] same note — s 1\n\n## code\n\n- [ ] same note — s 2\n";
	const merged = reflectMove(both, 1, "code") ?? "";
	assert.equal(openChecklistItems(merged).length, 1, "the duplicate merges away instead of being copied");
	assert.match(merged, /## code\n\n- \[ \] same note — s 2\n$/);
});

test("appendReflection writes the two project sections; an item under no heading files under playbook; legacy ## plugin is kept, never added to", () => {
	const flat = "# dev-flow reflections\n\n<!-- note -->\n- [ ] old note — y 2025-10-01\n";
	const out = appendReflection(flat, ["code"], "- [ ] new note — z 2025-10-02");
	assert.match(out, /## playbook\n\n- \[ \] old note — y 2025-10-01\n\n## code\n\n- \[ \] new note — z 2025-10-02\n$/);
	assert.equal(openChecklistItems(out).length, 2);
	const noted = "# my notes\n\noperator: triage on Fridays\n\n- [ ] item one\n";
	assert.equal(
		appendReflection(noted, ["code"], "- [ ] item two"),
		"# my notes\n\noperator: triage on Fridays\n\n## playbook\n\n- [ ] item one\n\n## code\n\n- [ ] item two\n",
		"the operator's preamble survives a rewrite verbatim",
	);
	const stale = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n\n## code\n\n## playbook\n\n- [ ] item one\n";
	const refreshed = appendReflection(stale, ["playbook"], "- [ ] item two\n");
	assert.equal(refreshed.split(/^## /m).length - 1, 1, "stale headers go away; only the non-empty section keeps a header");
	assert.ok(!/^## code$/m.test(refreshed), "an empty section is not resurrected by its stale header");
	assert.ok(refreshed.includes("<!-- n -->"), "the real preamble survives");
	const legacy = "# dev-flow reflections\n\n<!-- n -->\n\n## plugin\n\n- [ ] upstream thing — s 2026-10-19\n";
	assert.equal(
		appendReflection(legacy, ["playbook"], "- [ ] another — s 2026-10-20"),
		"# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] another — s 2026-10-20\n\n## plugin\n\n- [ ] upstream thing — s 2026-10-19\n",
		"a legacy ## plugin row survives verbatim, last — it is not mistaken for preamble and does not fall to playbook",
	);
	assert.match(REFLECT_HEADER, /never lands here — it is filed as a GitHub issue upstream/);
});

test("appendReflection: a heading owns its items, an exact note is queued once (#69)", () => {
	const start = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] old playbook item\n\n## code\n\n- [x] done code thing — fixed: earlier\n";
	const after = appendReflection(appendReflection(start, ["code"], "- [ ] linter note — s 2026-10-20"), ["playbook"], "- [ ] flaky note — s 2026-10-20");
	assert.equal(
		after,
		"# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] old playbook item\n- [ ] flaky note — s 2026-10-20\n\n## code\n\n- [x] done code thing — fixed: earlier\n- [ ] linter note — s 2026-10-20\n",
		"nothing moves out of its section, nothing is written twice",
	);
	assert.equal(appendReflection(after, ["code"], "- [ ] linter note — s 2026-10-21"), after, "the same note at another date is the same note");
	assert.equal(appendReflection(after, ["code"], "- [ ] done code thing — s 2026-10-21").split("done code thing").length - 1, 2, "a checked-off note may be queued again — it came back");
	assert.equal(appendReflection(after, ["code"], "- [ ] flaky note — s 2026-10-21").split("flaky note").length - 1, 2, "a note the other section has is still queued here — dedupe is per section");
});

test("reflectionNudges: fix fires on recurrence, age, a docs batch or code between flows; tidy on a real pile", () => {
	const q = (open: string[], closed: string[] = []) => `# dev-flow reflections\n\n## playbook\n\n${[...open, ...closed].join("\n")}\n`;
	const today = "2026-11-03";
	assert.deepEqual(reflectionNudges(q(["- [ ] a — s 2026-11-01"]), today), { fix: null, tidy: null }, "one fresh item: nothing to say");
	assert.match(reflectionNudges(q(["- [ ] a — s 2026-11-01"]), today, { recurred: 1 }).fix ?? "", /1 recurred this session/);
	assert.match(reflectionNudges(q(["- [ ] a — s 2026-10-10"]), today).fix ?? "", /1 open ≥ 14 days/);
	const batch = reflectionNudges(q(["- [ ] a — s 2026-11-01", "- [ ] b — s 2026-11-01", "- [ ] c — s 2026-11-01"]), today).fix ?? "";
	assert.match(batch, /3 playbook items batch into one docs flow/);
	assert.match(batch, /3 playbook item\(s\) → one docs flow \(flow start fold-<topic> --docs --confirmed\)/);
	const code = "## code\n\n- [ ] seed — s 2026-11-01\n";
	assert.equal(reflectionNudges(code, today).fix, null, "a code item mid-flow is not a reason to divert");
	assert.match(reflectionNudges(code, today, { between: true }).fix ?? "", /\(between flows\) — 1 code item\(s\) → patch flow/);
	assert.equal(reflectionNudges("## plugin\n\n- [ ] x — s 2020-01-01\n", today, { recurred: 1 }).fix, null, "legacy plugin rows never prompt a local fix");
	assert.equal(reflectionNudges("## playbook\n\n- [ ] old note dated 2020-01-01 in its text — s 2026-11-02\n", today).fix, null, "a date inside the note is not its filing date");
	// tidy
	const closed = (n: number, d = "2026-11-01") => Array.from({ length: n }, (_, i) => `- [x] c${i} — s ${d} — fixed: v1`);
	assert.equal(reflectionNudges(q(["- [ ] a — s 2026-11-01", "- [ ] b — s 2026-11-01", "- [ ] c — s 2026-11-01"], closed(2)), today).tidy, null, "a couple of fresh closed items among many open: no tidy");
	assert.match(reflectionNudges(q([], closed(5)), today).tidy ?? "", /↻ 5 closed reflection\(s\) — flow reflect tidy drops them/);
	assert.match(reflectionNudges(q(["- [ ] a — s 2026-11-01"], closed(3)), today).tidy ?? "", /3 closed/, "closed ≥ open with at least 3 closed");
	assert.match(reflectionNudges(q(["- [ ] a — s 2026-11-01", "- [ ] b — s 2026-11-01"], closed(1, "2026-09-01")), today).tidy ?? "", /1 closed/, "a month-old closed item is history worth dropping");
});

test("reflectionLine: the slug is left out with no flow bound (#69)", () => {
	assert.equal(reflectionLine("a note", "my-slug", "2026-10-20"), "- [ ] a note — my-slug 2026-10-20");
	assert.equal(reflectionLine("a note", null, "2026-10-20"), "- [ ] a note — 2026-10-20");
});

test("statusCompact: stage glyph + slug, failing-check flag", () => {
	const s = newState("f", false);
	assert.deepEqual(statusCompact(s), { text: "📝 f", failed: false });
	s.checks.test = { ok: false, at: "2026-01-01T10:00:00Z" };
	assert.equal(statusCompact(s).failed, true);
	s.checks.test = { ok: true, at: "2026-01-01T10:00:00Z" };
	assert.equal(statusCompact(s).failed, false);
});

test("statusFor: bound flow renders as before; unbound shows only the count", () => {
	const s = newState("f", false);
	assert.deepEqual(statusFor(s, 3), { text: "📝 f" }, "a bound feature renders exactly like statusCompact");
	s.checks.test = { ok: false, at: "2026-01-01T10:00:00Z" };
	assert.deepEqual(statusFor(s, 3), { text: "📝 f ⚠️" }, "⚠️ rides on the bound flow's own failing checks");
	assert.deepEqual(statusFor(null, 1), { text: "💬 1 flow open" }, "unbound names nobody — count only, under the pre-flow glyph");
	assert.deepEqual(statusFor(null, 2), { text: "💬 2 flows open" });
	assert.deepEqual(statusFor(null, 0), { text: "💬 no flows" }, "an initiated repo always carries the footer");
	const asked = newState("f", false);
	asked.pendingAsk = "Approve?";
	assert.deepEqual(statusFor(asked, 1), { text: "📝 f 💬" }, "an unanswered checkpoint is the operator's turn — 💬 is the legend's glyph for it");
	asked.yolo = true;
	assert.deepEqual(statusFor(asked, 1), { text: "📝 f 🎱 💬" }, "💬 rides after the mode markers");
	assert.deepEqual(statusFor(newState("f", false), 1), { text: "📝 f" }, "no pendingAsk, no glyph — an open flow reads exactly as before");
});

test("chipLabel: the unbound count fits pi-web's fixed-width chip; bound and idle read as the footer", () => {
	assert.equal(chipLabel(null, 0), "💬 no flows");
	assert.equal(chipLabel(null, 1), "💬 1 open");
	assert.equal(chipLabel(null, 12), "💬 12 open");
	const a = newState("alpha", false);
	assert.equal(chipLabel(a, 3), "📝alpha", "bound: glyph then slug, no space");
	a.stage = "implement";
	a.patch = true;
	a.yolo = true;
	a.pendingAsk = "Verified?";
	a.checks.test = { ok: false, at: "2026-01-01T10:00:00Z" };
	assert.equal(chipLabel(a, 1), "🔨⚡🎱💬⚠️alpha", "every glyph up front, so a clipped slug never hides the state");
});

test("widgetLines: one lean line per OTHER flow — the chip label already is the bound one (pi-web chip panel)", () => {
	assert.deepEqual(widgetLines(null, []), [], "no flows, no lines — a plain `💬 no flows` chip");
	const a = newState("alpha", false);
	const b = newState("beta", false);
	b.stage = "pre-release";
	assert.deepEqual(
		widgetLines(null, [a, b]),
		["📝 alpha · plan", "🔍 beta · pre-release"],
		"unbound: every open flow, stage word spelled out",
	);
	assert.deepEqual(widgetLines(a, [a, b]), ["🔍 beta · pre-release"], "bound: its own line is the chip label, not repeated in the panel");
	assert.deepEqual(widgetLines(a, [a]), ["no other flows open"], "bound and alone: the chip still expands, saying so");
	b.patch = true;
	b.yolo = true;
	b.pendingAsk = "Verified?";
	assert.deepEqual(
		widgetLines(null, [b]),
		["🔍 beta ⚡ 🎱 💬 · pre-release"],
		"markers ride exactly as in the footer — one vocabulary, no drift",
	);
	b.checks.test = { ok: false, at: "2026-01-01T10:00:00Z" };
	assert.deepEqual(widgetLines(null, [b]), ["🔍 beta ⚡ 🎱 💬 · pre-release ⚠️"], "⚠️ rides on the flow's own failing checks");
});

test("applyAnswer: dot paths, deletion, empty-object pruning", () => {
	const p: Record<string, unknown> = {};
	applyAnswer(p, "commands.test", "npm test");
	assert.deepEqual(p, { commands: { test: "npm test" } });
	applyAnswer(p, "versioning.file", "VERSION");
	applyAnswer(p, "versioning.pattern", "v{version}");
	applyAnswer(p, "versioning.file", null);
	applyAnswer(p, "versioning.pattern", "");
	assert.equal("versioning" in p, false, "empties prune away");
	applyAnswer(p, "commands.test", "(none)");
	assert.deepEqual(p, {}, "removing the last command prunes commands away");
	applyAnswer(p, "mainHook", false);
	assert.deepEqual(p, { mainHook: false }, "false is a value, not a deletion");
});

test("freshenChecks: a green recorded against a different tree is no green", () => {
	const s = newState("f", false);
	s.checks.test = { ok: true, at: "", wt: "aaa" };
	s.checks.build = { ok: true, at: "" }; // pre-fingerprint record from an older build
	assert.deepEqual(freshenChecks(s, null), [], "git unmeasurable drops nothing — a gate must not refuse on its own probe");
	assert.deepEqual(freshenChecks(s, checkFingerprint(" M src/x.ts", "abc")), ["test"], "the record from a moved tree is stale");
	assert.equal(s.checks.test, undefined, "the stale record is gone — the gate reruns it");
	assert.ok(s.checks.build, "a record without a fingerprint is never proven stale");
	assert.deepEqual(freshenChecks(s, checkFingerprint(" M src/x.ts", "abc")), [], "the same tree fingerprints equal");
	const s2 = newState("g", false);
	s2.checks.health = { ok: true, at: "", wt: "aaa" };
	assert.deepEqual(freshenChecks(s2, "zzz", (n) => n === "health"), [], "a keep predicate spares a name the gate re-probes itself");
	assert.ok(s2.checks.health, "the kept record stands for the deploy probe to overwrite");
	assert.deepEqual(freshenChecks(s2, "zzz"), ["health"], "without the predicate it is stale like any other");
});

test("verifyGate: tier-1 checks green + tier-2 checklist confirmed (ui-aware)", () => {
	const s = { ...newState("f", false), stage: "implement" as const };
	const items = [{ text: "visual pass ok", uiOnly: true }, { text: "docs updated", uiOnly: false }];
	const c = { ...buildConfig({}), checkList: [{ name: "health", cmd: "curl x" }], checklist: { implement: items } };
	assert.ok(verifyGate(s, c).some((e) => e.includes('check "health"')));
	assert.match(verifyGate(s, c).join(" "), /checklist not confirmed \(1 item/, "non-UI feature sees only the non-ui item");
	s.checks.health = { ok: true, at: "" };
	s.confirmations = { implement: { hash: checklistHash([{ text: "docs updated", uiOnly: false }]), at: "" } };
	assert.equal(verifyGate(s, c).length, 0, "non-UI feature satisfied without the ui item");
	assert.match(verifyGate({ ...s, ui: true }, c).join(" "), /checklist not confirmed \(2 item/, "UI feature must confirm both");
	s.confirmations = { implement: { hash: checklistHash(items), at: "" } };
	assert.equal(verifyGate({ ...s, ui: true }, c).length, 0);
});

test("parseVersion: all supported manifest formats", () => {
	assert.equal(parseVersion("VERSION", " v0.13.1-letta_0.34.9 \n"), "v0.13.1-letta_0.34.9");
	assert.equal(parseVersion("package.json", '{"version":"1.2.3"}'), "1.2.3");
	assert.equal(parseVersion("package.json", "{broken"), null);
	assert.equal(parseVersion("Cargo.toml", '[package]\nname = "x"\nversion = "2.0.1"\n'), "2.0.1");
	assert.equal(parseVersion("pyproject.toml", '[project]\nversion = "0.4.0"\n'), "0.4.0");
	assert.equal(parseVersion("Cargo.toml", '[package]\nname = "x"\n'), null);
});

test("pluginVersion: dev-flow's own manifest, found by walking up from the module dir", () => {
	const root = mkdtempSync(path.join(tmpdir(), "devflow-pv-"));
	mkdirSync(path.join(root, "extensions"), { recursive: true });
	writeFileSync(path.join(root, "package.json"), '{"name":"pi-dev-flow","version":"1.2.3","repository":{"url":"git+https://github.com/dmarchevsky/dev-flow.git"}}');
	assert.deepEqual(pluginVersion(path.join(root, "extensions")), { version: "1.2.3", dir: root, repo: "dmarchevsky/dev-flow" }, "nearest manifest named pi-dev-flow wins; git-installed copies carry their upstream");

	// manifest is ours but carries no version: say so about that package, do not walk past it
	writeFileSync(path.join(root, "package.json"), '{"name":"pi-dev-flow"}');
	assert.deepEqual(pluginVersion(path.join(root, "extensions")), { version: null, dir: root, repo: "" });

	// some other package, and nothing of ours above it: unknown, naming where it looked. The name is one
	// no ancestor carries — inside a flow TMPDIR is .dev-flow/<slug>/tmp/ of a dev-flow checkout itself
	const other = mkdtempSync(path.join(tmpdir(), "devflow-pv-"));
	mkdirSync(path.join(other, "lib"), { recursive: true });
	writeFileSync(path.join(other, "package.json"), '{"name":"someone-else","version":"9.9.9"}');
	assert.deepEqual(pluginVersion(path.join(other, "lib"), "pv-fixture-nowhere"), { version: null, dir: path.join(other, "lib"), repo: "" });
});

test("githubSlug: owner/slug from manifest strings, URLs and scp-style remotes", () => {
	assert.equal(githubSlug("github.com/dmarchevsky/dev-flow"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("https://github.com/dmarchevsky/dev-flow.git"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("git@github.com:dmarchevsky/dev-flow.git"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("https://gitlab.com/x/y"), "", "non-GitHub upstreams stay unknown");
	assert.equal(githubSlug(""), "");
});

test("reflectProtocol: session-review steps, npm-based update probe, fold/drop decision, routed open items", () => {
	const out = reflectProtocol(reflectItems("## plugin\n\n- [ ] the gate prompt asks twice — x 2026-01-01\n"), false, { version: "1.2.3", upstream: "dmarchevsky/dev-flow" }).join("\n");
	assert.match(out, /flow reflect — session reflection \(dev-flow 1\.2\.3, upstream: dmarchevsky\/dev-flow\)/);
	assert.match(out, /this output is your work instruction: execute these steps now/);
	assert.match(out, /dev-flow plugin feedback is never written there, it becomes a GitHub issue upstream/);
	assert.match(out, /1\. review the current session log in full/, "unbound: the review runs inline");
	assert.match(out, /git ls-remote --tags --sort=-v:refname https:\/\/github\.com\/dmarchevsky\/dev-flow \| head -1/, "a git-installed copy still gets a git probe");
	assert.match(out, /npm view pi-dev-flow version/);
	assert.match(out, /pi install npm:pi-dev-flow, then \/reload/);
	assert.match(out, /Ask fold or drop per item/);
	assert.match(out, /STOP until the operator answers/);
	assert.match(out, /fold plugin → flow reflect --plugin "<note>" prints the upstream recipe/);
	assert.match(out, /drop → nothing is recorded anywhere/);
	assert.match(out, /\[plugin\] the gate prompt asks twice/);
	assert.match(out, /legacy ## plugin row — belongs on GitHub/);
	assert.ok(out.indexOf("npm view pi-dev-flow") < out.indexOf("git ls-remote"), "npm is the primary update route; the git probe is the fallback for git installs");
	const bound = reflectProtocol([], false, { version: "1.2.3", upstream: "dmarchevsky/dev-flow", bound: true }).join("\n");
	assert.match(bound, /1\. delegate the review: call flow_stage\(op: "reflect"/, "bound: the review goes to a fresh reflect worker");
	assert.match(bound, /every flow_stage worker transcript/);
	const empty = reflectProtocol([], true, { version: null, upstream: "" }).join("\n");
	assert.match(empty, /dev-flow version unknown/);
	assert.match(empty, /<upstream-url>/);
	assert.match(empty, /open items: none/);
	assert.ok(!/closed reflection\(s\)/.test(empty), "no tidy nudge passed, no tidy line");
});

test("reflectProtocol: fix and tidy nudges ride after the decision step", () => {
	const out = reflectProtocol(reflectItems("## playbook\n\n- [ ] an open note"), true, { version: "1.2.3", upstream: "dmarchevsky/dev-flow", tidy: "↻ 6 closed reflection(s) — flow reflect tidy drops them", fix: "⚑ fix the open reflections now? (x)" }).join("\n");
	assert.match(out, /↻ 6 closed reflection\(s\) — flow reflect tidy drops them — offer it to the operator after the fold\/drop answer/);
	assert.match(out, /⚑ fix the open reflections now\? \(x\) — offer it/);
	assert.ok(out.indexOf("closed reflection(s)") < out.indexOf("open items ("), "the hint precedes the routed list the agent acts on");
});

test("childSessionFiles: workers of the driver and their children, never the driver or strangers", () => {
	const h = [
		{ file: "/s/driver.jsonl" },
		{ file: "/s/w1.jsonl", parentSession: "/s/driver.jsonl" },
		{ file: "/s/other.jsonl", parentSession: "/s/someone-else.jsonl" },
		{ file: "/s/w1a.jsonl", parentSession: "/s/w1.jsonl" },
		{ file: "/s/w2.jsonl", parentSession: "/s/driver.jsonl" },
		{ file: "/s/loop.jsonl", parentSession: "/s/loop.jsonl" },
	];
	assert.deepEqual(childSessionFiles("/s/driver.jsonl", h).map((x) => x.file), ["/s/w1.jsonl", "/s/w2.jsonl", "/s/w1a.jsonl"]);
	assert.deepEqual(childSessionFiles("/s/none.jsonl", h), []);
});

test("buildReflectBrief: transcripts, queue, upstream dedupe and the row contract", () => {
	const brief = buildReflectBrief({
		slug: "feat-x", root: "/r", today: "2026-11-03", driverFile: "/s/driver.jsonl",
		children: [{ file: "/s/w1.jsonl" }],
		reflectionsFile: "/r/.dev-flow/reflections.md",
		items: reflectItems("## playbook\n\n- [ ] stale test cmd — a 2026-10-01\n"),
		projectMd: "/r/.dev-flow/project.md", version: "1.2.3", upstream: "dmarchevsky/dev-flow", selfRepo: false,
		projectIssues: { repo: "me/app", issues: [{ number: 7, title: "seed is slow" }] },
		note: "the operator hated the double prompt",
	});
	assert.match(brief, /Driver session transcript \(read it in full\): \/s\/driver\.jsonl/);
	assert.match(brief, /  - \/s\/w1\.jsonl/);
	assert.match(brief, /1\. \[playbook\] stale test cmd — a 2026-10-01/);
	assert.match(brief, /gh issue list --repo dmarchevsky\/dev-flow --state all --search/);
	assert.match(brief, /gh#7 seed is slow/);
	assert.match(brief, /Operator context: the operator hated the double prompt/);
	assert.match(brief, /no gh issue create/);
	assert.match(brief, /F<n> \| fold\|drop \| docs\|code\|plugin/);
	assert.match(brief, /O<n> \| still-open\|fixed\|recurred/);
	const self = buildReflectBrief({ slug: "s", root: "/r", today: "d", driverFile: null, children: [], reflectionsFile: "f", items: [], projectMd: "p", version: null, upstream: "", selfRepo: true, note: "" });
	assert.match(self, /not file-backed/);
	assert.match(self, /no flow_stage worker ran/);
	assert.match(self, /this checkout IS dev-flow/);
	assert.ok(!self.includes("gh issue list --repo"), "no upstream search line without a foreign upstream");
});

test("buildReflectBrief: prebuilt digests, prefetched upstream issues and the budget replace the dump-and-search loop", () => {
	const brief = buildReflectBrief({
		slug: "feat-x", root: "/r", today: "2026-11-03", driverFile: "/s/driver.jsonl", children: [],
		reflectionsFile: "f", items: [], projectMd: "p", version: "1", upstream: "me/dev-flow", selfRepo: false,
		digests: [{ transcript: "/s/driver.jsonl", digest: "/r/.dev-flow/feat-x/tmp/reflect/driver.digest.txt" }],
		upstreamIssues: [{ number: 142, title: "worker cap cuts mid-stage", state: "CLOSED" }],
		budgetMin: 20, note: "",
	});
	assert.match(brief, /Start here — digests already built for you/);
	assert.match(brief, /\/r\/\.dev-flow\/feat-x\/tmp\/reflect\/driver\.digest\.txt  \(of driver\.jsonl\)/);
	assert.ok(!brief.includes("Skim with jq"), "with digests the raw-dump recipe is not offered");
	assert.match(brief, /gh#142 \[closed\] worker cap cuts mid-stage/);
	assert.ok(!brief.includes("--search"), "a prefetched list replaces the search loop");
	assert.match(brief, /Budget: 20 min, wall clock\. Aim to write the REPORT by about 60%/);
	assert.match(brief, /you review the session, not the product/i);
});

test("digestTranscript: operator words, flow calls and answers, errors and repeats — line-tagged, a fraction of the raw size", () => {
	const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: "2026-11-03T20:00:00Z", message: { role, content, ...extra } });
	const call = (id: string, name: string, args: unknown) => msg("assistant", [{ type: "thinking", thinking: "x".repeat(5000) }, { type: "toolCall", id, name, arguments: args }]);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "d" }),
		msg("user", [{ type: "text", text: "fix the status dot" }]),
		call("c1", "flow", { args: ["start", "dot"] }),
		msg("toolResult", [{ type: "text", text: "feature dot started at stage plan" }], { toolCallId: "c1", toolName: "flow", isError: false }),
		call("c2", "bash", { command: "npm test" }),
		msg("toolResult", [{ type: "text", text: "1 failing: dot.test.ts" }], { toolCallId: "c2", toolName: "bash", isError: true }),
		call("c3", "bash", { command: "npm test" }),
		call("c4", "bash", { command: "npm test" }),
		call("c5", "bash", { command: "cat big.log" }),
		msg("toolResult", [{ type: "text", text: "y".repeat(50_000) }], { toolCallId: "c5", toolName: "bash", isError: false }),
		JSON.stringify({ type: "compaction", summary: "s" }),
		JSON.stringify({ type: "custom_message", customType: "flow", content: "release needs the operator: NEEDS-OPERATOR" }),
		"not json",
	];
	const raw = lines.join("\n");
	const d = digestTranscript(raw);
	assert.match(d, /^digest: \d+ entries, 5 tool calls, 1 tool errors, 2026-11-03T20:00:00Z/);
	assert.match(d, /×3 from L5: npm test/);
	assert.match(d, /L2 OPERATOR: fix the status dot/);
	assert.match(d, /L3 flow start dot/);
	assert.match(d, /L4   ↳ feature dot started at stage plan/);
	assert.match(d, /L6 ERROR bash \(call L5: npm test\) → 1 failing: dot\.test\.ts/);
	assert.match(d, /L11 ── compaction/);
	assert.match(d, /L12 \/flow → release needs the operator/);
	assert.ok(!d.includes("yyyy"), "a plain tool result's output is not copied");
	assert.ok(!d.includes("xxxx"), "thinking is not copied");
	assert.ok(d.length < raw.length / 20, `digest ${d.length} vs raw ${raw.length}`);
	const clipped = digestTranscript(Array.from({ length: 400 }, (_, i) => msg("user", `operator line ${i} ${"z".repeat(300)}`)).join("\n"), { maxChars: 4000 });
	assert.match(clipped, /operator line 0 /, "the start survives the clip");
	assert.match(clipped, /operator line 399 /, "the end survives the clip");
	assert.match(clipped, /digest clipped/);
});

test("workerSteer: names the time left; implement commits, read-only ops write the REPORT", () => {
	assert.match(workerSteer("reflect", 20), /about 5 min of your 20-min budget/);
	assert.match(workerSteer("reflect", 20), /Stop probing and write the REPORT section now/);
	assert.match(workerSteer("implement", 60), /about 15 min .* commit what works/);
});

test("buildWorkerBrief: no plan file (a --docs / --patch flow) is said, not sent after as an ENOENT (gh#167)", () => {
	const base = { op: "review" as const, slug: "d", workDir: "/w", defaultBranch: "main", commits: "", status: "", checks: [], note: "review the docs change" };
	const none = buildWorkerBrief({ ...base, planFile: null });
	assert.match(none, /Plan: none — this flow \(--docs \/ --patch\) has no plan file by design/);
	assert.match(none, /Check, don't fix: read the task, the diff \(`git diff main\.\.\.HEAD`\)/);
	assert.ok(!none.includes("Approved plan"));
	const withPlan = buildWorkerBrief({ ...base, planFile: "/r/.dev-flow/d/plan/plan.md" });
	assert.match(withPlan, /Approved plan \(read it first; it is outside the worktree\): \/r\/\.dev-flow\/d\/plan\/plan\.md/);
	assert.match(withPlan, /read the plan, the diff/);
});

test("buildWorkerBrief: an implement worker sharing a dirty worktree commits only its own paths", () => {
	const base = { op: "implement" as const, slug: "r", workDir: "/w", defaultBranch: "main", commits: "", checks: [], note: "slice", planFile: null };
	const dirty = buildWorkerBrief({ ...base, status: " M web/src/App.tsx\nD  web/src/Old.tsx" });
	assert.match(dirty, /driving session's work in progress, not yours: never stage or commit them/);
	assert.match(dirty, /never `git add -A`, `git add \.` or `git commit -a`/);
	assert.ok(!buildWorkerBrief({ ...base, status: "" }).includes("work in progress, not yours"), "a clean worktree needs no warning");
	assert.ok(!buildWorkerBrief({ ...base, op: "review", status: " M x" }).includes("not yours"), "a reviewer commits nothing anyway");
});

test("conflictMarkerLines: added markers are named with file:line; removed lines and setext underlines are not (#164)", () => {
	const diff = [
		"diff --git a/CHANGELOG.md b/CHANGELOG.md",
		"--- a/CHANGELOG.md",
		"+++ b/CHANGELOG.md",
		"@@ -3,0 +4,3 @@",
		"+- new entry",
		"+>>>>>>> origin/main",
		"+=======",
		"@@ -20 +23 @@",
		"-<<<<<<< HEAD",
		"+<<<<<<<",
		"diff --git a/docs/a.md b/docs/a.md",
		"--- a/docs/a.md",
		"+++ b/docs/a.md",
		"@@ -1,0 +2,2 @@",
		"+Title",
		"+=======",
		"+>>>>>>>>>> not a marker (ten)",
	].join("\n");
	assert.deepEqual(conflictMarkerLines(diff), ["CHANGELOG.md:5: >>>>>>> origin/main", "CHANGELOG.md:23: <<<<<<<"]);
	assert.deepEqual(conflictMarkerLines(""), []);
});

test("preReleaseGate: leftover conflict markers refuse the release unless the operator grants --no-marker-check", () => {
	const c0 = buildConfig({});
	const st = { ...newState("m", false), stage: "pre-release" as const, noVersion: true };
	const prep = { manifestVersion: null, remoteTags: [], changelog: null, changelogChanged: null, conflictMarkers: ["CHANGELOG.md:5: >>>>>>> origin/main"] };
	assert.ok(preReleaseGate(st, c0, prep).some((e) => /adds 1 merge-conflict marker line\(s\)[\s\S]*CHANGELOG\.md:5/.test(e)));
	assert.ok(!preReleaseGate(st, c0, { ...prep, noMarkerCheck: true }).some((e) => /conflict marker/.test(e)));
	assert.ok(!preReleaseGate(st, c0, { ...prep, conflictMarkers: [] }).some((e) => /conflict marker/.test(e)));
});

test("--docs --no-version: no changelog proof (#163); (versioned) items stand down; the pre-release hint says unversioned is the usual docs path (#166)", () => {
	const c = buildConfig({ versioning: { file: "VERSION" }, release: { changelog: "CHANGELOG.md" } });
	const docs = { ...newState("d", false, false, true), stage: "pre-release" as const, noVersion: true };
	const prep = { manifestVersion: null, remoteTags: [], changelog: { file: "CHANGELOG.md", content: "# Changelog\n\n## [Unreleased]\n" }, changelogChanged: false };
	assert.deepEqual(preReleaseGate(docs, c, prep), [], "a docs flow shipped unversioned owes no changelog line");
	const code = { ...newState("n", false), stage: "pre-release" as const, noVersion: true, checks: { test: { ok: true, at: "" } } };
	assert.ok(preReleaseGate(code, c, prep).some((e) => /unchanged on this branch/.test(e)), "a code flow shipped unversioned still does");
	c.checklist.release = [{ text: "image tag matches", uiOnly: false, versionedOnly: true }, { text: "PR merged", uiOnly: false }];
	assert.deepEqual(applicableItems(c, docs, "release").map((i) => i.text), ["PR merged"]);
	assert.equal(checklistPending(c, docs, "release"), 1);
	assert.deepEqual(applicableItems(c, { ...docs, noVersion: false }, "release").map((i) => i.text), ["image tag matches", "PR merged"]);
	const hint = nextHint({ ...docs, noVersion: false }, c);
	assert.match(hint, /a docs flow usually ships unversioned — ask the operator \(flow release --no-version on their word\)/);
	assert.match(nextHint({ ...newState("v", false), stage: "pre-release" as const }, c), /bump version in VERSION/, "a normal flow keeps the versioned hint");
});

test("reflectDone: checks item n off with a fixed note, in list numbering (#165)", () => {
	const text = "# r\n\n## playbook\n\n- [ ] a — s 2026-10-01\n- [x] old — fixed: x\n\n## code\n\n- [ ] b — s 2026-10-02\n";
	const next = reflectDone(text, 2, "2026-11-03 fix-b — PR #9")!;
	assert.match(next, /- \[x\] b — s 2026-10-02 — fixed: 2026-11-03 fix-b — PR #9/);
	assert.match(next, /- \[ \] a — s 2026-10-01/, "the other item stays open");
	assert.equal(reflectItems(next).length, 1);
	assert.equal(reflectDone(text, 3, "x"), null);
});

test("parseReflectReport + renderReflectFindings: rows parse, junk is skipped, plugin routes upstream", () => {
	const body = [
		"F1 | fold | docs | test command drifted to pnpm | dup: none | why: hit 3 times | evidence: driver.jsonl:120",
		"- F2 | drop | plugin | guard blocked a scratch write | dup: gh#12 | why: already filed",
		"`F3 | fold | code | seed script skips admins | dup: #2 | why: real bug | evidence: w1.jsonl:40`",
		"F4 | maybe | docs | bad rec",
		"O1 | recurred | the stale checklist hit again (driver.jsonl:88)",
		"O2 | fixed | project.md line 12 now says pnpm",
		"O3 | bogus | x",
	].join("\n");
	const r = parseReflectReport(body);
	assert.deepEqual(r.findings.map((f) => [f.n, f.rec, f.kind, f.dup]), [[1, "fold", "docs", "none"], [2, "drop", "plugin", "gh#12"], [3, "fold", "code", "#2"]]);
	assert.equal(r.findings[0].evidence, "driver.jsonl:120");
	assert.deepEqual(r.open.map((o) => [o.n, o.status]), [[1, "recurred"], [2, "fixed"]]);
	const out = renderReflectFindings(r, false).join("\n");
	assert.match(out, /1\. \[fold\] docs: test command drifted to pnpm\n      → docs flow · record: flow reflect --playbook · hit 3 times/);
	assert.match(out, /2\. \[drop\] plugin: guard blocked a scratch write\n      → upstream GitHub issue · flow reflect --plugin prints the recipe \(never a local row\) · dup: gh#12/);
	assert.match(out, /3\. \[fold\] code: .*\n      → patch flow · record: flow reflect --code · dup: #2/);
	assert.match(out, /#1 recurred — .* → recommend fixing it now/);
	assert.match(out, /#2 fixed — .* → propose the check-off/);
	assert.match(renderReflectFindings(r, true).join("\n"), /2\. \[drop\] plugin: .*\n      → patch flow/, "in the dev-flow repo plugin is code");
	assert.deepEqual(parseReflectReport("nothing useful here"), { findings: [], open: [] });
	assert.match(renderReflectFindings({ findings: [], open: [] }, false).join("\n"), /findings: none/);
});

test("versionTagGate: manifest and tag must agree", () => {
	assert.deepEqual(versionTagGate("1.2.3", "v{version}", ["v1.2.3", "v1.2.2"]), []);
	assert.match(versionTagGate("1.2.3", "v{version}", ["v1.2.2"])[0], /expected release tag "v1\.2\.3"/);
	assert.deepEqual(versionTagGate("0.13.1-letta_0.34.9", "{version}", ["0.13.1-letta_0.34.9"]), [], "suffix-style patterns");
});


test("foreignWorktreeLinks: a mockup linking another feature's worktree is named; main checkout, own worktree and web links are fine", () => {
	const df = "/r/.dev-flow";
	const html = (href: string) => `<link rel="stylesheet" href="${href}">`;
	const links = foreignWorktreeLinks(df, "rail", [
		{ file: "mockups/a.html", html: html("../../../status-and-loading/worktree/web/src/styles.css") },
		{ file: "mockups/b.html", html: html("../../../../web/src/styles.css") },
		{ file: "mockups/c.html", html: html("../../worktree/web/src/styles.css") },
		{ file: "mockups/d.html", html: `<style>@import url("file:///r/.dev-flow/other/worktree/x.css");</style><img src="https://x/y.png">` },
	]);
	assert.deepEqual(links, ["mockups/a.html: ../../../status-and-loading/worktree/web/src/styles.css", "mockups/d.html: file:///r/.dev-flow/other/worktree/x.css"]);
	const errs = approveGate(newState("rail", false), cfg, ["plan.md"], "", links);
	assert.ok(errs.some((e) => /mockups link another feature's worktree — mockups\/a\.html/.test(e) && /link the main checkout's stylesheet/.test(e)));
	assert.deepEqual(approveGate(newState("rail", false), cfg, ["plan.md"], ""), []);
});

test("approveGate: patch features skip the plan document, gates stay", () => {
	const p = newState("p", false, true);
	assert.equal(approveGate(p, buildConfig({}), []).length, 0, "patch: empty plan/ passes the gate");
	assert.equal(approveGate(newState("p", false), buildConfig({}), []).length, 1, "non-patch still requires plan/*.md");
	assert.ok(statusCompact(p).text.includes("⚡"), "status marks patch features");
});

test("docs mode: no plan document, no tier-1 checks, release integrity intact", () => {
	const cfg = buildConfig({ commands: { test: "x" } });
	assert.equal(approveGate(newState("d", false, false, true), buildConfig({}), []).length, 0, "docs: empty plan/ passes the gate");
	assert.ok(approveGate(newState("d", false), buildConfig({}), []).length === 1, "normal features still require plan/*.md");
	assert.ok(statusCompact(newState("d", false, false, true)).text.includes("📚"), "status marks docs features");
	const d = { ...newState("d", false, false, true), stage: "implement" as const };
	assert.equal(verifyGate(d, cfg).length, 0, "docs skips the tier-1 check requirement");
	assert.ok(verifyGate({ ...newState("d", false), stage: "implement" as const }, cfg).length > 0, "non-docs still demands green checks");
	const pre = { ...newState("d", false, false, true), stage: "pre-release" as const };
	const c3 = buildConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const prep = { manifestVersion: "1.2.0", remoteTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0\n- shipped\n" }, changelogChanged: false };
	assert.ok(!preReleaseGate(pre, c3, prep).some((e) => e.includes("flow check")), "docs release gate skips re-greened checks");
	assert.ok(preReleaseGate(pre, c3, { ...prep, manifestVersion: null }).some((e) => e.includes("no parsable version")), "docs still needs the version bump");
});

test("shouldSelfCompact: only near pi's threshold and only when no chat-only state is pending", () => {
	// 200k window, default reserve 16384 + margin 16384 → trigger above 167232 tokens
	const base = { tokens: 190_000, contextWindow: 200_000, stage: "implement" as const, planFiles: 1, checklistPending: 0, compacting: false };
	assert.equal(shouldSelfCompact(base), true);
	assert.equal(shouldSelfCompact({ ...base, tokens: 167_232 }), false, "at threshold-minus-margin is still too early");
	assert.equal(shouldSelfCompact({ ...base, tokens: 167_233 }), true, "one over threshold-minus-margin triggers");
	assert.equal(shouldSelfCompact({ ...base, tokens: null }), false, "unknown usage");
	assert.equal(shouldSelfCompact({ ...base, stage: null }), false, "no flow bound");
	assert.equal(shouldSelfCompact({ ...base, checklistPending: 2 }), false, "operator dialog in flight — chat is the state");
	assert.equal(shouldSelfCompact({ ...base, stage: "plan", planFiles: 0 }), false, "undigested plan discussion");
	assert.equal(shouldSelfCompact({ ...base, stage: "plan", planFiles: 1 }), true, "plan on disk is safe to summarize");
	assert.equal(shouldSelfCompact({ ...base, planFiles: 0 }), true, "planFiles only matter at plan stage");
	assert.equal(shouldSelfCompact({ ...base, compacting: true }), false, "no stacked compactions");
	assert.equal(shouldSelfCompact({ ...base, tokens: 968_000, contextWindow: 1_000_000 }), true, "big window uses the same absolute margin");
	assert.equal(shouldSelfCompact({ ...base, tokens: 850_000, contextWindow: 1_000_000 }), false, "85% of a 1M window is still comfortable");
	// the real (settings/model-overridden) reserve moves the trigger, like it moves pi's own
	assert.equal(shouldSelfCompact({ ...base, tokens: 150_000 }, 40_000), true, "reserve 40k lowers the threshold below 150k");
	assert.equal(shouldSelfCompact({ ...base, tokens: 143_616 }, 40_000), false, "at the reserve-40k threshold-minus-margin");
	assert.equal(shouldSelfCompact({ ...base, tokens: 143_617 }, 40_000), true, "one over the reserve-40k threshold-minus-margin");
});

test("shouldTakeOverCompaction: only pi's threshold path, only when bound and idle", () => {
	assert.equal(shouldTakeOverCompaction({ reason: "threshold", bound: true, inFlight: false }), true);
	assert.equal(shouldTakeOverCompaction({ reason: "manual", bound: true, inFlight: false }), false, "/compact is the operator's; our own takeover fires as manual");
	assert.equal(shouldTakeOverCompaction({ reason: "overflow", bound: true, inFlight: false }), false, "cancelling overflow recovery drops pi's retry");
	assert.equal(shouldTakeOverCompaction({ reason: "threshold", bound: false, inFlight: false }), false, "no flow bound — nothing flow-aware to say");
	assert.equal(shouldTakeOverCompaction({ reason: "threshold", bound: true, inFlight: true }), false, "no stacked compactions");
});


// ---------------------------------------------------------------- flow-guard rules

const rules = (o: Partial<GuardRules> = {}): GuardRules => ({ deny: [], confirm: [], protect: [], forbid: [], ...o });

test("bashSegments: quoted text is an argument, not a command", () => {
	assert.deepEqual(bashSegments('git add -A && gh pr create --title "x" --body "first line\ngit commit -m done\nthen push"'), [
		"git add -A",
		'gh pr create --title "x" --body "first line\ngit commit -m done\nthen push"',
	]);
	assert.deepEqual(bashSegments("echo 'a; b' && ls"), ["echo 'a; b'", "ls"], "separators inside quotes stay inside");
	// an unbalanced quote is a typo, not an escape hatch: the plain split still shows the hidden command
	assert.ok(bashSegments('echo "oops && git push origin main').some((s) => s.includes("git push")), "unbalanced quoting keeps the raw split");
	assert.deepEqual(gitInvocation('gh pr create --body "line one\ngit commit -m x\nline three"').subs, [], "a quoted body discussing a commit runs no commit");
	assert.deepEqual(gitInvocation('sh -c "git push origin main"').subs, ["push"], "a wrapper that execs its argument still runs git");
	assert.ok(gitInvocation('sh -c "git add . && git commit -m x"').subs.includes("commit"), "every verb in a wrapper's payload counts, not just the first");
});

test("playbookTamper: quoting the target does not hide the write", () => {
	assert.ok(playbookTamper('cp "/tmp/project.md.bak" ".dev-flow/project.md"'), "a quoted destination is still the playbook");
	assert.ok(playbookTamper('printf x > ".dev-flow/project.md"'), "a quoted redirect target is still the playbook");
});

test("maskQuoted: what a command says is not what it does", () => {
	assert.equal(maskQuoted('gh pr create --body "ship it"'), 'gh pr create --body ""');
	assert.equal(maskQuoted("git commit -m 'ship it' -a"), 'git commit -m "" -a');
});

test("heredoc bodies are an argument's prose, not commands", () => {
	const commit = "git commit -F - <<'MSG'\nfix: the gate\n\nflow status said otherwise, and .dev-flow/demo/state.json was named here\nMSG";
	assert.equal(flowShellInvocation(commit), false, "a commit message line starting with `flow status` is not an invocation");
	assert.equal(stateTamper(commit), false, "naming flow state inside a message is not a write to it");
	assert.equal(playbookTamper("cat > /tmp/note.md <<'MD'\nsee .dev-flow/project.md\nMD"), false, "the redirect goes to /tmp, the body names the playbook");
	assert.deepEqual(bashSegments(commit), ["git commit -F -", "MSG"], "the body is blanked, the terminator line stays");
	assert.equal(stripHeredocBodies("a <<'M'\nx\ny\nM\n").length, 5, "line count is kept, so segment order survives");
	// the mask is scoped per segment: a real command after the terminator is still judged
	assert.ok(flowShellInvocation("git commit -m x <<'M'\nflow doctor\nM\nflow status"), "a later segment is untouched by the mask");
	assert.ok(stateTamper("cat <<'M'\nprose\nM\nrm -rf .dev-flow/demo"), "and so is a destructive one");
	// a head that execs its argument really runs its heredoc — masking it would unsee code
	assert.ok(flowShellInvocation("node - <<'JS'\nflow status\nJS"), "a heredoc piped into node is a program");
	assert.ok(flowShellInvocation("sh <<'SH'\nflow status\nSH"), "same for sh");
	assert.deepEqual(bashSegments("echo $((1<<2))\nflow status").length, 2, "a shift is not a heredoc opener");
	assert.deepEqual(bashSegments("flow status"), ["flow status"], "no heredoc, no change");
});

test("playbookTamper: prose about a write is not a write; a wrapper's payload is", () => {
	// the real v0.37.0 incident: a PR body quoting a copy of the playbook was refused as if it were the copy
	assert.equal(playbookTamper('gh pr create --title "t" --body "a safety copy was wrongly refused: cp the playbook to /tmp/project.md.bak .dev-flow/project.md"'), false);
	assert.ok(playbookTamper("bash -c 'cp /tmp/project.md.bak .dev-flow/project.md'"), "a shell wrapper's payload is code");
	assert.equal(playbookTamper("echo 'sed -i s/a/b/ .dev-flow/project.md' > /tmp/notes.md"), false, "a quoted mention, redirect elsewhere");
});

test("stateTamper: the folder is state — deleting it is tampering, reads are not", () => {
	// the old guard matched one path shape: it blocked a read through a bare `-e` and let the folder go
	assert.ok(stateTamper("rm -rf .dev-flow/my-feature"), "deleting the feature dir deletes its state and its plan");
	assert.ok(stateTamper("rm -rf /home/x/repo/.dev-flow/my-feature"), "absolute paths are the shape the harness hands the agent — /repo/.dev-flow/foo is the same folder");
	assert.ok(stateTamper("rm -rf /home/x/repo/.dev-flow"), "the whole folder by absolute path deletes every feature");
	assert.equal(stateTamper("rm -rf /home/x/repo/.dev-flow/my-feature/worktree/node_modules"), false, "the absolute twin keeps the worktree parity: inside a worktree is the feature's own working area");
	assert.equal(stateTamper('git commit -m "removed /home/x/repo/.dev-flow/foo by accident"'), false, "prose naming the absolute path is not a delete");
	assert.ok(stateTamper("rm .dev-flow/f/claim.json"), "the claim is the live-session lock — deleting it steals the flow");
	assert.ok(stateTamper("rm /home/x/repo/.dev-flow/f/claim.json"), "also at an absolute path");
	assert.equal(stateTamper("cat .dev-flow/f/claim.json"), false, "reading the claim is fine");
	assert.ok(stateTamper("rm -rf .dev-flow"), "deleting the folder deletes every feature");
	assert.ok(stateTamper("cd .dev-flow/my-feature && mv state.json /tmp/bak"), "a cd-relative move of state.json still destroys it");
	assert.ok(stateTamper("sh -c 'rm -rf .dev-flow/my-feature'"), "a wrapper's payload is the same command");
	assert.equal(stateTamper("jq -e .stage .dev-flow/my-feature/state.json"), false, "a read is not a write");
	assert.equal(stateTamper("rm src/state.json"), false, "a project's own state.json is none of our business");
	assert.equal(stateTamper("rm .dev-flow/roadmap.md"), false, "the advisory backlog stays deletable");
	assert.equal(stateTamper("rm -rf .dev-flow/my-feature/worktree/node_modules"), false, "inside a worktree is the feature's own working area");
	assert.equal(stateTamper("ls .dev-flow"), false, "a listing is a listing");
	assert.equal(stateTamper("python tools/render.py --dir .dev-flow/my-feature"), false, "pointing a script at a feature dir is not deleting it");
});

test("playbookTamper: moving the playbook away is a write to it too", () => {
	assert.ok(playbookTamper("mv .dev-flow/project.md /tmp/gone"), "mv out of the way destroys the operator's rules");
});

test("guardBash: deny blocks with the operator's reason, confirm is collected for the caller to ask", () => {
	const g = rules({
		deny: [{ pattern: "\\bgit\\b[^]*--force(?!\\w)", why: "history stays linear" }],
		confirm: [{ pattern: "\\bdocker\\b[^]*\\bcompose\\b[^]*\\brestart\\b", why: "drops the upstream" }],
	});
	assert.equal(guardBash("git push --force-with-lease origin feat/x", g).block, "project rule: history stays linear");
	assert.equal(guardBash("git push origin feat/x", g).block, null);
	assert.deepEqual(guardBash("docker compose restart app", g).confirms.map((r) => r.why), ["drops the upstream"]);
	assert.equal(guardBash("docker compose restart app", g).block, null, "a confirm rule never blocks on its own");
	assert.equal(guardBash("ls -la", rules()).block, null, "no rules, no verdict");
});

test("guardBash: read-only segments are skipped — quoted text is not a command", () => {
	const g = rules({ deny: [{ pattern: "\\bgit\\b[^]*--force", why: "no force pushes" }] });
	assert.equal(guardBash('grep -rn "git push --force origin main" docs/', g).block, null, "a docs search quoting the denied command must not trip");
	assert.equal(guardBash("git log --oneline && git status", g).block, null, "read-only git subcommands are skipped");
	assert.equal(guardBash("git push origin feat && grep -- --force NOTES.md", g).block, null, "a later segment's word cannot complete an earlier segment's rule");
	assert.equal(guardBash("git log --oneline && git push --force", g).block, "project rule: no force pushes", "the doing-segment still trips");
	assert.match(guardBash('echo "git push --force" >> notes.md', g).block ?? "", /no force pushes/, "a redirect makes even echo a write");
});

test("guardBash: a read-only head that can still write is judged like a writer", () => {
	const del = rules({ deny: [{ pattern: "\\brm\\b", why: "no deletes" }] });
	assert.equal(guardBash("find src -name '*.test.ts' -exec rm {} ;", del).block, "project rule: no deletes", "find -exec runs the denied verb");
	const push = rules({ deny: [{ pattern: "git push", why: "no push" }] });
	assert.equal(guardBash('find . -name x -exec git push origin main {} +', push).block, "project rule: no push", "find -delete/-exec are not reads");
	assert.equal(guardBash('awk "BEGIN{system(\'git push origin main\')}"', push).block, "project rule: no push", "awk system() executes");
	assert.equal(guardBash("find src -name '*.test.ts'", push).block, null, "a plain find still reads");
	assert.equal(guardBash('grep -rn "git push origin main" docs/', push).block, null, "the doc search stays a read");
});

test("guardBash: deny beats confirm inside one chain", () => {
	const g = rules({
		deny: [{ pattern: "\\bgit\\b[^]*worktree\\s+prune", why: "prunes other sessions" }],
		confirm: [{ pattern: "\\bdocker\\b[^]*\\bcompose\\b[^]*\\bdown\\b", why: "stops containers" }],
	});
	const v = guardBash("docker compose down && git worktree prune", g);
	assert.equal(v.block, "project rule: prunes other sessions");
});

test("guardPath: subtree, paths that do not exist yet, and no escaping the root", () => {
	const root = mkdtempSync(path.join(tmpdir(), "guard-"));
	mkdirSync(path.join(root, "docker")); // docker/secrets does not exist yet
	const g = rules({ protect: [{ pattern: "docker/.env", why: "live secrets" }], forbid: [{ pattern: "docker/secrets", why: "secret storage" }] });
	assert.equal(guardPath(path.join(root, "docker/secrets/new-key.pem"), root, g).block, "project rule: secret storage", "a directory rule covers its subtree, created or not");
	assert.equal(guardPath(path.join(root, "docker/.env"), root, g).confirm, "live secrets");
	assert.equal(guardPath(path.join(root, "docker/x/../.env"), root, g).confirm, "live secrets", "a lexical .. still lands on the rule");
	assert.equal(guardPath(path.join(root, "src/app.ts"), root, g).block, null);
	const elsewhere = mkdtempSync(path.join(tmpdir(), "outside-"));
	assert.equal(guardPath(path.join(elsewhere, "docker/.env"), root, g).confirm, null, "the same relative path in another checkout is not this repo's file");
	// a basename glob is a sibling set: the backup beside a secret is the same secret (#87)
	const glob = rules({ protect: [{ pattern: "docker/.env*", why: "live secrets and their backups" }], forbid: [{ pattern: "docker/keys-?", why: "one-off key dumps" }] });
	assert.equal(guardPath(path.join(root, "docker/.env"), root, glob).confirm, "live secrets and their backups", "the rule's own file still matches");
	assert.equal(guardPath(path.join(root, "docker/.env.bak-20261021"), root, glob).confirm, "live secrets and their backups", "the backup beside it is covered");
	assert.equal(guardPath(path.join(root, "docker/app.py"), root, glob).confirm, null, "a sibling that does not match is nobody's business");
	assert.equal(guardPath(path.join(root, "docker/sub/.env"), root, glob).confirm, null, "a basename glob is a sibling set, not a subtree");
	assert.equal(guardPath(path.join(root, "docker/keys-7"), root, glob).block, "project rule: one-off key dumps", "? matches one character, in forbid too");
	assert.equal(guardPath(path.join(root, "docker/keys-77"), root, glob).block, null, "? is exactly one character");
	const linkRoot = mkdtempSync(path.join(tmpdir(), "link-"));
	symlinkSync(path.join(root, "docker"), path.join(linkRoot, "d"));
	assert.deepEqual(guardPath(path.join(linkRoot, "d/.env.bak"), linkRoot, rules({ protect: [{ pattern: "d/.env*", why: "via symlink" }] })), { block: null, confirm: "via symlink" }, "a symlinked directory cannot dodge a glob rule");
});

test("buildConfig reads guard rules (bare patterns and objects)", () => {
	const c = buildConfig({ guard: { deny: ["\\bgit\\b[^]*--force"], forbid: [{ pattern: "docker/secrets", why: "secret storage" }] } });
	assert.deepEqual(c.guard.deny, [{ pattern: "\\bgit\\b[^]*--force", why: "" }]);
	assert.equal(c.guard.forbid[0].why, "secret storage");
	assert.deepEqual(buildConfig(null).guard, { deny: [], confirm: [], protect: [], forbid: [] });
});

test("claimBlocks refuses a silent take-over only for a foreign live claim", () => {
	const claim = { key: "A", pid: 123, at: "now" };
	assert.equal(claimBlocks(null, "B"), false, "no claim — nothing to refuse");
	assert.equal(claimBlocks(claim, "A"), false, "our own claim — nothing to take over");
	assert.equal(claimBlocks(claim, "B", () => true), true, "foreign claim from a live pid — take-over refused");
	assert.equal(claimBlocks(claim, "B", () => false), false, "foreign claim from a dead pid — claim is void");
});

test("pidAlive probes process existence without signaling", () => {
	assert.equal(pidAlive(process.pid), true, "our own process is alive");
	assert.equal(pidAlive(2 ** 30), false, "a pid beyond the range is dead");
	assert.equal(pidAlive("123" as unknown as number), false, "a corrupt pid value reads as dead, not as a crash");
});

test("cmpVersions: numeric segment compare (#52)", () => {
	assert.ok(cmpVersions("1.2.0", "1.2.1") < 0);
	assert.ok(cmpVersions("0.10.0", "0.9.9") > 0, "numeric, not lexical");
	assert.equal(cmpVersions("1.2", "1.2.0"), 0);
	assert.ok(cmpVersions("1.2.3-rc1", "1.2.3") < 0, "a non-numeric segment counts as 0 — 1.2.3-rc1 reads as 1.2.0");
});

test("sessionRunsOlderBuild: which dev-flow a session actually runs", () => {
	// the manifest on disk moved past the loaded code after a release, and the session kept shipping from behind (#51 dogfood)
	assert.equal(sessionRunsOlderBuild("0.36.0", "0.37.0"), "0.36.0");
	assert.equal(sessionRunsOlderBuild("0.37.0", "0.37.0"), "", "a current build says nothing");
	assert.equal(sessionRunsOlderBuild(null, "0.37.0"), "", "unknown loaded build: no claim either way");
	assert.equal(sessionRunsOlderBuild("0.37.0", null), "", "nothing to compare against");
});

test("changelogVersionsBetween: what a stale session is missing", () => {
	const cl = "# Changelog\n\n## [Unreleased]\n\n## [0.54.0] - 2026-10-22\nx\n\n## [0.53.2] - 2026-10-22\ny\n\n## [0.53.0]\nz\n\n## [0.52.0]\nw\n";
	assert.deepEqual(changelogVersionsBetween(cl, "0.53.0", "0.54.0"), ["0.54.0", "0.53.2"], "from exclusive, to inclusive, newest first");
	assert.deepEqual(changelogVersionsBetween(cl, "0.54.0", "0.54.0"), [], "a current build misses nothing");
	assert.deepEqual(changelogVersionsBetween(cl, "0.54.0", "0.55.0"), [], "nothing shipped above the newest heading");
	assert.deepEqual(changelogVersionsBetween("## not-a-version\n## [1.2.3]\n", "0.0.1", "9.9.9"), ["1.2.3"], "bracketed headings parse; prose headings are skipped");
	assert.deepEqual(changelogVersionsBetween(cl, "garbage", "0.54.0"), [], "an unparseable bound claims nothing");
	assert.deepEqual(changelogVersionsBetween(cl, "0.52.0", "0.54.0").length, 3, "a stale session sees every release it skipped");
});

test("what the forge already has: newestTaggedVersion and ls-remote parsing (#52)", () => {
	assert.equal(newestTaggedVersion("v{version}", ["v0.9.0", "v0.10.0", "not-a-release"]), "0.10.0");
	assert.equal(newestTaggedVersion("v{version}", ["release-1"]), null, "no matching tag");
	assert.equal(newestTaggedVersion("rel-{version}", ["rel-1.0.1", "rel-1.0.2"]), "1.0.2", "a prefixed pattern too");
	assert.deepEqual(parseLsRemoteTags("abc\trefs/tags/v1.0.0\ndef\trefs/tags/v1.0.0^{}\nghi\trefs/tags/v1.1.0\n"), ["v1.0.0", "v1.1.0"], "peeled refs collapse into their tag");
});

test("preReleaseGate (#97): the entry is this branch's own, and pending lines must survive the fold", () => {
	const s = { ...newState("f", false), stage: "pre-release" as const, checks: { test: { ok: true, at: "" } } };
	const c2 = buildConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const fold = "## [1.2.0] - 2026-10-22\n\n### Fixed\n\n- parked one\n- parked two\n";
	const prep = (over: Record<string, unknown> = {}) => ({
		manifestVersion: "1.2.0",
		remoteTags: ["v1.1.0"],
		changelog: { file: "CHANGELOG.md", content: fold },
		changelogChanged: true,
		changelogBase: { pending: ["parked one", "parked two"], source: "tag" as const },
		...over,
	});
	assert.equal(preReleaseGate(s, c2, prep()).length, 0, "a verbatim fold of what was pending passes");
	assert.ok(preReleaseGate(s, c2, prep({ changelogChanged: false })).some((e) => e.includes("unchanged on this branch")), "the branch must touch the changelog (#97)");
	assert.equal(preReleaseGate(s, c2, prep({ changelogChanged: null, changelogBase: { pending: [], source: "none" as const } })).length, 0, "no base to compare: the git-dependent proofs skip, they do not refuse");
	assert.ok(
		preReleaseGate(s, c2, prep({ changelog: { file: "CHANGELOG.md", content: "## [1.1.0]\n- see 1.2.0 for context\n" } })).some((e) => e.includes("has no entry heading")),
		"a version named in prose is not an entry (#97)",
	);
	assert.ok(
		preReleaseGate(s, c2, prep({ changelog: { file: "CHANGELOG.md", content: fold.replace("1.2.0", "1.2.0-beta") } })).some((e) => e.includes("has no entry heading")),
		"a 1.2.0-beta section cannot stand in for 1.2.0",
	);
	const dropped = preReleaseGate(s, c2, { ...prep(), changelog: { file: "CHANGELOG.md", content: "## [1.2.0]\n- parked one\n" } });
	assert.ok(dropped.some((e) => e.includes("drops 1 Unreleased entry") && e.includes("parked two")), "folding means moving: the refusal quotes the line that vanished");
	assert.equal(preReleaseGate(s, c2, { ...prep(), noFoldCheck: true, changelog: { file: "CHANGELOG.md", content: "## [1.2.0]\n- parked one\n" } }).length, 0, "--no-fold-check is the operator's escape");
	assert.equal(
		preReleaseGate(s, c2, { ...prep(), changelog: { file: "CHANGELOG.md", content: "## [1.2.0]\n   -   parked   one\n  - parked two\n" } }).length,
		0,
		"indentation and whitespace jitter are not a changed entry",
	);
	assert.equal(preReleaseGate(s, c2, prep({ changelogBase: { pending: [], source: "tag" as const } })).length, 0, "nothing was pending: nothing to fold");
	const nv = (content: string, basePending: string[] = []) =>
		preReleaseGate({ ...s, noVersion: true }, c2, { manifestVersion: null, remoteTags: [], changelog: { file: "CHANGELOG.md", content }, changelogChanged: true, changelogBase: { pending: basePending, source: "merge-base" as const } });
	assert.equal(nv("## [Unreleased]\n- fresh line\n").length, 0, "a new line under Unreleased passes");
	assert.ok(nv("## [1.1.0]\n- fixed an old entry\n").some((e) => e.includes("has no Unreleased heading")), "an unversioned release needs somewhere findable to record itself");
	assert.ok(nv("## [Unreleased]\n\n## [1.1.0]\n- fixed an old entry\n").some((e) => e.includes("no entry under its Unreleased heading")), "editing an older section releases nothing (#97)");
	assert.ok(nv("## [Unreleased]\n- parked one\n", ["parked one"]).some((e) => e.includes("gained nothing on this branch")), "leftover entries are not this flow's own entry");
	assert.equal(nv("## [Unreleased]\n- parked one\n", []).length, 0, "nothing pending at the base: any entry is new");
});

test("the fold comparison normalizes markdown, not meaning (#97)", () => {
	const md = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n  * parked   one\n- [x] checked note\n\n## [1.0.0]\n- old\n";
	assert.deepEqual(pendingEntryLines(md), ["parked one", "[x] checked note"], "bullets, indentation and whitespace runs are jitter; sub-headings are not entries");
	assert.equal(normalizeEntryLine("  -   a   b  "), "a b");
	assert.equal(pendingEntryLines("## [Unreleased]\n\n## [1.0.0]\n").length, 0, "an empty section holds nothing");
	assert.equal(pendingEntryLines("## 1.0.0\n- nothing pending here\n").length, 0, "no Unreleased section is vacuously clean");
});

test("release body helpers (#97): the changelog entry is the forge body, and the forge must keep it", () => {
	const md = "# Changelog\n\n## [1.2.0] - 2026\n\n### Fixed\n\n- thing\n\n## [1.1.0]\n- older\n";
	assert.deepEqual(pickReleaseNotes({ changelog: md, version: "1.2.0", annotation: "the tag's own words" }), { notes: "### Fixed\n\n- thing", source: "changelog" }, "the entry beats the tag annotation");
	assert.deepEqual(pickReleaseNotes({ changelog: md, version: "9.9.9", annotation: "annotated body" }), { notes: "annotated body", source: "annotation" }, "no entry for the version: the annotation stands in");
	assert.equal(pickReleaseNotes({ changelog: null, version: "1.2.0", annotation: '/bin/sh: 1: Syntax error: "(" unexpected' }).source, "none", "a shell complaint is still never a body (#51)");
	assert.equal(pickReleaseNotes({ changelog: md, version: "9.9.9", annotation: "" }).source, "none");
	assert.equal(normalizeReleaseBody("  \r\n- thing  \r\n\n"), "- thing", "what the forge stores is not a different body");
	assert.deepEqual(missingFoldedLines(["a", "b"], "- a\n- b"), [], "and the fold comparison is set membership on normalized lines");
});

test("tagNotesCommand is /bin/sh safe and changelogEntry finds the section (#51)", () => {
	assert.equal(tagNotesCommand("v1.2.3"), `git tag -l --format='%(contents)' 'v1.2.3'`, "an unquoted %(contents) is a shell syntax error (#51)");
	assert.equal(sq("it's"), `'it'\\''s'`, "single quotes survive the escape");
	assert.equal(sq("`x` $(y) ; z"), "'`x` $(y) ; z'", "code spans and substitutions become literal argument text");
	const md = "# Changelog\n\n## [0.35.0] - 2026-10-18\n\n### Added\n\n- thing\n\n## [0.34.0] - 2026-10-17\n\n### Fixed\n\n- older\n";
	assert.equal(changelogEntry(md, "0.35.0"), "### Added\n\n- thing", "its own section, subsections included");
	assert.equal(changelogEntry(md, "9.9.9"), "", "no section, no body");
	assert.ok(looksLikeShellError('/bin/sh: 1: Syntax error: "(" unexpected'), "the shape #51 shipped as the release body");
	assert.ok(!looksLikeShellError("### Fixed\n\n- the forge release body was a /bin/sh syntax error (#51)"), "a changelog line about the bug is a real body");
});

test("statusJson: stable machine view of the prose status (headless orchestrators)", () => {
	const st = newState("demo", false);
	st.branch = "feat/demo";
	st.worktree = ".dev-flow/demo/worktree";
	st.checks = { test: { ok: true, at: "x" }, health: { ok: false, at: "y" } };
	st.approvals = { approve: "t" };
	const j = JSON.parse(statusJson([st], "demo", DEFAULTS));
	assert.equal(j.bound, "demo");
	assert.equal(j.features.length, 1);
	const f = j.features[0];
	assert.deepEqual(f.checks, { test: true, health: false }, "checks reduce to name→ok");
	assert.equal(f.current, true);
	assert.deepEqual(f.approvals, ["approve"]);
	assert.equal(f.stage, "plan");
	assert.equal(f.worktree, ".dev-flow/demo/worktree");
	assert.equal(f.noVersion, false, "mode flags are always present booleans");
	assert.match(f.next, /plan/);
});

test("needsOperator: marker-first refusal for no-UI gates", () => {
	assert.equal(needsOperator("do it", "Approve?"), "NEEDS-OPERATOR Approve? — do it");
	assert.equal(needsOperator("do it"), "NEEDS-OPERATOR — do it");
});

test("gateHelpJson splits the real GATE_HELP without losing a gate", () => {
	const src = readFileSync(new URL("../src/runtime/base.ts", import.meta.url), "utf8");
	const m = src.match(/const GATE_HELP =\s*("(?:[^"\\]|\\.)*");/);
	assert.ok(m, "GATE_HELP literal found in the runtime source");
	const j = JSON.parse(gateHelpJson(JSON.parse(m![1]), "9.9.9"));
	assert.ok(j.gates.length >= 15, `every gate survived the split (${j.gates.length})`);
	assert.ok(j.gates.every((g: string) => !g.includes(" — ") && !g.includes(" | ")), "no note prose leaked into the command list");
	assert.ok(j.gates.some((g: string) => g.startsWith("status [slug] [--json]")));
	assert.ok(j.notes.includes("reflect <note> queues"));
	assert.deepEqual(j.protocol.checkpointQuestions, ["Approve?", "Verified?", "Release?", "Finish?"]);
	assert.equal(j.protocol.refusalMarker, "NEEDS-OPERATOR");
});

/* ------------------------------------------------------------- merge policy */

test("parseMergeStyle: the four answers, and nothing else", () => {
	assert.equal(parseMergeStyle("squash"), "squash");
	assert.equal(parseMergeStyle(" Merge "), "merge");
	assert.equal(parseMergeStyle("ANY"), "any");
	assert.equal(parseMergeStyle("fast-forward"), null, "a typo is not a policy — it must not silently mean no policy");
	assert.equal(parseMergeStyle(undefined), null);
});

test("classifyMergeHistory: reads the style a repo actually uses, newest first", () => {
	// dev-flow's own shape: merge commits with the feature commits underneath
	const merges = ["a b|Merge pull request #99 from x/feat/y", "a|release prep", "b c|Merge pull request #98 from x/feat/z"];
	assert.deepEqual(classifyMergeHistory(merges), { merges: 2, squashes: 0, recent: "merge", note: "merge history: 2 merge commit(s), 0 squash(es) — the most recent PR landed as merge" });
	// ollamaMQ's shape after it switched at PR #21: squash leaves one commit naming the PR
	const squashes = ["a|web: honest scrollbars (#26)", "b|docs: changelog entry (#25)", "c d|Merge pull request #20 from x/feat/y"];
	const c = classifyMergeHistory(squashes);
	assert.equal(c.recent, "squash", "the newest PR wins — that is what the repo does now");
	assert.equal(c.merges, 1);
	assert.equal(c.squashes, 2);
	// direct pushes and chores are not PR merges and say nothing
	assert.equal(classifyMergeHistory(["a|chore: keep raw inputs out of git", "b|release prep: 0.8.1"]).recent, null);
	assert.match(classifyMergeHistory(["x|anything"]).note, /no PR merges/);
});

test("mergeShapeProof: a measured contradiction refuses, an invisible topology advises", () => {
	// merge policy: ancestry is the proof, and it is the only style provable with git alone
	assert.deepEqual(mergeShapeProof("merge", { ancestor: true, branch: "feat/x", defaultBranch: "main" }).errors, []);
	assert.match(mergeShapeProof("merge", { ancestor: true, branch: "feat/x", defaultBranch: "main" }).note, /matches the playbook/);
	assert.match(mergeShapeProof("merge", { ancestor: false, forgeStyle: "squash", branch: "feat/x", defaultBranch: "main" }).errors[0], /says merge = merge.*squash-merged/s);
	assert.equal(mergeShapeProof("merge", { ancestor: null }).errors.length, 0, "unmeasurable ancestry never blocks a release");
	assert.match(mergeShapeProof("merge", { ancestor: null }).note, /could not be checked/);
	// squash policy: ancestry true means it was NOT squashed
	assert.match(mergeShapeProof("squash", { ancestor: true, branch: "feat/x", defaultBranch: "main" }).errors[0], /merge commit or fast-forward/);
	assert.equal(mergeShapeProof("squash", { ancestor: false }).errors.length, 0);
	// squash and rebase erase ancestry the same way — only the forge tells them apart
	assert.match(mergeShapeProof("squash", { ancestor: false, forgeStyle: "rebase" }).errors[0], /forge reports a rebase merge/);
	assert.match(mergeShapeProof("rebase", { ancestor: false, forgeStyle: "squash" }).errors[0], /forge reports a squash merge/);
	assert.equal(mergeShapeProof("rebase", { ancestor: false, forgeStyle: "rebase" }).errors.length, 0);
	// no policy (or an explicit opt-out) says nothing at all
	assert.deepEqual(mergeShapeProof(undefined, { ancestor: false }), { errors: [], note: "" });
	assert.deepEqual(mergeShapeProof("any", { ancestor: true }), { errors: [], note: "" });
});

test("mergeStyleInvocation: the merge command is where the policy is enforced", () => {
	// explicit contradiction on the forge CLI is a hard block, naming the playbook key
	assert.match(mergeStyleInvocation("gh pr merge 42 --squash", "merge").block ?? "", /playbook says merge = merge.*forces a squash/s);
	assert.match(mergeStyleInvocation("gh pr merge --rebase", "merge").block ?? "", /forces a rebase merge/);
	assert.match(mergeStyleInvocation("glab mr merge 7 --no-squash", "squash").block ?? "", /playbook says merge = squash.*forces a merge/s);
	// matching style passes clean
	assert.deepEqual(mergeStyleInvocation("gh pr merge 42 --merge", "merge"), { block: null, confirm: null });
	assert.deepEqual(mergeStyleInvocation("gh pr merge 42 --squash", "squash"), { block: null, confirm: null });
	assert.deepEqual(mergeStyleInvocation("glab mr merge 7 --squash", "squash"), { block: null, confirm: null });
	// no style flag: the forge default decides, so it is a confirmation and not a refusal
	assert.match(mergeStyleInvocation("gh pr merge 42", "squash").confirm ?? "", /no style flag.*pass --squash/s);
	assert.match(mergeStyleInvocation("glab mr merge 7", "squash").confirm ?? "", /pass --squash/, "glab spells the wanted flag its own way");
	// prose about a merge is not a merge (quoted text is an argument's text), a wrapper that execs is judged on its payload
	assert.deepEqual(mergeStyleInvocation('grep "gh pr merge --squash" docs/', "merge"), { block: null, confirm: null });
	assert.match(mergeStyleInvocation('sh -c "gh pr merge --squash"', "merge").block ?? "", /forces a squash/);
	// a local git merge --squash is a confirmation: merging main into a branch is ordinary work
	assert.match(mergeStyleInvocation("git merge --squash feat/x", "merge").confirm ?? "", /git merge --squash/);
	assert.deepEqual(mergeStyleInvocation("git merge --no-ff feat/x", "merge"), { block: null, confirm: null }, "--no-ff into a branch is not a merge policy");
	// no policy in the playbook means no new verdicts at all
	assert.deepEqual(mergeStyleInvocation("gh pr merge --squash", undefined), { block: null, confirm: null });
	assert.deepEqual(mergeStyleInvocation("gh pr merge --squash", "any"), { block: null, confirm: null });
});

test("nextHint: the UI clause appends to the plan path instead of replacing it", () => {
	const ui = newState("u", true);
	assert.match(nextHint(ui, DEFAULTS), /plan\/plan\.md and render mockups to plan\/mockups\/ \(\*\.png\) with headless chromium/);
	assert.match(nextHint({ ...ui, ui: false }, DEFAULTS), /plan\/plan\.md, then ask Approve\?/);
});

test("nextHint names the playbook merge style at the release stage", () => {
	const st = { ...newState("x", false), stage: "release" as const };
	const cfg = { ...DEFAULTS, release: { ...DEFAULTS.release, merge: "squash" as const } };
	assert.match(nextHint(st, cfg), /merge = squash — gh pr merge <n> --squash/, "the number goes before the flag — a trailing flag reads the branch as the PR selector");
	assert.doesNotMatch(nextHint(st, DEFAULTS), /gh pr merge/, "no policy, no advice");
});

test("Stage reports: the skill carries the report contract and each stage file shows its glyph", () => {
	const skill = readFileSync(new URL("../skills/dev-flow/SKILL.md", import.meta.url), "utf8");
	assert.match(skill, /\*\*Stage reports\*\*/, "the ground rules carry the Stage reports clause");
	assert.match(skill, /Next steps:/, "the clause defines the Next steps block");
	assert.match(skill, /or say what to do differently/, "the escape-hatch line is part of the contract");
	assert.match(skill, /\*\*\*bold italic\*\*\*/, "the recommended verb is bold italic");
	const glyphs: [string, string][] = [["start", "💬 pre-flow"], ["plan", "📝 plan"], ["implement", "🔨 implement"], ["pre-release", "🔍 pre-release"], ["release", "🚀 release"], ["finish", "🏁 finish"]];
	for (const [stage, needle] of glyphs) {
		const ref = readFileSync(new URL(`../skills/dev-flow/references/${stage}.md`, import.meta.url), "utf8");
		assert.ok(ref.includes(needle), `${stage}.md carries its stage-line marker ${needle}`);
	}
});

test("pre-reference: the changelog writer reviews the branch, not its commits", () => {
	const ref = readFileSync(new URL("../skills/dev-flow/references/pre-release.md", import.meta.url), "utf8");
	assert.match(ref, /\*\*The changelog writer reviews the branch, not its commit list\*\*/, "the writer is told to read the diff, not the commit list");
	assert.match(ref, /git diff/, "reading the branch diff is an explicit step");
	assert.match(ref, /One entry per net change, never\s+one per commit/, "iteration commits collapse into one entry");
	assert.match(ref, /fold-safe/, "consolidating one's own entry is stated as fold-proof-safe");
});

test("mainCheckoutRoot: git's common dir names the main checkout a worktree borrows its history from", () => {
	assert.equal(mainCheckoutRoot("/repo/.dev-flow/x/worktree", "/repo/.git"), "/repo", "a linked worktree resolves to the checkout owning its objects");
	assert.equal(mainCheckoutRoot("/elsewhere/wt", "/repo/.git"), "/repo", "a worktree parked anywhere off the repo still points home");
	assert.equal(mainCheckoutRoot("/repo", "/repo/.git"), null, "a main checkout is its own flow truth: nothing to remap");
	assert.equal(mainCheckoutRoot("/tmp/scratch", null), null, "no git answer is never a remap");
	assert.equal(mainCheckoutRoot("/wt", ".git"), null, "a relative answer resolves against cwd and says cwd is the main checkout");
});

test("release order: tags and forge shipping wait for the release stage", () => {
	const g = (command: string, stage: "implement" | "pre-release" | "release" | null, branch = "feat/x") => bashFlowGuard({ command, branch, stage, defaultBranch: "main" });
	assert.match(g("git tag -a v1.2.0 -m x", "pre-release") ?? "", /tagging is release work/, "a tag cut at pre-release is refused");
	assert.equal(g("git tag -a v1.2.0 -m x", "release", "main"), null, "the same tag at release is the release");
	assert.equal(g("git tag -l", "pre-release"), null, "listing tags only reads");
	assert.equal(g("git tag", "implement"), null, "bare git tag lists");
	assert.match(g("git push origin --tags", "pre-release") ?? "", /pushing tags is release work/);
	assert.match(g("git push origin refs/tags/v1.2.0", "implement") ?? "", /pushing tags is release work/);
	assert.equal(g("git push -u origin feat/x", "pre-release"), null, "pushing the feature branch for the PR is fine");
	assert.equal(g("git tag v1.2.0", null), null, "an unbound session is not judged by a stage it does not have");
	assert.ok(tagCreates("git tag v1"), "a lightweight tag creates");
	assert.ok(!tagCreates("git tag --contains HEAD"));
	assert.match(releaseOrderInvocation("gh pr merge 46 --squash", "pre-release") ?? "", /merging the PR is release work/);
	assert.match(releaseOrderInvocation("cd wt && gh release create v1 --notes x", "implement") ?? "", /forge release is release work/);
	assert.equal(releaseOrderInvocation("gh pr merge 46 --squash", "release"), null, "at release the merge is the job");
	assert.equal(releaseOrderInvocation("gh pr create --base main", "pre-release"), null, "opening the PR is pre-release work");
	assert.equal(releaseOrderInvocation('grep "gh pr merge" docs/', "implement"), null, "quoted prose is not a merge");
	assert.equal(releaseOrderInvocation("gh pr merge 1", null), null, "unbound: no stage to judge");
});

test("checkoutInvocation: the branch a checkout/switch creates, through leading flags", () => {
	assert.deepEqual(checkoutInvocation("git checkout -q -b fix/dockerfile"), { target: "fix/dockerfile", creates: true });
	assert.deepEqual(checkoutInvocation("git switch -c fix/x"), { target: "fix/x", creates: true });
	assert.deepEqual(checkoutInvocation("git checkout -q -B fix/y origin/main"), { target: "fix/y", creates: true });
	assert.equal(checkoutInvocation("git checkout feat/x")?.creates, false, "switching to an existing branch creates nothing");
});

test("worker helpers: op legality, budget clamp, REPORT parsing", () => {
	assert.equal(workerOpError("implement", "implement"), null);
	assert.match(workerOpError("implement", "pre-release") ?? "", /runs at implement/);
	assert.equal(workerOpError("review", "pre-release"), null);
	assert.match(workerOpError("review", "plan") ?? "", /runs at implement or pre-release/);
	assert.match(workerOpError("verify", "implement") ?? "", /unknown op/);
	for (const st of ["plan", "implement", "pre-release", "release"] as const) assert.equal(workerOpError("reflect", st), null, `reflect runs at ${st}`);
	assert.equal(clampBudgetMin(undefined, "implement"), 60);
	assert.equal(clampBudgetMin(1000, "review"), 180);
	assert.equal(clampBudgetMin(1, "review"), 5);
	const r = parseWorkerReport("work...\n\n## REPORT\nverdict: **PASS**\n- fine");
	assert.equal(r.found, true);
	assert.equal(r.verdict, "PASS");
	assert.match(r.body, /fine/);
	const none = parseWorkerReport("Now let me write D4.");
	assert.equal(none.found, false);
	assert.match(none.body, /write D4/, "the tail is kept for the driver");
	assert.equal(parseWorkerReport("REPORT mentioned inline is not a heading").found, false);
});

test("withTmpDir prefixes a shell-quoted TMPDIR and keeps the command as judged", () => {
	assert.equal(featureTmpDir("/r/.dev-flow", "x"), path.join("/r/.dev-flow", "x", "tmp"));
	assert.equal(
		withTmpDir("ls -la", "/r/a b/it's"),
		"export TMPDIR='/r/a b/it'\\''s' GIT_CEILING_DIRECTORIES='/r/a b/it'\\''s'${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}\nls -la",
	);
	assert.deepEqual(featureTmpEnv("/r/t", ""), { TMPDIR: "/r/t", GIT_CEILING_DIRECTORIES: "/r/t" });
	assert.deepEqual(featureTmpEnv("/r/t", "/home"), { TMPDIR: "/r/t", GIT_CEILING_DIRECTORIES: `/r/t${path.delimiter}/home` });
});

test("the feature scratch dir is a git ceiling: a fixture under it is not inside the checkout", () => {
	const repo = mkdtempSync(path.join(tmpdir(), "df-ceiling-"));
	try {
		execSync("git init -q", { cwd: repo });
		const tmp = featureTmpDir(path.join(repo, ".dev-flow"), "feat");
		const fixture = path.join(tmp, "fixture-1");
		mkdirSync(fixture, { recursive: true });
		const probe = (env: Record<string, string>) => {
			try {
				execSync("git rev-parse --git-dir", { cwd: fixture, stdio: "pipe", env: { ...process.env, ...env } });
				return true;
			} catch {
				return false;
			}
		};
		assert.equal(probe({ GIT_CEILING_DIRECTORIES: "" }), true, "without the ceiling git climbs out of the fixture into the checkout");
		assert.equal(probe(featureTmpEnv(tmp, "")), false, "with it the fixture is no repository");
		// the shell prefix the bash hook adds behaves the same
		const sh = withTmpDir("git rev-parse --git-dir >/dev/null 2>&1 && echo found || echo none", tmp);
		assert.equal(execSync(sh, { cwd: fixture, shell: "/bin/bash", env: { ...process.env, GIT_CEILING_DIRECTORIES: "" } }).toString().trim(), "none");
		// the main checkout still resolves under the same env
		assert.equal(execSync(sh, { cwd: repo, shell: "/bin/bash", env: { ...process.env, GIT_CEILING_DIRECTORIES: "" } }).toString().trim(), "found");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("workerTurnError: a trailing model-error storm is a dead model, not a stall (gh#173)", () => {
	const ok = { role: "assistant", stopReason: "toolUse" };
	const err = (m: string) => ({ role: "assistant", stopReason: "error", errorMessage: m });
	assert.equal(workerTurnError([]), null);
	assert.equal(workerTurnError([{ role: "user" }, ok, { role: "toolResult" }, { role: "assistant", stopReason: "stop" }]), null, "a normal end");
	assert.equal(workerTurnError([err("Request timed out."), ok]), null, "an error a retry recovered from");
	assert.deepEqual(workerTurnError([ok, err("terminated"), err("Request timed out."), { role: "user" }, err("Request timed out.")]), { reason: "error", message: "Request timed out.", streak: 3 });
	assert.equal(workerTurnError([{ role: "assistant", stopReason: "error" }])?.message, "(no error message)");
});

test("parseSize / formatSize read the playbook's instance costs", () => {
	assert.equal(parseSize("2G"), 2 * 1024 ** 3);
	assert.equal(parseSize("512M"), 512 * 1024 ** 2);
	assert.equal(parseSize("1.5GB"), 1.5 * 1024 ** 3);
	assert.equal(parseSize("4096"), 4096);
	assert.equal(parseSize("lots"), undefined, "junk is no size, not zero");
	assert.equal(formatSize(9.1 * 1024 ** 3), "9.1G");
	assert.equal(formatSize(2 * 1024 ** 3), "2G");
});

test("servedBuildMatches: any 7+ hex token that prefixes HEAD", () => {
	const head = "0382a2270dc087e8aafc9c23509b6a0c33522eb6";
	assert.ok(servedBuildMatches("GIT_SHA=0382a22\n", head));
	assert.ok(servedBuildMatches(`{"build":"${head}"}`, head));
	assert.ok(!servedBuildMatches("GIT_SHA=653d450", head), "another commit is a mismatch");
	assert.ok(!servedBuildMatches("v0.34.1", head), "a version is not a commit");
});

test("sideBySide offers a second instance only when the playbook and the machine allow it", () => {
	const md = (body: string) => mdToConfig(parseProjectMd(`## implement\n\n\`\`\`flow\n${body}\`\`\`\n`));
	const ok = md("port = 8090\nparallelDev = yes\ninstanceMem = 2G\ndev = BFF_PORT=$DEV_FLOW_PORT up\n");
	assert.equal(ok.devPort, 8090);
	assert.equal(ok.parallelDev, true);
	assert.equal(ok.instanceMem, 2 * 1024 ** 3);
	assert.deepEqual(sideBySide({ cfg: ok, nextPort: 8091, memAvail: 8 * 1024 ** 3, diskFree: null }), { ok: true, why: [] });
	assert.match(sideBySide({ cfg: ok, nextPort: 8091, memAvail: 1024 ** 3, diskFree: null }).why.join(), /RAM available 1G < 2G/);
	assert.match(sideBySide({ cfg: md("port = 8090\nparallelDev = no\ndev = x $DEV_FLOW_PORT\n"), nextPort: 8091, memAvail: null, diskFree: null }).why.join(), /parallelDev = no/);
	assert.match(sideBySide({ cfg: md("port = 8090\ndev = docker compose up -d\n"), nextPort: 8091, memAvail: null, diskFree: null }).why.join(), /do not read \$DEV_FLOW_PORT/, "a dev command that ignores the port would collide");
	assert.match(sideBySide({ cfg: md("dev = x\n"), nextPort: null, memAvail: null, diskFree: null }).why.join(), /names no `port`/);
});
