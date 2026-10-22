import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	applyAnswer,
	appendReflection,
	approveGate,
	bashSegments,
	bashFlowGuard,
	buildConfig,
	checklistHash,
	checkoutTarget,
	claimBlocks,
	classifyMergeHistory,
	mergeShapeProof,
	mergeStyleInvocation,
	parseMergeStyle,
	changelogEntry,
	cleanupAssess,
	cmpVersions,
	compactionReflectionLine,
	DEFAULTS,
	detectForge,
	featureBranchPrefix,
	FLOW_SHELL_HINT,
	flowShellInvocation,
	forcePushInvocation,
	gateHelpJson,
	getPath,
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
	parsePushRefs,
	playbookTamper,
	pluginVersion,
	preReleaseGate,
	unreleasedPending,
	unreleasedBody,
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
	reflectProtocol,
	reflectSections,
	reflectionLine,
	reflectionRoutes,
	releaseGate,
	shouldSelfCompact,
	shouldTakeOverCompaction,
	stateTamper,
	statusCompact,
	statusJson,
	sq,
	tagNotesCommand,
	openReflections,
	appendRoadmapItem,
	roadmapDone,
	roadmapDoneCount,
	roadmapDoneForSlug,
	roadmapOpenCount,
	roadmapPick,
	roadmapTidy,
	verifyGate,
	versionTagGate,
	writeGuard,
} from "../src/core.ts";

const cfg = structuredClone(DEFAULTS);

