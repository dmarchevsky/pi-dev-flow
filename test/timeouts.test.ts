import assert from "node:assert/strict";
import { test } from "node:test";
import { bashTimeout, BUILD_S, CLAMP_S, DEFAULT_S, LOCAL_GIT_S, NETWORK_S, QUICK_S, requireTimeout, SERVICE_S, WATCH_S } from "../src/timeouts.ts";

const cases: [string, number][] = [
	// quick inspection
	["ls -la", QUICK_S],
	["grep -rn foo src/", QUICK_S],
	["cat package.json | head -20", QUICK_S],
	["git status -s && git diff --stat", QUICK_S],
	["rg timeout src", QUICK_S],
	// local git
	["git add -A && git commit -m 'feat: x'", LOCAL_GIT_S],
	["git worktree add ../wt && git switch -c br", LOCAL_GIT_S],
	// network
	["git push origin main", NETWORK_S],
	["curl -s localhost:11435/ui/", NETWORK_S],
	["gh pr merge 42 --squash", NETWORK_S],
	["ssh host uptime", NETWORK_S],
	// services / containers
	["docker compose up -d web", SERVICE_S],
	["systemctl --user restart pi-web", SERVICE_S],
	["docker logs lettuce-bff-1 --since 10m", SERVICE_S],
	// builds, tests, installs
	["npm test", BUILD_S],
	["cd repo && cargo test --release", BUILD_S],
	["bun install", BUILD_S],
	["flow check", BUILD_S],
	["docker build -t x .", BUILD_S],
	["docker compose -f docker/compose.yml build bff", BUILD_S],
	// watchers run until done — biggest ceiling
	["gh run watch 123 --exit-status --interval 10", WATCH_S],
	["docker compose -f docker/compose.yml up", WATCH_S],
	["docker logs -f app", WATCH_S],
	["tail -f /var/log/sys.log", WATCH_S],
	// unrecognized falls to the default
	["python3 analyze.py", DEFAULT_S],
	["./scripts/deploy.sh", DEFAULT_S],
	// wrappers never decide the class alone
	["cd /tmp", DEFAULT_S],
	// compound: slowest class wins
	["git status && docker build -t x . ", BUILD_S],
	["cd repo && bun install && bun test", BUILD_S],
	// explicit values are honored
	["ls", QUICK_S],
];

test("class defaults per table", () => {
	for (const [cmd, want] of cases) assert.equal(bashTimeout(cmd), want, `bashTimeout(${JSON.stringify(cmd)})`);
});

test("explicit timeouts are kept, absurd ones clamped", () => {
	assert.equal(bashTimeout("sleep 5 && ls", 10), 10);
	assert.equal(bashTimeout("npm test", 600), 600);
	assert.equal(bashTimeout("npm test", 7200), CLAMP_S);
	assert.equal(bashTimeout("ls", 3600), CLAMP_S);
	// invalid explicit values (pi validates, but never hand it undefined/NaN) fall back to the class
	assert.equal(bashTimeout("npm test", 0), BUILD_S);
	assert.equal(bashTimeout("npm test", NaN), BUILD_S);
});

test("watcher ceilings beat their own head class", () => {
	assert.equal(bashTimeout("docker compose up -d"), SERVICE_S); // detached up is a service call
	assert.equal(bashTimeout("journalctl -u app -f"), WATCH_S);
});

test("env prefixes and sudo do not hide the class", () => {
	assert.equal(bashTimeout("LETTA=1 git push origin main"), NETWORK_S);
	assert.equal(bashTimeout("sudo tailscale serve --https=443 http://127.0.0.1:30141"), DEFAULT_S);
	assert.equal(bashTimeout("export PATH=$HOME/.cargo/bin:$PATH && cargo test"), BUILD_S);
});

test("requireTimeout: an explicit timeout passes, a missing one is refused with its class value", () => {
	assert.equal(requireTimeout("grep -rn x src", 12), undefined, "the model said 12 — nothing to refuse");
	assert.equal(requireTimeout("npm test", 99999), undefined, "an absurd explicit value is the clamp's business, not the refusal's");
	assert.equal(requireTimeout("npm test", 0), "pass an explicit timeout on shell calls — the class default here is 900s (it is armed silently either way; saying it makes it visible in the transcript)", "0 is not an explicit timeout");
	// the reason must carry the exact number the injection would have armed — the retry is then a one-token fix
	assert.match(requireTimeout("git push origin main") ?? "", /class default here is 180s/);
	assert.match(requireTimeout("ls") ?? "", /class default here is 30s/);
});
