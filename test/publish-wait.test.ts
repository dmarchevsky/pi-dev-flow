import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { awaitPrChecks, checkBucket, publishWait, type PrCheck } from "../src/runtime/publish.ts";

/** Fake clock + CI: each sleep advances time; `script(t)` says what the PR's checks look like at time t. */
async function withFakeChecks(script: (t: number) => PrCheck[] | null, fn: () => Promise<void>) {
	const saved = { ...publishWait };
	let t = 0;
	publishWait.clock = () => t;
	publishWait.sleep = async (ms) => { t += ms; };
	publishWait.checks = async () => script(t);
	try {
		await fn();
	} finally {
		Object.assign(publishWait, saved);
	}
}

const ck = (name: string, bucket: string): PrCheck => ({ name, bucket, link: `https://ci/${name}` });
const MIN = 60_000;

test("awaitPrChecks waits for pending checks, then reports green with how long it waited", async () => {
	await withFakeChecks((t) => (t < 4 * MIN ? [ck("build", "pending"), ck("lint", "pass")] : [ck("build", "pass"), ck("lint", "pass"), ck("docs", "skipping")]), async () => {
		const r = await awaitPrChecks(7, tmpdir());
		assert.deepEqual(r, { state: "green", note: "CI green (3 checks, waited 4 min)" });
	});
});

test("awaitPrChecks: a failed or cancelled check is red at once, named with its link", async () => {
	await withFakeChecks(() => [ck("build", "fail"), ck("lint", "pending"), ck("e2e", "cancel")], async () => {
		const r = await awaitPrChecks(7, tmpdir());
		assert.equal(r.state, "red");
		assert.match("why" in r ? r.why : "", /PR #7 checks failed — build: fail \(https:\/\/ci\/build\), e2e: cancel \(https:\/\/ci\/e2e\)/);
	});
});

test("awaitPrChecks: a repo with no CI is given a minute for checks to appear, then passes as 'none'", async () => {
	let polls = 0;
	await withFakeChecks(() => { polls++; return []; }, async () => {
		assert.deepEqual(await awaitPrChecks(7, tmpdir()), { state: "none", note: "no CI checks on the PR" });
		assert.ok(polls > 1, "it looked more than once before deciding");
	});
	await withFakeChecks((t) => (t < 40_000 ? [] : [ck("build", "pass")]), async () => {
		assert.equal((await awaitPrChecks(7, tmpdir())).state, "green", "a check that shows up late is waited for");
	});
});

test("awaitPrChecks: the budget ends the wait with what is still running; gh that cannot answer is 'unknown'", async () => {
	await withFakeChecks(() => [ck("slow", "pending")], async () => {
		const r = await awaitPrChecks(7, tmpdir());
		assert.equal(r.state, "running");
		assert.match("why" in r ? r.why : "", /PR #7 checks still running after 30 min \(slow\)/);
	});
	await withFakeChecks(() => null, async () => {
		assert.equal((await awaitPrChecks(7, tmpdir())).state, "unknown");
	});
});

test("checkBucket reads GitHub's status rollup: check runs and commit statuses", () => {
	const run = (status: string, conclusion = "") => checkBucket({ __typename: "CheckRun", status, conclusion });
	assert.equal(run("COMPLETED", "SUCCESS"), "pass");
	assert.equal(run("COMPLETED", "SKIPPED"), "skipping");
	assert.equal(run("COMPLETED", "NEUTRAL"), "skipping");
	assert.equal(run("COMPLETED", "CANCELLED"), "cancel");
	assert.equal(run("COMPLETED", "TIMED_OUT"), "fail");
	assert.equal(run("QUEUED"), "pending");
	assert.equal(run("IN_PROGRESS"), "pending");
	assert.equal(checkBucket({ __typename: "StatusContext", state: "SUCCESS" }), "pass");
	assert.equal(checkBucket({ __typename: "StatusContext", state: "PENDING" }), "pending");
	assert.equal(checkBucket({ __typename: "StatusContext", state: "ERROR" }), "fail");
});
