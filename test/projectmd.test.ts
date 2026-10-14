import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../src/core.ts";
import { buildDraft, doctorFindings, ghostFeatureDirs, loadProject, mdDigest, mdToConfig, parseProjectMd } from "../src/projectmd.ts";

const MD = `# dev-flow

## global
\`\`\`flow
defaultBranch = trunk
mainHook = no
mockupGlobs = *.png, *.jpg
\`\`\`

## plan
- [ ] mockups rendered
Plan must list rollback steps.

## implement
\`\`\`flow
test = npm test
run = npm run dev
\`\`\`
\`\`\`flow-check overflow
node scripts/check-overflow.mjs
\`\`\`
- [ ] visual pass at both widths
Prefer feature flags for risky paths.

## release
version rules here
\`\`\`flow
versionFile = VERSION
versionTag = {version}
\`\`\`
`;

test("parseProjectMd: tiers, key maps, prose per stage", () => {
	const p = parseProjectMd(MD);
	assert.equal(p.hard.length, 0);
	assert.equal(p.warn.length, 0);
	assert.equal(p.flow.global.defaultBranch, "trunk");
	assert.equal(p.flow.implement["commands.test"], "npm test");
	assert.equal(p.flow.release["versioning.file"], "VERSION");
	assert.deepEqual(p.checks, [{ name: "overflow", cmd: "node scripts/check-overflow.mjs" }]);
	assert.deepEqual(p.checklist.plan, [{ text: "mockups rendered", uiOnly: false }]);
	assert.deepEqual(p.checklist.implement, [{ text: "visual pass at both widths", uiOnly: false }]);
	assert.equal(p.prose.implement, "Prefer feature flags for risky paths.");
	assert.equal(p.prose.release, "version rules here");
});

test("mdToConfig: normalization and tier-1 checkList build", () => {
	const cfg = mdToConfig(parseProjectMd(MD));
	assert.equal(cfg.defaultBranch, "trunk");
	assert.equal(cfg.mainHook, false);
	assert.deepEqual(cfg.mockupGlobs, ["*.png", "*.jpg"]);
	assert.deepEqual(cfg.checkList.map((c) => c.name), ["test", "overflow"]);
	assert.equal(cfg.versioning.pattern, "{version}");
	const fromJson = mdToConfig(parseProjectMd("## implement\n"), mergeConfig({ commands: { test: "legacy" } }));
	assert.equal(fromJson.commands.test, "legacy", "empty md must not erase json base");
});

test("parseProjectMd: warnings and hard errors", () => {
	const warns = parseProjectMd("## bogus\n\n## implement\n```flow\nnonsense = x\n```\n");
	assert.ok(warns.warn.some((w) => w.includes('unknown stage "bogus"')));
	assert.ok(warns.warn.some((w) => w.includes('unknown key "nonsense"')));
	assert.equal(warns.hard.length, 0);
	const bad = parseProjectMd("## implement\n```flow\nnot a pair\n```\n```flow-check\nx\n```\n");
	assert.equal(bad.hard.length, 2);
	assert.ok(parseProjectMd("## implement\n```flow\nx = y").hard.some((h) => h.includes("unterminated")));
});

test("flow-check outside implement warns; empty body is hard", () => {
	assert.ok(parseProjectMd("## release\n```flow-check x\ncmd\n```\n").warn.some((w) => w.includes("## implement")));
	assert.ok(parseProjectMd("## implement\n```flow-check x\n\n```\n").hard.some((h) => h.includes("empty")));
});

