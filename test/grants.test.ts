import { test } from "node:test";
import assert from "node:assert/strict";
import { grantCheck, grantRecord, isFriction, newGrantLedger, operatorMessageCount, type RefusalStreak } from "../src/runtime/grants.ts";

const user = { type: "message", message: { role: "user" } };
const agent = { type: "message", message: { role: "assistant" } };

test("operatorMessageCount counts user messages only, null when the branch cannot be read", () => {
	assert.equal(operatorMessageCount([user, agent, { type: "custom_message" }, user]), 2);
	assert.equal(operatorMessageCount(undefined), null);
});

test("a refused operator grant cannot be re-run with --confirmed until the operator speaks (gh#190)", () => {
	const l = newGrantLedger();
	grantRecord(["start", "x", "--patch"], "s", 3, { text: "patch mode is operator-granted — ask the operator, then re-run with --confirmed", isError: true }, l);
	assert.match(grantCheck(["start", "x", "--patch", "--confirmed"], "s", 3, l) ?? "", /^NEEDS-OPERATOR no operator message since flow start asked/);
	assert.equal(grantCheck(["start", "x", "--patch", "--confirmed"], "s", 4, l), null, "an operator message after the question lets it through");
	assert.equal(grantCheck(["start", "x", "--patch", "--confirmed"], "other", 3, l), null, "per session");
});

test("a NEEDS-OPERATOR question binds its own gate only, and a pass clears it", () => {
	const l = newGrantLedger();
	grantRecord(["verify"], "s", 5, { text: "NEEDS-OPERATOR Verified? — deployed for review", isError: true }, l);
	assert.ok(grantCheck(["verify", "--confirmed"], "s", 5, l));
	assert.equal(grantCheck(["approve", "--confirmed"], "s", 5, l), null);
	grantRecord(["verify", "--confirmed"], "s", 6, { text: "verified — entering pre-release stage." }, l);
	assert.equal(grantCheck(["verify", "--confirmed"], "s", 6, l), null);
});

test("a mode flag on a feature started this session needs an operator message after the start", () => {
	const l = newGrantLedger();
	grantRecord(["start", "nav"], "s", 1, { text: "feature nav started at stage plan (ui=false)" }, l);
	assert.match(grantCheck(["start", "nav", "--no-ui", "--confirmed"], "s", 1, l) ?? "", /--no-ui on nav is operator-granted, and the operator has said nothing since it started/);
	assert.equal(grantCheck(["start", "nav", "--no-ui", "--confirmed"], "s", 2, l), null);
	assert.equal(grantCheck(["start", "other", "--no-ui", "--confirmed"], "s", 1, l), null, "a different feature is a fresh start");
	assert.equal(grantCheck(["start", "nav", "--ui", "--confirmed"], "s", 1, l), null, "--ui only adds a gate: no grant needed");
});

test("an unreadable session is never checked, and a word given up front needs no prior question", () => {
	const l = newGrantLedger();
	grantRecord(["start", "x", "--patch"], "s", null, { text: "patch mode is operator-granted", isError: true }, l);
	assert.equal(grantCheck(["start", "x", "--patch", "--confirmed"], "s", null, l), null);
	assert.equal(grantCheck(["approve", "--confirmed"], "s", 2, l), null);
});

