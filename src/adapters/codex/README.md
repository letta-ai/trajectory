# codex

Native Codex rollout JSONL, as written to `~/.codex/sessions/`. The whole file
is the transcript string.

The adapter decodes `session_meta` (cwd, git branch, session id),
`turn_context` (model), `event_msg` reasoning, and `response_item` payloads:
`message`, `reasoning`, `function_call`, `custom_tool_call`, `web_search_call`,
`tool_search_call`, and their outputs. Results link to calls by native
`call_id`.

Each `response_item` reasoning summary part becomes one reasoning record.
Older writers also emit each summary part as an `agent_reasoning` event; those
events are decoded as before, and summary parts that repeat one are skipped.
Newer writers repeat summaries in `item_completed` Reasoning events instead,
which are ignored. Encrypted reasoning content is not decoded.

Codex rollout lines carry no per-record id, so identity anchors to the
append-only byte offset (kind `byte`), which stays stable across chunked
uploads via `sourceContext.baseByteOffset`. Canonical normalization requires a
resolved session id: include the `session_meta` row or pass
`sourceContext.groupId`.

System-injected user content (`<environment_context>`, `<user_instructions>`,
`<permissions instructions>`, `<turn_context>`) is dropped with an
`injected_context_dropped` diagnostic.

## Listing

`listTrajectories({ source: "codex" })` walks `~/.codex/sessions/` recursively
for rollout `.jsonl` files; each item's `path` is the transcript file.
