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
	let cmdCtx: { notices?: string[] } | undefined; // last command's ctx — sendMessage output lands in its notices
	const api = {
		registerCommand: (n: string, o: unknown) => {
			const cmd = o as { handler: (a: string, c: unknown) => Promise<void> };
			stub.cmds[n] = {
				handler: async (a: string, c: unknown) => {
					cmdCtx = c as { notices?: string[] };
					await cmd.handler(a, c);
				},
			} as never;
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
		sendMessage: (m: { content: string }) => {
			if (cmdCtx) (cmdCtx.notices ??= []).push(m.content);
		},
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
	assert.ok(ctx.notices.at(-1)?.includes("needs the operator"), "approve without an operator answer refuses");

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
	// per-segment attribution: a chain spanning directories must not inherit one verdict (the release-blocker bug)
	assert.equal(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(wt)} && git commit -m x && cd ${JSON.stringify(repo)} && git pull` } }, ctx), undefined, "commit judged in the worktree even when the chain later cds to main");
	assert.ok(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(repo)} && git log && cd ${JSON.stringify(repo)} && git commit -m x` } }, ctx), "commit after cd back to main checkout is blocked");
	assert.ok(await guard({ toolName: "bash", input: { command: `git -C ${JSON.stringify(repo)} checkout -b feat/sneaky` } }, ctx), "checkout -b of a feature branch in the main checkout is blocked");
});

test("init keeps an existing project.md; --force rewrites from fresh detection", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const mdFile = path.join(repo, ".dev-flow", "project.md");
	await pi.cmds.flow.handler("init", ctx);
	writeFileSync(mdFile, "# dev-flow\n\n## implement\n\n```flow\ntest = custom-cmd\n```\n");
	await pi.cmds.flow.handler("init", ctx);
	assert.match(readFileSync(mdFile, "utf8"), /custom-cmd/, "a second init must keep operator config");
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

test("first init writes immediately even in a TUI — no editor or confirm gate", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, mode: "tui", notices: [] as string[], ui: { notify: (_m: string) => {}, setStatus: (_k: string, _t?: string) => {}, confirm: async () => { dialogs++; return true; }, editor: async () => { dialogs++; return undefined; } } };
	await pi.cmds.flow.handler("init", ctx);
	assert.equal(dialogs, 0, "first init must not ask before writing");
	assert.match(readFileSync(path.join(repo, ".dev-flow", "project.md"), "utf8"), /## implement/, "draft lands on disk directly");
});

test("flow-by-default: unbound writes blocked; start needs default branch; feature checkouts stay in worktrees", async () => {
	const pi = makePi();
	const repo = makeRepo(); // on main, no features
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const edit = () => pi.handlers.tool_call[0]({ toolName: "edit", input: { path: "src/app.ts" } }, ctx);
	assert.match((await edit())?.reason ?? "", /no active flow/, "clean repo still requires a flow");
	const r1 = await flow(["start", "x"]);
	assert.ok(!r1.isError, "start on main works");
	execFileSync("git", ["-C", repo, "checkout", "-qb", "work/two"]);
	assert.match((await flow(["start", "y"])).content[0].text, /not main/, "start refuses off the default branch");
	execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
	const chk = await pi.handlers.tool_call[0]({ toolName: "bash", input: { command: "git checkout feat/z" } }, ctx);
	assert.match(chk?.reason ?? "", /worktree/, "feature branches stay out of the main checkout");
});

test("feature-branch checkout allowed inside its own worktree", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const wt = path.join(repo, ".wt", "z");
	execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feat/z", wt]);
	const st = { slug: "z", stage: "implement", ui: false, branch: "feat/z", worktree: ".wt/z", approvals: {}, checks: {} };
	mkdirSync(path.join(repo, ".dev-flow", "z"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "project.json"), JSON.stringify({ defaultBranch: "main", worktreeDir: ".wt" }));
	writeFileSync(path.join(repo, ".dev-flow", "z", "state.json"), JSON.stringify(st));
	const ctx = { cwd: wt, hasUI: false, notices: [] as string[], ui: { notify: () => {} } };
	const res = await pi.handlers.tool_call[0]({ toolName: "bash", input: { command: "git checkout feat/z" } }, ctx);
	assert.equal(res, undefined, "checkout inside the owning worktree passes");
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
	await pi.cmds.flow.handler("use nope", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("no unfinished feature"), "use validates slug");
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("plan gate FAILED"), "bound gate runs on the bound feature (b-two)");
	await pi.cmds.flow.handler("abort b-two", ctx);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "b-two")), "plan-stage abort drops the feature entirely");
	await pi.cmds.flow.handler("approve", ctx);
	assert.ok(ctx.notices.at(-1)?.includes("plan gate FAILED"), "lone remaining feature auto-binds and hits its gate");
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

