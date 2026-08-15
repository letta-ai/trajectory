# dsh

DeepSeek Harness (`dsh`) stores each session as an append-only JSONL event
stream at `~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.jsonl.zstd`.
Pass the **decompressed JSONL text** to
`normalizeTranscript({ source: "dsh", transcript })`. The `.zstd` container is
an on-disk storage detail; this package intentionally has no zstd dependency.

| dsh event | Normalized output |
| --- | --- |
| `session` | meta session id, cwd, creation time |
| `request/header`, `request/context` | model metadata |
| `user/message` | user text blocks |
| `assistant/message` | aggregate assistant text and reasoning blocks |
| `tool/call` | assistant tool call |
| `tool/result` | linked tool result and native error status |
| `assistant/chunk`, turn/step boundaries, title, permission and request metadata | ignored |

`tool/call` and `tool/result` are the authoritative tool lifecycle events.
Assistant streaming chunks are deliberately ignored, and embedded tool blocks in
aggregate messages are not replayed, preventing duplicate calls and results.

`listTrajectories({ source: "dsh" })` discovers compressed session logs in the
standard store. It returns their `.jsonl.zstd` paths; callers decompress before
normalizing.
