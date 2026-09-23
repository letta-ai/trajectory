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
import {
  normalizeConversation,
  validateConversation,
} from "@letta-ai/trajectory/conversations";

const result = normalizeConversation({ source: "slack", transcript });
validateConversation(result.records);
```

```python
from trajectory.conversations import normalize_conversation

result = normalize_conversation(source="slack", transcript=transcript)
```

Both return `{ records, diagnostics }`. The records array is validated by
[`conversation-v1.schema.json`](schema/conversation-v1.schema.json), available
to npm consumers as `@letta-ai/trajectory/schema/conversation`. Runtime validation
additionally checks message-ID uniqueness and timestamp parseability.

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

Every envelope includes thread context, including reply-only fragments. A missing
root is not fabricated. Transport chunk offsets and agent canonical hashing are
not part of this contract.

## V0 scope

Only [Slack thread envelopes](src/adapters/slack/) can currently be normalized.
The record format can represent other messaging sources, but no Teams, Gmail,
or Google Chat adapter is implemented. Reactions, recipients, attachments, and
message-level metadata are deferred. Documents are not forced into this format.

Callers own source access, grouping, snapshot selection, and downstream ingestion.
Content remains untrusted source text, including any instructions quoted in it.
