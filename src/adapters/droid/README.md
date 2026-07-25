# droid

Droid stores one session per JSONL file under
`~/.factory/sessions/<cwd>/<uuid>.jsonl`. Pass the complete file contents as
the `transcript` to `normalizeTranscript({ source: "droid", transcript })`.

The first `session_start` object supplies `cwd` and the session UUID used as
the source group. Each subsequent `message` contains Anthropic-style content
blocks. The adapter preserves text, `thinking` blocks, assistant `tool_use`
blocks (with JSON-stringified inputs), and user `tool_result` blocks linked by
`tool_use_id`. Droid has no per-event timestamps or transcript model field, so
the shared core synthesizes timestamps and no model is added to metadata.

`todo_state`, `session_end`, and `compaction_state` rows are transport noise
and are dropped.

## Listing

`listTrajectories({ source: "droid" })` scans `~/.factory/sessions/` for JSONL
files. The listing is separate from normalization; the adapter itself never
reads the filesystem.
