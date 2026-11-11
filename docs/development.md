# Working on dev-flow

This repo is built with dev-flow itself.

```bash
npm i && npm test          # unit tests + wiring smoke test (node --test)
pi -e . run /flow status   # try the working tree against any repo
```

## Loaded code and duplicate copies

- **A running session keeps the code it started with.** After a release, run `/reload` in each
  session that needs the new behavior. Shared-process hosts like pi-web keep the old code until
  they're restarted: there, `/reload` re-binds state but doesn't swap code.
- **Two install sources load two copies.** For example, a project `git:` pin next to a global `npm:`
  install. Pi dedupes extensions by path, not by package. Keep only the source you update from.
- **The newest copy decides.** Every loaded copy's guards check which registered version is highest,
  and older copies stay silent. `flow version` lists every copy in the process and names the one
  serving the call.
- **This checkout uses the global install.** There's deliberately no `.pi/extensions/` shim here:
  one would load a second copy. The package's own `pi.extensions` manifest is a second source in
  this checkout, which is safe because the newest copy decides. To run the working tree instead, use
  `pi -e .`.

## Layout

- `extensions/dev-flow.ts`: Pi wiring only. The `/flow` command, the `flow` and `flow_stage` tools,
  and the event hooks (guards, injections, footer, compaction).
- `src/runtime/`: what the wiring runs.
  - `base`: shell, paths, state, sessions, claims.
  - `checks`: dev deploy, health, tier-1 checks.
  - `gates`: the runner and the non-shipping gates.
  - `ship`: verify, release, release-done, finish.
  - `setup`, `reflect`, `workers`.
- `src/core.ts`, `src/projectmd.ts`, `src/present.ts`, …: pure logic, unit-tested without Pi.
  `present.ts` splits each gate result into your view and the agent's text.

## The skill: an injected core plus per-stage references

Pi loads a skill's `SKILL.md` only when the model decides to read it. A session that never reads the
rules guesses at gates and fights the guards. So `skills/dev-flow/SKILL.md` is split in two:

- **The core** sits between `<!-- dev-flow:core:start -->` and `<!-- dev-flow:core:end -->`. It's
  injected **once per session**. A reload, resume or fork doesn't inject it again, and a compaction
  that summarizes it away brings it back once. Every session pays for it, so `package.test.ts`
  rejects a core over **4,000 characters**.
- **Everything else** lives in `references/<stage>.md`. Each stage's message names the one file it
  needs.

When a stage needs more guidance, add it to that stage's reference file, not the core. The tests
check that every stage has a file and that the map names every file.

## Publishing

`.github/workflows/release.yml` publishes to npm when a `v*` tag is pushed. It checks out the tag,
runs `npm ci && npm test`, and runs `npm publish --provenance`. Nothing publishes from a laptop.

- **Auth is npm trusted publishing** (OIDC, no token). The registration on npmjs.com names this repo
  and the workflow file name, so re-register after renaming either one.
- **`--provenance` needs a public repo.** If the repo ever goes private, drop the flag.
- **If the job fails,** fix the cause and re-run the same job. The tag already points at the right
  commit. `flow release-done` refuses to close the flow until `npm view pi-dev-flow@<version>`
  succeeds.

The README is also the package page on npm and [pi.dev](https://pi.dev/packages/pi-dev-flow). Its doc
links use absolute GitHub URLs, because pi.dev rewrites relative links to raw files on jsDelivr.
