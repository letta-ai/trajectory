# claude-code

Native Claude Code session JSONL, as written to
`~/.claude/projects/<project>/<sessionId>.jsonl`. The whole file is the
transcript string.

The adapter decodes `user` and `assistant` rows — including `thinking`,
`text`, `tool_use`, and `tool_result` content blocks — and links results to
calls by the native tool-use id. Line `uuid`s provide native record identity,
and session context (cwd, git branch) is resolved from source chronology so it
does not depend on transport-arrival order.

Dropped input:

- Sidechain records (`isSidechain: true`), reported with a
  `sidechain_record_dropped` diagnostic.
- Transport/UI rows (`progress`, `summary`, `system`, `file-history-snapshot`,
  title/mode bookkeeping, and similar), skipped silently.
- Harness-noise user rows (local-command output, command wrappers), reported
  by the shared core as `noise_record_dropped`.

## Listing

`listTrajectories({ source: "claude-code" })` scans `~/.claude/projects/*/`
for `<sessionId>.jsonl` files; each item's `path` is the transcript file.