test("flow version: the plugin's own version, and no .dev-flow/ needed", async () => {
	const pi = makePi();
	const ctx = makeCtx(mkdtempSync(path.join(tmpdir(), "noflow-")));
	const own = (JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
	const r = await pi.tools.flow.execute("id", { args: ["version"] }, undefined, undefined, ctx) as { content: [{ text: string }]; isError?: boolean };
	assert.ok(!r.isError, "version answers in a repo with no flow");
	assert.match(r.content[0].text, new RegExp(`^dev-flow ${own.split(".").join("\\.")} \\(pi-dev-flow at `));
	await pi.cmds.flow.handler("version", ctx); // same answer through /flow
	assert.match(ctx.notices.at(-1) ?? "", new RegExp(`dev-flow ${own.split(".").join("\\.")}`));
});

test("extension is pass-through without .dev-flow", async () => {
	const pi = makePi();
	const ctx = makeCtx(mkdtempSync(path.join(tmpdir(), "noflow-")));
	const r = await pi.handlers.tool_call[0]({ toolName: "write", input: { path: "anything.ts" } }, ctx);
	assert.equal(r, undefined);
});

test("ref-aware push guard end-to-end: tags pass from main, default branch refused", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	const ctx = makeCtx(repo);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "tag", "v9.9.9"]);
	const bash = (command: string) => pi.handlers.tool_call[0]({ toolName: "bash", input: { command } }, ctx);
	assert.equal(await bash("git push origin v9.9.9"), undefined, "tag name resolves to refs/tags — stage-free");
	assert.match((await bash("git push origin main"))?.reason ?? "", /requires stage "release"/);
	assert.equal(await bash("git push origin main:refs/heads/main-backup"), undefined, "explicit non-default dest passes");
});

test("doctor reflect: section by wording, listing, check-off semantics, status surfacing", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init"]);
	await flow(["start", "rfeat"]);
	await flow(["doctor", "reflect", "test", "cmd", "is", "stale"]);
	const r2 = await flow(["doctor", "reflect", "ui", "panels", "are", "ugly", "in", "the", "plugin"]);
	assert.match(r2.content[0].text, /reflected \(plugin\): - \[ \] ui panels are ugly in the plugin — rfeat \d{4}-\d{2}-\d{2}/);
	const reflFile = path.join(repo, ".dev-flow", "reflections.md");
	assert.match(readFileSync(reflFile, "utf8"), /## playbook\n\n- \[ \] test cmd is stale — rfeat \d{4}-\d{2}-\d{2}/);
	const listed = await flow(["doctor", "reflect"]);
	assert.match(listed.content[0].text, /1\. - \[ \] test cmd is stale/);
	writeFileSync(reflFile, readFileSync(reflFile, "utf8") + "- [x] already handled\n");
	const listed2 = await flow(["doctor", "reflect"]);
	assert.ok(!listed2.content[0].text.includes("handled"), "checked-off items are not open");
	const st = await flow(["status"]);
	assert.match(st.content[0].text, /↻ 2 reflection\(s\) open/);
});

