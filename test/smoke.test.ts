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

test("flow-by-default: unbound writes blocked; operator exempt lifts; start needs default branch; feature checkouts stay in worktrees", async () => {
	const pi = makePi();
	const repo = makeRepo(); // on main, no features
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const edit = () => pi.handlers.tool_call[0]({ toolName: "edit", input: { path: "src/app.ts" } }, ctx);
	assert.match((await edit())?.reason ?? "", /no active flow/, "clean repo still requires a flow");
	await flow(["exempt", "quick", "docs", "fix"]);
	assert.equal(await edit(), undefined, "exemption opens the checkout");
	await flow(["exempt", "off"]);
	assert.match((await edit())?.reason ?? "", /no active flow/, "exemption ends on off");
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

test("reflect queue: append, list, check-off semantics, status surfacing", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--yes"]);
	await flow(["start", "rfeat"]);
	await flow(["reflect", "test", "cmd", "is", "stale"]);
	const r2 = await flow(["reflect", "ui", "panels", "ugly", "--to", "plugin"]);
	assert.match(r2.content[0].text, /\(plugin\) ui panels ugly — rfeat \d{4}-\d{2}-\d{2}/);
	const reflFile = path.join(repo, ".dev-flow", "reflections.md");
	assert.match(readFileSync(reflFile, "utf8"), /- \[ \] \(playbook\) test cmd is stale — rfeat \d{4}-\d{2}-\d{2}/);
	const listed = await flow(["reflect"]);
	assert.match(listed.content[0].text, /1\. \(playbook\) test cmd is stale/);
	writeFileSync(reflFile, readFileSync(reflFile, "utf8") + "- [x] (doctor) already handled\n");
	const listed2 = await flow(["reflect"]);
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
	await flow(["init", "--yes"]);
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\ndev = touch dev-up\n```\n\n- [ ] operator item\n- [ ] (ui) mockup item\n"]);
	await flow(["start", "ck"]);
	mkdirSync(path.join(repo, ".dev-flow", "ck", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "ck", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved \(confirmed by operator instruction\)/);
	await flow(["check"]);
	const v = await flow(["verify", "--confirmed"]);
	assert.match(v.content[0].text, /verified \(confirmed by operator instruction\) — entering release/);
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
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /release recorded as complete \(confirmed by operator instruction\)/);
	assert.match(rd.content[0].text, /worktree and branch removed — feature ck done/, "clean worktree auto-closes the feature");
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "ck")), "feature dir gone after release");
	assert.equal(dialogs, 0, "still zero dialogs at the end");
});

test("release tail: dirty worktree keeps the operator in the loop", async () => {
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
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /worktree was not clean after release/, "not-clean falls back to manual cleanup");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "dirt", "state.json")), "feature stays until the operator sorts it out");
	const cl = await flow(["cleanup"]);
	assert.ok(cl.isError && cl.content[0].text.includes("uncommitted"), "cleanup reports why it refuses");
});

test("release opt-out: per-release flag and per-project config skip the GitHub release", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const versioned = async (slug: string, mdTail: string) => {
		await flow(["init", "--write", `# dev-flow\n\n## release\n\n\`\`\`flow\nversionFile = package.json\nversionTag = v{version}\n${mdTail}\`\`\`\n`]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		await flow(["verify", "--confirmed"]);
		writeFileSync(path.join(repo, "package.json"), '{"name":"t","version":"9.9.9"}');
		const wt = path.join(repo, ".dev-flow", slug, "worktree");
		execFileSync("git", ["-C", repo, "merge", "-q", "--ff", `feat/${slug}`]);
		try { execFileSync("git", ["-C", repo, "tag", "v9.9.9"]); } catch { /* second feature: tag already on main */ }
		void wt;
	};
	await versioned("optflag", "");
	const f = await flow(["release-done", "--confirmed", "--no-github-release"]);
	assert.match(f.content[0].text, /GitHub release skipped \(--no-github-release\)/);
	assert.match(f.content[0].text, /feature optflag done/);
	await versioned("optcfg", "github = false\n");
	const c = await flow(["release-done", "--confirmed"]);
	assert.ok(!c.content[0].text.includes("GitHub release"), "config-off: no attempt, no note");
	assert.match(c.content[0].text, /feature optcfg done/);
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
	writeFileSync(path.join(repo, "package.json"), '{"name":"t","version":"9.9.9"}');
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
	assert.match(okRun.content[0].text, /feature teeth done/);
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

test("flow exempt: opens the checkout, keeps dev-flow files protected, off closes it", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	await flow(["start", "ex-feat"]);
	const guard = pi.handlers.tool_call[0];
	assert.ok((await guard({ toolName: "write", input: { path: path.join(repo, "src", "x.ts") } }, ctx))?.block, "bound at implement blocks main-checkout writes");
	assert.match((await flow(["exempt", "one-off fix"])).content[0].text, /flow-exempt: one-off fix/);
	assert.equal(await guard({ toolName: "write", input: { path: path.join(repo, "src", "x.ts") } }, ctx), undefined, "exemption opens the checkout");
	assert.ok((await guard({ toolName: "write", input: { path: path.join(repo, ".dev-flow", "ex-feat", "state.json") } }, ctx))?.block, "exempt never touches flow-owned files");
	await flow(["exempt", "off"]);
	assert.ok((await guard({ toolName: "write", input: { path: path.join(repo, "src", "y.ts") } }, ctx))?.block, "off restores the rules");
});
