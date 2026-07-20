# AGENTS.md

## Cursor Cloud specific instructions

`trajectory` is a **library** (TypeScript core in `src/` published to npm as
`@letta-ai/trajectory`, plus a thin Python wrapper in `python/` published as
`letta-trajectory`). There is **no server, database, or `dev` command** — you
build/test it and consume it as an imported library.

### Toolchain
- **Bun 1.3.0** is the package manager, test runner, and bundler. It is installed
  at `~/.bun/bin/bun` (added to `PATH` via `~/.bashrc`, so interactive shells find
  `bun` automatically; non-interactive scripts should use the full path).
- **Node.js 20+** and **Python 3.10+** are required. The Python wrapper does not
  run normalization itself — it spawns Node as a subprocess to execute the
  bundled `trajectory-cli.mjs`, so Node must be on `PATH`.

### Commands (see `README.md` and `package.json` scripts)
- `bun install --frozen-lockfile` — install JS deps (the `prepare` script runs
  `build` automatically).
- `bun run check` — the main gate: regenerates the vendored Python CLI bundle,
  fails if the committed bundle is stale, then typechecks (`tsc`), runs `bun test`,
  and builds `dist/`.
- `bun run typecheck`, `bun test`, `bun run build` — individual steps.
- `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v` — Python
  parity suite.

### Non-obvious gotchas
- **Regenerate the vendored bundle after editing TS core.** `bun run check`
  runs `bun run build:python-cli` then `git diff --exit-code` on
  `python/src/trajectory/_vendor/trajectory-cli.mjs` (and `deepagents_checkpoint.py`).
  If you change TypeScript in `src/` and forget to regenerate, `check` fails on a
  dirty git diff. Run `bun run build:python-cli` and commit the regenerated bundle.
- **Deep Agents tests skip by default.** The `deepagents` TS tests and the Python
  `test_normalizes_deepagents_checkpoint_with_current_python` are skipped unless the
  optional extras are installed: `python -m pip install ".[deepagents]" "deepagents>=0.6,<0.7"`
  and run with `DEEPAGENTS_TEST_PYTHON=python DEEPAGENTS_SDK_TEST_PYTHON=python bun test ...`.
  These are optional; a clean `bun run check` + Python parity run is sufficient for
  most work.
