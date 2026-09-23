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
    users: [{ id: "UONE", profile: { display_name: "Alice" } }],
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

## Who does what

Slack requires `channel` to call `conversations.history` / `conversations.replies`
and does not echo it back on each message, so the caller already holds it. The
same goes for `team` and any `users.list` data. The package owns everything that
is Slack message semantics; the caller owns everything about where the data came from.

```
Caller (importer, mirror, script)        @letta-ai/trajectory
- fetch pages or read files              - group by thread_ts ?? ts   (groupSlackMessages)
- team, channel (from the API call       - sort, dedupe, conflict-check
  or the path the data was keyed by)     - speaker id, name resolution
- users (users.list, users.jsonl, ...)   - reactions, text-only diagnostics
- merge rows across month files          - validate against conversation-v1
```

Given one channel's raw message objects, `groupSlackMessages` returns one envelope
per thread; a standalone unthreaded post is its own thread. It passes message
objects through untouched and never guesses `channel` or `team`.

```ts
import { groupSlackMessages, normalizeConversation } from "@letta-ai/trajectory/conversations";

for (const thread of groupSlackMessages(messages, { team, channel, users })) {
  normalizeConversation({ source: "slack", transcript: JSON.stringify(thread) });
}
```

`trajectory.conversations.group_slack_messages(messages, team=..., channel=..., users=...)`
does the same in Python. Group across file/month boundaries before calling it, and
do not discard replies whose root is outside the selected history range. The adapter
does not claim a thread is complete based on Slack's `reply_count` and does not
synthesize missing roots. Bare JSONL or mixed-thread envelopes are not accepted by
`normalizeConversation`. Envelopes are not accepted by the agent trajectory or canonical APIs.

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
    "speaker": { "id": "UONE", "name": "Alice" },
    "content": "Hello",
    "timestamp": "2023-11-14T22:13:20.000Z"
  }
]
```

`speaker.id` is the raw `user` ID, falling back to `bot_id` only when no user ID
is available. At least one is required. A bot relaying `*User*` and `*Agent*`
sections stays the same speaker; those labels remain ordinary text.

To resolve human names, callers may include `users`, an array of raw Slack
`users.list` objects (for example, loaded from the mirror's `users.jsonl`).
`speaker.name` prefers an inline `user_profile` display/real name, then the
user directory's display name, real name, or account name. For bot messages,
`bot_profile.name` and the legacy `username` are fallbacks. Blank names are
ignored; unknown names remain absent. No API lookup is performed, and IDs never
change because a display name changed. Conflicting named directory entries fail.

When the source message has `reactions`, it becomes `metadata.reactions`, keeping
`name`, `count`, and `users`. Slack [may return only some reactor IDs](https://docs.slack.dev/reference/methods/reactions.get/),
so `count` is preserved, not recomputed from `users.length`. Reaction names and reactor IDs
are sorted deterministically, and invalid/duplicate names or IDs are rejected.
Absent reactions are not the same as an explicitly empty reaction snapshot.

`conversation_id` retains `thread_ts`; `source_metadata` retains the native
`team` and `channel` field names. These shared fields are not repeated on each
message. The record format is source-neutral; only Slack ingestion is implemented.
Recipients, attachments, and other per-message metadata are still deferred.

Records are sorted by exact Slack `ts`, including microseconds. ISO timestamps
use millisecond precision; the exact six-digit fractional `ts` is retained
losslessly as `id`. Identify a thread by `(source, team, channel, conversation_id)`
and a message within it by `id`. These source-native IDs are stable across retries,
input reordering, file reorganization, and edited snapshots. A reply-only envelope
retains the same thread metadata and does not synthesize a missing root.

Exact semantic duplicates are collapsed with diagnostics (including a reply
seen both through history and thread replies). A `thread_broadcast`'s nested
`root` is ignored: it is context, not a new post. Conflicting versions of one
message in a single envelope fail, including conflicting names/reaction snapshots;
the importer must choose an authoritative
snapshot rather than relying on transport arrival order. Edits and deletions
are not applied from event streams by this adapter.

## Supported content and explicit limits

- Handles ordinary messages plus `bot_message`, `thread_broadcast`, `file_share`,
  and `me_message` text. Raw `text` is preserved, including Unicode, Slack
  mentions, links, markup, and quoted instructions. Treat it as untrusted data.
- Blocks, link unfurls, attachments, and file contents are not copied into prose.
  Blocks can contain more than the top-level fallback text; this is not a lossless
  conversion. Emoji shortcodes in `text` are preserved, and reactions stay in
  metadata instead of being appended to prose. Posts without nonempty `text` are skipped
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
