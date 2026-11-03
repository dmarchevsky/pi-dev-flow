import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectProject, scriptCmd } from "../src/detect.ts";

function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "detect-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		writeFileSync(path.join(dir, name), content);
	}
	return dir;
}

test("node project: packageManager field drives the package manager", () => {
	const d = detectProject(fixture({ "package.json": JSON.stringify({ packageManager: "bun@1.3.0", scripts: { test: "bun test", dev: "vite" } }) }), "main");
	assert.equal(d.partial.defaultBranch, "main");
	assert.equal(d.partial.commands.setup, "bun install");
	assert.equal(d.partial.commands.test, "bun run test", "bun test is bun's own runner — the script needs bun run");
	assert.equal(d.partial.commands.run, "bun run dev");
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

test("versioning detection: VERSION wins, then package.json, then reports none", () => {
	const both = detectProject(fixture({ VERSION: "9.9.9\n", "package.json": '{"version":"1.1.1"}' }), "main");
	assert.equal(both.partial.versioning?.file, "VERSION");
	assert.ok(both.report.some((l) => l.includes("versioning: VERSION (current 9.9.9)")));
	const pkg = detectProject(fixture({ "package.json": '{"version":"2.2.2"}' }), "main");
	assert.equal(pkg.partial.versioning?.file, "package.json");
	const none = detectProject(fixture({ README: "hi" }), "main");
	assert.equal(none.partial.versioning, undefined);
	assert.ok(none.report.some((l) => l.includes("versioning: none found")));
});

test("unknown repo: empty commands with a warning", () => {
	const d = detectProject(fixture({ README: "hi" }), "main");
	assert.deepEqual(d.partial.commands, {});
	assert.ok(d.report.some((l) => l.includes("no supported manifest")));
	assert.deepEqual(d.missing, ["test", "build", "run"]);
});

test("npm scripts: only test/start have shorthands — build and dev need run", () => {
	assert.equal(scriptCmd("npm", "build"), "npm run build", "npm build is \"Unknown command\"");
	assert.equal(scriptCmd("npm", "dev"), "npm run dev");
	assert.equal(scriptCmd("npm", "test"), "npm test");
	assert.equal(scriptCmd("npm", "start"), "npm start");
	assert.equal(scriptCmd("bun", "test"), "bun run test");
	const d = detectProject(fixture({ "package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc", dev: "vite", lint: "eslint .", typecheck: "tsc --noEmit" } }) }), "main");
	assert.equal(d.partial.commands.build, "npm run build");
	assert.equal(d.partial.commands.run, "npm run dev");
	assert.deepEqual(d.partial.checks, { lint: "npm run lint", typecheck: "npm run typecheck" }, "lint/typecheck scripts become flow-check blocks");
});

test("task runners fill commands when no manifest does", () => {
	const d = detectProject(fixture({ Makefile: "VAR := 1\ntest:\n\tgo test\nbuild: deps\n\tgo build\nlint:\n\tx\n" }), "main");
	assert.equal(d.partial.commands.test, "make test");
	assert.equal(d.partial.commands.build, "make build");
	assert.equal(d.partial.checks?.lint, "make lint");
	assert.ok(!d.report.some((l) => l.includes("no supported manifest")));
});

test("secrets on disk are drafted as guards; templates are not secrets", () => {
	const d = detectProject(fixture({ ".env": "K=1", ".env.example": "K=", "secrets/x": "s" }), "main");
	assert.deepEqual(d.partial.guards, ["protect .env* :: live secrets — and any backup copied beside them", "forbid  secrets :: secret storage"]);
	assert.ok(d.report.some((l) => l.includes(".env.example")), "the template is named for the worktree setup copy");
	assert.equal(detectProject(fixture({ ".env.example": "" }), "main").partial.guards, undefined);
});

test("changelog: default, alternative name, or none", () => {
	assert.equal(detectProject(fixture({ "CHANGELOG.md": "" }), "main").partial.changelog, undefined);
	assert.equal(detectProject(fixture({ "CHANGES.md": "" }), "main").partial.changelog, "CHANGES.md");
	assert.equal(detectProject(fixture({ README: "" }), "main").partial.changelog, "");
});

test("docker, CI and publish evidence become suggestions, never drafted commands", () => {
	const d = detectProject(
		fixture({
			"package.json": JSON.stringify({ name: "@me/pkg", scripts: { test: "x" } }),
			Dockerfile: "FROM node",
			"compose.yaml": "services:\n  app:\n    healthcheck:\n      test: x\n",
			".github/workflows/release.yml": "jobs:\n  r:\n    steps:\n      - run: npm ci\n      - run: npm publish\n",
		}),
		"main",
	);
	const keys = Object.fromEntries(d.suggestions.map((x) => [x.key, x.value]));
	assert.equal(keys.preflight, "docker build .");
	assert.equal(keys.dev, "docker compose -f compose.yaml up -d --build");
	assert.equal(keys.artifact, "npm view --prefer-online @me/pkg@{version} version");
	assert.equal(d.partial.commands.dev, undefined, "a deploy is the operator's call");
	assert.ok(d.report.some((l) => l.startsWith("CI: .github/workflows/release.yml") && l.includes("`npm publish`")));
	assert.ok(d.report.some((l) => l.includes("declares a healthcheck")));
});

test("monorepo workspaces are reported", () => {
	assert.ok(detectProject(fixture({ "package.json": JSON.stringify({ workspaces: ["a"] }) }), "main").report.some((l) => l.startsWith("monorepo: npm/yarn workspaces")));
});
