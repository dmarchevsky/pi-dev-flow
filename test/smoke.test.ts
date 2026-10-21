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
import devFlow, { compactionTakeover } from "../extensions/dev-flow.ts";
import { tagNotesCommand } from "../src/core.ts";

type Handler = (event: { toolName?: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

interface Stub {
	cmds: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Record<string, { execute: (...a: unknown[]) => Promise<{ content: [{ text: string }] }> }>;
	handlers: Record<string, Handler[]>;
}

function makePi(): Stub & ((...a: never[]) => void) {
	const stub = { cmds: {}, tools: {}, handlers: {} } as Stub;
	let cmdCtx: { notices?: string[]; sent?: { triggerTurn?: boolean }[] } | undefined; // last command's ctx — sendMessage output lands in its notices
	const api = {
		registerCommand: (n: string, o: unknown) => {
			const cmd = o as { handler: (a: string, c: unknown) => Promise<void> };
			stub.cmds[n] = {
				handler: async (a: string, c: unknown) => {
					cmdCtx = c as { notices?: string[]; sent?: { triggerTurn?: boolean }[] };
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
		sendMessage: (m: { content: string }, opts?: { triggerTurn?: boolean }) => {
			if (cmdCtx) {
				(cmdCtx.notices ??= []).push(m.content);
				(cmdCtx.sent ??= []).push(opts ?? {});
			}
		},
	};
	devFlow(api as never);
	return stub as never;
}

function makeRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "devflow-"));
	execFileSync("git", ["init", "-b", "main", dir]);
	writeFileSync(path.join(dir, "README.md"), "# scratch\n");
	// release.changelog is on by default — every test repo has one, entries added per test as needed
	writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
	const id = ["-c", "user.email=t@t", "-c", "user.name=t"];
	execFileSync("git", ["-C", dir, ...id, "add", "-A"]);
	execFileSync("git", ["-C", dir, ...id, "commit", "-qm", "init"]);
	return dir;
}

function makeCtx(cwd: string, hasUI = false) {
	const notices: string[] = [];
	return { cwd, hasUI, notices, sent: [] as { triggerTurn?: boolean }[], ui: { notify: (m: string) => notices.push(m), confirm: async () => true } };
}

test("bare reflect from the command bar wakes the model; other commands stay display-only", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow")); // bare reflect needs an initialized repo to print the protocol
	const ctx = makeCtx(repo);
	await pi.cmds.flow.handler("reflect", ctx);
	assert.match(ctx.notices.at(-1) ?? "", /work instruction/, "the reflect protocol rendered");
	assert.equal(ctx.sent.at(-1)?.triggerTurn, true, "bare reflect triggers a model turn — its output is instructions the agent must execute");
	await pi.cmds.flow.handler("reflect some note", ctx);
	assert.notEqual(ctx.sent.at(-1)?.triggerTurn, true, "reflect <note> only queues — no model turn");
	await pi.cmds.flow.handler("status", ctx);
	assert.notEqual(ctx.sent.at(-1)?.triggerTurn, true, "gate output stays display-only");
});

/** project.md is un-ignored now — the finish dirty-check demands the playbook committed like everything else.
 *  The DEV_FLOW_ALLOW_MAIN env is the sanctioned override of the pre-commit hook the tests' own init installed. */
function trackPlaybook(repo: string) {
	execFileSync("git", ["-C", repo, "add", ".dev-flow/project.md"]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "track playbook"], { env: { ...process.env, DEV_FLOW_ALLOW_MAIN: "1" } });
}

/** verify proves a committed branch, so every test that walks a feature to Verified? needs a
 *  commit in the worktree — what a real flow does as it goes. Empty is fine: these tests carry
 *  no feature content, only the commit proof. */
function commitWt(repo: string, slug: string, msg = "work") {
	const wt = path.join(repo, ".dev-flow", slug, "worktree");
	execFileSync("git", ["-C", wt, "add", "-A"]);
	execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", msg]);
}

test("init → start → guards → gate ordering, end to end", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);

	await pi.cmds.flow.handler("init", ctx);
	assert.ok(existsSync(path.join(repo, ".dev-flow")), "init created .dev-flow/");
	assert.ok(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), "pre-commit hook installed");
	assert.equal(readFileSync(path.join(repo, ".dev-flow", ".gitignore"), "utf8").trim(), "*\n!project.md", "self-ignoring .dev-flow/ except the playbook");
	execFileSync("git", ["-C", repo, "check-ignore", "-q", ".dev-flow/whatever/file.txt"]); // throws when not ignored
	assert.throws(() => execFileSync("git", ["-C", repo, "check-ignore", "-q", ".dev-flow/project.md"]), "the playbook must be trackable");
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "project.md")), "first init never writes — the operator confirms first");
	assert.match(ctx.notices.at(-1) ?? "", /questions for the operator/, "first init prints the setup brief");
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
	const bash = await guard({ toolName: "bash", input: { command: "git commit -m x", timeout: 60 } }, ctx);
	assert.ok(bash?.block, "commit on main must be blocked");
	const stateTamperBlock = await guard({ toolName: "bash", input: { command: "echo x > .dev-flow/demo-feature/state.json", timeout: 60 } }, ctx);
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
	assert.match(ctx.notices.at(-1) ?? "", /NEEDS-OPERATOR Approve\? — plan approval needs the operator/, "no-UI refusal carries the machine marker before the prose");

	// stage context injection
	const inj = (await pi.handlers.before_agent_start[0]({}, ctx)) as { message?: { content: string } };
	assert.match(inj.message?.content ?? "", /demo-feature — stage: plan/);

	// the model-facing tool routes through the same runner
	const res = await pi.tools.flow.execute("id", { args: ["status"] }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /demo-feature/);
	// machine surfaces for headless orchestrators
	const sj = JSON.parse((await pi.tools.flow.execute("id", { args: ["status", "--json"] }, undefined, undefined, ctx)).content[0].text);
	assert.equal(sj.bound, "demo-feature");
	assert.deepEqual(sj.features.map((f: { slug: string; stage: string }) => [f.slug, f.stage]), [["demo-feature", "plan"]]);
	const hj = JSON.parse((await pi.tools.flow.execute("id", { args: ["help", "--json"] }, undefined, undefined, ctx)).content[0].text);
	assert.ok(hj.gates.includes("approve [--yolo]"), "gate contract is structured data");
	assert.equal(hj.protocol.refusalMarker, "NEEDS-OPERATOR");
	await pi.cmds.flow.handler("abort demo-feature", ctx); // the empty case must stay parseable too
	const empty = JSON.parse((await pi.tools.flow.execute("id", { args: ["status", "--json"] }, undefined, undefined, ctx)).content[0].text);
	assert.deepEqual(empty, { bound: null, features: [] }, "no features still answers JSON, not prose");
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
	assert.ok(await guard({ toolName: "bash", input: { command: "git commit -m x", timeout: 60 } }, ctx), "commit on main must be blocked");
	// commit inside the feature worktree passes however the command gets there
	const wt = path.join(repo, ".dev-flow", "wt-feature", "worktree");
	assert.equal(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(wt)} && git commit -m x`, timeout: 60 } }, ctx), undefined, "worktree commit via cd must pass");
	assert.equal(await guard({ toolName: "bash", input: { command: `git -C ${JSON.stringify(wt)} commit -m x`, timeout: 60 } }, ctx), undefined, "worktree commit via -C must pass");
	// reads are never misguarded
	assert.equal(await guard({ toolName: "bash", input: { command: "cat .git/hooks/pre-commit", timeout: 60 } }, ctx), undefined, "reading the hook is not a commit");
	assert.equal(await guard({ toolName: "bash", input: { command: "git log --oneline", timeout: 60 } }, ctx), undefined, "git log is not a commit");
	// per-segment attribution: a chain spanning directories must not inherit one verdict (the release-blocker bug)
	assert.equal(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(wt)} && git commit -m x && cd ${JSON.stringify(repo)} && git pull`, timeout: 60 } }, ctx), undefined, "commit judged in the worktree even when the chain later cds to main");
	assert.ok(await guard({ toolName: "bash", input: { command: `cd ${JSON.stringify(repo)} && git log && cd ${JSON.stringify(repo)} && git commit -m x`, timeout: 60 } }, ctx), "commit after cd back to main checkout is blocked");
	assert.ok(await guard({ toolName: "bash", input: { command: `git -C ${JSON.stringify(repo)} checkout -b feat/sneaky`, timeout: 60 } }, ctx), "checkout -b of a feature branch in the main checkout is blocked");
	// the reported failure: ~ is the shell's to expand, path.resolve does not, so `~/wt` resolved under the
	// session cwd and the failed probe fell back to main — a worktree commit got the default branch's rule
	const home = process.env.HOME;
	process.env.HOME = path.dirname(repo);
	try {
		assert.equal(await guard({ toolName: "bash", input: { command: `cd ~/${path.relative(process.env.HOME, wt)} && git commit -m x`, timeout: 60 } }, ctx), undefined, "worktree commit via a ~ cd must pass");
	} finally {
		process.env.HOME = home;
	}
	assert.equal(await guard({ toolName: "bash", input: { command: "cd /nonexistent-dir-xyz && git commit -m x", timeout: 60 } }, ctx), undefined, "a directory git cannot answer for invents no main verdict — git itself fails there");
});

