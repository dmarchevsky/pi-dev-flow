import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../src/core.ts";
import { buildDraft, doctorFindings, loadProject, mdToConfig, parseProjectMd } from "../src/projectmd.ts";

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

test("loadProject: md overrides json base", () => {
	const root = fixtureRoot({ ".dev-flow/project.json": '{"defaultBranch":"jsonbranch","commands":{"build":"make"}}', ".dev-flow/project.md": MD });
	const { cfg } = loadProject(root, path.join(root, ".dev-flow"));
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
