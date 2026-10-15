import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	applyAnswer,
	appendReflection,
	approveGate,
	bashFlowGuard,
	checkoutTarget,
	claimBlocks,
	compactionReflectionLine,
	featureBranchPrefix,
	gitInvocation,
	guardBash,
	guardPath,
	type GuardRules,
	checklistHash,
	cleanupAssess,
	DEFAULTS,
	getPath,
	mergeConfig,
	parsePushRefs,
	preReleaseGate,
	newState,
	parseVersion,
	pidAlive,
	pluginVersion,
	releaseGate,
	reflectSections,
	shouldSelfCompact,
	stateTamper,
	statusCompact,
	openReflections,
	verifyGate,
	versionTagGate,
	writeGuard,
} from "../src/core.ts";

const cfg = structuredClone(DEFAULTS);

test("mergeConfig fills defaults and merges partial overrides", () => {
	const c = mergeConfig({ defaultBranch: "master", commands: { test: "bun test" }, release: { changelog: "CHANGELOG.md" } });
	assert.equal(c.defaultBranch, "master");
	assert.equal(c.commands.test, "bun test");
	assert.equal(c.commands.build, undefined);
	assert.equal(c.release.changelog, "CHANGELOG.md");
	assert.equal(c.release.review, "/ponytail-review"); // kept from defaults
	assert.equal(mergeConfig(null).defaultBranch, "main");
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
	const htmlCfg = mergeConfig({ mockupGlobs: ["*.html"] });
	assert.equal(approveGate(su, htmlCfg, ["plan.md", "mockups/screen.html"]).length, 0, "configured glob overrides the png default");
	const done = { ...s, stage: "release" as const };
	assert.ok(approveGate(done, cfg, ["plan.md"]).length > 0, "wrong stage must not pass");
});

test("verifyGate requires green test check when configured", () => {
	const s = { ...newState("f", false), stage: "implement" as const };
	assert.ok(verifyGate(s, cfg).length === 0, "no test command configured → gate open (ui confirm covers)");
	const c2 = mergeConfig({ commands: { test: "x" } });
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
	const c2 = mergeConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const prep = { manifestVersion: "1.2.0", localTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0" } };
	assert.ok(preReleaseGate(s, c2, prep).some((e) => e.includes("flow check")), "checks must be rerun after prep edits");
	s.checks.test = { ok: true, at: "" };
	assert.equal(preReleaseGate(s, c2, prep).length, 0);
	assert.ok(preReleaseGate({ ...s, stage: "implement" as const }, c2, prep).length > 0, "wrong stage");
	assert.ok(preReleaseGate(s, c2, { ...prep, localTags: ["v1.2.0"] }).some((e) => e.includes("already tagged")), "version not bumped past the last tag");
	assert.ok(preReleaseGate(s, c2, { ...prep, manifestVersion: null }).some((e) => e.includes("no parsable version")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: null }).some((e) => e.includes("does not exist")));
	assert.ok(preReleaseGate(s, c2, { ...prep, changelog: { file: "CHANGELOG.md", content: "## 1.1.0" } }).some((e) => e.includes("does not mention")));
	// unversioned flow (operator granted release --no-version): bump and changelog requirements are off
	assert.equal(preReleaseGate({ ...s, noVersion: true }, c2, { manifestVersion: null, localTags: ["v1.2.0"], changelog: null }).length, 0);
	// no versioning/changelog configured: only the check matters
	assert.equal(preReleaseGate({ ...newState("f", false), stage: "pre-release" as const, checks: { test: { ok: true, at: "" } } }, mergeConfig({ commands: { test: "x" } }), prep).length, 0);
});

test("bashFlowGuard: main protection and release-stage release", () => {
	const base = { branch: "main", stage: null as "plan" | null, defaultBranch: "main" };
	assert.ok(bashFlowGuard({ ...base, command: "git commit -m x" }));
	assert.equal(bashFlowGuard({ ...base, branch: "feat/x", command: "git commit -m x" }), null);
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
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/a/state.json", dfDir: df, features: [], boundSlug: null }));
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/project.json", dfDir: df, features: [], boundSlug: null }));
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
});

test("statusCompact: slug ▸ stage with failing-check marker", () => {
	const s = newState("f", false);
	assert.deepEqual(statusCompact(s), { text: "f ▸ plan", failed: false });
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
	const c = { ...mergeConfig({}), checkList: [{ name: "health", cmd: "curl x" }], checklist: { implement: items } };
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
	writeFileSync(path.join(root, "package.json"), '{"name":"pi-dev-flow","version":"1.2.3"}');
	assert.deepEqual(pluginVersion(path.join(root, "extensions")), { version: "1.2.3", dir: root }, "nearest manifest named pi-dev-flow wins");

	// manifest is ours but carries no version: say so about that package, do not walk past it
	writeFileSync(path.join(root, "package.json"), '{"name":"pi-dev-flow"}');
	assert.deepEqual(pluginVersion(path.join(root, "extensions")), { version: null, dir: root });

	// some other package, and nothing of ours above it: unknown, naming where it looked
	const other = mkdtempSync(path.join(tmpdir(), "devflow-pv-"));
	mkdirSync(path.join(other, "lib"), { recursive: true });
	writeFileSync(path.join(other, "package.json"), '{"name":"someone-else","version":"9.9.9"}');
	assert.deepEqual(pluginVersion(path.join(other, "lib")), { version: null, dir: path.join(other, "lib") });
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
	assert.equal(approveGate(p, mergeConfig({}), []).length, 0, "patch: empty plan/ passes the gate");
	assert.equal(approveGate(newState("p", false), mergeConfig({}), []).length, 1, "non-patch still requires plan/*.md");
	assert.ok(statusCompact(p).text.includes("⚡"), "status marks patch features");
});

test("docs mode: no plan document, no tier-1 checks, release integrity intact", () => {
	const cfg = mergeConfig({ commands: { test: "x" } });
	assert.equal(approveGate(newState("d", false, false, true), mergeConfig({}), []).length, 0, "docs: empty plan/ passes the gate");
	assert.ok(approveGate(newState("d", false), mergeConfig({}), []).length === 1, "normal features still require plan/*.md");
	assert.ok(statusCompact(newState("d", false, false, true)).text.includes("📄"), "status marks docs features");
	const d = { ...newState("d", false, false, true), stage: "implement" as const };
	assert.equal(verifyGate(d, cfg).length, 0, "docs skips the tier-1 check requirement");
	assert.ok(verifyGate({ ...newState("d", false), stage: "implement" as const }, cfg).length > 0, "non-docs still demands green checks");
	const pre = { ...newState("d", false, false, true), stage: "pre-release" as const };
	const c3 = mergeConfig({ commands: { test: "x" }, versioning: { file: "package.json" }, release: { changelog: "CHANGELOG.md" } });
	const prep = { manifestVersion: "1.2.0", localTags: ["v1.1.0"], changelog: { file: "CHANGELOG.md", content: "## 1.2.0" } };
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

test("mergeConfig reads guard rules from project.json (bare patterns and objects)", () => {
	const c = mergeConfig({ guard: { deny: ["\\bgit\\b[^]*--force"], forbid: [{ pattern: "docker/secrets", why: "secret storage" }] } });
	assert.deepEqual(c.guard.deny, [{ pattern: "\\bgit\\b[^]*--force", why: "" }]);
	assert.equal(c.guard.forbid[0].why, "secret storage");
	assert.deepEqual(mergeConfig(null).guard, { deny: [], confirm: [], protect: [], forbid: [] });
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