test("a forced push is confirmed with the operator; the prefix the refusal prints answers for it", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let answer = false;
	const ctx = { cwd: repo, hasUI: true, ui: { notify: () => {}, confirm: async () => answer, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	await pi.cmds.flow.handler("init", ctx);
	const guard = pi.handlers.tool_call[0];
	assert.equal(await guard({ toolName: "bash", input: { command: "git push origin feat/x", timeout: 60 } }, ctx), undefined, "an ordinary push asks nobody");
	assert.ok(await guard({ toolName: "bash", input: { command: "git push --force origin feat/x", timeout: 60 } }, ctx), "a forced push needs the operator (#83)");
	assert.equal(await guard({ toolName: "bash", input: { command: "DEV_FLOW_ALLOW_REWRITE=1 git push -f origin feat/x", timeout: 60 } }, ctx), undefined, "the sanctioned prefix is the operator's word spelled out — no dialog, so it works headless");
	answer = true;
	assert.equal(await guard({ toolName: "bash", input: { command: "git push -f origin feat/x", timeout: 60 } }, ctx), undefined, "the operator said yes in the dialog");
	answer = false;
	assert.ok(await guard({ toolName: "bash", input: { command: "git push -f origin feat/x && git status", timeout: 60 } }, ctx), "a declined dialog blocks the call");
	assert.equal(await guard({ toolName: "bash", input: { command: "git filter-branch --force --index-filter 'git rm --cached --ignore-unmatch k' main..HEAD", timeout: 60 } }, ctx), undefined, "the local rewrite tool stays free — no blunt flag deny needed");
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
	await pi.cmds.flow.handler("init", ctx);
	const refused = (await pi.tools.flow.execute("id", { args: ["init", "--force"] }, undefined, undefined, ctx)) as { content: [{ text: string }]; isError?: boolean };
	assert.ok(refused.isError && /operator's word/.test(refused.content[0].text), "overwriting the operator's playbook needs their word");
	assert.match(readFileSync(mdFile, "utf8"), /custom-cmd/, "a refused --force touches nothing");
	await pi.cmds.flow.handler("init --force --confirmed", ctx);
	assert.match(readFileSync(mdFile, "utf8"), /## implement/, "--force writes a full draft");
	assert.ok(!/custom-cmd/.test(readFileSync(mdFile, "utf8")), "the draft replaces the hand-set value");
	assert.match(readFileSync(`${mdFile}.bak`, "utf8"), /custom-cmd/, "the operator's previous playbook is kept");
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

test("init reports .dev-flow/ created only when it created it (#39)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	assert.match((await flow(["init"])).content[0].text, /\.dev-flow\/ created in /, "a real creation is still reported");
	const again = await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = x\n```\n"]);
	assert.match(again.content[0].text, /project\.md written/);
	assert.ok(!/created/.test(again.content[0].text), `nothing was created, nothing may be claimed: ${again.content[0].text}`);
});

test("verify names the commands it ran, and says when dev is not configured (#38)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	const toImplement = async (slug: string, body: string) => {
		await flow(["init", "--write", md(body)]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		commitWt(repo, slug);
	};
	await flow(["init"]);
	await toImplement("ran", "test = node --version\ndev = touch dev-up\n");
	// the commands run before the operator is asked, so even the walk-out path must report them
	const early = await flow(["verify"]);
	assert.ok(early.isError, "no UI and no --confirmed: verification still needs the operator");
	assert.match(early.content[0].text, /dev ran \(touch dev-up\)/);
	assert.match((await flow(["verify", "--confirmed"])).content[0].text, /entering pre-release stage\.\ncommits: 1 ahead of main, 1 uncommitted path\(s\); dev ran \(touch dev-up\)/);
	await toImplement("nodev", "test = node --version\n");
	assert.match((await flow(["verify", "--confirmed"])).content[0].text, /dev: none configured/);
});

test("verify runs the checks it gates on instead of asking for them (#84)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	// deliberately no `flow check`: entering the stage leaves the records empty, which used to be a refusal
	const toImplement = async (slug: string, body: string) => {
		await flow(["init", "--write", md(body)]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		commitWt(repo, slug);
	};
	await flow(["init"]);
	await toImplement("selfrun", "test = node --version\n");
	const ok = await flow(["verify", "--confirmed"]);
	assert.match(ok.content[0].text, /entering pre-release stage/, "the gate ran its own checks");
	assert.match(ok.content[0].text, /checks ran at the gate \(test\)/, "and says which ones it ran");
	assert.ok(JSON.parse(readFileSync(path.join(repo, ".dev-flow", "selfrun", "state.json"), "utf8")).checks.test.ok, "the PASS is recorded, not only printed");
	await toImplement("selffail", "test = exit 3\n");
	const bad = await flow(["verify", "--confirmed"]);
	assert.ok(bad.isError && /a check run at the gate failed/.test(bad.content[0].text), "a failing check still refuses the gate");
	assert.match(bad.content[0].text, /test: FAIL \(exit 3\)/, "with the run output instead of a pointer");
	assert.ok(!/has not passed/.test(bad.content[0].text), "no run-flow-check-and-come-back round trip left");
});

test("verify refuses a branch with nothing committed, and names what a passing verify asks you to approve", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\n```\n"]);
	await flow(["start", "uncommitted"]);
	mkdirSync(path.join(repo, ".dev-flow", "uncommitted", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "uncommitted", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	writeFileSync(path.join(repo, ".dev-flow", "uncommitted", "worktree", "f.txt"), "the whole change, uncommitted\n");
	await flow(["check"]);
	const refused = await flow(["verify"]);
	assert.ok(refused.isError && /nothing committed on the feature branch/.test(refused.content[0].text), "an uncommitted branch cannot be verified");
	assert.match(refused.content[0].text, /commits: 0 ahead of main, 1 uncommitted path\(s\)/, "the refusal says what the branch holds");
	assert.ok(!/build ran|dev ran/.test(refused.content[0].text), "the commit proof is judged before the gate spends minutes deploying");
	commitWt(repo, "uncommitted");
	const ok = await flow(["verify", "--confirmed"]);
	assert.match(ok.content[0].text, /entering pre-release stage\.\ncommits: 1 ahead of main, 0 uncommitted path\(s\)/, "the operator sees the committed state they are approving");
});

test("verify re-probes health after the dev deploy — a stale pre-deploy PASS cannot carry the gate", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	const toImplement = async (slug: string, body: string) => {
		await flow(["init", "--write", md(body)]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		commitWt(repo, slug);
	};
	const stage = (slug: string) => JSON.parse(readFileSync(path.join(repo, ".dev-flow", slug, "state.json"), "utf8")).stage;
	await flow(["init"]);
	// the probe passes before the deploy and fails after it: precisely the hole the post-deploy probe closes
	// healthWait = 0: this case is about the stale PASS, not the wait — keep it a single shot
	await toImplement("stale", "test = node --version\ndev = touch deploy-up\nhealth = test ! -e deploy-up\nhealthWait = 0\n");
	const failed = await flow(["verify", "--confirmed"]);
	assert.ok(failed.isError, "a deploy the probe rejects cannot be verified");
	assert.match(failed.content[0].text, /post-deploy probe FAILED \(test ! -e deploy-up\)/);
	assert.equal(stage("stale"), "implement", "a failed probe leaves the flow in implement");
	await toImplement("probed", "test = node --version\ndev = touch dev-up\nhealth = node --version\n");
	const ok = await flow(["verify", "--confirmed"]);
	assert.match(ok.content[0].text, /dev ran \(touch dev-up\); health: PASS \(node --version\)/);
	assert.ok(JSON.parse(readFileSync(path.join(repo, ".dev-flow", "probed", "state.json"), "utf8")).checks.health.ok, "the post-deploy PASS is what lands in state");
});

test("the health probe waits for a service that lags its deploy; healthWait 0 keeps the single shot (#42)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	// the deploy stamps the second it ran; the probe only goes green 3s later — the boot-lag shape from #42
	const bootLag = (wait: string) => `test = node --version\ndev = date +%s > flow-start\nhealth = test $(( $(date +%s) - $(cat flow-start) )) -ge 3\nhealthWait = ${wait}\n`;
	const toImplement = async (slug: string, body: string) => {
		await flow(["init", "--write", md(body)]);
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		writeFileSync(path.join(repo, ".dev-flow", slug, "worktree", "flow-start"), "0"); // the app is up before the redeploy, so the pre-verify check passes
		await flow(["check"]);
		commitWt(repo, slug);
	};
	await flow(["init"]);
	await toImplement("bootlag", bootLag("10"));
	const ok = await flow(["verify", "--confirmed"]);
	assert.match(ok.content[0].text, /health: PASS \(.*, 3 attempts\)/, `the gate waited and says how it tried: ${ok.content[0].text}`);
	await toImplement("single", bootLag("0"));
	const fast = await flow(["verify", "--confirmed"]);
	assert.ok(fast.isError, "an opt-out of the wait fails as fast as it used to");
	assert.match(fast.content[0].text, /gave up after 1 attempt\(s\)/);
});

test("docs mode runs no project command: approve skips setup, verify skips build/dev/health (#43 #49)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	await flow(["init", "--write", md("setup = touch setup-ran\ntest = node --version\ndev = touch dev-up\n")]);
	await flow(["start", "docflow", "--docs", "--confirmed"]);
	const ap = await flow(["approve", "--confirmed"]);
	assert.match(ap.content[0].text, /setup skipped \(docs mode/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "docflow", "worktree", "setup-ran")), "a docs flow must not run the project's setup");
	commitWt(repo, "docflow");
	const v = await flow(["verify", "--confirmed"]);
	assert.match(v.content[0].text, /docs mode: project commands skipped/);
	assert.match(v.content[0].text, /entering pre-release/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "docflow", "worktree", "dev-up")), "and no dev deploy either");
});

test("a failed setup runs again on the next approve — re-approve is not a no-op (#49)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const md = (body: string) => `# dev-flow\n\n## implement\n\n\`\`\`flow\n${body}\`\`\`\n`;
	const state = () => JSON.parse(readFileSync(path.join(repo, ".dev-flow", "retry", "state.json"), "utf8"));
	await flow(["init", "--write", md("setup = exit 1\ntest = node --version\n")]);
	await flow(["start", "retry"]);
	mkdirSync(path.join(repo, ".dev-flow", "retry", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "retry", "plan", "plan.md"), "# plan\n");
	const first = await flow(["approve", "--confirmed"]);
	assert.ok(first.isError && /setup failed in /.test(first.content[0].text), "setup still fails the gate");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "retry", "worktree")), "the worktree is kept for the retry");
	assert.ok(!state().setupAt, "no setup stamp before it succeeds");
	await flow(["init", "--write", md("setup = touch setup-ran\ntest = node --version\n")]);
	const second = await flow(["approve", "--confirmed"]);
	assert.match(second.content[0].text, /setup ran in the worktree \(touch setup-ran\)/, `re-approve must actually set up: ${second.content[0].text}`);
	assert.ok(existsSync(path.join(repo, ".dev-flow", "retry", "worktree", "setup-ran")), "setup ran in the reused worktree");
	assert.ok(state().setupAt, "the stamp lands with the success");
	assert.equal(state().stage, "implement");
});

