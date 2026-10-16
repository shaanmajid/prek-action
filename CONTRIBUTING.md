# Contributing

## Setup

1. Install Node.js 24 or newer.
2. Install dependencies:

```bash
npm ci
```

If you are bootstrapping from scratch and no lockfile exists yet, run `npm install` once, then commit the generated `package-lock.json`.

## Build

Compile TypeScript:

```bash
npm run build
```

Bundle the action `dist/` entrypoints for GitHub Actions:

```bash
npm run bundle
```

That command produces `dist/index.cjs`, which is used for both the main action and
the post-step cache save.

The generated `dist/` files must be committed, because GitHub Actions consumers run the checked-in `dist/` output directly.

## Test

Run the unit tests:

```bash
npm test
```

This runs the TypeScript tests directly with Vitest.

## Validate

Run the action repo checks locally:

```bash
npm test
npm run bundle
git diff --stat
```

`git diff` should only show the source and generated `dist/` changes you intend to release.

## Release

1. Make the source changes.
2. Run `npm ci`.
3. Run `npm test`.
4. Run `npm run bundle`.
5. Commit both source files and the generated `dist/` output.
6. Push the commit to `main`.
7. Open the `Release` workflow in GitHub Actions and run it manually with the desired version, for example `v1.2.0` or `1.2.0`.
8. The workflow re-runs validation, creates the GitHub Release with generated notes, and creates the corresponding Git tag from the current `main` commit.

You do not need to create or push the version tag manually; the workflow does that via GitHub when it creates the release.

## Version manifest compatibility

Released actions download `version-manifest.json` from this repository's `main`
branch for `latest`, version ranges, and release asset URLs. Treat this file as a
public API for old action versions: keep its top-level array, existing field
names and types, and descending version order. Additive fields are compatible;
a breaking schema needs a new filename and a separate migration.

`npm run update-known-versions` refreshes the manifest and bundled checksums.
The prek release workflow sets `EXPECTED_RELEASE_TAG` to its triggering tag.
The updater waits up to 135 seconds for that published release, at least one
installable archive, and SHA256 digests for all its installable archives. It fails
before writing files if readiness checks fail. Empty or malformed release API
responses also fail rather than erasing the manifest. Historical checksums are
retained when GitHub omits their digest.

The OS test matrix installs the newest stable version from the checked-in
manifest with a fresh tool cache. This checks the proposed release's uploaded
archive and bundled checksum before the updater PR merges, even while `main`
still lists the previous release.

Updating these files on `main` advances explicit `latest` and range resolution;
it does not publish a new action release or refresh checksums bundled in an
already released action.
