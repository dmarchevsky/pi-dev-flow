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

```flow
artifact = npm view pi-dev-flow@{version} version
merge = merge
```

This repo merge-commits its PRs (history: 17 merge commits), so the branch's own commits stay in the
release's ancestry — that is what makes a post-merge tag point at reviewed SHAs. Merge with
`gh pr merge --merge`; a squash here rewrites them out of the release.

- [ ] dogfood: `flow doctor` here reports no shim finding, and the operator was told that already-running sessions keep the old code until `/reload`
- [ ] CI published pi-dev-flow from the tag (Actions `release` run green — a failed publish is re-run on the same tag, never re-tagged; if the artifact check raced the publish, wait for the job and run release-done again)

<!-- e.g. who publishes artifacts -->
