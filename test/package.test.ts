import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	license?: string;
	repository?: string;
	engines?: { node?: string };
	files?: string[];
	keywords?: string[];
	description?: string;
	pi?: { image?: string };
};
const files = pkg.files ?? [];

// Pi discovers extensions/, skills/, prompts/ and themes/ without a `pi` manifest, so a resource dir
// that exists on disk but is missing from `files` ships to npm without its resources — and only the
// person installing the published package finds out.
test("every pi-discoverable resource dir is in the npm files allow-list", () => {
	for (const dir of ["extensions", "skills", "prompts", "themes"]) {
		if (!existsSync(path.join(root, dir))) continue;
		assert.ok(files.includes(`${dir}/`), `package.json files must list "${dir}/" or the published package drops it`);
	}
});

test("the published manifest is self-describing", () => {
	assert.equal(pkg.license, "MIT");
	assert.ok(existsSync(path.join(root, "LICENSE")), "`license: MIT` without a LICENSE file makes npm warn and users guess");
	assert.ok(pkg.engines?.node, "engines.node states the floor pi requires");
	assert.match(pkg.repository ?? "", /^https:\/\/github\.com\/[^/]+\/pi-dev-flow$/, "repository must name the repo CI publishes from");
	assert.ok(!files.includes("test"), "tests stay out of the runtime artifact");
	// the pi.dev gallery lists and searches by these, and renders pi.image as its preview
	assert.ok((pkg.keywords ?? []).includes("pi-package"), "pi.dev discovers packages by the pi-package keyword");
	assert.ok((pkg.description ?? "").length > 40, "the gallery search matches the description — spend words there");
	if (pkg.pi?.image) {
		const img = pkg.pi.image.replace(/^\.\//, "");
		assert.ok(existsSync(path.join(root, img)), `pi.image points at ${img}, which must exist`);
		assert.ok(files.includes(img), `pi.image points at ${img}, which npm would drop from the tarball`);
	}
});
