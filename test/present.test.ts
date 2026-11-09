import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, newState, type Config } from "../src/core.ts";
import { agentText, askOf, commandish, operatorCommandAsks, presentGate, renderPlain, splitLine, stageLine } from "../src/present.ts";

const cfg: Config = { ...DEFAULTS, release: { ...DEFAULTS.release, merge: "merge" } };

test("splitLine keeps the fact and hands the instruction to the agent", () => {
	const s = splitLine("- test has not passed — run flow check");
	assert.equal(s.user, "- test has not passed");
	assert.deepEqual(s.agent, ["run flow check"]);
	assert.deepEqual(splitLine("plain fact, no command"), { user: "plain fact, no command", agent: [] });
	assert.deepEqual(splitLine("↪ ask Verified? and run flow verify --confirmed"), { user: "", agent: ["ask Verified? and run flow verify --confirmed"] });
	assert.equal(splitLine("- run flow check first").user, "", "a bullet that is only an instruction disappears");
});

test("commandish recognises flow verbs, gate flags, the worker tool and the slash command", () => {
	for (const s of ["run flow verify", "`flow approve --confirmed`", "re-run with --confirmed", "flow_stage({ op })", "type /flow status"]) assert.ok(commandish(s), s);
	for (const s of ["the flow is at implement", "dev-flow 0.85.1", "workflow green"]) assert.ok(!commandish(s), s);
});

test("askOf reads the NEEDS-OPERATOR question, else the pending checkpoint", () => {
	assert.equal(askOf("NEEDS-OPERATOR Verified? — deployed for review", null), "Verified?");
	assert.equal(askOf("NEEDS-OPERATOR — no UI", null), "your decision");
	const st = newState("x", false);
	st.pendingAsk = "Approve?";
	assert.equal(askOf("plan ready", st), "Approve?");
});

test("stageLine is built from state with provenance marks", () => {
	const st = newState("dark-mode", true);
	assert.equal(stageLine(st, cfg, { plan: "written", mockups: { rendered: 2, total: 2 } }), "**📝 plan · `dark-mode`** — `normal` ✓playbook · ui `on` ✓ · plan `written` ~ · mockups `2/2` ~");
	st.stage = "pre-release";
	st.branch = "feat/dark-mode";
	st.checks = { test: { ok: true, at: "" } as never };
	const line = stageLine(st, cfg, { ahead: 3, uncommitted: 0, head: "abcdef123", manifest: "1.2.0" });
	assert.match(line, /🔍 pre-release · `dark-mode`/);
	assert.match(line, /commits `3 ahead, 0 uncommitted`/);
	assert.match(line, /checks test ✓/);
	assert.match(line, /version `1\.2\.0` ~/);
	assert.match(line, /merge `merge` ✓playbook/);
	assert.match(line, /`feat\/dark-mode@abcdef1`/);
	st.yolo = true;
	st.noVersion = true;
	assert.match(stageLine(st, cfg), /`dark-mode` 🎱\*\*.*version `no-version` ✓/);
});

test("presentGate: the operator view carries no command; the agent copy keeps every instruction", () => {
	const st = newState("dark-mode", false);
	st.stage = "implement";
	const text = "NEEDS-OPERATOR Verified? — deployed for review on port 5173 — look at it yourself, then ask the operator Verified? in chat and run flow verify --confirmed once they answer\nbuild ran (npm run build)";
	const v = presentGate("verify", text, false, st, cfg);
	assert.equal(v.ask, "Verified?");
	assert.equal(v.title, "Verification");
	for (const l of [...v.lines, renderPlain(v)]) assert.ok(!commandish(l), l);
	assert.ok(v.lines.some((l) => l.includes("deployed for review on port 5173")));
	assert.ok(v.agent.some((l) => l.includes("flow verify --confirmed")));
	const agent = agentText(text, v);
	assert.ok(agent.startsWith(text));
	assert.match(agent, /stage line for your report/);
	const refused = presentGate("verify", "verify gate FAILED:\n- test has not passed — run flow check", true, st, cfg);
	assert.equal(refused.ok, false);
	assert.match(renderPlain(refused), /❌ Verification refused · dark-mode/);
});

test("operatorCommandAsks flags a message that hands the operator a command, not one reporting what the agent ran", () => {
	assert.equal(operatorCommandAsks("Plan is ready. Please run `/flow approve` when happy.").length, 1);
	assert.equal(operatorCommandAsks("You can type flow verify --confirmed to continue.").length, 1);
	assert.equal(operatorCommandAsks("I ran flow check and everything is green. Verified?").length, 0);
	assert.equal(operatorCommandAsks("Output:\n```\nflow verify --confirmed\n```\nVerified?").length, 0);
	assert.equal(operatorCommandAsks("- ***Run `flow verify`*** — it deploys the stack.").length, 1);
});

test("operatorCommandAsks leaves reports alone: generic CLI flags, verbs inside inline code, other clauses, reflection rows", () => {
	// every one of these drew a correction in real sessions
	const reports = [
		"- **From `main`, clean tree:** pulled to `b283c97`, `bun run build`, `bun run build:bff`, `docker compose up -d --no-deps bff`, then `bun run deploy-check` green.",
		"- `flow check`: `bun run verify` PASS; build + dev deploy + health PASS; **the container now serves this branch**.",
		"*yolo* — docs mode granted and both gates run back to back without another word, `flow finish` included.",
		"- `flow verify` state holds: stack healthy on 8090 — you can use the **Lens QA** agent for your own click-through.",
		"**[fold · docs]** Release tail order drifted: deploy-check from `main` should run *before* `flow finish`.",
		"F1 | fold | plugin | flow release-done's artifact gate failed while the publish CI was running; use the run list to wait | dup: gh#179",
		"Merged with `gh pr merge 103 --merge` and pushed the tag.",
	];
	for (const r of reports) assert.deepEqual(operatorCommandAsks(r), [], r);
});