test("reflect <note> --confirmed queues the note without the flag (#43)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", TEST_MD]);
	const r = await flow(["reflect", "the", "verify", "gate", "lies", "--confirmed"]);
	assert.match(r.content[0].text, /- \[ \] the verify gate lies — /, "the flag is not part of the operator's sentence");
	assert.ok(!/--confirmed/.test(readFileSync(path.join(repo, ".dev-flow", "reflections.md"), "utf8")), "and nothing lands in the file");
	const bare = await flow(["reflect", "--confirmed"]);
	assert.match(bare.content[0].text, /flow reflect — session reflection/, "a flags-only reflect is a bare reflect");
});

test("first init in a TUI reviews the draft with the operator and writes only on confirm", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, mode: "tui", notices: [] as string[], ui: { notify: (_m: string) => {}, setStatus: (_k: string, _t?: string) => {}, confirm: async () => { dialogs++; return true; }, editor: async () => { dialogs++; return undefined; } } };
	await pi.cmds.flow.handler("init", ctx);
	assert.equal(dialogs, 1, "the detection draft is reviewed in one confirm, never written silently");
	assert.match(readFileSync(path.join(repo, ".dev-flow", "project.md"), "utf8"), /## implement/, "the confirmed draft lands on disk");
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
	const chk = await pi.handlers.tool_call[0]({ toolName: "bash", input: { command: "git checkout feat/z", timeout: 60 } }, ctx);
	assert.match(chk?.reason ?? "", /worktree/, "feature branches stay out of the main checkout");
});