test("Dev port? answers (--replace, --port=<n>) bind like --confirmed (gh#203)", () => {
	const l = newGrantLedger();
	grantRecord(["verify"], "s", 4, { text: "NEEDS-OPERATOR Dev port? — port 8090 is serving pa", isError: true }, l);
	assert.match(grantCheck(["verify", "--replace"], "s", 4, l) ?? "", /^NEEDS-OPERATOR no operator message since flow verify asked for their word — --replace records/);
	assert.match(grantCheck(["verify", "--port=8091"], "s", 4, l) ?? "", /--port=8091 records the operator's answer/);
	assert.equal(grantCheck(["verify", "--replace"], "s", 5, l), null, "an operator message after the question lets it through");
	assert.equal(grantCheck(["verify"], "s", 4, l), null, "a plain re-run carries no answer");
	const fresh = newGrantLedger();
	assert.equal(grantCheck(["verify", "--replace"], "s", 4, fresh), null, "a word given up front needs no prior question");
});

test("a refusal says a word given before it does not count (gh#206)", () => {
	const l = newGrantLedger();
	grantRecord(["start", "x", "--docs"], "s", 3, { text: "docs mode is operator-granted — ask", isError: true }, l);
	assert.match(grantCheck(["start", "x", "--docs", "--confirmed"], "s", 3, l) ?? "", /A word given before the question does not count/);
});

test("isFriction: a red check is the tool doing its job; a process refusal, a self-grant or a gate stuck twice is friction", () => {
	const st: RefusalStreak = new Map();
	const err = (text: string) => ({ text, isError: true });
	assert.equal(isFriction(["check"], "s", err("tier-1 checks:\ntest: FAIL (npm test)"), false, st), false, "red tests are not friction");
	assert.equal(isFriction(["check"], "s", err("tier-1 checks:\ntest: FAIL (npm test)"), false, st), false, "however often they are red");
	assert.equal(isFriction(["test"], "s", err("test: FAIL (npm test)\nboom"), false, st), false);
	assert.equal(isFriction(["check"], "s", err("no tier-1 checks configured — add flow blocks"), false, st), true, "a check that could not run is a playbook gap");
	assert.equal(isFriction(["approve"], "s", err("NEEDS-OPERATOR Approve? — the plan is waiting"), false, st), false, "a question is not friction");
	assert.equal(isFriction(["approve", "--confirmed"], "s", err("NEEDS-OPERATOR no operator message since flow approve asked"), true, st), true, "a self-granted answer is");
	assert.equal(isFriction(["verify", "--confirmed"], "s", err('verify gate FAILED:\n- stage is "plan", verify only applies to "implement"'), false, st), true, "a process refusal is");
	const st2: RefusalStreak = new Map();
	assert.equal(isFriction(["verify"], "s", err("build FAILED (npm run build):\nboom"), false, st2), false, "a broken build found at the gate is work, once");
	assert.equal(isFriction(["verify"], "s", err("dev deploy FAILED (make dev):\nboom"), false, st2), true, "the same gate refusing again is the agent stuck on it");
	assert.equal(isFriction(["verify"], "s", { text: "NEEDS-OPERATOR Verified?" }, false, st2), false);
	assert.equal(isFriction(["verify"], "s", err("build FAILED (npm run build):\nboom"), false, st2), false, "a pass in between resets the streak");
	assert.equal(isFriction(["verify"], "other", err("build FAILED (x)"), false, st2), false, "per session");
	assert.equal(isFriction(["finish"], "f", err('finish blocked — after-merge check "deployed" failed in the main checkout (make x); nothing was removed:'), false, new Map()), false, "a red after-merge check is work too");
});

test("isFriction: the release gate waiting on CI is never friction; a red PR check is a work failure", () => {
	const streak: RefusalStreak = new Map();
	const waiting = { text: "release approved — entering release stage.\npublish waiting — PR #7 checks still running after 30 min (build)", isError: true };
	assert.equal(isFriction(["release"], "s", waiting, false, streak), false);
	assert.equal(isFriction(["release"], "s", waiting, false, streak), false, "however often it is re-run");
	const red = { text: "publish stopped — PR #7 checks failed — build: fail", isError: true };
	assert.equal(isFriction(["release"], "s", red, false, streak), false, "one red run is the work failing");
	assert.equal(isFriction(["release"], "s", red, false, streak), true, "twice in a row is the agent stuck");
	assert.equal(isFriction(["release"], "t", { text: "publish stopped — merging PR #7 failed", isError: true }, false, new Map()), true, "a process stop counts");
});
