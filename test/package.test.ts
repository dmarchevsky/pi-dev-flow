import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	license?: string;
	repository?: string;
	engines?: { node?: string };
	files?: string[];
	keywords?: string[];
	description?: string;
	pi?: { image?: string };
};
const files = pkg.files ?? [];

// Pi discovers extensions/, skills/, prompts/ and themes/ without a `pi` manifest, so a resource dir
// that exists on disk but is missing from `files` ships to npm without its resources — and only the
// person installing the published package finds out.
test("every pi-discoverable resource dir is in the npm files allow-list", () => {
	for (const dir of ["extensions", "skills", "prompts", "themes"]) {
		if (!existsSync(path.join(root, dir))) continue;
		assert.ok(files.includes(`${dir}/`), `package.json files must list "${dir}/" or the published package drops it`);
	}
});

test("the published manifest is self-describing", () => {
	assert.equal(pkg.license, "MIT");
	assert.ok(existsSync(path.join(root, "LICENSE")), "`license: MIT` without a LICENSE file makes npm warn and users guess");
	assert.ok(pkg.engines?.node, "engines.node states the floor pi requires");
	assert.match(pkg.repository ?? "", /^https:\/\/github\.com\/[^/]+\/pi-dev-flow$/, "repository must name the repo CI publishes from");
	assert.ok(!files.includes("test"), "tests stay out of the runtime artifact");
	// the pi.dev gallery lists and searches by these, and renders pi.image as its preview
	assert.ok((pkg.keywords ?? []).includes("pi-package"), "pi.dev discovers packages by the pi-package keyword");
	assert.ok((pkg.description ?? "").length > 40, "the gallery search matches the description — spend words there");
	if (pkg.pi?.image) {
		const img = pkg.pi.image.replace(/^\.\//, "");
		assert.ok(existsSync(path.join(root, img)), `pi.image points at ${img}, which must exist`);
		assert.ok(files.includes(img), `pi.image points at ${img}, which npm would drop from the tarball`);
	}
});

// Pi advertises a skill (name, description, path) and never loads it unasked, so whatever the
// extension injects must stay small, and whatever it does not inject must be findable from the file.
const SKILL_DIR = path.join(root, "skills", "dev-flow");
const SKILL_STAGES = ["start", "plan", "implement", "pre-release", "release", "finish", "reflect"];

test("the dev-flow skill keeps its always-on core inside the budget", () => {
	const md = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
	const open = md.indexOf("<!-- dev-flow:core:start -->");
	const close = md.indexOf("<!-- dev-flow:core:end -->");
	assert.ok(open >= 0 && close > open, "the core must sit between its markers — that span is what every session gets injected");
	const core = md.slice(open + "<!-- dev-flow:core:start -->".length, close).trim();
	// 4500 since the Stage reports contract joined the always-on rules (~900 chars, docs/playbook.md holds the long form)
	assert.ok(core.length <= 4500, `the core costs every session ~${Math.round(core.length / 4)} tokens; stage detail belongs in references/ (now ${core.length} chars)`);
	for (const rule of ["flow tool is the only invocation", "Approve?", "flow abort"])
		assert.ok(core.includes(rule), `the core has to carry "${rule}" — it is what a session gets wrong without it`);
});

test("every stage has a playbook file and the map names it", () => {
	const md = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
	const onDisk = readdirSync(path.join(SKILL_DIR, "references")).sort();
	assert.deepEqual(onDisk, [...SKILL_STAGES].sort().map((s) => `${s}.md`), "references/ holds exactly one file per stage — no orphans, nothing missing");
	for (const s of SKILL_STAGES) assert.match(md, new RegExp(`references/${s}\\.md`), `the stage map in SKILL.md never points at ${s}.md`);
	// the state machine has no finish stage, so nothing would ever name finish.md if release.md did not
	assert.match(readFileSync(path.join(SKILL_DIR, "references", "release.md"), "utf8"), /finish\.md/, "release must hand over to finish");
});