test("feature-branch checkout allowed inside its own worktree", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const wt = path.join(repo, ".wt", "z");
	execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feat/z", wt]);
	const st = { slug: "z", stage: "implement", ui: false, branch: "feat/z", worktree: ".wt/z", approvals: {}, checks: {} };
	mkdirSync(path.join(repo, ".dev-flow", "z"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "z", "state.json"), JSON.stringify(st));
	const ctx = { cwd: wt, hasUI: false, notices: [] as string[], ui: { notify: () => {} } };
	const res = await pi.handlers.tool_call[0]({ toolName: "bash", input: { command: "git checkout feat/z", timeout: 60 } }, ctx);
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
	assert.equal(statuses.at(-1), "📝 demo-feature");
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
	const bash = (command: string) => pi.handlers.tool_call[0]({ toolName: "bash", input: { command, timeout: 60 } }, ctx);
	assert.equal(await bash("git push origin v9.9.9"), undefined, "tag name resolves to refs/tags — stage-free");
	assert.match((await bash("git push origin main"))?.reason ?? "", /requires stage "release"/);
	assert.equal(await bash("git push origin main:refs/heads/main-backup"), undefined, "explicit non-default dest passes");
});

test("guard reads commands, not prose: a quoted body is data, a shell wrapper's payload is not", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	const ctx = makeCtx(repo);
	const bash = (command: string) => pi.handlers.tool_call[0]({ toolName: "bash", input: { command, timeout: 60 } }, ctx);
	// the v0.37.0 incident: a PR body whose text discussed a commit and the playbook path
	const body = 'gh pr create --title "t" --body "the tracking chore: git add -f .dev-flow/project.md && git commit -m x\\nthe safety copy: cp .dev-flow/project.md /tmp/bak"';
	assert.equal(await bash(body), undefined, "prose in a quoted argument is not a main-branch commit or a playbook write");
	assert.match((await bash('sh -c "git push origin main"'))?.reason ?? "", /stage "release"|forbidden/, "a wrapper cannot carry a push past the guard");
	assert.match((await bash("cp /tmp/bak .dev-flow/project.md"))?.reason ?? "", /operator playbook/, "the real write is still refused");
});

test("reflect <note>: section by wording, protocol lists open items, check-off semantics, status surfacing", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init"]);
	await flow(["start", "rfeat"]);
	await flow(["reflect", "test", "cmd", "is", "stale"]);
	const r2 = await flow(["reflect", "ui", "panels", "are", "ugly", "in", "the", "plugin"]);
	assert.match(r2.content[0].text, /reflected \(plugin\): - \[ \] ui panels are ugly in the plugin — rfeat \d{4}-\d{2}-\d{2}/);
	const reflFile = path.join(repo, ".dev-flow", "reflections.md");
	assert.match(readFileSync(reflFile, "utf8"), /## playbook\n\n- \[ \] test cmd is stale — rfeat \d{4}-\d{2}-\d{2}/);
	const proto = await flow(["reflect"]);
	assert.match(proto.content[0].text, /flow reflect — session reflection \(dev-flow \d+\.\d+\.\d+, upstream: dmarchevsky\/dev-flow\)/);
	assert.match(proto.content[0].text, /open items \(2\)/);
	assert.match(proto.content[0].text, /\[playbook\] test cmd is stale — rfeat \d{4}-\d{2}-\d{2}/);
	writeFileSync(reflFile, readFileSync(reflFile, "utf8") + "- [x] already handled\n");
	const proto2 = await flow(["reflect"]);
	assert.match(proto2.content[0].text, /open items \(2\)/, "checked-off items stay out of the open list");
	assert.ok(!/open items[\s\S]*already handled/.test(proto2.content[0].text), "a checked-off item is not listed");
	const st = await flow(["status"]);
	assert.match(st.content[0].text, /↻ 2 reflection\(s\) open/);
});

test("bare reflect prints the protocol in a foreign repo: plugin items route upstream", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", TEST_MD]);
	await flow(["reflect", "the gate prompt asks twice"]);
	const proto = await flow(["reflect"]);
	assert.match(proto.content[0].text, /1\. review the current session log in full/);
	assert.match(proto.content[0].text, /gh issue list --repo dmarchevsky\/dev-flow --state all --search/);
	assert.match(proto.content[0].text, /b\. playbook items: run flow doctor/);
	assert.match(proto.content[0].text, /file an issue against pi-dev-flow upstream/, "a foreign repo routes plugin items upstream");
});

test("flow doctor no longer queues: reflect is the only queue command", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", TEST_MD]);
	const d = await flow(["doctor", "reflect", "some", "note"]);
	assert.match(d.content[0].text, /investigate: "reflect some note"/, "the old form falls through to the fresh-note brief");
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "reflections.md")), "doctor writes nothing — the queue lives at flow reflect");
});