test("checkpoint contract: --confirmed walks every gate with zero dialogs", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => { dialogs++; return false; }, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init"]);
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\ndev = touch dev-up\n```\n\n- [ ] operator item\n- [ ] (ui) mockup item\n"]);
	await flow(["start", "ck"]);
	mkdirSync(path.join(repo, ".dev-flow", "ck", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "ck", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved \(confirmed by operator instruction\)/);
	await flow(["check"]);
	const v = await flow(["verify", "--confirmed"]);
	assert.match(v.content[0].text, /verified \(confirmed by operator instruction\) — entering pre-release/);
	assert.equal(dialogs, 0, "operator answered in chat — gates must not ask again");
	const st = JSON.parse(readFileSync(path.join(repo, ".dev-flow", "ck", "state.json"), "utf8"));
	assert.ok(st.checks.dev?.ok, "dev deploy ran and recorded before verification");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "ck", "worktree", "dev-up")), "dev deploy ran in the worktree");
	// ui-only item stayed out of the non-UI feature's hash: implement confirm hashed exactly 1 item
	assert.equal(st.confirmations.implement.hash.length, 12);
	const cwt = path.join(repo, ".dev-flow", "ck", "worktree");
	execFileSync("git", ["-C", cwt, "add", "-A"]);
	execFileSync("git", ["-C", cwt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "dev artifact"]);
	execFileSync("git", ["-C", repo, "merge", "-q", "--ff", "feat/ck"]); // simulate the merge landing on main
	assert.match((await flow(["release", "--confirmed"])).content[0].text, /release approved/);
	const rd = await flow(["release-done", "--confirmed"]); // flag still accepted, as a no-op — release-done asks nothing
	assert.match(rd.content[0].text, /release recorded as complete/);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "ck", "state.json")), "release-done records the release; closing out is finish's job");
	const fin = await flow(["finish", "--confirmed"]);
	assert.match(fin.content[0].text, /feature ck done — worktree and branch feat\/ck removed/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "ck")), "feature dir gone after finish");
	assert.equal(dialogs, 0, "still zero dialogs at the end");
});

test("release tail: finish refuses to remove a dirty worktree", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	await flow(["start", "dirt"]);
	mkdirSync(path.join(repo, ".dev-flow", "dirt", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "dirt", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	await flow(["verify", "--confirmed"]);
	writeFileSync(path.join(repo, ".dev-flow", "dirt", "worktree", "loose.txt"), "uncommitted\n");
	await flow(["release", "--confirmed"]);
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /release recorded as complete/, "release-done records the release even when the worktree is dirty");
	const fin = await flow(["finish", "--confirmed"]);
	assert.ok(fin.isError && fin.content[0].text.includes("uncommitted"), "finish reports why it refuses");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "dirt", "state.json")), "feature stays until the operator sorts it out");
});

test("finish closes a released feature only: refuses early, then removes worktree, branch and state", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	await flow(["start", "fin"]);
	mkdirSync(path.join(repo, ".dev-flow", "fin", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "fin", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	await flow(["verify", "--confirmed"]);
	const early = await flow(["finish"]);
	assert.ok(early.isError && early.content[0].text.includes("release-done"), "finish refuses until the release is recorded");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "fin", "state.json")), "a refused finish removes nothing");
	await flow(["release", "--confirmed"]);
	await flow(["release-done", "--confirmed"]);
	assert.match((await flow(["finish", "--confirmed"])).content[0].text, /feature fin done — worktree and branch feat\/fin removed/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "fin")), "the flow state folder is gone");
	assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "feat/fin"]));
});

test("release opt-out: per-release flag and per-project config skip the GitHub release", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const versioned = async (slug: string, ver: string, mdTail: string) => {
		await flow(["init", "--write", `# dev-flow\n\n## release\n\n\`\`\`flow\nversionFile = package.json\nversionTag = v{version}\n${mdTail}\`\`\`\n`]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		await flow(["verify", "--confirmed"]);
		const wt = path.join(repo, ".dev-flow", slug, "worktree");
		writeFileSync(path.join(wt, "package.json"), `{"name":"t","version":"${ver}"}`); // pre-release bump lives on the branch
		execFileSync("git", ["-C", wt, "add", "-A"]);
		execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `bump ${ver}`]);
		assert.match((await flow(["release", "--confirmed"])).content[0].text, /release approved/);
		execFileSync("git", ["-C", repo, "merge", "-q", "--ff", `feat/${slug}`]);
		execFileSync("git", ["-C", repo, "tag", `v${ver}`]);
	};
	await versioned("optflag", "9.9.9", "");
	const f = await flow(["release-done", "--confirmed", "--no-github-release"]);
	assert.match(f.content[0].text, /GitHub release skipped \(--no-github-release\)/);
	assert.match(f.content[0].text, /release recorded as complete/);
	await versioned("optcfg", "9.9.8", "github = false\n");
	const c = await flow(["release-done", "--confirmed"]);
	assert.ok(!c.content[0].text.includes("GitHub release"), "config-off: no attempt, no note");
	assert.match(c.content[0].text, /release recorded as complete/);
});

