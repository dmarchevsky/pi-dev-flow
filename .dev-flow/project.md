# dev-flow

<!-- Operator-owned playbook. Regenerate with: flow init --draft -->

## global

```flow
defaultBranch = main
```

## plan

- [ ] (ui) rendered mockups attached for every changed screen

<!-- what the plan must contain, UI expectations -->

## implement

```flow
setup = npm install
test = npm test
```

- [ ] (ui) app runs locally with real data; visual pass: no overflows or stray scrollbars

<!-- tier-3: standing guidance for this stage -->

## pre-release

```flow
versionFile = package.json
versionTag = v{version}
```

<!-- e.g. semver rules, changelog policy, who confirms the version -->

## release

- [ ] dogfood: `flow doctor` here reports no shim finding, and the operator was told that already-running sessions keep the old code until `/reload`

<!-- e.g. PR/merge/tag policy, who publishes artifacts -->
