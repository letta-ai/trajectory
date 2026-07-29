# token-efficiency

Compare token counts of a real agent session across three representations:
the harness's **native** session file, this repo's **trajectory** normalized
JSONL, and Harbor's **ATIF** (RFC 0001) as produced by Harbor's own
converters.

```sh
export ANTHROPIC_API_KEY=...   # token counting uses /v1/messages/count_tokens
bun scripts/token-efficiency/index.ts <session-file>
```

`<session-file>` is a Claude Code session
(`~/.claude/projects/<project>/<session-id>.jsonl`) or a Codex rollout
(`~/.codex/sessions/.../rollout-*.jsonl`); the source is auto-detected.

Example output:

```
format                          bytes       tokens  vs native  file
native                        168,592       77,281          —  token-efficiency-out/rollout-.../native.jsonl
trajectory                     46,763       18,438       4.2x  token-efficiency-out/rollout-.../trajectory.jsonl
atif (harbor, minified)        88,410       35,847       2.2x  token-efficiency-out/rollout-.../atif.min.json
atif (harbor, persisted)       92,293       36,841       2.1x  token-efficiency-out/rollout-.../atif.json
```

Each representation is also written to `token-efficiency-out/<session-stem>/`
(override with `--out-dir`). Other flags: `--source claude-code|codex`,
`--model <id>` (default `claude-opus-4-8`), `--untruncated` (adds a trajectory
row with tool-result truncation disabled).

## ATIF details

Harbor has no standalone conversion CLI — session → ATIF conversion lives in
its agent classes and normally runs inside a harness trial.
`harbor_atif_convert.py` drives the exact upstream
`ClaudeCode`/`Codex`.`_convert_events_to_trajectory` code from a harbor
checkout with the harness-only imports stubbed (requires `uv` and `git`; a
checkout is cloned to `~/.cache/trajectory/harbor-repo` on first use, override
with `HARBOR_REPO=<path>`). The output validates against harbor's own ATIF
validator (`harbor-atif2otel`).

Note on interpreting results: ATIF as Harbor produces it intentionally keeps
untruncated tool results, structured result payloads (in `extra`), and
per-step token metrics, so it carries more content than trajectory by design —
the comparison reflects each format's content policy, not just syntax.