test("release-teeth: tag must reach origin; release.artifact verifies the published artifact", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const origin = mkdtempSync(path.join(tmpdir(), "devflow-origin-"));
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## release\n\n\`\`\`flow\nversionFile = package.json\nversionTag = v{version}\nartifact = test -f published.txt\n\`\`\`\n"]);
	await flow(["start", "teeth"]);
	mkdirSync(path.join(repo, ".dev-flow", "teeth", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "teeth", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	await flow(["verify", "--confirmed"]);
	const wt = path.join(repo, ".dev-flow", "teeth", "worktree");
	writeFileSync(path.join(wt, "package.json"), '{"name":"t","version":"9.9.9"}'); // the bump lives on the branch
	execFileSync("git", ["-C", wt, "add", "-A"]);
	execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump 9.9.9"]);
	await flow(["release", "--confirmed"]);
	execFileSync("git", ["-C", repo, "merge", "-q", "--ff", "feat/teeth"]);
	execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);
	execFileSync("git", ["-C", repo, "tag", "v9.9.9"]);
	const local = await flow(["release-done", "--confirmed", "--no-artifact-check"]);
	assert.match(local.content[0].text, /local-only/, "a tag that never left the laptop is not a release");
	execFileSync("git", ["-C", repo, "push", "-q", "origin", "v9.9.9"]);
	const noart = await flow(["release-done", "--confirmed"]);
	assert.ok(noart.isError && noart.content[0].text.includes("artifact not published"), "release.artifact gates the published artifact");
	writeFileSync(path.join(repo, "published.txt"), "sha256:deadbeef\n");
	const okRun = await flow(["release-done", "--confirmed"]);
	assert.match(okRun.content[0].text, /Artifact verified\./);
	assert.match(okRun.content[0].text, /release recorded as complete/);
});

test("abort at plan stage drops the feature; approved features keep recoverable state", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	await flow(["start", "ghost"]);
	assert.match((await flow(["abort", "ghost"])).content[0].text, /feature removed/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "ghost")), "plan-stage abort leaves no ghost for auto-bind");
	await flow(["start", "keeper"]);
	mkdirSync(path.join(repo, ".dev-flow", "keeper", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "keeper", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	const ab = await flow(["abort", "keeper"]);
	assert.match(ab.content[0].text, /state stays at .dev-flow\/keeper/);
	assert.match(ab.content[0].text, /git worktree remove/);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "keeper", "state.json")), "real work stays recoverable");
});

test("patch feature: no plan file, same gates end to end", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	assert.match((await flow(["start", "ungranted", "--patch"])).content[0].text, /operator-granted/, "--patch without the operator's chat grant is refused");
	assert.match((await flow(["start", "ungranted", "--patch", "--docs", "--confirmed"])).content[0].text, /exclusive/, "modes are mutually exclusive");
	await flow(["start", "chore", "--patch", "--confirmed"]);
	const noPlan = await flow(["approve"]);
	assert.ok(!noPlan.content[0].text.includes("plan gate FAILED"), "patch does not require plan/*.md");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved/);
	await flow(["check"]);
	assert.match((await flow(["verify", "--confirmed"])).content[0].text, /entering pre-release/);
	await flow(["release", "--confirmed"]);
	assert.match((await flow(["release-done"])).content[0].text, /release recorded as complete/, "release-done is check-only — asks the operator nothing");
	assert.match((await flow(["finish", "--confirmed"])).content[0].text, /feature chore done/);
});

test("docs feature: no plan file, no tier-1 checks, full release end to end", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	assert.match((await flow(["start", "readme-typo", "--docs"])).content[0].text, /operator-granted/, "--docs without the operator's chat grant is refused");
	assert.match((await flow(["start", "readme-typo", "--docs", "--confirmed"])).content[0].text, /docs/, "docs mode announced at start");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved/, "docs approves with no plan file written");
	assert.match((await flow(["verify", "--confirmed"])).content[0].text, /entering pre-release/, "docs verify passes with no flow check run");
	await flow(["release", "--confirmed"]);
	assert.match((await flow(["release-done"])).content[0].text, /release recorded as complete/);
	assert.match((await flow(["finish", "--confirmed"])).content[0].text, /feature readme-typo done/);
});

test("flow init --draft prints content and writes nothing", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const d = await flow(["init", "--draft"]);
	assert.match(d.content[0].text, /defaultBranch/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "project.md")), "--draft must not write");
});

test("first init writes project.md immediately and hands it over for review", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const r = (await pi.tools.flow.execute("id", { args: ["init"] }, undefined, undefined, ctx)) as { content: [{ text: string }] };
	const text = r.content[0].text;
	assert.ok(existsSync(path.join(repo, ".dev-flow", "project.md")), "file written without any dialog");
	assert.match(text, /wrote \.dev-flow\/project\.md from detection/);
	assert.match(text, /confirm as-is, or edit it/);
});

