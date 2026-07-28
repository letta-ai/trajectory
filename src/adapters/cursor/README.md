# cursor

The adapter accepts the Cursor capture JSONL used by SWE-chat. Each line is:

```json
{ "role": "user | assistant", "message": { "content": [] } }
```

Content may also be a scalar string. `text`, `thinking`, `tool_use`, and
`tool_result` blocks become prose, reasoning, tool calls, and linked results.
Tool arguments remain structured JSON. When present, block call IDs and
`is_error` are preserved.

The observed SWE-chat Cursor capture omits timestamps, top-level record IDs,
tool-call IDs, and tool results. In that native subset the shared core
synthesizes deterministic timestamps and call IDs, while canonical source
identity anchors to each JSONL row's UTF-8 byte offset. The adapter also accepts
the same content-block shape when IDs or results are present.

The transcript itself has no session identifier. Callers using
`normalizeToCanonical()` must therefore pass the corpus/session ID as
`sourceContext.groupId`; trajectory-v1 `normalizeTranscript()` needs no extra
context.

Malformed JSONL lines and unknown rows or content-block types are recoverable
diagnostics. The capture is an exported transcript rather than a documented
Cursor local store, so `listTrajectories()` is not supported.
