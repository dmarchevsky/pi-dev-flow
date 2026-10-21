# Hacking on dev-flow

This checkout dogfoods itself — the repo is developed with dev-flow.

```bash
npm i && npm test     # unit tests + wiring smoke test (node --test)
pi -e . run /flow status   # try it against any repo
```

This checkout dogfoods itself: `.pi/extensions/dev-flow.ts` is a committed one-line re-export of
`extensions/dev-flow.ts`, so pi loads the working tree rather than an installed copy, and a fresh
clone needs no setup. It is a pointer, not a copy — after any merge or pull, new sessions here run
main's current code, with nothing to re-run. A symlink would not work: pi resolves a module's
relative imports from the link's own directory, so the extension's `../src/core.ts` would not
resolve. `flow doctor` flags a missing or edited shim.

A release cannot update a session that is already running — pi keeps the code it loaded at startup.
After merging and tagging, `/reload` in every session that must carry the new behavior.

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
