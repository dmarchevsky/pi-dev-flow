import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactWait, awaitArtifact, type TagRun } from "../src/runtime/ship.ts";

/** Fake clock + CI: each sleep advances time; `script(t)` says what the tag's runs look like at time t
 *  and may publish the artifact (create the file the probe tests for). */
async function withFakeCi(script: (t: number, publish: () => void) => TagRun[] | null, fn: (cmd: string, publish: () => void) => Promise<void>) {
	const dir = mkdtempSync(path.join(tmpdir(), "artwait-"));
	const marker = path.join(dir, "published");
	const saved = { ...artifactWait };
	let t = 0;
	artifactWait.clock = () => t;
	artifactWait.sleep = async (ms) => { t += ms; };
	artifactWait.runs = async () => script(t, () => writeFileSync(marker, ""));
	try {
		await fn(`test -f ${JSON.stringify(marker)}`, () => writeFileSync(marker, ""));
	} finally {
		Object.assign(artifactWait, saved);
	}
}

const run = (status: string, conclusion = ""): TagRun => ({ status, conclusion, url: "https://ci/run/1", workflowName: "Publish images" });
const MIN = 60_000;

test("awaitArtifact waits for the publish run the tag started, then verifies (gh#179)", async () => {
	await withFakeCi((t, publish) => {
		if (t < 4 * MIN) return [run("in_progress")];
		publish();
		return [run("completed", "success")];
	}, async (cmd) => {
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.equal(r.ok, true, r.waited);
		assert.match(r.waited, /after waiting \d+ min for the publish CI v1\.0\.0 started/);
	});
});

test("awaitArtifact: an artifact already there answers at once, with no wait note", async () => {
	await withFakeCi(() => [], async (cmd, publish) => {
		publish();
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.deepEqual([r.ok, r.waited], [true, ""]);
	});
});

test("awaitArtifact names a failed publish run instead of waiting on", async () => {
	await withFakeCi(() => [run("completed", "failure")], async (cmd) => {
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.equal(r.ok, false);
		assert.match(r.waited, /did not pass — Publish images: failure \(https:\/\/ci\/run\/1\)/);
	});
});

test("awaitArtifact gives up on a run still going after the budget, pointing at it", async () => {
	await withFakeCi(() => [run("in_progress")], async (cmd) => {
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.equal(r.ok, false);
		assert.match(r.waited, /still running after 15 min \(Publish images: https:\/\/ci\/run\/1\) — re-run release-done once it finishes/);
	});
});

test("awaitArtifact: no run for the tag means nothing to wait for, after a short look", async () => {
	await withFakeCi(() => [], async (cmd) => {
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.equal(r.ok, false);
		assert.match(r.waited, /no CI run was started by v1\.0\.0/);
	});
});

test("awaitArtifact rides out a registry that lags the green run, and gh being unavailable keeps the plain result", async () => {
	await withFakeCi((t, publish) => {
		if (t >= 2 * MIN + 20_000) publish(); // visible 40 s after the run went green at 2 min
		return [t < 2 * MIN ? run("in_progress") : run("completed", "success")];
	}, async (cmd) => {
		assert.equal((await awaitArtifact(cmd, "v1.0.0", tmpdir())).ok, true);
	});
	await withFakeCi(() => null, async (cmd) => {
		const r = await awaitArtifact(cmd, "v1.0.0", tmpdir());
		assert.deepEqual([r.ok, r.waited], [false, ""]);
	});
});
