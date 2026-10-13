import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyAnswer,
	approveGate,
	bashFlowGuard,
	checkoutTarget,
	featureBranchPrefix,
	gitInvocation,
	checklistHash,
	cleanupAssess,
	DEFAULTS,
	getPath,
	mergeConfig,
	parsePushRefs,
	newState,
	parseVersion,
	releaseGate,
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
	assert.deepEqual(gitInvocation("cat .git/hooks/pre-commit"), { subs: [], dir: null, pushes: [] });
	assert.deepEqual(gitInvocation("git commit -m x"), { subs: ["commit"], dir: null, pushes: [] });
	assert.deepEqual(gitInvocation("cd .dev-flow/f/worktree && git commit -m x"), { subs: ["commit"], dir: ".dev-flow/f/worktree", pushes: [] });
	assert.deepEqual(gitInvocation("git -C /tmp/wt push origin feat/x"), { subs: ["push"], dir: "/tmp/wt", pushes: [["origin", "feat/x"]] });
	assert.deepEqual(gitInvocation("git -C=/tmp/wt commit"), { subs: ["commit"], dir: "/tmp/wt", pushes: [] });
	assert.deepEqual(gitInvocation("/usr/bin/git branch --show-current"), { subs: ["branch"], dir: null, pushes: [] });
	assert.deepEqual(gitInvocation("cd wt; git status; git push"), { subs: ["status", "push"], dir: "wt", pushes: [[]] });
	assert.deepEqual(gitInvocation("sudo git commit -m x"), { subs: ["commit"], dir: null, pushes: [] });
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
	assert.match(writeGuard({ abs: "/repo/src/app.ts", dfDir: df, features: [], boundSlug: null }) ?? "", /no active flow/, "flow-by-default: clean repo still requires a flow");
	assert.equal(writeGuard({ abs: "/repo/src/app.ts", dfDir: df, features: [], boundSlug: null, exempt: true }), null, "operator exemption opens the checkout");
	assert.equal(writeGuard({ abs: "/repo/CHANGELOG.md", dfDir: df, features: feats, boundSlug: "b", exempt: true }), null, "exemption lifts stage confinement too (user override)");
	assert.ok(writeGuard({ abs: "/repo/.dev-flow/a/state.json", dfDir: df, features: [], boundSlug: null, exempt: true }), "exempt never touches dev-flow-owned files");
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