test("init finds ghost feature dirs and removes them only on the operator's word", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const noUI = makeCtx(repo);
	await pi.cmds.flow.handler("init", noUI);
	mkdirSync(path.join(repo, ".dev-flow", "closed", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "closed", "plan", "plan.md"), "# old plan\n");
	mkdirSync(path.join(repo, ".dev-flow", "live"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "live", "state.json"), '{"slug":"live","stage":"implement","ui":false,"branch":"","worktree":"","createdAt":"","approvals":{},"checks":{}}');

	await pi.cmds.flow.handler("init", noUI);
	assert.match(noUI.notices.at(-1) ?? "", /1 ghost feature dir\(s\).*closed/, "reported when no operator is present");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "closed")), "nothing is deleted without a confirmation");

	const declined = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => declined.notices.push(m), confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	await pi.cmds.flow.handler("init", declined);
	assert.match(declined.notices.at(-1) ?? "", /kept 1 ghost feature dir/);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "closed")), "a declined offer deletes nothing");

	const agreed = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => agreed.notices.push(m), confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	await pi.cmds.flow.handler("init", agreed);
	assert.match(agreed.notices.at(-1) ?? "", /removed 1 ghost feature dir\(s\): closed/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "closed")), "the ghost is gone on the operator's yes");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "live", "state.json")), "a live feature is never a ghost");
});

const GUARD_MD = ["# dev-flow", "", "## global", "", "```flow-guard", "deny    \\bgit\\b[^]*--force(?!\\w)      :: history stays linear", "deny    \\bgit\\b[^]*\\bworktree\\s+prune\\b :: prunes other sessions' worktrees", "confirm \\bdocker\\b[^]*\\bcompose\\b[^]*\\brestart\\b :: drops the upstream connection", "protect docker/.env                     :: gitignored live secrets", "forbid  docker/secrets                  :: gitignored secret storage", "```", "", "## implement", "", "```flow", "test = node --version", "```", ""].join("\n");

test("flow-guard wiring: deny blocks with the operator's reason, confirm needs a live operator", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", GUARD_MD]);
	await flow(["start", "gf"]);
	const guard = pi.handlers.tool_call[0];
	const bash = (command: string) => guard({ toolName: "bash", input: { command } }, ctx);
	assert.match((await bash("git push --force-with-lease origin feat/x"))?.reason ?? "", /history stays linear/);
	assert.match((await bash("docker compose restart app"))?.reason ?? "", /needs an operator confirmation/, "without UI a confirm rule is a block, never a silent pass");
	assert.equal(await bash("git push origin feat/x"), undefined, "commands no rule matches pass");
	assert.match((await bash("git worktree prune"))?.reason ?? "", /prunes other sessions/, "project deny rules apply in every stage and binding");
	assert.match((await guard({ toolName: "write", input: { path: path.join(repo, "docker", "secrets", "new-key.pem") } }, ctx))?.reason ?? "", /gitignored secret storage/, "forbid covers a path that does not exist yet");
	assert.match((await guard({ toolName: "edit", input: { path: path.join(repo, "docker", ".env") } }, ctx))?.reason ?? "", /gitignored live secrets/, "protect without UI is a block");

	const declined = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false } };
	assert.match((await guard({ toolName: "bash", input: { command: "docker compose restart app" } }, declined))?.reason ?? "", /operator declined/);
	const approved = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => true } };
	assert.equal(await guard({ toolName: "bash", input: { command: "docker compose restart app" } }, approved), undefined, "an operator OK lets a confirm rule through");
	assert.match((await guard({ toolName: "edit", input: { path: path.join(repo, "docker", ".env") } }, approved))?.reason ?? "", /in plan/, "the operator OK clears the project rule; flow discipline still confines the write");
});

test("approve runs commands.setup in the fresh worktree; a failing setup fails the gate", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\nsetup = touch setup-ran\ntest = node --version\n```\n"]);
	await flow(["start", "su"]);
	mkdirSync(path.join(repo, ".dev-flow", "su", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "su", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /setup ran in the worktree/);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "su", "worktree", "setup-ran")), "setup ran inside the worktree, not the checkout");

	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\nsetup = exit 1\ntest = node --version\n```\n"]);
	await flow(["start", "sub"]);
	mkdirSync(path.join(repo, ".dev-flow", "sub", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "sub", "plan", "plan.md"), "# plan\n");
	const bad = await flow(["approve", "--confirmed"]);
	assert.ok(bad.isError && bad.content[0].text.includes("setup failed"), "a broken worktree must not be approved as ready");
});

