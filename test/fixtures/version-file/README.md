These complete lockfiles were generated for `prek==0.5.5`, the latest stable
release on GitHub and PyPI when regenerated on 2026-10-16.
The shared input is `pyproject.toml`.

| Fixture | Generator | Validation |
| --- | --- | --- |
| `uv.lock` | uv 0.13.1, `uv lock` | `uv lock --check` |
| `poetry.lock` | Poetry 2.5.1, `poetry lock` | `poetry check --lock` |
| `pdm.lock` | PDM 2.29.2, `pdm lock --python '>=3.11'` | `pdm lock --check` |
| `pylock.toml` | uv 0.13.1, `uv export --format pylock.toml` | `uv pip sync --system --dry-run pylock.toml` |

Generation and native validation ran in disposable rootless containers. Tests
also read every fixture through the action. Inline TOML fragments in unit tests
exercise individual reader cases; they are not complete lockfiles.
