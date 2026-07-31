# pool

Native Pool (poolside) session NDJSON, as written to
`~/.local/state/poolside/trajectories/trajectory-standalone_<session-id>.ndjson`.
The whole file is the transcript string.

One JSON object per line. Every event carries a top-level native UUID (`id`), a
`step_id`, an ISO `timestamp`, and a `type`. The adapter maps the conversational
event types to the shared record contract:

| Pool `type` | payload | trajectory record |
| --- | --- | --- |
| `session.input` | `session_input.prompt` | `user` |
| `thought.end` | `thought_end.thought` | `reasoning` |
| `assistant_message.end` | `assistant_message_end.assistant_message` | `assistant` |
| `tool_call.parsed` | `tool_call_parsed.{id, name, args/raw_args}` | assistant `tool_call` |
| `tool_call.result` | `tool_call_result.{id, tool_name, observation, is_error?}` | `tool` result |

## Identity

- Every body record is anchored to its native event UUID, so identity is
  `native` and independent of transport-arrival order.
- Tool calls and results link by the native call id shared between
  `tool_call_parsed.id` and `tool_call_result.id` (not by the event UUID).
- The `session.start` record id anchors the source group. A file with a single
  session-start id resolves its group natively; a file with multiple distinct
  session-start ids (a resumed/concatenated export) is flagged ambiguous and
  requires `sourceContext.groupId`.

## Tool-result status

`ok = !is_error` is projected only when `tool_call_result.is_error` is a boolean.
It is omitted otherwise and is never inferred from result text.

## Dropped input

Skipped silently, as transport/marker/noise rows (matching other adapters):

- `session.start` (used only for cwd/created-at/group; not a conversational record)
- `tool_call.inference.start` (harvests `model` only; the full chat-completion
  request is skipped as transport noise)
- `thought.start`, `assistant_message.start`, `tool_call.start`
- `tool_call.approval` (an approval gate, not a result status)
- `model_reminder` (injected context)
- empty/`session.input` prompts, malformed JSON lines (recoverable `invalid_json_line` diagnostics)

## Listing

`listTrajectories({ source: "pool" })` scans
`~/.local/state/poolside/trajectories/` for
`trajectory-standalone_<session-id>.ndjson` files, newest first by mtime. The
listing `id` is the session UUID parsed from the filename.
