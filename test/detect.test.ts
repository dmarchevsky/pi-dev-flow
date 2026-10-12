import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectProject } from "../src/detect.ts";

function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "detect-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
	return dir;
}

test("node project: packageManager field drives the package manager", () => {
	const d = detectProject(fixture({ "package.json": JSON.stringify({ packageManager: "bun@1.3.0", scripts: { test: "bun test", dev: "vite" } }) }), "main");
	assert.equal(d.partial.defaultBranch, "main");
	assert.equal(d.partial.commands.setup, "bun install");
	assert.equal(d.partial.commands.test, "bun test");
	assert.equal(d.partial.commands.run, "bun dev");
	assert.deepEqual(d.missing, ["build"]);
});

test("node project: lockfile fallbacks and npm defaults", () => {
	const npm = detectProject(fixture({ "package.json": JSON.stringify({ scripts: { test: "jest", start: "node ." } }) }), "master");
	assert.equal(npm.partial.commands.setup, "npm install");
	assert.equal(npm.partial.commands.run, "npm start");
	assert.equal(npm.partial.defaultBranch, "master");
	const pnpm = detectProject(fixture({ "package.json": "{}", "pnpm-lock.yaml": "" }), "main");
	assert.equal(pnpm.partial.commands.setup, "pnpm install");
});

test("rust, go, python ecosystems", () => {
	assert.equal(detectProject(fixture({ "Cargo.toml": "" }), "main").partial.commands.test, "cargo test");
	assert.equal(detectProject(fixture({ "go.mod": "module x" }), "main").partial.commands.build, "go build ./...");
	const uv = detectProject(fixture({ "pyproject.toml": "", "uv.lock": "" }), "main");
	assert.equal(uv.partial.commands.test, "uv run pytest");
	assert.equal(uv.partial.commands.setup, "uv sync");
});

test("unknown repo: empty commands with a warning", () => {
	const d = detectProject(fixture({ README: "hi" }), "main");
	assert.deepEqual(d.partial.commands, {});
	assert.ok(d.report.some((l) => l.includes("no supported manifest")));
	assert.deepEqual(d.missing, ["test", "build", "run"]);
});
