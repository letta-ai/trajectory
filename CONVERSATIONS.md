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
import { normalizeConversations } from "@letta-ai/trajectory/conversations";

const { conversations } = normalizeConversations({
  source: "slack",
  transcript: rawJsonl, // one channel's messages, as fetched
  context: { team, channel, users },
});
```

```python
from trajectory.conversations import normalize_conversations

result = normalize_conversations(
    source="slack", transcript=raw_jsonl, context={"team": team, "channel": channel, "users": users}
)
```

`transcript` is the raw dump: JSONL rows, a JSON array, or a `conversations.history`
response. `context` is what Slack required you to know to fetch it (`team`,
`channel`) plus optional `users.list` rows for display names. The result is one
`{ records, diagnostics }` per thread, in thread order. An empty dump yields no
conversations. `normalizeConversation` (singular) normalizes one pre-built thread
envelope and `validateConversation` checks a records array; both are exported for
callers that already hold threads in memory.

Each conversation is `{ records, diagnostics }`. The records array is validated by
[`conversation-v1.schema.json`](schema/conversation-v1.schema.json), available
to npm consumers as `@letta-ai/trajectory/schema/conversation`. Runtime validation
additionally checks message-ID/reaction-name uniqueness, timestamp parseability,
and that the listed reactors do not exceed the reported count.

## Records

One leading `meta` contains:

- `source`: source name.
- `conversation_id`: source-native thread identity.
- Optional `source_metadata`: source-native string-valued context shared by the
  thread, such as Slack's `team` and `channel`.

At least one `message` follows, with `id`, `speaker: { id }`, `content`, and an
ISO `timestamp`. Message IDs are unique within the scoped conversation;
participant IDs are interpreted in the source's account/workspace context.
Bot messages are attributed to their source identity, not an assistant role.
Optional `speaker.name` is a display label from source profiles, not an identifier.

Optional message `metadata.reactions` contains `{ name, count, users }` snapshots.
`count` is the total reported by the source; `users` lists known reactor IDs and
may be incomplete. Missing reactions mean no snapshot was provided; an explicit
empty array means the provided snapshot has no reactions. No timestamps or
reaction meanings are invented.

Every envelope includes thread context, including reply-only fragments. A missing
root is not fabricated. Transport chunk offsets and agent canonical hashing are
not part of this contract.

## V0 scope

Only [Slack thread envelopes](src/adapters/slack/) can currently be normalized.
The record format can represent other messaging sources, but no Teams, Gmail,
or Google Chat adapter is implemented. Names and reaction snapshots are supported;
recipients, attachments, and other message-level metadata are deferred.
Documents are not forced into this format.

Callers own source access, channel/workspace context, snapshot selection, and
downstream ingestion. `groupSlackMessages` turns one channel's raw messages into
thread envelopes so callers do not reimplement Slack threading.
Content remains untrusted source text, including any instructions quoted in it.