test("checkpoint contract: --confirmed walks every gate with zero dialogs", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => { dialogs++; return false; }, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\ndev = touch dev-up\n```\n\n- [ ] operator item\n- [ ] (ui) mockup item\n"]);
	trackPlaybook(repo);
	await flow(["start", "ck"]);
	mkdirSync(path.join(repo, ".dev-flow", "ck", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "ck", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved \(confirmed by operator instruction\)/);
	await flow(["check"]);
	commitWt(repo, "ck");
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
	commitWt(repo, "dirt");
	await flow(["verify", "--confirmed"]);
	writeFileSync(path.join(repo, ".dev-flow", "dirt", "worktree", "loose.txt"), "uncommitted\n");
	await flow(["release", "--confirmed"]);
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /release recorded as complete/, "release-done records the release even when the worktree is dirty");
	const fin = await flow(["finish", "--confirmed"]);
	assert.ok(fin.isError && fin.content[0].text.includes("uncommitted"), "finish reports why it refuses");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "dirt", "state.json")), "feature stays until the operator sorts it out");
});

test("roadmap: add → list → pick → done → tidy route through the backlog file", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	const rf = path.join(repo, ".dev-flow", "roadmap.md");
	assert.match((await flow(["roadmap"])).content[0].text, /empty/, "empty roadmap is a listing, not an error");
	assert.ok((await flow(["roadmap", "pick", "1", "nope"])).isError, "nothing to pick yet");
	assert.match((await flow(["roadmap", "add", "dark", "mode"])).content[0].text, /added — 1 open/);
	await flow(["roadmap", "add", "roadmap tidy"]);
	assert.match((await flow(["roadmap"])).content[0].text, /1\. dark mode[\s\S]*2\. roadmap tidy/, "numbered open items");
	assert.match((await flow(["roadmap", "pick", "1", "dark-mode"])).content[0].text, /now: flow start dark-mode/, "pick stamps and points at flow start (one verb)");
	assert.match(readFileSync(rf, "utf8"), /- \[ \] dark mode \(dark-mode\)/);
	assert.match((await flow(["roadmap", "done", "2"])).content[0].text, /item 2 marked done \(1 open\)/);
	assert.match((await flow(["roadmap", "done", "5"])).content[0].text, /1–1 required/);
	assert.match((await flow(["roadmap", "tidy"])).content[0].text, /dropped 1 done item/);
	assert.ok(!readFileSync(rf, "utf8").includes("[x]"), "tidy drops the history line");
	assert.match((await flow(["status"])).content[0].text, /1 roadmap item\(s\) open/, "status nudges the backlog");
});

test("finish closes a released feature only: refuses early, then removes worktree, branch and state", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n"]);
	trackPlaybook(repo);
	await flow(["roadmap", "add", "the finishing move"]);
	await flow(["roadmap", "pick", "1", "fin"]);
	await flow(["start", "fin"]);
	mkdirSync(path.join(repo, ".dev-flow", "fin", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "fin", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	commitWt(repo, "fin");
	await flow(["verify", "--confirmed"]);
	const early = await flow(["finish"]);
	assert.ok(early.isError && early.content[0].text.includes("release-done"), "finish refuses until the release is recorded");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "fin", "state.json")), "a refused finish removes nothing");
	await flow(["release", "--confirmed"]);
	await flow(["release-done", "--confirmed"]);
	assert.match((await flow(["finish", "--confirmed"])).content[0].text, /feature fin done — worktree and branch feat\/fin removed.*roadmap: 1 item\(s\) marked done/, "finish checks off the picked backlog item");
	assert.match(readFileSync(path.join(repo, ".dev-flow", "roadmap.md"), "utf8"), /- \[x\] the finishing move \(fin\) — done: \d{4}-\d{2}-\d{2}/);
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "fin")), "the flow state folder is gone");
	assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "feat/fin"]));
});

test("release opt-out: per-release flag and per-project config skip forge release creation", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const versioned = async (slug: string, ver: string, mdTail: string, mdAfter = "") => {
		await flow(["init", "--write", `# dev-flow\n\n## release\n\n\`\`\`flow\nversionFile = package.json\nversionTag = v{version}\n${mdTail}\`\`\`\n${mdAfter}`]);
		trackPlaybook(repo); // finish demands a clean main checkout — the self-ignoring .dev-flow/ needs its playbook tracked
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		commitWt(repo, slug);
		await flow(["verify", "--confirmed"]);
		const wt = path.join(repo, ".dev-flow", slug, "worktree");
		writeFileSync(path.join(wt, "package.json"), `{"name":"t","version":"${ver}"}`); // pre-release bump lives on the branch
		writeFileSync(path.join(wt, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${ver}]\n- shipped\n`); // the gate wants the version mentioned
		execFileSync("git", ["-C", wt, "add", "-A"]);
		execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `bump ${ver}`]);
		assert.match((await flow(["release", "--confirmed"])).content[0].text, /release approved/);
		execFileSync("git", ["-C", repo, "merge", "-q", "--ff", `feat/${slug}`]);
		execFileSync("git", ["-C", repo, "tag", `v${ver}`]);
	};
	await versioned("optflag", "9.9.9", "");
	const f = await flow(["release-done", "--confirmed", "--no-release-create"]);
	assert.match(f.content[0].text, /Forge release skipped \(--no-release-create\)/);
	assert.match(f.content[0].text, /release recorded as complete/);
	await versioned("optcfg", "9.9.10", "releases = false\n");
	const c = await flow(["release-done", "--confirmed"]);
	assert.ok(!c.content[0].text.includes("release skipped"), "config-off: no attempt, no note");
	assert.match(c.content[0].text, /release recorded as complete/);
	// release-stage items have no gate of their own — release-done names them; and a failing forge create (#63)
	// must be named by finish before the state vanishes: forge=gitlab without a GitLab remote — glab is absent
	// or has no matching repo, the create deterministically fails.
	await versioned("chores", "9.9.11", "", "\n- [ ] dogfood the shim in the released checkout\n");
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n\n## global\n\n```flow\nforge = gitlab\n```\n\n## release\n\n```flow\nversionFile = package.json\nversionTag = v{version}\n```\n\n- [ ] dogfood the shim in the released checkout\n");
	trackPlaybook(repo);
	const chores = await flow(["release-done", "--confirmed"]);
	assert.match(chores.content[0].text, /release-stage checklist still open \(1\): dogfood the shim/, "release-stage items surface at the last gate; the operator's Finish? answer closes them");
	assert.match(chores.content[0].text, /release skipped/, "a failed forge release is printed, not swallowed");
	const finChores = await flow(["finish", "--confirmed"]);
	assert.match(finChores.content[0].text, /WARNING: the forge release was not created/, "finish names the missing forge release — it cannot slip past (#63)");
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
	commitWt(repo, "teeth");
	await flow(["verify", "--confirmed"]);
	const wt = path.join(repo, ".dev-flow", "teeth", "worktree");
	writeFileSync(path.join(wt, "package.json"), '{"name":"t","version":"9.9.9"}'); // the bump lives on the branch
	writeFileSync(path.join(wt, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [9.9.9]\n- shipped\n"); // the gate wants the version mentioned
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
	assert.match(okRun.content[0].text, /Artifact verified for 9\.9\.9\./, "the probe names the version it probed (#52)");
	assert.match(okRun.content[0].text, /release recorded as complete/);
});

test("a release gate refuses to guess when origin cannot be asked (offline)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	execFileSync("git", ["-C", repo, "remote", "add", "origin", path.join(tmpdir(), `no-such-remote-${Date.now()}`)]);
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## release\n\n```flow\nversionFile = package.json\nversionTag = v{version}\n```\n"]);
	await flow(["start", "offline"]);
	mkdirSync(path.join(repo, ".dev-flow", "offline", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "offline", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	commitWt(repo, "offline");
	await flow(["verify", "--confirmed"]);
	const wt = path.join(repo, ".dev-flow", "offline", "worktree");
	writeFileSync(path.join(wt, "package.json"), '{"name":"t","version":"1.2.3"}');
	execFileSync("git", ["-C", wt, "add", "-A"]);
	execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump 1.2.3"]);
	const gate = await flow(["release", "--confirmed"]);
	assert.ok(gate.isError && /cannot list tags on origin/.test(gate.content[0].text), `an unreachable origin is not answered with local tags: ${gate.content[0].text}`);
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
	trackPlaybook(repo);
	assert.match((await flow(["start", "ungranted", "--patch"])).content[0].text, /operator-granted/, "--patch without the operator's chat grant is refused");
	assert.match((await flow(["start", "ungranted", "--patch", "--docs", "--confirmed"])).content[0].text, /exclusive/, "modes are mutually exclusive");
	await flow(["start", "chore", "--patch", "--confirmed"]);
	const noPlan = await flow(["approve"]);
	assert.ok(!noPlan.content[0].text.includes("plan gate FAILED"), "patch does not require plan/*.md");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved/);
	await flow(["check"]);
	commitWt(repo, "chore");
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
	trackPlaybook(repo);
	assert.match((await flow(["start", "readme-typo", "--docs"])).content[0].text, /operator-granted/, "--docs without the operator's chat grant is refused");
	assert.match((await flow(["start", "readme-typo", "--docs", "--confirmed"])).content[0].text, /docs/, "docs mode announced at start");
	assert.match((await flow(["approve", "--confirmed"])).content[0].text, /plan approved/, "docs approves with no plan file written");
	commitWt(repo, "readme-typo");
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

test("first init prints the setup questions and writes nothing until confirmed", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const r = (await pi.tools.flow.execute("id", { args: ["init"] }, undefined, undefined, ctx)) as { content: [{ text: string }] };
	const text = r.content[0].text;
	assert.ok(!existsSync(path.join(repo, ".dev-flow", "project.md")), "nothing is written before the operator answers");
	assert.match(text, /questions for the operator/);
	assert.match(text, /forge/, "the forge question is asked with its detected default");
	assert.match(text, /flow init --write/, "the agent learns the sanctioned write path");
	assert.match(text, /git add -f \.dev-flow\/project\.md/, "and that the playbook belongs in git");
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
	const bash = (command: string) => guard({ toolName: "bash", input: { command, timeout: 60 } }, ctx);
	assert.match((await bash("git push --force-with-lease origin feat/x"))?.reason ?? "", /history stays linear/);
	assert.match((await guard({ toolName: "bash", input: { command: "git push --force-with-lease origin feat/x" } }, ctx))?.reason ?? "", /history stays linear/, "the operator's deny outranks the timeout nag");
	assert.match((await bash("docker compose restart app"))?.reason ?? "", /needs an operator confirmation/, "without UI a confirm rule is a block, never a silent pass");
	assert.equal(await bash("git push origin feat/x"), undefined, "commands no rule matches pass");
	assert.match((await bash("git worktree prune"))?.reason ?? "", /prunes other sessions/, "project deny rules apply in every stage and binding");
	assert.match((await guard({ toolName: "write", input: { path: path.join(repo, "docker", "secrets", "new-key.pem") } }, ctx))?.reason ?? "", /gitignored secret storage/, "forbid covers a path that does not exist yet");
	assert.match((await guard({ toolName: "edit", input: { path: path.join(repo, "docker", ".env") } }, ctx))?.reason ?? "", /gitignored live secrets/, "protect without UI is a block");

	const declined = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false } };
	assert.match((await guard({ toolName: "bash", input: { command: "docker compose restart app", timeout: 60 } }, declined))?.reason ?? "", /operator declined/);
	const approved = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => true } };
	assert.equal(await guard({ toolName: "bash", input: { command: "docker compose restart app", timeout: 60 } }, approved), undefined, "an operator OK lets a confirm rule through");
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
	assert.match(d.content[0].text, /doctor: 2 finding\(s\)/);
	assert.match(d.content[0].text, /\.dev-flow\/ghosty has a plan\/ but no state\.json/);
	assert.match(d.content[0].text, /not tracked in git/, "an untracked playbook is a finding — it must live in the repo");
	assert.equal(dialogs, 0, "the doctor never asks — it only reports");
	assert.ok(existsSync(path.join(repo, ".dev-flow", "ghosty")), "and it never deletes — that stays flow init's job");
	assert.ok(!d.isError, "findings are advisory, not a failure");
	execFileSync("rm", ["-rf", path.join(repo, ".dev-flow", "ghosty")]);
	execFileSync("git", ["-C", repo, "add", ".dev-flow/project.md"]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "track playbook"], { env: { ...process.env, DEV_FLOW_ALLOW_MAIN: "1" } });
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
	assert.match(ctx.notices.at(-1) ?? "", /project\.json is no longer read/);
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

test("flow doctor reviews open reflections with routing and briefs a fresh note", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", TEST_MD]);
	writeFileSync(
		path.join(repo, ".dev-flow", "reflections.md"),
		"# dev-flow reflections\n\n## playbook\n\n- [ ] test command is stale — x 2026-01-01\n\n## plugin\n\n- [ ] the gate prompt asks twice — y 2026-01-01\n",
	);
	const d = await flow(["doctor"]);
	assert.match(d.content[0].text, /reflection review — 2 open item\(s\)/);
	assert.match(d.content[0].text, /docs flow \(flow start fold-<topic> --docs --confirmed\)/, "playbook items route to a docs flow");
	assert.match(d.content[0].text, /file an issue against pi-dev-flow upstream/, "plugin items route upstream in a foreign repo");
	assert.match(d.content[0].text, /doctor never implements/);
	const n = await flow(["doctor", "the", "health", "check", "drifted"]);
	assert.match(n.content[0].text, /investigate: "the health check drifted"/);
	assert.match(n.content[0].text, /fix routing: docs flow/);
});

test("pre-release stage: verify lands there, release gate has teeth, finish asks Finish?", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const ctx = makeCtx(repo); // no UI: every checkpoint must demand an operator answer or --confirmed
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const stage = () => (JSON.parse(readFileSync(path.join(repo, ".dev-flow", "rel", "state.json"), "utf8")) as { stage: string }).stage;
	await flow(["init", "--write", TEST_MD]);
	trackPlaybook(repo);
	await flow(["start", "rel"]);
	mkdirSync(path.join(repo, ".dev-flow", "rel", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "rel", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	assert.equal(stage(), "implement");
	await flow(["check"]);
	commitWt(repo, "rel");
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

	// a foreign session passing the slug is not a takeover of the gates
	const stolen = (await pi.tools.flow.execute("id", { args: ["approve", "claim-feature", "--confirmed"] }, undefined, undefined, b)) as { content: [{ text: string }]; isError?: boolean };
	assert.ok(stolen.isError && /claimed by another live session/.test(stolen.content[0].text), "gates follow the claim, not whoever passes a slug");

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
	trackPlaybook(repo);
	git("push", "-q", "origin", "main");
	const cycle = async (slug: string) => {
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		await flow(["check"]);
		commitWt(repo, slug);
		await flow(["verify", "--confirmed"]);
		await flow(["release", "--confirmed"]);
		await flow(["release-done", "--confirmed"]);
	};
	// (a) the origin branch is contained in origin/main (merge-commit shape) -> finish deletes it
	await cycle("gone");
	git("push", "-q", "origin", "feat/gone");
	git("merge", "-q", "--no-edit", "feat/gone"); // the case is a merged branch: now it really is contained in origin/main
	git("push", "-q", "origin", "main");
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
		assert.match(r.content[0].text, /^usage: flow <sub> — help \[--json\] \| init/);
		assert.match(r.content[0].text, /approve \[--yolo\]/);
		assert.match(r.content[0].text, /verify \[--yolo\]/);
		assert.match(r.content[0].text, /release \[--yolo\|--no-version\]/);
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
	trackPlaybook(repo);
	await flow(["start", "yo"]);
	mkdirSync(path.join(repo, ".dev-flow", "yo", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "yo", "plan", "plan.md"), "# plan\n");
	assert.match((await flow(["approve", "--yolo", "--confirmed"])).content[0].text, /yolo: later gate questions pre-confirmed/);
	// a failing check still blocks verify — yolo pre-confirms questions, not checks
	await flow(["check"]);
	commitWt(repo, "yo");
	const v = await flow(["verify"]);
	assert.ok(v.isError && /a check run at the gate failed/.test(v.content[0].text), "yolo never bypasses tier-1 checks — the gate reruns what is not green and refuses on it (#84)");
	await flow(["init", "--write", "# dev-flow\n"]);
	trackPlaybook(repo);
	await flow(["check"]);
	assert.match((await flow(["verify"])).content[0].text, /verified \(yolo: pre-confirmed\) — entering pre-release/);
	await flow(["release"]);
	await flow(["release-done"]);
	assert.match((await flow(["finish"])).content[0].text, /feature yo done — worktree and branch feat\/yo removed/);
	assert.equal(dialogs, 0, "yolo answered every checkpoint up front — gates must not ask");
});

test("yolo at any gate: verify --yolo answers that question and pre-confirms the rest to finish", async () => {
	const pi = makePi();
	const repo = makeRepo();
	let dialogs = 0;
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => { dialogs++; return false; }, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## implement\n\n```flow\ntest = exit 0\n```\n"]);
	trackPlaybook(repo);
	await flow(["start", "late"]);
	mkdirSync(path.join(repo, ".dev-flow", "late", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "late", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	commitWt(repo, "late");
	// yolo is the operator's word — never self-granted: --confirmed is the anchor
	const bare = await flow(["verify", "--yolo"]);
	assert.ok(bare.isError && /operator's word/.test(bare.content[0].text), "--yolo without --confirmed is refused");
	assert.match((await flow(["verify", "--yolo", "--confirmed"])).content[0].text, /entering pre-release/);
	// every later gate now runs with no flags and no dialogs — the flow completes on its own
	await flow(["release"]);
	await flow(["release-done"]);
	assert.match((await flow(["finish"])).content[0].text, /feature late done — worktree and branch feat\/late removed/);
	assert.equal(dialogs, 0, "yolo said at Verify? — later gates must not ask");
});

test("unversioned release: --no-version ships merge + changelog and skips the bump/tag machinery", async () => {
	const pi = makePi();
	const repo = makeRepo(); // already carries a committed CHANGELOG with an empty Unreleased
	const ctx = makeCtx(repo);
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	await flow(["init", "--write", "# dev-flow\n\n## release\n\n```flow\nversionFile = package.json\nversionTag = v{version}\n```\n"]);
	await flow(["start", "nv"]);
	mkdirSync(path.join(repo, ".dev-flow", "nv", "plan"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "nv", "plan", "plan.md"), "# plan\n");
	await flow(["approve", "--confirmed"]);
	await flow(["check"]);
	commitWt(repo, "nv");
	await flow(["verify", "--confirmed"]);
	// default stays versioned: no manifest in the worktree → the gate refuses
	const versioned = await flow(["release", "--confirmed"]);
	assert.ok(versioned.isError && /no parsable version/.test(versioned.content[0].text), "default release still demands the version bump");
	// unversioned still owes a changelog line: an untouched one is a refusal
	const cold = await flow(["release", "--no-version", "--confirmed"]);
	assert.ok(cold.isError && /unchanged on this branch/.test(cold.content[0].text), "an unversioned release must change the changelog");
	const wt = path.join(repo, ".dev-flow", "nv", "worktree");
	writeFileSync(path.join(wt, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- nv ships\n");
	const r = await flow(["release", "--no-version", "--confirmed"]);
	assert.match(r.content[0].text, /unversioned: no bump or tag; your changelog entry rides under Unreleased/);
	const st = JSON.parse(readFileSync(path.join(repo, ".dev-flow", "nv", "state.json"), "utf8"));
	assert.equal(st.noVersion, true, "the mode is persisted for release-done");
	const rd = await flow(["release-done", "--confirmed"]);
	assert.match(rd.content[0].text, /release recorded as complete \(unversioned — the changelog entry ships under Unreleased; the next versioned release folds it\)/);
});

test("release-done publishes the version the release gate stamped, and refuses to go behind origin (#52)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	const origin = mkdtempSync(path.join(tmpdir(), "devflow-origin-"));
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	const ctx = { cwd: repo, hasUI: true, notices: [] as string[], ui: { notify: () => {}, confirm: async () => false, setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } } };
	const flow = (args: string[]) => pi.tools.flow.execute("id", { args }, undefined, undefined, ctx) as Promise<{ content: [{ text: string }]; isError?: boolean }>;
	const git = (args: string[], dir = repo) => execFileSync("git", ["-C", dir, ...args]);
	const ship = async (slug: string, ver: string) => {
		await flow(["start", slug]);
		mkdirSync(path.join(repo, ".dev-flow", slug, "plan"), { recursive: true });
		writeFileSync(path.join(repo, ".dev-flow", slug, "plan", "plan.md"), "# plan\n");
		await flow(["approve", "--confirmed"]);
		commitWt(repo, slug);
		await flow(["verify", "--confirmed"]);
		const wt = path.join(repo, ".dev-flow", slug, "worktree");
		writeFileSync(path.join(wt, "package.json"), `{"name":"t","version":"${ver}"}`); // the bump lives on the branch
		writeFileSync(path.join(wt, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${ver}]\n- shipped\n`); // the gate wants the version mentioned
		git(["add", "-A"], wt);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `bump ${ver}`], wt);
		assert.match((await flow(["release", "--confirmed"])).content[0].text, /release approved/);
		git(["merge", "-q", "--ff", `feat/${slug}`]);
		git(["push", "-q", "origin", "main"]);
		git(["-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", `v${ver}`, "-m", `v${ver} notes (with parens)`]);
		git(["push", "-q", "origin", `refs/tags/v${ver}`]);
	};
	// the artifact probe only passes for 9.9.9: it proves which version release-done actually published
	await flow(["init", "--write", "# dev-flow\n\n## release\n\n```flow\nversionFile = package.json\nversionTag = v{version}\nreleases = false\nartifact = test \"{version}\" = 9.9.9\n```\n"]);
	await ship("ahead", "9.9.9");
	writeFileSync(path.join(repo, "package.json"), '{"name":"t","version":"0.1.0"}'); // the #52 shape: the main checkout is still behind
	const done = await flow(["release-done", "--confirmed"]);
	assert.match(done.content[0].text, /Artifact verified for 9\.9\.9\./, `a stale checkout must not change what is published: ${done.content[0].text}`);
	assert.equal(JSON.parse(readFileSync(path.join(repo, ".dev-flow", "ahead", "state.json"), "utf8")).releaseVersion, "9.9.9", "the gate's version is the version of record");

	git(["checkout", "-q", "--", "package.json"]);
	git(["tag", "-d", "v9.9.9"]); // only origin knows about it now: the clone must not get to decide
	await ship("behind", "9.9.8");
	const refuse = await flow(["release-done", "--confirmed"]);
	assert.ok(refuse.isError, "a release behind the forge is not a release");
	assert.match(refuse.content[0].text, /v9\.9\.9 is already tagged — refusing to release v9\.9\.8 behind it/);
});

