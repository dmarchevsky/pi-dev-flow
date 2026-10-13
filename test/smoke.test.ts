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
		registerShortcut: () => {},
		appendEntry: () => {},
	};
	devFlow(api as never);
	return stub as never;
}

function makeRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "devflow-"));
	execFileSync("git", ["init", "-b", "main", dir]);
	writeFileSync(path.join(dir, "README.md"), "# scratch\n");
	const id = ["-c", "user.email=t@t", "-c", "user.name=t"];
	execFileSync("git", ["-C", dir, ...id, "add", "-A"]);
	execFileSync("git", ["-C", dir, ...id, "commit", "-qm", "init"]);
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
	assert.equal(readFileSync(path.join(repo, ".dev-flow", ".gitignore"), "utf8").trim(), "*", "self-ignoring .dev-flow/");
	execFileSync("git", ["-C", repo, "check-ignore", "-q", ".dev-flow/whatever/file.txt"]); // throws when not ignored
	assert.ok(readFileSync(path.join(repo, ".dev-flow", "project.md"), "utf8").includes("## global"), "init drafted project.md");
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n<!-- kept -->\n");
	await pi.cmds.flow.handler("init", ctx);
	assert.ok(readFileSync(path.join(repo, ".dev-flow", "project.md"), "utf8").includes("kept"), "re-init must not overwrite operator config");

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

test("worktree isolation: commit guards follow the command's directory", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => ctx.notices.push(m), confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	await pi.cmds.flow.handler("init", ctx);
	await pi.cmds.flow.handler("start wt-feature", ctx);
	mkdirSync(path.join(repo, ".dev-flow", "wt-feature", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "wt-feature", "plan", "plan.md"), "# plan\n");
	await pi.cmds.flow.handler("approve", ctx); // creates the worktree (branch feat/wt-feature)
	const guard = pi.handlers.tool_call[0];
	// commit at the session root (main checkout on main) stays blocked
	assert.ok(await guard({ toolName: "bash", input: { command: "git commit -m x" } }, ctx), "commit on main must be blocked");
	// commit inside the feature worktree passes however the command gets there
	const wt = path.join(repo, ".dev-flow", "wt-feature", "worktree");
	assert.equal(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(wt)} && git commit -m x` } }, ctx), undefined, "worktree commit via cd must pass");
	assert.equal(await guard({ toolName: "bash", input: { command: `git -C ${JSON.stringify(wt)} commit -m x` } }, ctx), undefined, "worktree commit via -C must pass");
	// reads are never misguarded
	assert.equal(await guard({ toolName: "bash", input: { command: "cat .git/hooks/pre-commit" } }, ctx), undefined, "reading the hook is not a commit");
	assert.equal(await guard({ toolName: "bash", input: { command: "git log --oneline" } }, ctx), undefined, "git log is not a commit");
});

test("init --yes keeps existing project.md; --force rewrites from fresh detection", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const mdFile = path.join(repo, ".dev-flow", "project.md");
	await pi.cmds.flow.handler("init", ctx);
	writeFileSync(mdFile, "# dev-flow\n\n## implement\n\n```flow\ntest = custom-cmd\n```\n");
	await pi.cmds.flow.handler("init --yes", ctx);
	assert.match(readFileSync(mdFile, "utf8"), /custom-cmd/, "--yes must keep operator config");
	await pi.cmds.flow.handler("init --force", ctx);
	assert.match(readFileSync(mdFile, "utf8"), /## implement/, "--force writes a full draft");
});

test("init --write stores validated project.md (tool path)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const mdFile = path.join(repo, ".dev-flow", "project.md");
	await pi.cmds.flow.handler("init", ctx);
	const ok = await pi.tools.flow.execute("id", { args: ["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = x\n```\n"] }, undefined, undefined, ctx);
	assert.match(ok.content[0].text, /project.md written/);
	assert.match(readFileSync(mdFile, "utf8"), /test = x/);
	const bad = (await pi.tools.flow.execute("id", { args: ["init", "--write", "## implement\n```flow\nbroken line\n```"] }, undefined, undefined, ctx)) as { content: { text: string }[]; isError?: boolean };
	assert.ok(bad.isError);
	assert.match(bad.content[0].text, /REJECTED/);
	assert.match(readFileSync(mdFile, "utf8"), /test = x/, "rejected write must not touch the file");
});

test("interactive first init reviews the draft in the editor when the client has one", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const seen: string[] = [];
	const ctx = { cwd: repo, hasUI: true, mode: "tui", notices: [] as string[], ui: { notify: (_m: string) => {}, setStatus: (_k: string, _t?: string) => {}, confirm: async () => true, editor: async (_t: string, prefill?: string) => { seen.push(prefill ?? ""); return `${prefill}<!-- operator edited -->\n`; } } };
	await pi.cmds.flow.handler("init", ctx);
	assert.match(seen[0], /## implement/, "draft offered for editing");
	assert.match(readFileSync(path.join(repo, ".dev-flow", "project.md"), "utf8"), /operator edited/, "editor output is what lands on disk");
});

test("session binding: use/abort/ambiguity", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	await pi.cmds.flow.handler("init", ctx);
	await pi.cmds.flow.handler("start a-one", ctx);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", ".current")), "no legacy .current file");
	await pi.cmds.flow.handler("start b-two", ctx); // start binds b-two
	await pi.cmds.flow.handler("use nope", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("no unfinished feature"), "use validates slug");
	await pi.cmds.flow.handler("abort b-two", ctx);
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("multiple unfinished"), "ambiguous without binding must refuse");
	await pi.cmds.flow.handler("use a-one", ctx);
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("plan gate FAILED"), "bound gate runs on the bound feature");
});

test("status bar: compact refresh follows the gates", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const statuses: (string | undefined)[] = [];
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (_m: string) => {}, confirm: async () => true, select: async (_t: string, opts: string[]) => opts.find((o) => o === "keep") ?? opts.find((o) => o === "leave unset") ?? opts.find((o) => o === "(none)") ?? opts[0], input: async () => "", setStatus: (_k: string, t?: string) => statuses.push(t), theme: { fg: (_c: string, s: string) => s } } };
	await pi.cmds.flow.handler("init", ctx);
	await pi.cmds.flow.handler("start demo-feature", ctx);
	assert.equal(statuses.at(-1), "◆ demo-feature ▸ plan");
});

test("extension is pass-through without .dev-flow", async () => {
	const pi = makePi();
	const ctx = makeCtx(mkdtempSync(path.join(tmpdir(), "noflow-")));
	const r = await pi.handlers.tool_call[0]({ toolName: "write", input: { path: "anything.ts" } }, ctx);
	assert.equal(r, undefined);
});