test("init doctor refuses a refresh that would drop hand-written project.md", async () => {
	const pi = makePi();
	const repo = makeRepo();
	// confirm always answers yes: the point is that the refresh cannot be talked into destroying anything
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => ctx.notices.push(m), confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const mdFile = path.join(repo, ".dev-flow", "project.md");
	const hand = ["# dev-flow", "", "## global", "", "Only ship from a green main.", "", "## implement", "", "```flow", "test = node --version", "```", "", "```flow-check overflow", "node scripts/check-overflow.mjs", "```", "", "## release", "", "```flow", "versionFile = package.json", "versionTag = {version}", "```", ""].join("\n");
	await pi.cmds.flow.handler("init", ctx);
	writeFileSync(mdFile, hand);
	await pi.cmds.flow.handler("init", ctx);
	assert.match(ctx.notices.at(-1) ?? "", /refresh refused/, "doctor must not overwrite a hand-written playbook");
	assert.match(ctx.notices.at(-1) ?? "", /Only ship from a green main/, "it names what a draft cannot reproduce");
	const after = readFileSync(mdFile, "utf8");
	assert.match(after, /Only ship from a green main/, "tier-3 prose survives");
	assert.match(after, /versionTag = \{version\}/, "a hand-set tag pattern survives");
	assert.match(after, /flow-check overflow/, "hand-written checks survive");
});

const TEST_MD = "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\n```\n";

test("flow doctor: findings without writing, deleting or asking", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => ctx.notices.push(m), confirm: async () => { dialogs++; return true; }, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", TEST_MD]);
	mkdirSync(path.join(repo, ".dev-flow", "ghosty", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "ghosty", "plan", "plan.md"), "# old plan\n");
	const d = await flow(["doctor"]);
	assert.match(d.content[0].text, /doctor: 1 finding\(s\)/);
	assert.match(d.content[0].text, /\.dev-flow\/ghosty has a plan\/ but no state\.json/);
	assert.equal(dialogs, 0, "the doctor never asks — it only reports");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "ghosty")), "and it never deletes — that stays flow init's job");
	assert.ok(!d.isError, "findings are advisory, not a failure");
	execFileSync("rm", ["-rf", path.join(repo, ".dev-flow", "ghosty")]);
	assert.match((await flow(["doctor"])).content[0].text, /doctor: no findings/, "a clean repo gets the no-findings line");
});

test("flow init without a UI prints the findings; flow status reports them even with no features", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }] }>;
	await flow(["init", "--write", TEST_MD]);
	writeFileSync(path.join(repo, ".dev-flow", "project.json"), JSON.stringify({ defaultBranch: "main" }));
	await pi.cmds.flow.handler("init", ctx); // the no-UI path: no dialogs, findings printed
	assert.match(ctx.notices.at(-1) ?? "", /doctor: 1 finding\(s\):/);
	assert.match(ctx.notices.at(-1) ?? "", /both project\.json and project\.md exist/);
	const st = await flow(["status"]);
	assert.match(st.content[0].text, /no features/);
	assert.match(st.content[0].text, /⚠ doctor: 1 finding\(s\) — run flow doctor/);
});

test("flow doctor: a feature's own branch (checked out in its worktree) is not an orphan", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: (m: string) => ctx.notices.push(m), confirm: async () => true, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }] }>;
	await flow(["init", "--write", TEST_MD]);
	await flow(["start", "orphan-bait"]);
	mkdirSync(path.join(repo, ".dev-flow", "orphan-bait", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "orphan-bait", "plan", "plan.md"), "# plan\n");
	await flow(["approve"]); // worktree + branch feat/orphan-bait; git branch --list marks it "+ " — the marker must be stripped
	const d = await flow(["doctor"]);
	assert.ok(!/orphan branch/.test(d.content[0].text), `the active feature's own branch must not be flagged:\n${d.content[0].text}`);
	assert.ok(!d.content[0].text.includes("+ "), "branch names print without git's column markers");
});