test("tagNotesCommand prints an annotated tag's body through /bin/sh (#51)", () => {
	const repo = makeRepo();
	const body = "notes with (parens), $HOME, `touch pwned`, $(touch pwned2) and ; semicolons"; // the payloads that executed or killed releases when the notes were quoted on the way in but not the way out
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", "v1.0.0", "-m", body]);
	const out = execFileSync("/bin/sh", ["-c", tagNotesCommand("v1.0.0")], { cwd: repo, encoding: "utf8" }).trim();
	assert.equal(out, body, "the format must be quoted — an unquoted %(contents) is a /bin/sh syntax error");
	assert.ok(!existsSync(path.join(repo, "pwned")) && !existsSync(path.join(repo, "pwned2")), "code spans and substitutions stay literal argument text");
});

test("the playbook tracking chore is legal on the default branch (#53)", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n\n## implement\n\n```flow\ntest = node --version\n```\n");
	const ctx = makeCtx(repo);
	const guard = (command: string) => pi.handlers.tool_call[0]({ toolName: "bash", input: { command, timeout: 60 } }, ctx);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
	git("add", "-f", ".dev-flow/project.md");
	assert.equal(await guard('DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"'), undefined, "its only content is the operator's playbook — setup, not feature work");
	writeFileSync(path.join(repo, "notes.txt"), "something else is dirty\n");
	assert.match((await guard('DEV_FLOW_ALLOW_MAIN=1 git commit -m "track project.md"'))?.reason ?? "", /direct commits to main/, "any other dirty path closes the lane");
});

