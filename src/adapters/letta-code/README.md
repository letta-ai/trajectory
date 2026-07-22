# letta-code

The adapter accepts the append-only client transcript that Letta Code writes
for agent conversations:

```text
~/.letta/transcripts/<agent>/<conversation>/transcript.jsonl
```

Each JSONL row has a `kind` of `user`, `assistant`, `reasoning`, `tool_call`,
or `error`. Text rows use `text`; tool rows use `name`, `argsText`,
`resultText`, and `resultOk`; `captured_at` supplies the record timestamp.
`source_message_id` is the preferred source identity when present, with
`source_line_id` as the fallback. If neither exists, canonical normalization
uses the row's position within the provided JSONL; it does not substitute a
byte offset or require caller metadata. A completed tool row expands into a
linked assistant tool call and tool result.
For an older tool row with neither source id, a line-scoped call id links those
two emitted records without becoming the row's source identity. An unfinished
tool row without result fields emits only the call. Failed results gain an
`Error:` prefix.

`error` rows are client runtime/UI noise and are dropped with a diagnostic.
Malformed JSONL lines and unsupported row kinds are also recoverable
diagnostics when the file still contains recognizable transcript rows.

The adapter intentionally does not accept either backend's native conversation
history (`lc-local-backend/.../messages.jsonl` or Letta API message arrays).
Those stores serve model context, resume, and compaction rather than the
client-side reflection pipeline. It also does not accept generated reflection
payloads such as `payload-auto-*.json` or `payload-slice-*.json`.

## Listing

`listTrajectories({ source: "letta-code" })` scans `~/.letta/transcripts/`.
Each item is identified by `<agent>/<conversation>`, points to that
conversation's `transcript.jsonl`, and excludes empty logs.
