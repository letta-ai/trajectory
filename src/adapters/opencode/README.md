# opencode

The adapter accepts one native OpenCode session export as a single JSON
document:

```json
{ "info": { "...": "..." }, "messages": [{ "info": {}, "parts": [] }] }
```

This is a whole document even when a corpus stores it with a `.jsonl`
extension. `info.id`, `info.directory`, and `info.time.created` provide the
session identity, working directory, and creation time. Message metadata
provides role, model, and message time.

Message parts decode as follows:

- `text` becomes user or assistant prose.
- `reasoning` becomes a reasoning record.
- `tool` becomes one call and, when the state is terminal, its linked result.
  `callID` and `tool` are preserved; `state.input` is serialized as arguments;
  `state.output` or `state.error` supplies result content.
- `completed` and `error` states map to `ok: true` and `ok: false`.
  A `running` call without output remains an unfinished call.

Native part IDs are the preferred canonical source identity. Older or
hand-built exports fall back to message IDs and then whole-document part
ordinals. Part timestamps take precedence over message timestamps; a later
part without its own time inherits the latest time in that message so the
native part order remains stable.

`step-start`, `step-finish`, `patch`, `snapshot`, `file`, and `subtask` parts
are transport/state records and are dropped. Other unknown part types are
dropped with a diagnostic.

Local-store discovery is intentionally not provided. The caller supplies an
already assembled OpenCode session export to
`normalizeTranscript({ source: "opencode", transcript })`.