test("threshold compaction takeover: flow-aware compact() returned as custom compaction; pi's own on failure", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n");
	const ctx = makeCtx(repo);
	await pi.cmds.flow.handler("start demo-feature", ctx);
	const takeover = pi.handlers.session_before_compact[0] as unknown as (
		e: { reason: string; preparation?: unknown; signal?: AbortSignal },
		c: unknown,
	) => Promise<{ cancel?: boolean; compaction?: { summary: string } } | undefined>;
	// never ctx.compact here — awaiting it inside this hook deadlocks the run (compact() starts with abort + waitForIdle)
	const mk = () => ({
		event: { reason: "threshold", preparation: { firstKeptEntryId: "keep-me", tokensBefore: 123 }, signal: new AbortController().signal },
		c: { ...ctx, model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: { h: "1" }, env: { E: "x" } }) } },
	});
	const orig = compactionTakeover.run;
	try {
		const calls: Record<string, unknown>[] = [];
		compactionTakeover.run = (async (preparation: { firstKeptEntryId: string; tokensBefore: number }, _m: unknown, apiKey: string, headers: unknown, instructions: string, signal: unknown) => {
			calls.push({ preparation, apiKey, headers, instructions, signal });
			return { summary: "flow-aware summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore };
		}) as typeof compactionTakeover.run;
		const t = mk();
		const res = await takeover(t.event, t.c);
		assert.equal(res?.compaction?.summary, "flow-aware summary", "our summary lands via the custom-compaction channel — no cancel dance, no re-entry");
		assert.equal(res?.cancel, undefined, "pi appends the returned compaction itself — nothing to cancel");
		assert.match(String(calls[0].instructions), /demo-feature/, "the summary carries the flow-aware instructions");
		assert.equal(calls[0].apiKey, "k", "request-time auth is resolved and forwarded");
		assert.equal(calls[0].signal, t.event.signal, "the event's abort signal is forwarded — Stop really cancels the summarize call");
		compactionTakeover.run = (async () => {
			throw new Error("boom");
		}) as typeof compactionTakeover.run;
		assert.equal(await takeover(mk().event, mk().c), undefined, "a failed takeover must NOT cancel pi's own compaction");
		compactionTakeover.run = (async (preparation: { firstKeptEntryId: string; tokensBefore: number }) => ({ summary: "retry", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore })) as typeof compactionTakeover.run;
		assert.equal((await takeover(mk().event, mk().c))?.compaction?.summary, "retry", "the failed takeover released the in-flight mark — the next one is not skipped");
	} finally {
		compactionTakeover.run = orig;
	}
	assert.equal(await takeover({ reason: "manual" }, mk().c), undefined, "/compact stays the operator's");
	assert.equal(await takeover({ reason: "overflow" }, mk().c), undefined, "overflow keeps pi's compact-and-retry");
});

