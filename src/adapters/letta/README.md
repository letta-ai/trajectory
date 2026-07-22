# letta

Two accepted input containers:

- **Cloud/API message array** — messages with native `message_type` values
  such as `user_message`, `reasoning_message`, `assistant_message`,
  `tool_call_message`, `approval_request_message`, and `tool_return_message`.
  The adapter orders a complete response by `seq_id`, handles singular and
  batched tool fields (`tool_calls` / `tool_returns`), and ignores system and
  approval-control records.
- **Local conversation JSONL** — Letta's actual local conversation files from
  `lc-local-backend/conversations/*/messages.jsonl`, in both the legacy
  headerless message-row form and the version 3 session-entry form
  (`type: "session"` header plus `type: "message"` wrapper rows with
  `thinking` / `text` / `toolCall` parts).

Compaction entries are excluded because they summarize existing conversation
context. The separate `~/.letta/transcripts` tree contains reflection
artifacts and is not a supported native input. Failed tool returns gain an
`Error:` prefix.

## Listing

`listTrajectories({ source: "letta" })` scans
`~/.letta/lc-local-backend/conversations/`, decoding each base64 directory
name to its conversation id; each item's `path` is the `messages.jsonl` file.
