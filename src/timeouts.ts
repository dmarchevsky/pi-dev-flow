/**
 * Deterministic default timeouts for shell tool calls (bash-tool-timeouts).
 *
 * pi arms its kill timer only when a timeout is passed, and the model omits it
 * in ~75% of calls — observed hangs ran for hours (interactive prompts, hung
 * network). The class defaults below come from this host's session logs:
 * 99% of no-timeout calls finish under ~70s (p99=66s), real builds under ~400s,
 * so these ceilings sit at a comfortable multiple and a premature kill is
 * self-correcting — the model sees `timeout:` and reruns with an explicit value.
 *
 * Pure module — no pi imports so it is unit-testable with `node --test`.
 */
import { bashSegments } from "./core.ts";

export const QUICK_S = 30;
export const LOCAL_GIT_S = 120;
export const NETWORK_S = 180;
export const SERVICE_S = 300;
export const BUILD_S = 900;
export const WATCH_S = 1200;
export const DEFAULT_S = 120;
export const CLAMP_S = 1800;

// heads that also appear as subcommand-sensitive tools are handled by name below
const QUICK = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "which", "whereis", "echo", "printf", "true", "find", "rg", "grep", "fgrep", "egrep", "sort", "uniq", "cut", "awk", "sed", "jq", "stat", "file", "du", "df", "date", "uname", "id", "tree", "diff", "comm"]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "rsync", "gh", "nc"]);
const SERVICE = new Set(["docker", "podman", "kubectl", "systemctl", "service", "journalctl", "helm"]);
const BUILD = new Set(["make", "cargo", "go", "tsc", "pytest", "gradle", "mvn", "cmake", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "node", "flow"]);
const GIT_QUICK = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "ls-tree", "remote", "describe", "blame", "shortlog", "config", "help", "version"]);
const GIT_NETWORK = new Set(["push", "pull", "fetch", "clone", "ls-remote", "submodule", "request-pull"]);
// wrappers/prefixes that never decide the class of a segment
const SKIP_HEADS = new Set(["cd", "export", "source", ".", "set", "unset", "if", "then", "else", "fi", "do", "done", "while", "for", "case", "esac", "{", "}", "(", "!", "test", "[[", "time", "nohup", "env", "command", "sudo"]);

/** Margin over a command's own `timeout N`: the shell's timer fires first, with its own message;
 *  dev-flow's kill stays the backstop. */
export const WRAPPER_MARGIN_S = 15;

/** `timeout`'s options that take a value as the next token (`-s KILL`, `-k 5`). */
const TIMEOUT_VALUE_OPTS = new Set(["-s", "--signal", "-k", "--kill-after"]);

/** A coreutils duration (`600`, `90s`, `2m`, `1.5h`, `1d`) in seconds; null when unreadable or 0 (= no limit). */
function parseDuration(tok: string): number | null {
	const m = tok.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
	if (!m) return null;
	const n = Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
	return n > 0 ? Math.ceil(n) : null;
}

/** Class of one command segment: its ceiling in seconds and the class name the timeout note reports;
 *  0 = contributes nothing (a wrapper like `cd x`). */
function segClass(seg: string): { s: number; cls: string } {
	// watchers run by design until done — they get their own ceiling no matter what head they carry
	if (/\bgh\s+run\s+watch\b/.test(seg)) return { s: WATCH_S, cls: "watch" };
	if (/(logs?|tail|journalctl)/.test(seg) && /(^|\s)(-f|--follow)(\s|$)/.test(seg)) return { s: WATCH_S, cls: "watch" };
	if (/\bcompose\b.*\bup\b/.test(seg) && !/(^|\s)(-d|--detach)(\s|$)/.test(seg)) return { s: WATCH_S, cls: "watch" };
	const tok = seg.trim().split(/\s+/);
	let i = 0;
	while (i < tok.length && (/^[\w.]+=/.test(tok[i]) || SKIP_HEADS.has(tok[i]))) i++;
	const base = (tok[i] ?? "").split("/").pop() ?? "";
	if (SKIP_HEADS.has(base) || !base) return { s: 0, cls: "" };
	// `timeout N cmd`: the command already says how long it may run — honour that, plus a margin, instead
	// of judging the segment by the head `timeout` (which fell to the 120s default and killed a
	// `timeout 600 bun test` at two minutes). An unreadable duration falls back to the wrapped command.
	if (base === "timeout" || base === "gtimeout") {
		let j = i + 1;
		while (j < tok.length && tok[j].startsWith("-")) j += TIMEOUT_VALUE_OPTS.has(tok[j]) ? 2 : 1;
		const n = parseDuration(tok[j] ?? "");
		if (n !== null) return { s: Math.min(n + WRAPPER_MARGIN_S, CLAMP_S), cls: `its own timeout ${tok[j]}` };
		const inner = segClass(tok.slice(j + 1).join(" "));
		return inner.s ? inner : { s: DEFAULT_S, cls: "default" };
	}
	if (base === "git") {
		const sub = tok[i + 1] ?? "";
		if (GIT_QUICK.has(sub)) return { s: QUICK_S, cls: "quick" };
		if (GIT_NETWORK.has(sub)) return { s: NETWORK_S, cls: "network" };
		return { s: LOCAL_GIT_S, cls: "local git" };
	}
	if (NETWORK.has(base)) return { s: NETWORK_S, cls: "network" };
	if (SERVICE.has(base)) return /\bbuild\b/.test(seg) ? { s: BUILD_S, cls: "build" } : { s: SERVICE_S, cls: "service" }; // docker/compose build is an image build, not a service poke
	if (BUILD.has(base)) return { s: BUILD_S, cls: "build" };
	if (QUICK.has(base)) return { s: QUICK_S, cls: "quick" };
	return { s: DEFAULT_S, cls: "default" };
}

/** The slowest segment's class — what decides a command's default timeout, and what the kill note names. */
export function timeoutClass(command: string): { s: number; cls: string } {
	let best = { s: 0, cls: "" };
	for (const seg of bashSegments(command)) {
		const c = segClass(seg);
		if (c.s > best.s) best = c;
	}
	return best.s ? best : { s: DEFAULT_S, cls: "default" };
}

/**
 * Effective timeout (seconds) for a shell command: an explicit value is kept but
 * clamped to CLAMP_S; otherwise the slowest class among the command's segments wins.
 */
export function bashTimeout(command: string, explicit?: number): number {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, CLAMP_S);
	return timeoutClass(command).s;
}

/**
 * `bashTimeout = require` (opt-in; `inject` is the default): the model must state the timeout itself,
 * because the injected value never reaches the transcript — the tool call entry records the arguments the model
 * emitted, and the handler mutates them afterwards. Returns the refusal, or undefined when the call
 * already carries an explicit timeout. The refused call is not lost: the reason names the exact
 * value the class table would have armed, so the retry is a one-token fix.
 */
export function requireTimeout(command: string, explicit?: number): string | undefined {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return undefined;
	return `pass an explicit timeout on shell calls — the class default here is ${bashTimeout(command)}s (it is armed silently either way; saying it makes it visible in the transcript)`;
}
