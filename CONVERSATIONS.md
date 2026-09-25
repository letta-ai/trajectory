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
  channelName: "eng-deploys", // optional
  users, // optional users.list rows, for display names and bot flags
});
```

```python
from trajectory.conversations import normalize_conversation

result = normalize_conversation(
    source="slack", transcript=raw_jsonl, channel="C0AB…", channel_name="eng-deploys", users=users
)
```

One channel is one conversation. `transcript` is the raw dump: JSONL rows, a
JSON array, or a `conversations.history` response, containing both top-level
posts and thread replies. `channel` is what Slack required you to know to fetch
it and does not appear on messages. `channelName` is an optional readable name the
caller already has (for example from `conversations.info`). `users` is optional and
only resolves names and bot flags. An empty dump is an empty channel: the result is
the `meta` record alone.

The result is `{ records, diagnostics }`. The records array is validated by
[`conversation-v1.schema.json`](schema/conversation-v1.schema.json), available
to npm consumers as `@letta-ai/trajectory/schema/conversation`. Runtime validation
additionally checks message-ID uniqueness across the whole conversation, that
every `speaker` is a `participants` label, that participant IDs are unique, and
timestamp parseability. `validateConversation` is exported for records built elsewhere.

## Records

The format is designed to be read by a model, so shared context appears once
and thread structure is nesting rather than repeated IDs.

```json
[
  { "role": "meta", "source": "slack", "channel": "C0AB…", "channel_name": "eng-deploys",
    "participants": { "Charles": { "id": "U079…" }, "Deploy Bot": { "id": "B08…", "bot": true },
      "Titan": { "id": "U0BRK…" }, "U084…": { "id": "U084…" } } },
  { "id": "1790028870.001200", "speaker": "Titan", "timestamp": "2026-09-20T17:47:50Z",
    "content": "@Charles deploy is stuck", "reactions": { "eyes": 2 },
    "replies": [
      { "id": "1790028881.776679", "speaker": "Charles",
        "timestamp": "2026-09-20T17:48:01Z", "content": "looking\n[file: deploy.log]" }
    ] },
  { "id": "1790139575.812159", "speaker": "U084…",
    "timestamp": "2026-09-22T00:32:55Z", "content": ":hype_pepe:" }
]
```

One leading `meta` carries `source`, `channel`, an optional `channel_name`, and
`participants`; it is the only record with a `role`. Every following record is a
top-level post in time order:

- A **post** has `id`, `speaker`, `content`, an ISO `timestamp`, and optional
  `reactions`. If the thread has replies, `replies` holds them in time order with
  the same message shape; replies never nest further. The thread's identity is
  the root's `id` (Slack's `thread_ts` is the root's `ts`), so it appears once.
- A **thread fragment** is `{ id, missing_root: true, replies }` with no speaker
  or content: replies were present but their root was not in the input. The root
  is not fabricated.

`participants` maps each label used as a `speaker` or an `@` mention to
`{ id, bot? }`, once per conversation. A label is the participant's display name,
suffixed (`Alex (2)`) when two participants share one, or the source ID when no
name is known. `bot: true` marks bots and apps; bot messages are attributed to
their source identity, not an assistant role. User mentions in `content` are
rewritten to `@label`; everything else stays source text.

Message IDs are source-native and unique across the whole conversation; for
Slack the ID is the exact `ts`. `timestamp` has second precision.
`reactions` maps each reaction name to the count the source reports. Who reacted
is not kept. Missing `reactions` means no snapshot was provided; an explicit
empty object means the provided snapshot has no reactions.

## V0 scope

Only [Slack channel dumps](src/adapters/slack/) can currently be normalized.
The record format can represent other messaging sources, but no Teams, Gmail,
or Google Chat adapter is implemented. Names, reaction counts, and file
placeholders are supported; recipients, file contents, and other message-level
metadata are deferred.
Documents are not forced into this format.

Callers own source access, channel context, `users.list` snapshots, and
downstream ingestion. Content remains untrusted source text, including any
instructions quoted in it.