test("buildConfig fills defaults and merges partial overrides", () => {
	const c = buildConfig({ defaultBranch: "master", commands: { test: "bun test" }, release: { changelog: "CHANGELOG.md" } });
	assert.equal(c.defaultBranch, "master");
	assert.equal(c.commands.test, "bun test");
	assert.equal(c.commands.build, undefined);
	assert.equal(c.release.changelog, "CHANGELOG.md");
	assert.equal(c.release.review, "/ponytail-review"); // kept from defaults
	assert.equal(buildConfig(null).defaultBranch, "main");
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
	assert.equal(approveGate(s, cfg, ["plan.md"]).length, 0);
	const su = newState("f", true);
	assert.ok(approveGate(su, cfg, ["plan.md"]).length > 0, "ui feature without a render must not pass");
	assert.ok(approveGate(su, cfg, ["plan.md", "mockups/screen.html"]).length > 0, "html source alone is not evidence of a render");
	assert.equal(approveGate(su, cfg, ["plan.md", "mockups/screen-390.png"]).length, 0);
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
	assert.deepEqual(gitInvocation("cat .git/hooks/pre-commit"), { subs: [], dir: null, pushes: [], gitSegs: [] });
	assert.deepEqual(gitInvocation("git commit -m x"), { subs: ["commit"], dir: null, pushes: [], gitSegs: [{ seg: "git commit -m x", dir: null }] });
	assert.deepEqual(gitInvocation("cd .dev-flow/f/worktree && git commit -m x"), { subs: ["commit"], dir: ".dev-flow/f/worktree", pushes: [], gitSegs: [{ seg: "git commit -m x", dir: ".dev-flow/f/worktree" }] });
	assert.deepEqual(gitInvocation("git -C /tmp/wt push origin feat/x"), { subs: ["push"], dir: "/tmp/wt", pushes: [["origin", "feat/x"]], gitSegs: [{ seg: "git -C /tmp/wt push origin feat/x", dir: "/tmp/wt" }] });
	assert.deepEqual(gitInvocation("git -C=/tmp/wt commit"), { subs: ["commit"], dir: "/tmp/wt", pushes: [], gitSegs: [{ seg: "git -C=/tmp/wt commit", dir: "/tmp/wt" }] });
	assert.deepEqual(gitInvocation("/usr/bin/git branch --show-current"), { subs: ["branch"], dir: null, pushes: [], gitSegs: [{ seg: "/usr/bin/git branch --show-current", dir: null }] });
	assert.deepEqual(gitInvocation("cd wt; git status; git push"), { subs: ["status", "push"], dir: "wt", pushes: [[]], gitSegs: [{ seg: "git status", dir: "wt" }, { seg: "git push", dir: "wt" }] });
	assert.deepEqual(gitInvocation("sudo git commit -m x"), { subs: ["commit"], dir: null, pushes: [], gitSegs: [{ seg: "sudo git commit -m x", dir: null }] });
	assert.deepEqual(gitInvocation("cd wt && git commit -m x && cd main && git pull").gitSegs.map((g) => [g.seg.split(" ")[1], g.dir]), [["commit", "wt"], ["pull", "main"]], "per-segment dirs: last-cd must not leak into earlier segments");
	const home = process.env.HOME || "/home/me";
	assert.equal(gitInvocation("cd ~/wt && git commit -m x").dir, `${home}/wt`, "the shell expands ~ before git runs; an unexpanded one resolved against the session cwd and main got the blame");
	assert.equal(gitInvocation("git -C $HOME/wt commit").dir, `${home}/wt`, "$HOME is expanded the same way");
	assert.equal(gitInvocation("cd $WT/wt && git commit -m x").dir, "$WT/wt", "any other var stays literal — a guess is worse than a literal");
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

test("reflectionRoutes and investigationBrief route fixes to the right flow", () => {
	const [p] = reflectionRoutes(["- [ ] the checklist item about seeded data is stale"], false);
	assert.equal(p.mode, "docs");
	assert.match(p.route, /docs flow/);
	const [x] = reflectionRoutes(["- [ ] the gate prompt asks twice"], false);
	assert.equal(x.mode, "upstream", "plugin feedback in someone else's repo goes upstream");
	assert.match(x.route, /pi-dev-flow/);
	const [s] = reflectionRoutes(["- [ ] the gate prompt asks twice"], true);
	assert.equal(s.mode, "code", "in the dev-flow repo a plugin item is a flow of its own");
	const brief = investigationBrief("the gate prompt asks twice", true);
	assert.match(brief.join(" "), /gate prompt asks twice/);
	assert.match(brief.join(" "), /patch flow/);
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
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/project.json", dfDir: df, features: [], boundSlug: null }));
	assert.match(writeGuard({ abs: "/repo/.dev-flow/project.md", dfDir: df, features: [], boundSlug: null }) ?? "", /operator playbook/, "the main-checkout playbook is never an agent edit target");
	const docsF = { state: { ...newState("d", false, false, true), stage: "implement" as const, worktree: ".wt/d" }, worktreeAbs: "/repo/.wt/d" };
	const normF = { state: { ...newState("n", false), stage: "implement" as const, worktree: ".wt/n" }, worktreeAbs: "/repo/.wt/n" };
	assert.equal(writeGuard({ abs: "/repo/.wt/d/.dev-flow/project.md", dfDir: df, features: [docsF], boundSlug: "d" }), null, "a docs flow edits the playbook in its worktree");
	assert.ok(writeGuard({ abs: "/repo/.wt/n/.dev-flow/project.md", dfDir: df, features: [normF], boundSlug: "n" }), "a normal feature cannot touch the playbook");
	assert.equal(checkoutTarget("git checkout feat/x"), "feat/x");
	assert.equal(checkoutTarget("git switch -c feat/y && make"), "feat/y");
	assert.equal(checkoutTarget("git checkout -- src/app.ts"), "--");
	assert.equal(checkoutTarget("git commit -m x"), null);
	assert.equal(featureBranchPrefix({ ...DEFAULTS, branchPattern: "feat/{slug}" }), "feat/");
});

test("openReflections: unchecked items only", () => {
	assert.deepEqual(openReflections("# h\n- [ ] (playbook) a\n- [x] done\n  - [ ] indented\n"), ["- [ ] (playbook) a", "- [ ] indented"]);
	assert.deepEqual(openReflections(""), []);
});

test("roadmap: append mints the header once and adds open items", () => {
	const one = appendRoadmapItem("", "dark mode");
	assert.match(one, /^# dev-flow roadmap/);
	assert.equal(roadmapOpenCount(one), 1);
	const two = appendRoadmapItem(one, "  roadmap tidy  \n");
	assert.ok(two.includes("- [ ] roadmap tidy\n"), "text is trimmed into the item");
	assert.equal(roadmapOpenCount(two), 2);
	assert.equal(roadmapDoneCount(two), 0);
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
	assert.equal(roadmapDoneCount(roadmapDone(src, 1, "d")!), 2);
});

test("roadmap: finish hook checks off every item stamped (slug)", () => {
	const src = "- [ ] pick me (fin)\n- [ ] also (fin) and more\n- [ ] other (later)\n- [x] history (fin)\n";
	const r = roadmapDoneForSlug(src, "fin", "2025-10-19");
	assert.equal(r.count, 2);
	assert.ok(r.text.includes("- [x] pick me (fin) — done: 2025-10-19"));
	assert.ok(r.text.includes("- [ ] other (later)"), "unstamped items stay open");
	assert.equal(roadmapDoneForSlug(src, "nobody", "x").count, 0);
});

test("roadmap: tidy drops done items and keeps preamble and open items", () => {
	const src = "# r\n\n<!-- note -->\n\n- [ ] keep\n- [x] drop — done: 2025-01-01\n\n- [ ] keep too\n";
	const out = roadmapTidy(src);
	assert.ok(out.includes("<!-- note -->") && out.includes("- [ ] keep\n") && out.includes("- [ ] keep too"));
	assert.ok(!out.includes("[x]"));
});

test("reflectSections: plugin wording → plugin, playbook wording → playbook", () => {
	assert.deepEqual(reflectSections("the gate prompt asks twice, that is wrong"), ["plugin"]);
	assert.deepEqual(reflectSections("the checklist item about seeded data is stale"), ["playbook"]);
	assert.deepEqual(reflectSections("the verify gate should read the health command from project.md"), ["playbook", "plugin"]);
	assert.deepEqual(reflectSections("typo in the readme"), ["playbook"], "unclear notes land where the operator reads them");
	assert.deepEqual(reflectSections("the test command drifted, npm test no longer works"), ["playbook"], "a drifted project command is a playbook issue, not a plugin one");
});

test("appendReflection writes the two sections and migrates a legacy flat file", () => {
	const legacy = "# dev-flow reflections\n\n<!-- note -->\n- [ ] (plugin) old plugin note — x 2025-10-01\n- [ ] (playbook) old playbook note — y 2025-10-01\n";
	const out = appendReflection(legacy, ["plugin"], "- [ ] new note — z 2025-10-02");
	assert.match(out, /## playbook\n\n- \[ \] old playbook note — y 2025-10-01\n\n## plugin\n/);
	assert.match(out, /- \[ \] old plugin note — x 2025-10-01\n- \[ \] new note — z 2025-10-02\n$/);
	assert.ok(!out.includes("(plugin)"), "inline target markers go away once the section carries them");
	assert.equal(openReflections(out).length, 3);
	const both = appendReflection("", ["playbook", "plugin"], "- [ ] both — z 2025-10-02");
	assert.equal(openReflections(both).length, 2, "a both-sections note is written to each");
	const noted = "# my notes\n\noperator: triage on Fridays\n\n- [ ] item one\n";
	assert.equal(
		appendReflection(noted, ["plugin"], "- [ ] item two"),
		"# my notes\n\noperator: triage on Fridays\n\n## playbook\n\n- [ ] item one\n\n## plugin\n\n- [ ] item two\n",
		"the operator's preamble survives a rewrite verbatim",
	);
	assert.equal(both.split(/^## /m).length - 1, 2, "both sections written");
	assert.equal(both.split("- [ ] both").length - 1, 2, "the line is in each section");
	const stale = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n\n## plugin\n\n## playbook\n\n- [ ] item one\n";
	assert.equal(stale.split(/^## /m).length - 1, 3, "fixture: duplicated empty section headers");
	const refreshed = appendReflection(stale, ["playbook"], "- [ ] item two\n");
	assert.equal(refreshed.split(/^## /m).length - 1, 1, "stale headers go away; only the non-empty section keeps a header");
	assert.ok(!refreshed.includes("## plugin"), "an empty section is not resurrected by its stale header");
	assert.ok(refreshed.includes("<!-- n -->"), "the real preamble survives");
	// a file whose playbook section is empty starts with `## plugin` — that header must own its items too.
	const pluginOnly = "# dev-flow reflections\n\n<!-- n -->\n\n## plugin\n\n- [ ] upstream thing — s 2026-10-19\n";
	assert.equal(
		appendReflection(pluginOnly, ["plugin"], "- [ ] another — s 2026-10-20"),
		"# dev-flow reflections\n\n<!-- n -->\n\n## plugin\n\n- [ ] upstream thing — s 2026-10-19\n- [ ] another — s 2026-10-20\n",
		"the leading header is not mistaken for preamble and its items do not fall to playbook",
	);
});

test("appendReflection: a heading owns its items, an exact note is queued once (#69)", () => {
	const start = "# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] old playbook item\n\n## plugin\n\n- [x] done plugin thing — fixed: earlier\n";
	// the reported sequence: plugin, then playbook + plugin, then playbook.
	const after = appendReflection(appendReflection(appendReflection(start, ["plugin"], "- [ ] linter note — s 2026-10-20"), ["playbook", "plugin"], "- [ ] gate note — s 2026-10-20"), ["playbook"], "- [ ] flaky note — s 2026-10-20");
	assert.equal(
		after,
		"# dev-flow reflections\n\n<!-- n -->\n\n## playbook\n\n- [ ] old playbook item\n- [ ] gate note — s 2026-10-20\n- [ ] flaky note — s 2026-10-20\n\n## plugin\n\n- [x] done plugin thing — fixed: earlier\n- [ ] linter note — s 2026-10-20\n- [ ] gate note — s 2026-10-20\n",
		"nothing moves out of its section, nothing is written twice",
	);
	// re-reflecting the same note is a no-op in one section, and in both.
	assert.equal(appendReflection(after, ["plugin"], "- [ ] linter note — s 2026-10-21"), after, "the same note at another date is the same note");
	assert.equal(appendReflection(after, ["playbook", "plugin"], "- [ ] gate note — s 2026-10-21"), after, "a both-sections note already in both adds nothing");
	assert.equal(appendReflection(after, ["plugin"], "- [ ] done plugin thing — s 2026-10-21").split("done plugin thing").length - 1, 2, "a checked-off note may be queued again — it came back");
	assert.equal(appendReflection(after, ["plugin"], "- [ ] flaky note — s 2026-10-21").split("flaky note").length - 1, 2, "a note the other section has is still queued here — dedupe is per section");
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
	assert.equal(getPath(p, "mainHook"), false);
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

	// some other package, and nothing of ours above it: unknown, naming where it looked
	const other = mkdtempSync(path.join(tmpdir(), "devflow-pv-"));
	mkdirSync(path.join(other, "lib"), { recursive: true });
	writeFileSync(path.join(other, "package.json"), '{"name":"someone-else","version":"9.9.9"}');
	assert.deepEqual(pluginVersion(path.join(other, "lib")), { version: null, dir: path.join(other, "lib"), repo: "" });
});

test("githubSlug: owner/slug from manifest strings, URLs and scp-style remotes", () => {
	assert.equal(githubSlug("github.com/dmarchevsky/dev-flow"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("https://github.com/dmarchevsky/dev-flow.git"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("git@github.com:dmarchevsky/dev-flow.git"), "dmarchevsky/dev-flow");
	assert.equal(githubSlug("https://gitlab.com/x/y"), "", "non-GitHub upstreams stay unknown");
	assert.equal(githubSlug(""), "");
});

test("reflectProtocol: session-review steps, npm-based update probe, routed open items", () => {
	const out = reflectProtocol(["- [ ] the gate prompt asks twice — x 2026-01-01"], false, { version: "1.2.3", upstream: "dmarchevsky/dev-flow" }).join("\n");
	assert.match(out, /flow reflect — session reflection \(dev-flow 1\.2\.3, upstream: dmarchevsky\/dev-flow\)/);
	assert.match(out, /this output is your work instruction: execute these steps now/);
	assert.match(out, /gitignored and yours to edit/);
	assert.match(out, /1\. review the current session log in full/);
	assert.match(out, /git ls-remote --tags --sort=-v:refname https:\/\/github\.com\/dmarchevsky\/dev-flow \| head -1/, "a git-installed copy still gets a git probe");
	assert.match(out, /npm view pi-dev-flow version/);
	assert.match(out, /pi install npm:pi-dev-flow, then \/reload/);
	assert.match(out, /gh issue list --repo dmarchevsky\/dev-flow --state all --search/);
	assert.match(out, /gh issue create --repo dmarchevsky\/dev-flow/);
	assert.match(out, /b\. playbook items: run flow doctor/);
	assert.match(out, /\[plugin\] the gate prompt asks twice/);
	assert.match(out, /file an issue against pi-dev-flow upstream/);
	assert.ok(out.indexOf("npm view pi-dev-flow") < out.indexOf("git ls-remote"), "npm is the primary update route; the git probe is the fallback for git installs");
	const empty = reflectProtocol([], true, { version: null, upstream: "" }).join("\n");
	assert.match(empty, /dev-flow version unknown/);
	assert.match(empty, /<upstream-url>/);
	assert.match(empty, /open items: none/);
});

test("versionTagGate: manifest and tag must agree", () => {
	assert.deepEqual(versionTagGate("1.2.3", "v{version}", ["v1.2.3", "v1.2.2"]), []);
	assert.match(versionTagGate("1.2.3", "v{version}", ["v1.2.2"])[0], /expected release tag "v1\.2\.3"/);
	assert.ok(versionTagGate(null, "v{version}", []).length === 1);
	assert.deepEqual(versionTagGate("0.13.1-letta_0.34.9", "{version}", ["0.13.1-letta_0.34.9"]), [], "suffix-style patterns");
});

test("cleanupAssess flags dirty worktree and lists unmerged", () => {
	assert.deepEqual(cleanupAssess("", []), { errors: [], unmerged: [] });
	assert.ok(cleanupAssess(" M file.ts", []).errors.length === 1);
	assert.deepEqual(cleanupAssess("", ["abc msg", ""]).unmerged, ["abc msg"]);
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
	assert.equal(shouldSelfCompact({ ...base, stage: "done" }), false, "finished feature");
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

test("compactionReflectionLine is a valid open reflection item", () => {
	const line = compactionReflectionLine("compact-aware", "implement", "threshold", "2025-10-13");
	assert.deepEqual(openReflections(line).length, 1);
	assert.match(line, /^- \[ \] pi auto-compacted \(threshold\) at stage implement .* — compact-aware 2025-10-13$/);
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

test("playbookTamper: prose about a write is not a write; a wrapper's payload is", () => {
	// the real v0.37.0 incident: a PR body quoting a copy of the playbook was refused as if it were the copy
	assert.equal(playbookTamper('gh pr create --title "t" --body "a safety copy was wrongly refused: cp the playbook to /tmp/project.md.bak .dev-flow/project.md"'), false);
	assert.ok(playbookTamper("bash -c 'cp /tmp/project.md.bak .dev-flow/project.md'"), "a shell wrapper's payload is code");
	assert.equal(playbookTamper("echo 'sed -i s/a/b/ .dev-flow/project.md' > /tmp/notes.md"), false, "a quoted mention, redirect elsewhere");
});

test("stateTamper: the folder is state — deleting it is tampering, reads are not", () => {
	// the old guard matched one path shape: it blocked a read through a bare `-e` and let the folder go
	assert.ok(stateTamper("rm -rf .dev-flow/my-feature"), "deleting the feature dir deletes its state and its plan");
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

test("claimBlocks blocks auto-bind only for a foreign live claim", () => {
	const claim = { key: "A", pid: 123, at: "now" };
	assert.equal(claimBlocks(null, "B"), false, "no claim — auto-bind proceeds");
	assert.equal(claimBlocks(claim, "A"), false, "our own claim — auto-bind proceeds");
	assert.equal(claimBlocks(claim, "B", () => true), true, "foreign claim from a live pid — auto-bind blocked");
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
	const src = readFileSync(new URL("../extensions/dev-flow.ts", import.meta.url), "utf8");
	const m = src.match(/const GATE_HELP =\s*("(?:[^"\\]|\\.)*");/);
	assert.ok(m, "GATE_HELP literal found in the extension source");
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

test("nextHint names the playbook merge style at the release stage", () => {
	const st = { ...newState("x", false), stage: "release" as const };
	const cfg = { ...DEFAULTS, release: { ...DEFAULTS.release, merge: "squash" as const } };
	assert.match(nextHint(st, cfg), /merge = squash — gh pr merge --squash/);
	assert.doesNotMatch(nextHint(st, DEFAULTS), /gh pr merge/, "no policy, no advice");
});
