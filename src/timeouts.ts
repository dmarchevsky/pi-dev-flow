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

/** Timeout class of one command segment; 0 = contributes nothing (wrapper like `cd x`). */
function segTimeout(seg: string): number {
	// watchers run by design until done — they get their own ceiling no matter what head they carry
	if (/\bgh\s+run\s+watch\b/.test(seg)) return WATCH_S;
	if (/(logs?|tail|journalctl)/.test(seg) && /(^|\s)(-f|--follow)(\s|$)/.test(seg)) return WATCH_S;
	if (/\bcompose\b.*\bup\b/.test(seg) && !/(^|\s)(-d|--detach)(\s|$)/.test(seg)) return WATCH_S;
	const tok = seg.trim().split(/\s+/);
	let i = 0;
	while (i < tok.length && (/^[\w.]+=/.test(tok[i]) || SKIP_HEADS.has(tok[i]))) i++;
	const base = (tok[i] ?? "").split("/").pop() ?? "";
	if (SKIP_HEADS.has(base) || !base) return 0;
	if (base === "git") {
		const sub = tok[i + 1] ?? "";
		if (GIT_QUICK.has(sub)) return QUICK_S;
		if (GIT_NETWORK.has(sub)) return NETWORK_S;
		return LOCAL_GIT_S;
	}
	if (NETWORK.has(base)) return NETWORK_S;
	if (SERVICE.has(base)) return /\bbuild\b/.test(seg) ? BUILD_S : SERVICE_S; // docker/compose build is an image build, not a service poke
	if (BUILD.has(base)) return BUILD_S;
	if (QUICK.has(base)) return QUICK_S;
	return DEFAULT_S;
}

/**
 * Effective timeout (seconds) for a shell command: an explicit value is kept but
 * clamped to CLAMP_S; otherwise the slowest class among the command's segments wins.
 */
export function bashTimeout(command: string, explicit?: number): number {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, CLAMP_S);
	let t = 0;
	for (const seg of bashSegments(command)) t = Math.max(t, segTimeout(seg));
	return t || DEFAULT_S;
}

/**
 * `bashTimeout = require` (the default): the model must state the timeout itself, because the
 * injected value never reaches the transcript — the tool call entry records the arguments the model
 * emitted, and the handler mutates them afterwards. Returns the refusal, or undefined when the call
 * already carries an explicit timeout. The refused call is not lost: the reason names the exact
 * value the class table would have armed, so the retry is a one-token fix.
 */
export function requireTimeout(command: string, explicit?: number): string | undefined {
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return undefined;
	return `pass an explicit timeout on shell calls — the class default here is ${bashTimeout(command)}s (it is armed silently either way; saying it makes it visible in the transcript)`;
}
