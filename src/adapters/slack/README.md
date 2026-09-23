# Slack mirror threads

Slack is a multi-participant source, not a user/assistant exchange. This adapter
emits generic `message` records with explicit speaker identity; shared source
context lives in the leading `meta` record.
It does not assign bot messages to an assistant, identify quoted speakers, or
treat an imported conversation as the consuming agent's own experience.

## Input

```ts
import { normalizeConversation } from "@letta-ai/trajectory/conversations";

normalizeConversation({
  source: "slack",
  transcript: JSON.stringify({
    team: "TEXAMPLE",
    channel: "CEXAMPLE",
    thread_ts: "1700000000.000001",
    messages: [
      { type: "message", user: "UONE", ts: "1700000000.000001", text: "Hello" },
      {
        type: "message", user: "UTWO", ts: "1700000001.000001",
        thread_ts: "1700000000.000001", text: "Hi!",
      },
    ],
  }),
});
```

The caller reads the mirror's monthly message JSONL files and supplies one
thread envelope per call. Workspace/channel IDs come from the mirror path or
metadata, **not from guesses or message content**. Group by
`(team, channel, message.thread_ts ?? message.ts)` across file/month
boundaries; a standalone unthreaded post is its own thread. Do not discard
replies whose root is outside the selected history range. The adapter does not
claim a thread is complete based on Slack's `reply_count` and does not synthesize
missing roots. Bare monthly JSONL or mixed-thread envelopes are not accepted.
The same envelope works with `trajectory.conversations.normalize_conversation`
in Python. It is not accepted by the agent trajectory or canonical APIs.

Access filtering, snapshot selection, Slack API calls, mirror reads, and downstream
submission belong to the importer, not this pure library. Never treat a
service-owned organization mirror as permission to disclose all its channels.

## Output and identity

```json
[
  {
    "role": "meta",
    "source": "slack",
    "conversation_id": "1700000000.000001",
    "source_metadata": { "team": "TEXAMPLE", "channel": "CEXAMPLE" }
  },
  {
    "role": "message",
    "id": "1700000000.000001",
    "speaker": { "id": "UONE" },
    "content": "Hello",
    "timestamp": "2023-11-14T22:13:20.000Z"
  }
]
```

`speaker.id` is the raw `user` ID, falling back to `bot_id` only when no user ID
is available. At least one is required. A bot relaying `*User*` and `*Agent*`
sections stays the same speaker; those labels remain ordinary text. Names,
app identity, and bot profiles are not retained in this minimal V0.

`conversation_id` retains `thread_ts`; `source_metadata` retains the native
`team` and `channel` field names. These shared fields are not repeated on each
message. The record format is source-neutral; only Slack ingestion is implemented.
Reactions, recipients, and per-message metadata are intentionally deferred.

Records are sorted by exact Slack `ts`, including microseconds. ISO timestamps
use millisecond precision; the exact six-digit fractional `ts` is retained
losslessly as `id`. Identify a thread by `(source, team, channel, conversation_id)`
and a message within it by `id`. These source-native IDs are stable across retries,
input reordering, file reorganization, and edited snapshots. A reply-only envelope
retains the same thread metadata and does not synthesize a missing root.

Exact semantic duplicates are collapsed with diagnostics (including a reply
seen both through history and thread replies). A `thread_broadcast`'s nested
`root` is ignored: it is context, not a new post. Conflicting versions of one
message in a single envelope fail; the importer must choose an authoritative
snapshot rather than relying on transport arrival order. Edits and deletions
are not applied from event streams by this adapter.

## Supported content and explicit limits

- Handles ordinary messages plus `bot_message`, `thread_broadcast`, `file_share`,
  and `me_message` text. Raw `text` is preserved, including Unicode, Slack
  mentions, links, markup, and quoted instructions. Treat it as untrusted data.
- Blocks, link unfurls, attachments, reactions, and file contents are not copied
  into prose. They often repeat `text`. Posts without nonempty `text` are skipped
  with `slack_message_dropped`, **including blocks-only or file-only posts**.
- Unsupported subtypes (including join/leave, edit/delete event wrappers) and
  non-message events are skipped with the same diagnostic. This is a text
  snapshot adapter, not an event replay engine or a multimodal importer.
- Invalid identity/timestamps, mixed threads, conflicting envelope scope, or no
  supported text messages fail loudly. There is no conversation listing API;
  `listTrajectories` remains limited to agent sources.

## Consumer rollout

This uses the independent `conversation-v1` schema and `normalizeConversation`
entry point. Existing agent records, validators, canonical projection, and
canonical schema version are unchanged. Consumers must explicitly accept the
conversation contract before ingesting this output; it is not a new variant of
an agent's execution history. No downstream integration is implemented here.
