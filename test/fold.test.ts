/** Tests for the read-time fold: gh output parsing, dedupe keys, and the hint-only similarity. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	contentTokens,
	dedupeReflections,
	issueBodyTails,
	linkedTag,
	normKey,
	parseGhIssues,
	referencedIssues,
	similarNote,
	type GhIssue,
} from "../src/fold.ts";

const issue = (number: number, title: string, body = ""): GhIssue => ({ number, title, body });

test("parseGhIssues: clean JSON, empty list, and junk", () => {
	assert.deepEqual(parseGhIssues('[{"number":5,"title":"t","body":"b"}]'), [{ number: 5, title: "t", body: "b" }]);
	assert.deepEqual(parseGhIssues("[]"), [], "a clean empty list is [], not null");
	assert.equal(parseGhIssues("gh: error: authentication required"), null, "junk parses to null — the caller reports the skip");
	assert.equal(parseGhIssues('[{"number":5,"title":"t"'), null, "truncated stream is junk");
	assert.deepEqual(parseGhIssues('[{"title":"no number"},{"number":"x"},{"number":0}]'), [], "entries without a usable number are dropped");
	assert.deepEqual(parseGhIssues('{"number":5}'), null, "not an array");
});

test("normKey: backticks, quotes and dash kinds never decide a match", () => {
	const a = normKey("`flow check` cannot run — CI-only checks!");
	const b = normKey('flow check cannot run - CI-only checks');
	assert.equal(a, b);
});

test("referencedIssues: gh# and bare # references", () => {
	assert.deepEqual(referencedIssues("already upstream gh#120 — see #121 and gh#120"), [120, 121]);
	assert.deepEqual(referencedIssues("nothing numeric here"), []);
});

test("issueBodyTails: the text before the 'reflection from' filing tail", () => {
	const i = issue(1, "ignored title", "**Source:** release/finish stays silent — reflection from `my-flow` (2026-10-24), dogfood.\n\nMore prose.");
	assert.ok(issueBodyTails(i).includes(normKey("**Source:** release/finish stays silent")), `got ${JSON.stringify(issueBodyTails(i))}`);
	assert.deepEqual(issueBodyTails(issue(2, "t", "plain body, no tail")), []);
});

test("dedupe: title equality links, one link per issue, first item wins", () => {
	const items = [{ body: "test command is stale", line: "- [ ] test command is stale — x 2026-01-01" }, { body: "test command is stale", line: "- [ ] test command is stale — y 2026-01-02" }];
	const r = dedupeReflections(items, [issue(9, "test command is stale")]);
	assert.equal(r.linked.length, 1);
	assert.deepEqual({ ...r.linked[0] }, { item: 0, issue: 9, via: "title" });
	assert.deepEqual(r.upstreamOnly, []);
});

test("dedupe: an explicit #N reference beats title coincidence", () => {
	const items = [{ body: "the gate lies", line: "- [ ] the gate lies — see gh#7 — x 2026-01-01" }];
	const r = dedupeReflections(items, [issue(7, "totally other title"), issue(8, "the gate lies")]);
	assert.deepEqual({ ...r.linked[0] }, { item: 0, issue: 7, via: "ref" });
	assert.deepEqual(r.upstreamOnly.map((i) => i.number), [8]);
});

test("dedupe: body filing tail matches the local body", () => {
	const items = [{ body: "release stays silent about uncommitted paths", line: "- [ ] release stays silent about uncommitted paths — flow-slug 2026-10-24" }];
	const r = dedupeReflections(items, [issue(131, "different title", "release stays silent about uncommitted paths — reflection from `flow-slug` (2026-10-24).")]);
	assert.deepEqual({ ...r.linked[0] }, { item: 0, issue: 131, via: "body" });
});

test("dedupe: near-misses are hints, never links", () => {
	const items = [{ body: "npm install rewrites package lock file indentation tabs", line: "- [ ] npm install rewrites package lock file indentation tabs — x 2026-01-01" }];
	const r = dedupeReflections(items, [issue(4, "npm install rewrites package lock indentation to tabs")]);
	assert.equal(r.linked.length, 0, "a near miss is never auto-merged");
	assert.equal(r.similar.length, 1);
	assert.equal(r.similar[0].issue, 4);
	assert.ok(r.similar[0].score >= 0.6);
	assert.deepEqual(r.upstreamOnly.map((i) => i.number), [4], "the issue stays an upstream row");
});

test("dedupe: unrelated items and issues stay apart; short text is never guessed at", () => {
	const items = [{ body: "merge policy missing", line: "- [ ] merge policy missing — x 2026-01-01" }];
	const r = dedupeReflections(items, [issue(5, "health probe times out")]);
	assert.equal(r.linked.length, 0);
	assert.equal(r.similar.length, 0, "below SIM_MIN_TOKENS there is no hint");
	assert.deepEqual(r.upstreamOnly.map((i) => i.number), [5]);
});

test("contentTokens: stopwords and strays drop out", () => {
	const t = contentTokens("The gate is a door");
	assert.ok(t.has("gate") && t.has("door") && !t.has("the") && !t.has("a") && !t.has("is"));
});

test("render tags", () => {
	assert.equal(linkedTag(120), " ⟷ gh#120");
	assert.match(similarNote({ item: 2, issue: 132, score: 0.72 }, 3), /^~ gh#132 may duplicate local item 3 \(72% similar\)/);
});