test("turn_end compaction check survives a broken compaction setting", async () => {
	const pi = makePi();
	const repo = makeRepo();
	mkdirSync(path.join(repo, ".dev-flow"), { recursive: true });
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n");
	mkdirSync(path.join(repo, ".pi"));
	writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: "bogus" } }));
	const ctx = makeCtx(repo);
	await pi.cmds.flow.handler("start demo-feature", ctx);
	const c = { ...ctx, getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 }), compact: () => { throw new Error("must not fire"); } };
	await (pi.handlers.turn_end[0] as unknown as (e: unknown, c: unknown) => Promise<void>)({}, c); // must not reject
});

test("shell calls must state their timeout by default; bashTimeout = inject restores the silent arming", async () => {
	// one bash tool_call against a repo: the verdict plus the input the handler may have armed
	const run = async (cwd: string, command: string, timeout?: number) => {
		const pi = makePi();
		const input: { command: string; timeout?: number } = { command };
		if (timeout !== undefined) input.timeout = timeout;
		return { verdict: await pi.handlers.tool_call[0]({ toolName: "bash", input }, makeCtx(cwd)), input };
	};
	const init = (repo: string, md: string) => {
		const pi = makePi();
		const ctx = makeCtx(repo);
		return { pi, ctx, seed: pi.tools.flow.execute("id", { args: ["init", "--write", md] }, undefined, undefined, ctx) };
	};
	// 1. no .dev-flow at all: no playbook to opt out with, so the hard default rules
	const bare = makeRepo();
	assert.match(((await run(bare, "git status")).verdict as { reason: string }).reason, /class default here is 30s/, "a bare call is refused with the number it should have said");
	assert.equal((await run(bare, "git status", 45)).verdict, undefined, "an explicit timeout passes untouched");
	// 2. a playbook with no bashTimeout key: require is the default
	const plain = init(makeRepo(), TEST_MD);
	await plain.seed;
	assert.match(((await run(plain.ctx.cwd, "git status")).verdict as { reason: string }).reason, /class default here is 30s/, "no key means the model must state it");
	// 3. the same playbook opting back to inject: the call runs and the default is armed silently
	const inj = init(makeRepo(), TEST_MD.replace("## implement", "## global\n```flow\nbashTimeout = inject\n```\n\n## implement"));
	await inj.seed;
	assert.equal(await inj.pi.handlers.tool_call[0]({ toolName: "bash", input: { command: "git status" } }, inj.ctx), undefined, "inject: the bare call runs");
	const armed = { command: "git status" } as { command: string; timeout?: number };
	await inj.pi.handlers.tool_call[0]({ toolName: "bash", input: armed }, inj.ctx);
	assert.equal(armed.timeout, 30, "and the class default lands on the call input — that is what arms pi\u0027s kill timer");
});
