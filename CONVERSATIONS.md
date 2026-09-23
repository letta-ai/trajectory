# Imported conversations (v1)

Imported conversations describe what multiple participants said to one another.
They are not an agent's execution history: there is no inferred assistant,
reasoning, or tool-call role.

This contract is independent of `trajectory-v1` and the agent canonical schema.
Existing `NormalizedRecord`, `normalizeTranscript`, `normalizeToCanonical`, and
their schema versions do not change. Consumers must explicitly opt into
conversation input; no conversion into agent canonical rows is provided.

## API

```ts
import { normalizeConversation } from "@letta-ai/trajectory/conversations";

const { records, diagnostics } = normalizeConversation({
  source: "slack",
  transcript: rawJsonl, // one channel's messages, as fetched
  channel: "C0AB…",
  users, // optional users.list rows, for display names
});
```

```python
from trajectory.conversations import normalize_conversation

result = normalize_conversation(source="slack", transcript=raw_jsonl, channel="C0AB…", users=users)
```

One channel is one conversation. `transcript` is the raw dump: JSONL rows, a
JSON array, or a `conversations.history` response, containing both top-level
posts and thread replies. `channel` is what Slack required you to know to fetch
it and does not appear on messages. `users` is optional and only resolves names.

The result is `{ records, diagnostics }`. The records array is validated by
[`conversation-v1.schema.json`](schema/conversation-v1.schema.json), available
to npm consumers as `@letta-ai/trajectory/schema/conversation`. Runtime validation
additionally checks message-ID/reaction-name uniqueness across the whole
conversation, timestamp parseability, and that listed reactors do not exceed
the reported count. `validateConversation` is exported for records built elsewhere.

## Records

The format is designed to be read by a model, so shared context appears once
and thread structure is nesting rather than repeated IDs.

```json
[
  { "role": "meta", "source": "slack", "channel": "C0AB…" },
  { "id": "1790028870.001200", "speaker": { "id": "U0BRK…", "name": "Titan" },
    "timestamp": "2026-09-20T17:47:50.001Z", "content": "deploy is stuck",
    "reactions": [{ "name": "eyes", "count": 2, "users": ["U079…", "U084…"] }],
    "replies": [
      { "id": "1790028881.776679", "speaker": { "id": "U079…" },
        "timestamp": "2026-09-20T17:48:01.776Z", "content": "looking" }
    ] },
  { "id": "1790139575.812159", "speaker": { "id": "U084…" },
    "timestamp": "2026-09-22T00:32:55.812Z", "content": ":hype_pepe:" }
]
```

One leading `meta` carries `source` and `channel`; it is the only record with a
`role`. Every following record is a top-level post in time order:

- A **post** has `id`, `speaker: { id, name? }`, `content`, an ISO `timestamp`,
  and optional `reactions`. If the thread has replies, `replies` holds them in
  time order with the same message shape; replies never nest further. The
  thread's identity is the root's `id` (Slack's `thread_ts` is the root's `ts`),
  so it appears once.
- A **thread fragment** is `{ id, replies }` with no speaker or content: replies
  were present but their root was not in the input. The root is not fabricated.

Message IDs are source-native and unique across the whole conversation.
Participant IDs are interpreted in the source's workspace context. Bot messages
are attributed to their source identity, not an assistant role. Optional
`speaker.name` is a display label from source profiles, never a replacement for
`speaker.id`; mentions inside `content` are left as source text.

`reactions` contains `{ name, count, users }` snapshots. `count` is the total
reported by the source; `users` lists known reactor IDs and may be incomplete.
Missing `reactions` means no snapshot was provided; an explicit empty array
means the provided snapshot has no reactions.

## V0 scope

Only [Slack channel dumps](src/adapters/slack/) can currently be normalized.
The record format can represent other messaging sources, but no Teams, Gmail,
or Google Chat adapter is implemented. Names and reaction snapshots are supported;
recipients, attachments, and other message-level metadata are deferred.
Documents are not forced into this format.

Callers own source access, channel context, `users.list` snapshots, and
downstream ingestion. Content remains untrusted source text, including any
instructions quoted in it.
