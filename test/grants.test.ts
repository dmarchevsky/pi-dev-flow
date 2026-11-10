import { test } from "node:test";
import assert from "node:assert/strict";
import { grantCheck, grantRecord, newGrantLedger, operatorMessageCount } from "../src/runtime/grants.ts";

const user = { type: "message", message: { role: "user" } };
const agent = { type: "message", message: { role: "assistant" } };

test("operatorMessageCount counts user messages only, null when the branch cannot be read", () => {
	assert.equal(operatorMessageCount([user, agent, { type: "custom_message" }, user]), 2);
	assert.equal(operatorMessageCount(undefined), null);
});

test("a refused operator grant cannot be re-run with --confirmed until the operator speaks (gh#190)", () => {
	const l = newGrantLedger();
	grantRecord(["start", "x", "--ui"], "s", 3, { text: "--ui is operator-granted — ask the operator, then re-run with --confirmed", isError: true }, l);
	assert.match(grantCheck(["start", "x", "--ui", "--confirmed"], "s", 3, l) ?? "", /^NEEDS-OPERATOR no operator message since flow start asked/);
	assert.equal(grantCheck(["start", "x", "--ui", "--confirmed"], "s", 4, l), null, "an operator message after the question lets it through");
	assert.equal(grantCheck(["start", "x", "--ui", "--confirmed"], "other", 3, l), null, "per session");
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
	assert.match(grantCheck(["start", "nav", "--ui", "--confirmed"], "s", 1, l) ?? "", /--ui on nav is operator-granted, and the operator has said nothing since it started/);
	assert.equal(grantCheck(["start", "nav", "--ui", "--confirmed"], "s", 2, l), null);
	assert.equal(grantCheck(["start", "other", "--ui", "--confirmed"], "s", 1, l), null, "a different feature is a fresh start");
});

test("an unreadable session is never checked, and a word given up front needs no prior question", () => {
	const l = newGrantLedger();
	grantRecord(["start", "x", "--ui"], "s", null, { text: "--ui is operator-granted", isError: true }, l);
	assert.equal(grantCheck(["start", "x", "--ui", "--confirmed"], "s", null, l), null);
	assert.equal(grantCheck(["approve", "--confirmed"], "s", 2, l), null);
});