test("pre-release stage: verify lands there, release gate has teeth, finish asks Finish?", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo); // no UI: every checkpoint must demand an operator answer or --confirmed
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const stage = () => (JSON.parse(readFileSync(path.join(repo, ".dev-flow", "rel", "state.json"), "utf8")) as { stage: string }).stage;
	await flow(["init", "--write", TEST_MD]);
	await flow(["start", "rel"]);
	mkdirSync(path.join(repo, ".dev-flow", "rel", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "rel", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	assert.equal(stage(), "implement");
	await flow(["check"]);
	await flow(["verify", "--confirmed"]);
	assert.equal(stage(), "pre-release", "verify now lands in pre-release");
	// a guarded prep edit in the worktree must invalidate the checks again — the release gate re-demands them
	const guard = pi.handlers.tool_call[0];
	assert.equal(await guard({ toolName: "write", input: { path: path.join(repo, ".dev-flow", "rel", "worktree", "CHANGELOG.md") } }, ctx), undefined);
	writeFileSync(path.join(repo, ".dev-flow", "rel", "worktree", "CHANGELOG.md"), "## 0.0.1\n");
	const early = await flow(["release", "--confirmed"]);
	assert.ok(early.isError && /check "test" has not passed/.test(early.content[0].text), "release gate demands re-greened checks after prep edits");
	execFileSync("git", ["-C", path.join(repo, ".dev-flow", "rel", "worktree"), "add", "-A"]);
	execFileSync("git", ["-C", path.join(repo, ".dev-flow", "rel", "worktree"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "changelog"]);
	await flow(["check"]);
	const noOp = await flow(["release"]);
	assert.ok(noOp.isError && /needs the operator/.test(noOp.content[0].text), "Release? needs an operator answer");
	assert.equal(stage(), "pre-release");
	await flow(["release", "--confirmed"]);
	assert.equal(stage(), "release");
	const earlyFinish = await flow(["finish", "--confirmed"]);
	assert.ok(earlyFinish.isError && /release-done/.test(earlyFinish.content[0].text), "finish refuses before the release is recorded");
	await flow(["release-done", "--confirmed"]);
	const finishNoAsk = await flow(["finish"]);
	assert.ok(finishNoAsk.isError && /Finish\?/.test(finishNoAsk.content[0].text), "finish asks the operator first");
	const fin = await flow(["finish", "--confirmed"]);
	assert.match(fin.content[0].text, /done/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "rel")), "feature directory removed on finish");
});

test("a live foreign claim refuses auto-bind; flow use takes over explicitly", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const session = (id: string) => ({ ...makeCtx(repo), sessionManager: { getSessionId: () => id, getBranch: () => [] as never[] } });
	const a = session("sess-A");
	await pi.cmds.flow.handler("init", a);
	await pi.cmds.flow.handler("start claim-feature", a);
	const claimOf = () => JSON.parse(readFileSync(path.join(repo, ".dev-flow", "claim-feature", "claim.json"), "utf8")) as { key: string };
	assert.equal(claimOf().key, "sess-A", "start binds and claims the feature");

	// a second live session on the same repo must not auto-bind onto it
	const b = session("sess-B");
	const injB = (await pi.handlers.before_agent_start[0]({}, b)) as { message?: { content: string } };
	assert.match(injB.message?.content ?? "", /no flow bound/, "a foreign live claim refuses the auto-bind");
	assert.match(injB.message?.content ?? "", /claim-feature is claimed by another live session/, "the unbound context names the blocked feature");

	// explicit use succeeds and says it took over from a live holder
	await pi.cmds.flow.handler("use claim-feature", b);
	assert.ok(b.notices.at(-1)?.includes("taken over from live session"), "takeover from the live holder is stated");
	assert.equal(claimOf().key, "sess-B", "the claim moves to the taking-over session");
	const injB2 = (await pi.handlers.before_agent_start[0]({}, b)) as { message?: { content: string } };
	assert.match(injB2.message?.content ?? "", /bound to: claim-feature/, "after the takeover B is bound");
});

test("finish deletes merged feature branches on origin and keeps unverifiable ones", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const origin = mkdtempSync(path.join(tmpdir(), "devflow-origin-"));
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const remoteHas = (br: string) => execFileSync("git", ["ls-remote", "--heads", origin, `refs/heads/${br}`], { encoding: "utf8" }).trim() !== "";
	const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
	await flow(["init", "--write", "# dev-flow\n"]);
	git("push", "-q", "origin", "main");
	const cycle = async (slug: string) => {
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		await flow(["verify", "--confirmed"]);
		await flow(["release", "--confirmed"]);
		await flow(["release-done", "--confirmed"]);
	};
	// (a) the origin branch is contained in origin/main (merge-commit shape) -> finish deletes it
	await cycle("gone");
	git("push", "-q", "origin", "feat/gone");
	const gone = await flow(["finish", "--confirmed"]);
	assert.match(gone.content[0].text, /origin\/feat\/gone deleted \(verified merged\)/);
	assert.ok(!remoteHas("feat/gone"), "the released branch is gone from origin too");
	// (b) origin branch is ahead of origin/main (squash shape) and origin is not GitHub -> unverifiable, keep
	await cycle("kept");
	const wt = path.join(repo, ".dev-flow", "kept", "worktree");
	writeFileSync(path.join(wt, "x.txt"), "feature work\n");
	execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
	execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
	git("push", "-q", "origin", "feat/kept");
	const kept = await flow(["finish", "--confirmed"]);
	assert.match(kept.content[0].text, /origin\/feat\/kept kept — merged state not verifiable/, "an unverifiable branch is never deleted");
	assert.ok(remoteHas("feat/kept"), "the branch survives for the operator to judge");
});

