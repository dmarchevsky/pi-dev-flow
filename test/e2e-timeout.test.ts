/**
 * End to end through a real pi session: the timeout dev-flow arms on a bash call that states none is the
 * one pi kills it with, and the result says it was dev-flow's. The smoke suite only proves the hook
 * mutated its event — this proves the host still honours that mutation (it is the whole mechanism:
 * pi arms its kill timer only when the call carries a timeout).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import devFlow, { testSeams } from "../extensions/dev-flow.ts";

async function runBash(args: { command: string; timeout?: number }) {
	const base = mkdtempSync(path.join(tmpdir(), "devflow-e2e-"));
	const repo = path.join(base, "repo");
	const agentDir = path.join(base, "agent");
	mkdirSync(agentDir);
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	mkdirSync(path.join(repo, ".dev-flow"));
	writeFileSync(path.join(repo, ".dev-flow", "project.md"), "# dev-flow\n\n## release\n\n```flow\nmerge = any\n```\n");
	const id = ["-c", "user.email=t@t", "-c", "user.name=t"];
	execFileSync("git", ["-C", repo, ...id, "add", "-A"]);
	execFileSync("git", ["-C", repo, ...id, "commit", "-qm", "init"]);
	const faux = fauxProvider({ models: [{ id: "faux-e2e" }] });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", args)], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const loader = new DefaultResourceLoader({ cwd: repo, agentDir, extensionFactories: [{ name: "dev-flow", factory: devFlow }], noSkills: true, noContextFiles: true });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: repo, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(repo) });
	let result = { text: "", isError: false };
	session.subscribe((e) => {
		if (e.type !== "tool_execution_end") return;
		const content = (e.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
		result = { text: content.map((c) => c.text ?? "").join(""), isError: !!e.isError };
	});
	const t0 = Date.now();
	await session.prompt("go");
	const elapsed = (Date.now() - t0) / 1000;
	rmSync(base, { recursive: true, force: true });
	return { ...result, elapsed };
}

test("a bash call with no timeout is killed at dev-flow's armed default, and the result says so", async () => {
	testSeams.bashTimeout.cap = 2;
	try {
		const r = await runBash({ command: `awk 'BEGIN{system("sleep 20")}'` });
		assert.ok(r.isError, r.text);
		assert.match(r.text, /Command timed out after 2 seconds/, "pi armed the timeout the hook set");
		assert.match(r.text, /\[dev-flow\] stopped at 2s: dev-flow's default for quick commands, armed because the call stated no timeout/, r.text);
		assert.ok(r.elapsed < 15, `killed at the cap, not after the command's 20s (${r.elapsed}s)`);
	} finally {
		testSeams.bashTimeout.cap = undefined;
	}
});

test("a call that states its own timeout is killed by it, and dev-flow adds nothing", async () => {
	testSeams.bashTimeout.cap = 2; // would shorten only the silent default
	try {
		const r = await runBash({ command: `awk 'BEGIN{system("sleep 20")}'`, timeout: 3 });
		assert.match(r.text, /Command timed out after 3 seconds/, "the explicit value stands");
		assert.ok(!/\[dev-flow\]/.test(r.text), "the agent chose that cap — no note");
	} finally {
		testSeams.bashTimeout.cap = undefined;
	}
});

test("the kill note names a wrapper's own timeout when that is what set the cap", async () => {
	const { timeoutKillNote } = await import("../extensions/dev-flow.ts");
	assert.equal(timeoutKillNote({ s: 615, cls: "its own timeout 600" }), "[dev-flow] stopped at 615s: the command's timeout 600 plus a 15s margin — it outlived its own timer. If it needs longer, rerun with an explicit timeout (seconds) on the call.");
});
