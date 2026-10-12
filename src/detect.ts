/**
 * Deterministic project detection for `flow init`.
 *
 * Produces a *partial* project.json (merged over DEFAULTS by loadConfig) plus
 * human-readable report lines. No LLM, no guessing beyond strong evidence —
 * anything not confidently detected is left empty and reported as missing.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseVersion } from "./core.ts";

export interface Detection {
	partial: { defaultBranch: string; commands: Record<string, string>; versioning?: { file: string } };
	report: string[]; // human lines: what was detected
	missing: string[]; // command keys left empty (excluding setup)
}

const read = (p: string): string | null => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

function pkgManager(root: string, field?: string): string {
	const m = field?.match(/^(npm|pnpm|yarn|bun)@/);
	if (m) return m[1];
	if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return "bun";
	if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
	return "npm";
}

export function detectProject(root: string, defaultBranch: string): Detection {
	const commands: Record<string, string> = {};
	const report: string[] = [`default branch: ${defaultBranch} (guessed from git)`];
	const detected = detectCommands(root, commands, report);
	if (!detected) report.push("no supported manifest found — fill in commands yourself (see README)");
	if (Object.keys(commands).length) report.push(`commands: ${Object.entries(commands).map(([k, v]) => `${k}="${v}"`).join(", ")}`);
	const missing = ["test", "build", "run"].filter((k) => !commands[k]);
	const versioning = detectVersioning(root, report);
	return { partial: { defaultBranch, commands, ...(versioning ? { versioning } : {}) }, report, missing };
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
	report.push("versioning: none found — ask the operator to pick/create a version manifest (VERSION recommended), then set versioning.file");
	return null;
}

function detectCommands(root: string, c: Record<string, string>, report: string[]): boolean {
	// node — first match wins; other ecosystems below are realistically exclusive here
	const pkgRaw = read(path.join(root, "package.json"));
	if (pkgRaw) {
		try {
			const pkg = JSON.parse(pkgRaw) as { packageManager?: string; scripts?: Record<string, string> };
			const pm = pkgManager(root, pkg.packageManager);
			report.push(`node project detected (package manager: ${pm})`);
			c.setup = `${pm} install`;
			if (pkg.scripts?.test) c.test = `${pm} test`;
			if (pkg.scripts?.build) c.build = `${pm} build`;
			if (pkg.scripts?.dev) c.run = `${pm} dev`;
			else if (pkg.scripts?.start) c.run = `${pm} start`;
			return true;
		} catch {
			report.push("package.json exists but is not valid JSON — ignored");
		}
	}
	if (existsSync(path.join(root, "Cargo.toml"))) {
		report.push("rust project detected (Cargo.toml)");
		Object.assign(c, { test: "cargo test", build: "cargo build --release", run: "cargo run" });
		return true;
	}
	if (existsSync(path.join(root, "go.mod"))) {
		report.push("go project detected (go.mod)");
		Object.assign(c, { test: "go test ./...", build: "go build ./..." });
		return true;
	}
	if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "requirements.txt"))) {
		if (existsSync(path.join(root, "uv.lock"))) Object.assign(c, { setup: "uv sync", test: "uv run pytest" });
		else if (existsSync(path.join(root, "poetry.lock"))) Object.assign(c, { setup: "poetry install", test: "poetry run pytest" });
		else {
			c.test = "pytest";
			if (existsSync(path.join(root, "requirements.txt"))) c.setup = "pip install -r requirements.txt";
		}
		report.push("python project detected");
		return true;
	}
	return false;
}
