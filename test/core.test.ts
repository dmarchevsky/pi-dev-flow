import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
	changelogEntry,
	cleanupAssess,
	cmpVersions,
	compactionReflectionLine,
	DEFAULTS,
	detectForge,
	featureBranchPrefix,
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
	parsePushRefs,
	playbookTamper,
	pluginVersion,
	preReleaseGate,
	newState,
	newestTaggedVersion,
	parseLsRemoteTags,
	parseVersion,
	pidAlive,
	playbookOnlyChange,
	sessionRunsOlderBuild,
	reflectProtocol,
	reflectSections,
	reflectionRoutes,
	releaseGate,
	shouldSelfCompact,
	stateTamper,
	statusCompact,
	tagNotesCommand,
	openReflections,
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

test("releaseGate requires verify approval and release stage", () => {
	const s = newState("f", false);
	assert.ok(releaseGate(s).length === 2);
	s.approvals.verify = "now";
	assert.ok(releaseGate(s).length === 1, "still wrong stage");
});

test("preReleaseGate: stage, re-greened checks, bumped version, changelog mention", () => {
	const s = { ...newState("f", false), stage: "pre-release" as const };
	const c2 = buildConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const prep = { manifestVersion: "1.2.0", remoteTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0" } };
	assert.ok(preReleaseGate(s, c2, prep).some((e) => e.includes("flow check")), "checks must be rerun after prep edits");
	s.checks.test = { ok: true, at: "" };
	assert.equal(preReleaseGate(s, c2, prep).length, 0);
	assert.ok(preReleaseGate({ ...s, stage: "implement" as const }, c2, prep).length > 0, "wrong stage");
	assert.ok(preReleaseGate(s, c2, { ...prep, remoteTags: ["v1.2.0"] }).some((e) => e.includes("already tagged")), "version not bumped past the last tag");
	assert.ok(preReleaseGate(s, c2, { ...prep, manifestVersion: null }).some((e) => e.includes("no parsable version")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: null }).some((e) => e.includes("does not exist")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: { file: "CHANGELOG.md", content: "## 1.1.0" } }).some((e) => e.includes("does not mention")));
	// unversioned flow (operator granted release --no-version): bump and changelog requirements are off
	assert.equal(preReleaseGate({ ...s, noVersion: true }, c2, { manifestVersion: null, remoteTags: ["v1.2.0"], changelog: null }).length, 0);
	// no versioning/changelog configured: only the check matters
	assert.equal(preReleaseGate({ ...newState("f", false), stage: "pre-release" as const, checks: { test: { ok: true, at: "" } } }, buildConfig({ commands: { test: "x" } }), prep).length, 0);
});

test("bashFlowGuard: main protection and release-stage release", () => {
	const base = { branch: "main", stage: null as "plan" | null, defaultBranch: "main" };
	assert.ok(bashFlowGuard({ ...base, command: "git commit -m x" }));
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

test("reflectProtocol: session-review steps, git-based update probe, routed open items", () => {
	const out = reflectProtocol(["- [ ] the gate prompt asks twice — x 2026-01-01"], false, { version: "1.2.3", upstream: "dmarchevsky/dev-flow" }).join("\n");
	assert.match(out, /flow reflect — session reflection \(dev-flow 1\.2\.3, upstream: dmarchevsky\/dev-flow\)/);
	assert.match(out, /this output is your work instruction: execute these steps now/);
	assert.match(out, /gitignored and yours to edit/);
	assert.match(out, /1\. review the current session log in full/);
	assert.match(out, /git ls-remote --tags --sort=-v:refname https:\/\/github\.com\/dmarchevsky\/dev-flow \| head -1/);
	assert.match(out, /pi install git:github\.com\/dmarchevsky\/dev-flow, then \/reload/);
	assert.match(out, /gh issue list --repo dmarchevsky\/dev-flow --state all --search/);
	assert.match(out, /gh issue create --repo dmarchevsky\/dev-flow/);
	assert.match(out, /b\. playbook items: run flow doctor/);
	assert.match(out, /\[plugin\] the gate prompt asks twice/);
	assert.match(out, /file an issue against pi-dev-flow upstream/);
	assert.ok(!out.includes("npm"), "dev-flow ships from git — the npm registry must not appear");
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
	const prep = { manifestVersion: "1.2.0", remoteTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0" } };
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

test("what the forge already has: newestTaggedVersion and ls-remote parsing (#52)", () => {
	assert.equal(newestTaggedVersion("v{version}", ["v0.9.0", "v0.10.0", "not-a-release"]), "0.10.0");
	assert.equal(newestTaggedVersion("v{version}", ["release-1"]), null, "no matching tag");
	assert.equal(newestTaggedVersion("rel-{version}", ["rel-1.0.1", "rel-1.0.2"]), "1.0.2", "a prefixed pattern too");
	assert.deepEqual(parseLsRemoteTags("abc\trefs/tags/v1.0.0\ndef\trefs/tags/v1.0.0^{}\nghi\trefs/tags/v1.1.0\n"), ["v1.0.0", "v1.1.0"], "peeled refs collapse into their tag");
});

test("tagNotesCommand is /bin/sh safe and changelogEntry finds the section (#51)", () => {
	assert.equal(tagNotesCommand("v1.2.3"), `git tag -l --format='%(contents)' "v1.2.3"`, "an unquoted %(contents) is a shell syntax error (#51)");
	const md = "# Changelog\n\n## [0.35.0] - 2026-10-18\n\n### Added\n\n- thing\n\n## [0.34.0] - 2026-10-17\n\n### Fixed\n\n- older\n";
	assert.equal(changelogEntry(md, "0.35.0"), "### Added\n\n- thing", "its own section, subsections included");
	assert.equal(changelogEntry(md, "9.9.9"), "", "no section, no body");
	assert.ok(looksLikeShellError('/bin/sh: 1: Syntax error: "(" unexpected'), "the shape #51 shipped as the release body");
	assert.ok(!looksLikeShellError("### Fixed\n\n- the forge release body was a /bin/sh syntax error (#51)"), "a changelog line about the bug is a real body");
});
