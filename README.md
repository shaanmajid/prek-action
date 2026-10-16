# Prek Action

Run [prek](https://github.com/j178/prek) in your GitHub Actions workflows.

## Usage

```yaml
name: Prek checks
on: [push, pull_request]

jobs:
  prek:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
```

`prek` is always invoked as:

```text
prek run --show-diff-on-failure --color=always [--all-files] <extra-args>
```

## Version Tags

For v2 and earlier releases, major and minor tags such as `v2` and `v2.0` are moving tags. Starting with v3, major and minor tags are no longer published. Always use an exact version such as `j178/prek-action@v3.0.0`; for stronger protection against supply-chain attacks, pin to a full commit SHA.

## Inputs

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `all-files` | Run against all files; disable when selecting files with `extra-args` | No | `true` |
| `extra-args` | Additional arguments appended to `prek run --show-diff-on-failure --color=always` | No | `''` |
| `extra_args` | Deprecated alias for `extra-args` | No | |
| `prek-version` | Version, semver range, `latest`, or `latest-known`; overrides `version-file` | No | `version-file` if supplied, otherwise `latest` |
| `version-file` | Read prek's version from `uv.lock`, `poetry.lock`, `pdm.lock`, `pylock.toml` (including `pylock.<name>.toml`), `pyproject.toml`, or `Cargo.lock`, relative to `working-directory` | No | |
| `install-only` | Install `prek` but skip `prek run` | No | `false` |
| `working-directory` | Directory where `prek run` is executed | No | `.` |
| `show-verbose-logs` | Print the `prek` verbose log after `prek run` completes | No | `true` |
| `cache` | Cache the prek environment between workflow runs | No | `true` |
| `token` | Deprecated and unused; retained for backward compatibility | No | `''` |

## Outputs

| Output | Description |
| --- | --- |
| `prek-version` | The resolved `prek` version, normalized to a `v`-prefixed tag |
| `cache-hit` | Whether the restored prek cache exactly matched the computed primary cache key |

## Examples

Install and run against all files:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
```

Pass extra arguments:

`all-files` defaults to `true`, independently of `extra-args`.

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
    with:
      extra-args: '--directory packages/'
```

### Next-major migration: file selection

In the next major release, `extra-args` defaults to an empty string and the new
`all-files` input defaults to `true`. Previously, setting `extra-args` replaced
the default `--all-files`. Remove any existing `--all-files` or `-a` from
`extra-args`, because prek rejects duplicate flags. Existing workflows using `--files`, `--from`/`--to`,
or an empty `extra-args` to run only staged files must now set `all-files: false`:

```yaml
with:
  all-files: false
  extra-args: '--files src/main.py'
```

The action passes extra arguments through to prek without interpreting them.
The deprecated `extra_args` alias uses the same behavior.

Pin a specific `prek` version:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
    with:
      prek-version: '0.2.30'
```

Resolve a semver range:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
    with:
      prek-version: '0.3.x'
```

Select the newest stable version included in the action's bundled checksums:

```yaml
with:
  prek-version: latest-known
```

`latest-known` resolves without downloading the version manifest. Updating the action
pin advances this version when the newer action includes newer checksums. `latest`
instead follows the version manifest on this repository's `main` branch. Downloads
with a bundled checksum are verified before extraction; downloads without one emit
a warning. Existing runner tool-cache entries are reused without re-verification.

Reuse a project version by configuring the action step:

```yaml
with:
  version-file: uv.lock
```

`prek-version` takes precedence, including an explicit `latest`. If neither input is
set, the action installs the latest version. Files are read only when explicitly
selected; relative paths start at `working-directory`.

Lockfiles must contain one unique prek version from a package registry. Git, URL,
and local sources are unsupported. Poetry and PDM index packages are supported,
including registry mirrors. Pylock files must use format major version 1 and record
prek's exact version with release wheels or an sdist by HTTP(S) URL. Local artifact paths,
VCS, directory, and archive sources are unsupported. Artifact URLs and hashes are
not used: the action downloads the official prek binary for that version.

`pyproject.toml` supports prek in
`project.dependencies`, `project.optional-dependencies`, and `dependency-groups`,
using PEP 440 specifiers. Direct URL dependencies and uv source overrides other
than an unconditional index selection are unsupported.
Prek entries in uv's `override-dependencies` are also unsupported; use `uv.lock`
or set `prek-version` explicitly instead.

Inference selects an official prek release version; it does not install the
project's Python or Rust dependencies, or reproduce packages from other sources.

Manifest requirements select the highest matching stable release. Distinct
constraints across dependency groups and conditional Python dependencies require
an explicit `prek-version` or an unambiguous lockfile. The action does not resolve
Python environment markers or search other files.
Missing or malformed files, missing prek entries, and unsupported or ambiguous
requirements fail with an error; they never fall back to installing latest.

Install only:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
    with:
      install-only: true
  - run: prek run --show-diff-on-failure --color=always --all-files
```

Disable verbose log output after the run:

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16 # v2.0.6
    with:
      show-verbose-logs: false
```
## Caching

The action caches prek's hook environments, using the cache directory reported by
prek (including `PREK_HOME`). The key includes the runner OS, architecture, Python
location when set by `setup-python`, and the paths and contents of `prek.toml`,
`.pre-commit-config.yaml`, and `.pre-commit-config.yml` files under `working-directory`.
Directory symlinks and files resolving outside that directory are not hashed.

Caching uses exact matches. Changing a hook configuration creates a new cache;
there is no broad fallback to older caches. Cache service failures produce warnings
and allow the checks to continue. Set `cache: false` to disable restore and save.

The downloaded prek executable uses the runner's separate tool cache. `install-only`
still restores and saves hook environments, so later workflow steps can use them.

## Requirements

The target repository needs a `prek` or pre-commit configuration file:

- `prek.toml`
- `.pre-commit-config.yaml`
- `.pre-commit-config.yml`

## Contributing

For contributor setup, testing, bundling, and release steps, see [CONTRIBUTING.md](CONTRIBUTING.md).
