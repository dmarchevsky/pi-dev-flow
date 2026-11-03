/**
 * Deterministic project detection for `flow init`.
 *
 * Produces a *partial* config (merged over DEFAULTS by the caller) plus
 * human-readable report lines. No LLM, no guessing beyond strong evidence —
 * anything not confidently detected is left empty and reported as missing.
 *
 * Two kinds of output: `partial` is drafted into project.md (strong evidence only), `suggestions` are
 * ready-made answers to setup questions (plausible, but a command that reaches a network or a registry
 * is the operator's call, so it is offered — never drafted).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseVersion } from "./core.ts";

/** A ready-made answer to one setup question: `flow init --answers <key>=<value>` applies it. */
export interface Suggestion {
	key: string;
	value: string;
	why: string;
}

export interface Detection {
	/** `merge`/`versionTag` are not detected here (detection is fs-only): the caller fills them from git history. */
	partial: {
		defaultBranch: string;
		commands: Record<string, string>;
		versioning?: { file: string };
		forge?: string;
		merge?: string;
		versionTag?: string;
		/** a changelog file other than the default CHANGELOG.md; "" = none found (the release would expect one) */
		changelog?: string;
		/** extra tier-1 checks (lint, typecheck…) drafted as flow-check blocks under ## implement */
		checks?: Record<string, string>;
		/** flow-guard lines drafted under ## global (protect/forbid of secrets that exist on disk) */
		guards?: string[];
	};
	report: string[]; // human lines: what was detected
	missing: string[]; // command keys left empty (excluding setup)
	suggestions: Suggestion[];
}

const read = (p: string): string | null => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

const firstExisting = (root: string, names: string[]): string | undefined => names.find((n) => existsSync(path.join(root, n)));

function pkgManager(root: string, field?: string): string {
	const m = field?.match(/^(npm|pnpm|yarn|bun)@/);
	if (m) return m[1];
	if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return "bun";
	if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
	return "npm";
}

/** How a package manager runs a package.json script. `npm build` / `npm dev` are "Unknown command" —
 *  only test/start have npm shorthands — and `bun test` is bun's own runner, not the script. */
export function scriptCmd(pm: string, script: string): string {
	if (pm === "npm" && (script === "test" || script === "start")) return `npm ${script}`;
	return `${pm} run ${script}`;
}

export function detectProject(root: string, defaultBranch: string): Detection {
	const commands: Record<string, string> = {};
	const checks: Record<string, string> = {};
	const suggestions: Suggestion[] = [];
	const report: string[] = [];
	const guessed = /^(main|master|develop|trunk)$/.test(defaultBranch);
	report.push(guessed ? `default branch: ${defaultBranch} (guessed from git)` : `default branch: "${defaultBranch}" looks like a working branch — confirm or correct it below`);
	const detected = detectCommands(root, commands, checks, report) || detectTaskRunner(root, commands, checks, report);
	if (!detected) report.push("no supported manifest or task runner found — fill in commands yourself (see docs/playbook.md)");
	if (Object.keys(commands).length) report.push(`commands: ${Object.entries(commands).map(([k, v]) => `${k}="${v}"`).join(", ")}`);
	if (Object.keys(checks).length) report.push(`extra checks (drafted as flow-check blocks): ${Object.entries(checks).map(([k, v]) => `${k}="${v}"`).join(", ")}`);
	const missing = ["test", "build", "run"].filter((k) => !commands[k]);
	const versioning = detectVersioning(root, report);
	detectWorkspaces(root, report);
	const ci = detectCi(root, report);
	detectDocker(root, report, suggestions);
	const guards = detectSecrets(root, report);
	const changelog = detectChangelog(root, report);
	detectPublish(root, ci, report, suggestions);
	const agentDocs = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"].filter((f) => existsSync(path.join(root, f)));
	if (agentDocs.length) report.push(`project docs: ${agentDocs.join(", ")} — read them for stage guidance and release rules worth moving into the playbook (proposed to the operator, never copied silently)`);
	return {
		partial: {
			defaultBranch,
			commands,
			...(versioning ? { versioning } : {}),
			...(changelog !== undefined ? { changelog } : {}),
			...(Object.keys(checks).length ? { checks } : {}),
			...(guards.length ? { guards } : {}),
		},
		report,
		missing,
		suggestions,
	};
}

