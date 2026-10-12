/**
 * Smoke test: wires the real extension against a stub ExtensionAPI and a
 * scratch git repo, proving command routing, gate refusal and tool guards.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import devFlow from "../extensions/dev-flow.ts";

type Handler = (event: { toolName?: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

interface Stub {
	cmds: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Record<string, { execute: (...a: unknown[]) => Promise<{ content: [{ text: string }] }> }>;
	handlers: Record<string, Handler[]>;
}

function makePi(): Stub & ((...a: never[]) => void) {
	const stub = { cmds: {}, tools: {}, handlers: {} } as Stub;
	const api = {
		registerCommand: (n: string, o: unknown) => {
			stub.cmds[n] = o as never;
		},
		registerTool: (t: { name: string }) => {
			stub.tools[t.name] = t as never;
		},
		on: (e: string, h: Handler) => {
			(stub.handlers[e] ??= []).push(h);
			return () => {};
		},
	};
	devFlow(api as never);
	return stub as never;
}

function makeRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "devflow-"));
	execFileSync("git", ["init", "-b", "main", dir]);
	writeFileSync(path.join(dir, "README.md"), "# scratch\n");
	return dir;
}

function makeCtx(cwd: string, hasUI = false) {
	const notices: string[] = [];
	return { cwd, hasUI, notices, ui: { notify: (m: string) => notices.push(m), confirm: async () => true } };
}

test("init → start → guards → gate ordering, end to end", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);

	await pi.cmds.flow.handler("init", ctx);
	assert.ok(existsSync(path.join(repo, ".dev-flow")), "init created .dev-flow/");
	assert.ok(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), "pre-commit hook installed");
	assert.ok(readFileSync(path.join(repo, ".gitignore"), "utf8").includes(".dev-flow/"), "gitignore updated");
	assert.ok(readFileSync(path.join(repo, ".dev-flow", "project.json"), "utf8").includes('"defaultBranch"'), "init wrote detected project.json");
	writeFileSync(path.join(repo, ".dev-flow", "project.json"), '{"defaultBranch":"main","_marker":"kept"}');
	await pi.cmds.flow.handler("init", ctx);
	assert.ok(readFileSync(path.join(repo, ".dev-flow", "project.json"), "utf8").includes("kept"), "re-init must not overwrite operator config");

	await pi.cmds.flow.handler("start demo-feature", ctx);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "demo-feature", "state.json")));

	// plan stage: code edits blocked, plan edits allowed
	const guard = pi.handlers.tool_call[0];
	const blocked = await guard({ toolName: "write", input: { path: path.join(repo, "src", "x.ts") } }, ctx);
	assert.ok(blocked?.block, "out-of-stage write must be blocked at plan stage");
	const ok = await guard({ toolName: "write", input: { path: path.join(repo, ".dev-flow", "demo-feature", "plan", "plan.md") } }, ctx);
	assert.equal(ok, undefined);

	// main protection: a commit on main is always blocked
	const bash = await guard({ toolName: "bash", input: { command: "git commit -m x" } }, ctx);
	assert.ok(bash?.block, "commit on main must be blocked");
	const stateTamperBlock = await guard({ toolName: "bash", input: { command: "echo x > .dev-flow/demo-feature/state.json" } }, ctx);
	assert.ok(stateTamperBlock?.block, "state tampering must be blocked");

	// approve gate: missing plan file fails before the UI ask (no UI in this test)
	const before = await guard({ toolName: "read", input: {} }, ctx);
	assert.equal(before, undefined, "unrelated tools pass");
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("plan gate FAILED"), "approve refuses without a plan file");

	mkdirSync(path.join(repo, ".dev-flow", "demo-feature", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "demo-feature", "plan", "plan.md"), "# plan\n");
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("requires the operator"), "approve without UI refuses interactively");

	// stage context injection
	const inj = (await pi.handlers.before_agent_start[0]({}, ctx)) as { message?: { content: string } };
	assert.match(inj.message?.content ?? "", /demo-feature — stage: plan/);

	// the model-facing tool routes through the same runner
	const res = await pi.tools.flow.execute("id", { args: ["status"] }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /demo-feature/);
});

test("extension is pass-through without .dev-flow", async () => {
	const pi = makePi();
	const ctx = makeCtx(mkdtempSync(path.join(tmpdir(), "noflow-")));
	const r = await pi.handlers.tool_call[0]({ toolName: "write", input: { path: "anything.ts" } }, ctx);
	assert.equal(r, undefined);
});
