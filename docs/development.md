# Hacking on dev-flow

This checkout dogfoods itself — the repo is developed with dev-flow.

```bash
npm i && npm test     # unit tests + wiring smoke test (node --test)
pi -e . run /flow status   # try it against any repo
```

Sessions in this checkout load the **single global dev-flow install** (`pi update --extensions`
reconciles it after a release, `/reload` brings it into a running session) — there is deliberately no
`.pi/extensions/` pointer here: a committed shim beside the global package loads two copies of the
extension in one process (pi dedupes by path, not by package — see the README's two-sources
warning), which is what the shim used to cause. To dogfood the working tree instead of the
installed copy, point pi at it explicitly for that run: `pi -e .`.

A release cannot update a session that is already running — pi keeps the code it loaded at startup.
After merging and tagging, `/reload` in every session that must carry the new behavior.

## The skill: an injected core, plus references a stage reads

Pi advertises a skill (name, description, path) and loads `SKILL.md` only when the model decides to
read it — nothing makes a skill always-on. A session that never reads the playbook is a session that
guesses at a gate and then fights the guard, so `skills/dev-flow/SKILL.md` is split:

- The **core** — the ground rules every turn needs — sits between `<!-- dev-flow:core:start -->` and
  `<!-- dev-flow:core:end -->`. The extension extracts that span and injects it into the hidden
  `[dev-flow]` message **once per session**: a `dev-flow-skill` entry records the fact, so a reload,
  resume or fork does not pay it twice, and a compaction that summarizes it away re-arms exactly one
  re-injection. That budget is what every session in a dev-flow repo pays, so `package.test.ts`
  refuses a core over **4,000 characters**.
- Everything else lives in `references/<stage>.md` — stage prose moved verbatim. The stage injection
  names the one file the current stage needs (`…/references/plan.md` at plan), and the map under the
  core lists them all. `references/` stays invisible to pi: only `SKILL.md` registers, and a
  directory holding one is not scanned deeper.

When a stage grows, add to its reference file — do not grow the core. The tests guard both halves:
every stage has a file, the map names every file, and `release.md` hands over to `finish.md` because
the state machine has no finish stage that could name it.

## Publishing

`pi-dev-flow` is published to npm by `.github/workflows/release.yml`, triggered by the `v*` tag the
release stage pushes: it checks out that tag, runs `npm ci && npm test`, and `npm publish --provenance`
from exactly that commit. Nothing publishes from a developer machine.

Auth is npm **trusted publishing** — the workflow's OIDC identity, no token in the repo. The publisher
registered on npmjs.com names this repo **and the workflow file name**, so after renaming either one,
re-register it there or the next publish is rejected. And the publisher must be registered on a package
that already exists: npm has no place to put the credential before the first publish.

`--provenance` requires a **public** source repository — npm refuses the attestation from a private one
(`422 … Unsupported GitHub Actions source repository visibility: "private"`), which is why this repo is
public. If it ever goes private, drop the flag rather than the release.

If the job fails, fix the cause and **Re-run jobs** on the same failed run: the tag already points at what
should ship, so no re-tag. `flow release-done` then runs `npm view pi-dev-flow@<version> version` and
refuses to close the flow while the version is missing — which also catches a tag that never published.