function fixtureRoot(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pm-"));
	for (const [name, content] of Object.entries(files)) {
		const p = path.join(dir, name);
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	return dir;
}

test("doctorFindings: drift, missing manifest, no health check", () => {
	const root = fixtureRoot({ "package.json": '{"name":"x","scripts":{"test":"vitest"},"version":"1.0.0"}', VERSION: "9.9.9" });
	const cfg = mdToConfig(parseProjectMd(MD));
	const md = parseProjectMd(MD);
	const f = doctorFindings(root, cfg, md, false, true);
	assert.ok(f.some((x) => x.includes('runs "run dev"')), "npm run dev drift detected");
	assert.ok(f.some((x) => x.includes("missing file scripts/check-overflow.mjs")));
	assert.ok(f.some((x) => x.includes("no tier-1 health check")), "run configured, health absent");
	assert.ok(!f.some((x) => x.includes("versioning.file")), "VERSION exists → no finding");
	const dual = doctorFindings(root, cfg, md, true, true);
	assert.ok(dual.some((x) => x.includes("both project.json and project.md")));
	const broken = doctorFindings(fixtureRoot({ "package.json": "{}" }), { ...cfg }, md, false, true);
	assert.ok(broken.some((x) => x.includes("does not exist")), "VERSION missing in second fixture");
});

test("doctorFindings: the dogfood shim is probed only in a dev-flow checkout", () => {
	const cfg = mergeConfig({ commands: { test: "npm test" } });
	const has = (root: string) => doctorFindings(root, cfg, null, false, true).some((x) => x.includes("dogfood shim"));
	const repo = fixtureRoot({ "package.json": '{"name":"pi-dev-flow","version":"1.0.0"}' });
	assert.ok(has(repo), "a dev-flow checkout whose extension is not wired loads nothing");
	const shim = path.join(repo, ".pi", "extensions", "dev-flow.ts");
	mkdirSync(path.dirname(shim), { recursive: true });
	writeFileSync(shim, 'export { default } from "../../extensions/dev-flow.ts";\n');
	assert.ok(!has(repo), "the committed one-liner is what satisfies it");
	writeFileSync(shim, 'export { default } from "../elsewhere.ts";\n');
	assert.ok(has(repo), "a shim pointing somewhere else is stale wiring");
	// a project that merely carries dev-flow's skill, or is named similarly, is not our checkout
	const other = fixtureRoot({ "package.json": '{"name":"my-app","version":"1.0.0"}', "skills/dev-flow/SKILL.md": "# dev-flow\n" });
	assert.ok(!has(other), "an ordinary project never hears about our dogfood setup");
});

test("loadProject: md overrides json base", () => {
	const root = fixtureRoot({ ".dev-flow/project.json": '{"defaultBranch":"jsonbranch","commands":{"build":"make"}}', ".dev-flow/project.md": MD });
	const { cfg } = loadProject(path.join(root, ".dev-flow"));
	assert.equal(cfg.defaultBranch, "trunk", "md wins over json");
	assert.equal(cfg.commands.build, "make", "json-only values survive");
});

test("buildDraft: fresh is detection-driven; refresh keeps configured values", () => {
	const det = { report: [], partial: { defaultBranch: "master", commands: { test: "detected-test" }, versioning: { file: "Cargo.toml" } } };
	const fresh = buildDraft(det);
	assert.match(fresh, /defaultBranch = master/);
	assert.match(fresh, /test = detected-test/);
	assert.match(fresh, /versionFile = Cargo.toml/);
	const kept = buildDraft(det, mdToConfig(parseProjectMd(MD)));
	assert.match(kept, /defaultBranch = trunk/);
	assert.match(kept, /test = npm test/);
	assert.match(kept, /versionFile = VERSION/);
	assert.ok(!fresh.includes("```flow-check"), "no phantom health placeholder in fresh drafts");
	assert.match(fresh, /optional tier-1/, "hint where a health check would go");
	assert.match(kept, /```flow-check overflow\nnode scripts\/check-overflow\.mjs/, "refresh carries explicit checks");
	const withHealth = mdToConfig(parseProjectMd(`${MD.replace("## release", "```flow-check health\ncurl -sf :4000/health\n```\n\n## release")}`));
	assert.match(buildDraft(det, withHealth), /```flow-check health\ncurl -sf :4000\/health/, "health check carried, exactly once");
});

test("parseProjectMd: (ui) marker splits tier-2 items", () => {
	const p = parseProjectMd("## plan\n- [ ] (ui) mockups only\n- [ ] both\n");
	assert.deepEqual(p.checklist.plan, [{ text: "mockups only", uiOnly: true }, { text: "both", uiOnly: false }]);
});

test("mdToConfig: release.github toggles the GitHub release", () => {
	assert.equal(mdToConfig(parseProjectMd("## release\n```flow\nversionFile = package.json\ngithub = false\n```\n")).release.githubRelease, false);
	assert.equal(mdToConfig(parseProjectMd("## release\n```flow\ngithub = no\n```\n")).release.githubRelease, false);
	assert.equal(mdToConfig(parseProjectMd("## release\n```flow\ngithub = yes\n```\n")).release.githubRelease, true);
	assert.equal(mdToConfig(parseProjectMd("# dev-flow\n")).release.githubRelease, true);
});

test("mdToConfig: release.artifact key; doctor flags an empty tier-1", () => {
	assert.equal(mdToConfig(parseProjectMd("## release\n```flow\nartifact = docker manifest inspect app:{tag}\n```\n")).release.artifact, "docker manifest inspect app:{tag}");
	const emptyDir = mkdtempSync(path.join(tmpdir(), "pdf-doctor-"));
	assert.ok(doctorFindings(emptyDir, mergeConfig({}), null, false, true).some((f) => f.includes("gates nothing")));
	const withTest = mdToConfig(parseProjectMd("## implement\n```flow\ntest = x\n```\n"));
	assert.equal(doctorFindings(emptyDir, withTest, null, false, true).some((f) => f.includes("gates nothing")), false);
});

test("mdDigest: human phase-grouped summary with real values, nothing truncated", () => {
	const d = mdDigest("# dev-flow\n\n## global\n```flow\ndefaultBranch = main\n```\n\n## implement\n```flow\ntest = npm test\ndev = docker compose up -d\n```\n\n- [ ] visual pass at both widths\n\nreal data required before shipping\n\n## release\n```flow\nversionFile = package.json\nversionTag = v{version}\n```\n");
	assert.match(d, /^General — default branch: main$/m);
	assert.match(d, /Implement — test: "npm test" · dev deploy: "docker compose up -d" · manual check: "visual pass at both widths" · guidance: "real data required before shipping"/);
	assert.match(d, /Release — version in package\.json → tag v\{version\} · GitHub release: created automatically · artifact check: none set/);
	assert.ok(!d.includes("set:") && !/\bprose\b/.test(d), "no internal notation left");
	assert.match(d, /nothing is executed or uploaded now/);
});

// ---------------------------------------------------------------- flow-guard block

const GUARD_LINES = [
	"```flow-guard",
	"deny    \\bgit\\b[^]*--force(?!\\w)              :: history stays linear",
	"confirm \\bgit\\b[^]*\\bworktree remove\\b       :: a script checks PR state first",
	"protect docker/.env                             :: gitignored live secrets",
	"forbid  docker/secrets                          :: gitignored secret storage",
	"```",
];
const GUARD_MD = ["# dev-flow", "", "## global", "", ...GUARD_LINES, ""].join("\n");

test("flow-guard block: each verb maps to its rule list", () => {
	const p = parseProjectMd(GUARD_MD);
	assert.deepEqual(p.hard, []);
	assert.deepEqual(p.warn, []);
	assert.deepEqual(p.guard.deny, [{ pattern: "\\bgit\\b[^]*--force(?!\\w)", why: "history stays linear" }]);
	assert.equal(p.guard.confirm.length, 1);
	assert.equal(p.guard.protect[0].pattern, "docker/.env");
	assert.equal(p.guard.forbid[0].pattern, "docker/secrets");
	assert.equal(p.guard.forbid[0].why, "gitignored secret storage", "reason is free text");
	const cfg = mdToConfig(p);
	assert.equal(cfg.guard.deny[0].why, "history stays linear");
	assert.equal(mdToConfig(parseProjectMd("## global\n"), mergeConfig({ guard: { forbid: ["docker/secrets"] } })).guard.forbid.length, 1, "no block must not erase the project.json base");
});

test("flow-guard block: hard findings and warnings", () => {
	assert.ok(parseProjectMd("## global\n```flow-guard\ndeny git push :: \n```\n").hard.length === 0, "empty reason is allowed (free text)");
	assert.ok(parseProjectMd("## global\n```flow-guard\ndeny git push\n```\n").hard.some((h) => h.includes("::")), "missing separator is hard");
	assert.ok(parseProjectMd("## global\n```flow-guard\ndeny    :: why\n```\n").hard.some((h) => h.includes("no pattern")), "empty pattern is hard");
	assert.ok(parseProjectMd("## global\n```flow-guard\ndeny (unclosed[ :: why\n```\n").hard.some((h) => h.includes("regular expression")), "bad regex is hard so init --write refuses");
	assert.ok(parseProjectMd("## global\n```flow-guard\nblock docker/.env :: why\n```\n").warn.some((w) => w.includes('unknown flow-guard verb "block"')), "unknown verb warns");
	assert.ok(!parseProjectMd("## global\n```flow-guard\nblock docker/.env :: why\n```\n").hard.length, "unknown verb is not a hard finding");
});

test("flow-guard rules belong to ## global — a stage-scoped block warns and applies nothing", () => {
	const p = parseProjectMd(["## implement", ...GUARD_LINES, ""].join("\n"));
	assert.ok(p.warn.some((w) => w.includes("flow-guard rules belong to ## global")), p.warn.join("; "));
	assert.deepEqual(p.guard.deny, []);
	assert.equal(mdToConfig(p).guard.forbid.length, 0);
});

test("flow-guard acceptance: the adopting project's real rule set parses clean", () => {
	const md = [
		"# dev-flow",
		"",
		"## global",
		"",
		"```flow-guard",
		"deny    \\bgit\\b[^\\n]*--force(?!\\w)                        :: history stays linear — PRs squash-merge, update a branch by merging main into it",
		"deny    \\bgit\\b[^\\n]*\\bpush\\b(?!\\w)[^\\n]*\\s-f(?!\\w)        :: the short spelling of the force push above",
		"deny    \\bgit\\b[^\\n]*\\bworktree\\s+prune\\b                 :: prunes other sessions' worktrees",
		"confirm \\bgit\\b[^\\n]*\\bworktree remove\\b                  :: a script checks PR state and live sessions first",
		"confirm \\bgit\\b[^\\n]*\\bbranch\\s+(?:-d\\b|--delete\\b)        :: report the branch instead; a checked script does the checking",
		"confirm \\bgit\\b[^\\n]*\\bbranch\\s+(?:-D\\b|--delete\\s+--force|--force\\s+--delete) :: deletes a squash-merged branch that git cannot see as merged",
		"confirm \\bgh\\b[^\\n]*\\bpr\\s+merge\\b                        :: the operator merges, or names this specific PR",
		"confirm \\bgh\\b[^\\n]*\\bpr\\s+review\\b[^\\n]*(?:--approve|\\bapprove\\b) :: an approval is a human statement that they ran it",
		"confirm \\bgh\\b[^\\n]*\\bapi\\b[^\\n]*\\/merges?\\b              :: the same merge through the raw API",
		"confirm \\bdocker\\b[^\\n]*\\bcompose\\b[^\\n]*\\b(?:rm|down|stop|kill)\\b :: stops running containers",
		"confirm \\bdocker\\b[^\\n]*\\bcompose\\b[^\\n]*\\brestart\\b      :: drops a permanent upstream connection and any turn in flight",
		"confirm \\bdocker\\b[^\\n]*\\bcompose\\b[^\\n]*\\bup\\b[^\\n]*(?:^|\\s)app-server(?=\\s|$) :: service shares a network namespace with two others",
		"protect docker/.env                                       :: gitignored live secrets — never echo the values",
		"forbid  docker/secrets                                    :: gitignored secret storage",
		"```",
		"",
	].join("\n");
	const p = parseProjectMd(md);
	assert.deepEqual(p.hard, []);
	assert.deepEqual(p.warn, []);
	assert.deepEqual([p.guard.deny.length, p.guard.confirm.length, p.guard.protect.length, p.guard.forbid.length], [3, 9, 1, 1]);
	for (const r of [...p.guard.deny, ...p.guard.confirm]) new RegExp(r.pattern); // every rule compiles
});

test("doctorFindings probes only root-relative paths — worktree-relative ones are not its business", () => {
	const root = fixtureRoot({ "package.json": '{"name":"x","version":"1.0.0"}' });
	const wtRelative = mdToConfig(parseProjectMd("## implement\n```flow\ntest = cp -n ../../docker/.env .\n```\n"));
	assert.ok(!doctorFindings(root, wtRelative, null, false, true).some((f) => f.includes("missing file")), "a path above the repo root is resolved by the shell in the gate cwd");
	const rootRelative = mdToConfig(parseProjectMd("## implement\n```flow\ntest = node scripts/nope.mjs\n```\n"));
	assert.ok(doctorFindings(root, rootRelative, null, false, true).some((f) => f.includes("missing file scripts/nope.mjs")), "root-relative probes still work");
});

const GHOST_STATE = '{"slug":"live","stage":"implement","ui":false,"branch":"","worktree":"","createdAt":"","approvals":{},"checks":{}}';

test("ghostFeatureDirs: a plan/ with no flow state is a ghost, everything else is not", () => {
	const root = fixtureRoot({
		".dev-flow/project.md": "# dev-flow\n",
		".dev-flow/closed/plan/plan.md": "# plan\n",
		".dev-flow/live/plan/plan.md": "# plan\n",
		".dev-flow/live/state.json": GHOST_STATE,
		".dev-flow/bare/readme.txt": "x",
	});
	assert.deepEqual(ghostFeatureDirs(root), [".dev-flow/closed"]);
	const f = doctorFindings(root, mdToConfig(parseProjectMd("# dev-flow\n")), null, false, true);
	assert.ok(f.some((x) => x.includes(".dev-flow/closed has a plan/ but no state.json")), f.join("; "));
	assert.ok(!f.some((x) => x.includes("live")), "a live feature is never a ghost");
	assert.deepEqual(ghostFeatureDirs(mkdtempSync(path.join(tmpdir(), "nodf-"))), [], "no .dev-flow at all, no ghosts");
});
