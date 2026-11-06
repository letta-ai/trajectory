# DeepSeek Harness

The `dsh` source accepts the logical session JSONL returned by DeepSeek
Harness `SessionPersistence.readRaw()`. The first line is the immutable
`type: "session"` header and the remaining lines are session events or packed
stream-chunk storage rows. When the physical artifact is `.jsonl.zstd`, callers
must use the DSH persistence API (or another Zstandard decoder) before calling
`normalizeTranscript()`; this package performs no filesystem or decompression
work.

The adapter targets DSH `SESSION_FORMAT_VERSION = 0` as published by
`dsh-v0.1.0-rc.8`.

| DSH input | Normalized output |
| --- | --- |
| session header | source group, working directory, creation time |
| `request/header`, `request/context` | `provider/model` route metadata |
| append-origin `user/message` | user text |
| append-origin `assistant/message` | reasoning, assistant text, and tool calls in native block order |
| append-origin `tool/result` | linked result with `isError` mapped to `ok` |

Only `user/message` records whose source is exactly `kind: "user"` become user
records. DSH also uses the same event type for system-prompt snapshots, skill
catalogs, and plugin injections; those are dropped with an
`injected_context_dropped` diagnostic rather than being mislabeled as human
learning input.

Message IDs become native canonical source identities. Event `seq` becomes the
source ordering key, and event `time` becomes the source timestamp. Tool-call
IDs and raw JSON argument strings are retained. Tool calls are decoded from the
assembled `assistant/message`; the later `tool/call` lifecycle record is not
emitted a second time.

Streaming chunks (including packed chunk rows), turn/step boundaries, request
metadata after route extraction, and plugin-specific log-only events are
ignored. Surface replacement messages created by compaction are also ignored:
they are model-context checkpoints, while the append-origin events remain the
human-visible learning transcript.

Local listing is intentionally unavailable. DSH requires deployments to choose
their session root explicitly, so there is no truthful default store path for
this library to discover.
