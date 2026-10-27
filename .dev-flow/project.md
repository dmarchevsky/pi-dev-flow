# dev-flow

<!-- Operator-owned playbook. Regenerate with: flow init --draft -->

## global

```flow
defaultBranch = main
```

## plan

- [ ] (ui) rendered mockups attached for every changed screen

Every stage report opens with one inline stage line (plain markdown, never fenced): `◆ <stage> · <slug>`
— mode (+grant ✓/?) · ui · stage fields, `·`-separated — and closes with exactly one plain-chat
checkpoint (context | options incl. yolo | recommend | verb). Plan stage fields: plan.md status,
mockups rendered/total, open questions. See docs/playbook.md — Structured stage reports.

<!-- what the plan must contain, UI expectations -->

## implement

```flow
setup = npm install
test = npm test
```

- [ ] (ui) app runs locally with real data; visual pass: no overflows or stray scrollbars

Stage line adds: commits `N ahead, M uncommitted`, tier-1, tier-2, deploy/health, branch@sha;
mid-stage additions go to plan.md as `**Added mid-stage:**` lines, never a second checkpoint.

<!-- tier-3: standing guidance for this stage -->

## pre-release

```flow
versionFile = package.json
versionTag = v{version}
```

Stage line carries the full version decision: pending | bump patch/minor/major → vX.Y.Z | no-version
(only on the operator's explicit word), plus tag, changelog, Unreleased-fold status and
/flow-review tally. Never invent a version or a no-version decision.

<!-- e.g. semver rules, changelog policy, who confirms the version -->

## release

```flow
artifact = npm view --prefer-online pi-dev-flow@{version} version
merge = merge
```

`--prefer-online` is load-bearing: plain `npm view` can serve a cached 404 for a minute after CI
publishes, which makes `release-done` refuse a package that is really out (hit on the 0.54.0 release).

Version bumps edit the version fields of `package.json` and `package-lock.json` in place — never
`npm install` to refresh the lock: npm rewrites it to package.json's tab indentation (the lock ships
2-space), turning a bump into a ~5000-line diff (hit on the 0.64.6 bump).

This repo merge-commits its PRs (history: 17 merge commits), so the branch's own commits stay in the
release's ancestry — that is what makes a post-merge tag point at reviewed SHAs. Merge with
`gh pr merge <n> --merge` (PR number first — a positional after the style flag is read as the PR
selector); a squash here rewrites them out of the release.

- [ ] dogfood: `flow doctor` here reports no findings, and the operator was told that already-running sessions keep the old code until `/reload`
- [ ] CI published pi-dev-flow from the tag (Actions `release` run green — a failed publish is re-run on the same tag, never re-tagged; if the artifact check raced the publish, wait for the job and run release-done again)

<!-- e.g. who publishes artifacts -->
