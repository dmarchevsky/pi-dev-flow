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