/** Version manifest probe: first of VERSION / package.json / Cargo.toml / pyproject.toml holding a version. */
function detectVersioning(root: string, report: string[]): { file: string } | null {
	const candidates = ["VERSION", "package.json", "Cargo.toml", "pyproject.toml"];
	for (const file of candidates) {
		const raw = read(path.join(root, file));
		if (!raw) continue;
		const v = parseVersion(file, raw);
		if (v) {
			report.push(`versioning: ${file} (current ${v}) — release tags must match this manifest`);
			return { file };
		}
	}
	report.push("versioning: none found — ask the operator to pick/create a version manifest (VERSION recommended), then set versionFile");
	return null;
}

function detectCommands(root: string, c: Record<string, string>, checks: Record<string, string>, report: string[]): boolean {
	// node — first match wins; other ecosystems below are realistically exclusive here
	const pkgRaw = read(path.join(root, "package.json"));
	if (pkgRaw) {
		try {
			const pkg = JSON.parse(pkgRaw) as { packageManager?: string; scripts?: Record<string, string> };
			const pm = pkgManager(root, pkg.packageManager);
			const s = pkg.scripts ?? {};
			report.push(`node project detected (package manager: ${pm})`);
			c.setup = `${pm} install`;
			if (s.test) c.test = scriptCmd(pm, "test");
			if (s.build) c.build = scriptCmd(pm, "build");
			if (s.dev) c.run = scriptCmd(pm, "dev");
			else if (s.start) c.run = scriptCmd(pm, "start");
			if (s.lint) checks.lint = scriptCmd(pm, "lint");
			const tc = ["typecheck", "type-check", "check-types", "tsc"].find((k) => s[k]);
			if (tc) checks.typecheck = scriptCmd(pm, tc);
			const fmt = ["format:check", "fmt:check", "prettier:check"].find((k) => s[k]);
			if (fmt) checks.format = scriptCmd(pm, fmt);
			return true;
		} catch {
			report.push("package.json exists but is not valid JSON — ignored");
		}
	}
	if (existsSync(path.join(root, "Cargo.toml"))) {
		report.push("rust project detected (Cargo.toml)");
		Object.assign(c, { test: "cargo test", build: "cargo build --release", run: "cargo run" });
		Object.assign(checks, { clippy: "cargo clippy --all-targets -- -D warnings", format: "cargo fmt --check" });
		return true;
	}
	if (existsSync(path.join(root, "go.mod"))) {
		report.push("go project detected (go.mod)");
		Object.assign(c, { test: "go test ./...", build: "go build ./..." });
		checks.vet = "go vet ./...";
		return true;
	}
	if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "requirements.txt"))) {
		const py = read(path.join(root, "pyproject.toml")) ?? "";
		const runner = existsSync(path.join(root, "uv.lock")) ? "uv run " : existsSync(path.join(root, "poetry.lock")) ? "poetry run " : "";
		if (runner === "uv run ") c.setup = "uv sync";
		else if (runner === "poetry run ") c.setup = "poetry install";
		else if (existsSync(path.join(root, "requirements.txt"))) c.setup = "pip install -r requirements.txt";
		c.test = `${runner}pytest`;
		// a tool configured in pyproject is strong evidence the project runs it
		if (/^\[tool\.ruff\b/m.test(py)) checks.lint = `${runner}ruff check .`;
		if (/^\[tool\.mypy\b/m.test(py)) checks.typecheck = `${runner}mypy .`;
		report.push("python project detected");
		return true;
	}
	return false;
}

/** Makefile / justfile / Taskfile targets — the fallback when no language manifest decided the commands. */
function detectTaskRunner(root: string, c: Record<string, string>, checks: Record<string, string>, report: string[]): boolean {
	const runners: [string, string, RegExp][] = [
		["Makefile", "make", /^([A-Za-z][\w-]*)\s*:(?!=)/gm],
		["justfile", "just", /^([A-Za-z][\w-]*)(?:\s+[^:\n=]*)?:(?!=)/gm],
		["Taskfile.yml", "task", /^ {2}([A-Za-z][\w-]*):\s*$/gm],
	];
	for (const [file, bin, re] of runners) {
		const raw = read(path.join(root, file)) ?? (file === "justfile" ? read(path.join(root, "Justfile")) : null);
		if (!raw) continue;
		const targets = new Set([...raw.matchAll(re)].map((m) => m[1]));
		const pick = (...names: string[]) => names.find((n) => targets.has(n));
		const t = pick("test", "tests", "check");
		const b = pick("build");
		const r = pick("run", "dev", "serve", "start");
		const l = pick("lint");
		if (!t && !b && !r && !l) continue;
		if (t) c.test = `${bin} ${t}`;
		if (b) c.build = `${bin} ${b}`;
		if (r) c.run = `${bin} ${r}`;
		if (l) checks.lint = `${bin} ${l}`;
		report.push(`${file} targets detected (${[...targets].slice(0, 12).join(", ")})`);
		return true;
	}
	return false;
}

function detectWorkspaces(root: string, report: string[]): void {
	const pkg = read(path.join(root, "package.json")) ?? "";
	const cargo = read(path.join(root, "Cargo.toml")) ?? "";
	const kinds = [
		/"workspaces"\s*:/.test(pkg) && "npm/yarn workspaces",
		existsSync(path.join(root, "pnpm-workspace.yaml")) && "pnpm workspace",
		/^\[workspace\]/m.test(cargo) && "cargo workspace",
		existsSync(path.join(root, "go.work")) && "go workspace",
	].filter(Boolean);
	if (kinds.length) report.push(`monorepo: ${kinds.join(", ")} — the root commands run every package; ask whether some checks or the version manifest are per package`);
}

/** CI is where the project already states what "green" means: its `run:` lines are the check commands
 *  the operator trusts, and a tool only CI has is a check the local gate cannot run (gh#134). */
function detectCi(root: string, report: string[]): string {
	const files: string[] = [];
	const wf = path.join(root, ".github", "workflows");
	if (existsSync(wf)) {
		try {
			for (const f of readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(path.join(".github", "workflows", f));
		} catch {
			/* unreadable dir: nothing to report */
		}
	}
	for (const f of [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml"]) if (existsSync(path.join(root, f))) files.push(f);
	if (!files.length) return "";
	const all = files.map((f) => read(path.join(root, f)) ?? "").join("\n");
	const runs = [...new Set([...all.matchAll(/^\s*(?:-\s*)?(?:run|script):\s*(?!\||>)(.+?)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, "")).filter((r) => !/^\$\{\{/.test(r)))];
	report.push(`CI: ${files.join(", ")}${runs.length ? ` — runs: ${runs.slice(0, 8).map((r) => `\`${r}\``).join(", ")}${runs.length > 8 ? ` (+${runs.length - 8})` : ""}` : ""} — the tier-1 checks should match what CI enforces`);
	return all;
}

function detectDocker(root: string, report: string[], suggestions: Suggestion[]): void {
	const dockerfile = firstExisting(root, ["Dockerfile", "docker/Dockerfile"]);
	const compose = firstExisting(root, ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml", "docker/compose.yaml", "docker/docker-compose.yml"]);
	if (dockerfile) {
		const ctx = path.dirname(dockerfile) === "." ? "." : `-f ${dockerfile} .`;
		report.push(`docker: ${dockerfile}`);
		suggestions.push({ key: "preflight", value: `docker build ${ctx}`, why: `${dockerfile} exists — prove the image builds before the tag triggers the real build` });
	}
	if (compose) {
		const raw = read(path.join(root, compose)) ?? "";
		const hc = /^\s+healthcheck:/m.test(raw);
		report.push(`compose: ${compose}${hc ? " (declares a healthcheck)" : ""}`);
		suggestions.push({ key: "dev", value: `docker compose -f ${compose} up -d --build`, why: `${compose} exists — the dev deploy the operator reviews before verify (must background and exit)` });
	}
}

/** Secrets that exist on disk get a drafted guard: the agent must never rewrite live credentials, and a
 *  backup copied beside them is the same secret (hence the basename glob). Templates are not secrets. */
function detectSecrets(root: string, report: string[]): string[] {
	const guards: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		return guards;
	}
	const envs = entries.filter((f) => /^\.env(\.|$)/.test(f) && !/\.(example|sample|template|dist)$/.test(f));
	if (envs.length) guards.push("protect .env* :: live secrets — and any backup copied beside them");
	for (const d of ["secrets", ".secrets"]) if (existsSync(path.join(root, d))) guards.push(`forbid  ${d} :: secret storage`);
	const tmpl = entries.find((f) => /^\.env\.(example|sample|template|dist)$/.test(f));
	if (envs.length || guards.length) report.push(`secrets on disk: ${[...envs, ...guards.filter((g) => g.startsWith("forbid")).map((g) => g.split(/\s+/)[1])].join(", ")} — drafted as flow-guard rules`);
	if (tmpl) report.push(`env template: ${tmpl} — a fresh worktree needs its own .env: put the copy into setup (e.g. cp <main checkout>/.env .env)`);
	return guards;
}

/** undefined = CHANGELOG.md is there (the default holds); a name = a different file; "" = none found. */
function detectChangelog(root: string, report: string[]): string | undefined {
	if (existsSync(path.join(root, "CHANGELOG.md"))) return undefined;
	const other = firstExisting(root, ["CHANGES.md", "HISTORY.md", "CHANGELOG", "NEWS.md", "docs/CHANGELOG.md"]);
	if (other) {
		report.push(`changelog: ${other}`);
		return other;
	}
	report.push("changelog: none found — the release gates expect CHANGELOG.md: create one, or answer changelog= (empty) to opt out");
	return "";
}

/** A release CI that publishes is the strongest hint of what release-done should verify. */
function detectPublish(root: string, ci: string, report: string[], suggestions: Suggestion[]): void {
	const pkg = (() => {
		try {
			return JSON.parse(read(path.join(root, "package.json")) ?? "null") as { name?: string; private?: boolean } | null;
		} catch {
			return null;
		}
	})();
	if (pkg?.name && !pkg.private && /\bnpm publish\b|\bpnpm publish\b|\byarn npm publish\b/.test(ci)) {
		report.push(`publish: CI runs npm publish for ${pkg.name}`);
		suggestions.push({ key: "artifact", value: `npm view --prefer-online ${pkg.name}@{version} version`, why: "CI publishes to npm — release-done proves the version is really out (--prefer-online skips npm's cached 404)" });
	}
	if (/\bcargo publish\b/.test(ci)) {
		const name = (read(path.join(root, "Cargo.toml")) ?? "").match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
		if (name) {
			report.push(`publish: CI runs cargo publish for ${name}`);
			suggestions.push({ key: "artifact", value: `cargo search ${name} --limit 1 | grep -q '"{version}"'`, why: "CI publishes the crate — release-done proves the version is on crates.io" });
		}
	}
	const image = ci.match(/\b(?:docker\/build-push-action|docker push|buildx[^\n]*--push)\b[\s\S]{0,400}?tags:\s*([\w./-]+\/[\w.-]+):/)?.[1] ?? ci.match(/docker push\s+([\w./-]+\/[\w.-]+)(?::|\s)/)?.[1];
	if (image && !image.includes("$")) {
		report.push(`publish: CI pushes the image ${image}`);
		suggestions.push({ key: "artifact", value: `docker buildx imagetools inspect ${image}:{version}`, why: "CI pushes a container image — release-done proves the tag reached the registry" });
	}
}