test("flow help: usage answers everywhere, even with no .dev-flow/", async () => {
	const pi = makePi();
	const ctx = makeCtx(mkdtempSync(path.join(tmpdir(), "noflow-")));
	for (const args of [["help"], ["--help"], ["-h"]]) {
		const r = (await pi.tools.flow.execute("id", { args }, undefined, undefined, ctx)) as { content: [{ text: string }]; isError?: boolean };
		assert.ok(!r.isError, `flow ${args[0]} answers in a repo without .dev-flow/`);
		assert.match(r.content[0].text, /^usage: flow <sub> — help \| init/);
		assert.match(r.content[0].text, /approve \[--yolo\]/);
		assert.match(r.content[0].text, /release \[--no-version\]/);
	}
});

test("flow start prints the plugin version and stamps it into the feature state", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const own = (JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
	await pi.cmds.flow.handler("init", ctx);
	await pi.cmds.flow.handler("start stamped", ctx);
	assert.match(ctx.notices.at(-1) ?? "", new RegExp(`dev-flow ${own.split(".").join("\\.")}`), "start names the dev-flow build");
	const st = JSON.parse(readFileSync(path.join(repo, ".dev-flow", "stamped", "state.json"), "utf8"));
	assert.equal(st.flowVersion, own, "state.json carries the stamp");
	const s = await pi.tools.flow.execute("id", { args: ["status"] }, undefined, undefined, ctx) as { content: [{ text: string }] };
	assert.match(s.content[0].text, new RegExp(`flow=${own.split(".").join("\\.")}`), "status shows it per feature");
});

test("yolo: approve --yolo pre-confirms every later gate question, checks still enforced", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => { dialogs++; return false; }, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = exit 1\n```\n"]);
	await flow(["start", "yo"]);
	mkdirSync(path.join(repo, ".dev-flow", "yo", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "yo", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--yolo", "--confirmed"])).content[0].text, /yolo: later gate questions pre-confirmed/);
	// a failing check still blocks verify — yolo pre-confirms questions, not checks
	await flow(["check"]);
	const v = await flow(["verify"]);
	assert.ok(v.isError && /check "test" has not passed/.test(v.content[0].text), "yolo never bypasses tier-1 checks");
	await flow(["init", "--write", "# dev-flow\n"]);
	await flow(["check"]);
	assert.match((await flow(["verify"])).content[0].text, /verified \(yolo: pre-confirmed\) — entering pre-release/);
	await flow(["release"]);
	await flow(["release-done"]);
	assert.match((await flow(["finish"])).content[0].text, /feature yo done — worktree and branch feat\/yo removed/);
	assert.equal(dialogs, 0, "yolo answered every checkpoint up front — gates must not ask");
});

test("unversioned release: --no-version skips the bump/tag machinery for that flow", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## release\n\n```flow\nversionFile = package.json\nversionTag = v{version}\n```\n"]);
	await flow(["start", "nv"]);
	mkdirSync(path.join(repo, ".dev-flow", "nv", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "nv", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	await flow(["verify", "--confirmed"]);
	// default stays versioned: no manifest in the worktree → the gate refuses
	const versioned = await flow(["release", "--confirmed"]);
	assert.ok(versioned.isError && /no parsable version/.test(versioned.content[0].text), "default release still demands the version bump");
	const r = await flow(["release", "--no-version", "--confirmed"]);
	assert.match(r.content[0].text, /unversioned: this flow creates no version bump or tag/);
	const st = JSON.parse(readFileSync(path.join(repo, ".dev-flow", "nv", "state.json"), "utf8"));
	assert.equal(st.noVersion, true, "the mode is persisted for release-done");
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /release recorded as complete \(unversioned — this flow created no version or tag\)/);
});
