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

## Canonical-contract work: invariants and review learnings

The canonical view (`normalizeToCanonical`, see `CANONICAL.md`) is a frozen
cross-repo contract consumed by the letta-cloud normalizer worker. Changes here
went through several avoidable review rounds; hold these invariants explicitly
from the start and self-audit against them **before** requesting review:

- **Chunk-stable identity.** A given source record must produce identical
  `stable_source_record_id` / `record_id` / `source_order_id` / `content_hash`
  whether it is normalized in the full transcript or in a standalone
  continuation chunk, and regardless of transport-arrival order. Never derive
  identity from content, in-transcript position, or synthesized timestamps.
- **Per-adapter anchor semantics differ.** Identity anchors are `byte` (JSONL
  byte-cursor sources: Claude Code, Codex, local Letta) vs `ordinal` (whole
  decode: Deep Agents). `sourceContext.baseByteOffset` applies only to `byte`
  anchors; the unit is part of the identity tuple. Group must be authoritative
  and stable across chunks (worker-supplied `sourceContext.groupId` fills a
  missing detected group; disagreement fails). Audit **every** adapter, not just
  the one you changed.
- **Continuation chunks are partial.** `baseByteOffset > 0` ⇒ partial mode: omit
  meta, don't require user/assistant turns, and keep cross-chunk tool results
  (call in an earlier chunk) instead of dropping them. `normalizeTranscript()`
  stays strict. Single-line JSONL continuations still parse (route lone wrapper
  rows through the local parser).
- **Process:** for contract-heavy tickets, ask the design authority (Amelia) to
  *red-team* the invariants ("what breaks under chunking / partial uploads / each
  adapter's anchor?"), not just to approve a proposed shape — a prose proposal
  hides bugs that a diff review finds. Then do a per-adapter self-audit against
  the invariants above before undrafting.
