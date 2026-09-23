# Slack channels

Slack is a multi-participant source, not a user/assistant exchange. This adapter
turns one channel's raw messages into one conversation: a leading `meta`, then
top-level posts in time order with thread replies nested once under their root.
It does not assign bot messages to an assistant, identify quoted speakers, or
treat an imported conversation as the consuming agent's own experience.

## Input

```ts
import { normalizeConversation } from "@letta-ai/trajectory/conversations";

const { records, diagnostics } = normalizeConversation({
  source: "slack",
  transcript: rawJsonl, // JSONL rows, a JSON array, or a conversations.history response
  channel: "CEXAMPLE",
  users: [{ id: "UONE", profile: { display_name: "Alice" } }], // optional
});
```

`transcript` is the channel dump as fetched or mirrored, mixing top-level posts
and thread replies in any order. Python exposes `normalize_conversation` with
the same keyword arguments.

## Who does what

Slack requires `channel` to call `conversations.history` / `conversations.replies`
and does not echo it back on each message, so the caller already holds it. The
same goes for any `users.list` data. The package owns everything that is Slack
message semantics; the caller owns everything about where the data came from.

```
Caller (importer, mirror, script)        @letta-ai/trajectory
- fetch pages or read files              - group by thread_ts ?? ts, nest replies
- channel (from the API call or the      - sort, dedupe, conflict-check
  path the data was keyed by)            - speaker id, name resolution
- users (users.list, users.jsonl, ...)   - reactions, text-only diagnostics
- merge rows across month files          - validate against conversation-v1
```

Merge rows across file/month boundaries before calling, and do not discard replies
whose root is outside the selected history range: they become a thread fragment
(below). The adapter does not claim a thread is complete based on Slack's
`reply_count` and does not synthesize missing roots. The API does not accept
agent trajectory input, and conversation output is not accepted by the agent
trajectory or canonical APIs.

Access filtering, snapshot selection, Slack API calls, mirror reads, and downstream
submission belong to the importer, not this pure library. Never treat a
service-owned organization mirror as permission to disclose all its channels.

## Output and identity

```json
[
  { "role": "meta", "source": "slack", "channel": "CEXAMPLE" },
  {
    "id": "1700000000.000001",
    "speaker": { "id": "UONE", "name": "Alice" },
    "content": "Hello",
    "timestamp": "2023-11-14T22:13:20.000Z",
    "reactions": [{ "name": "eyes", "count": 1, "users": [{ "id": "UTWO" }] }],
    "replies": [
      {
        "id": "1700000001.000001",
        "speaker": { "id": "UTWO" },
        "content": "Hi",
        "timestamp": "2023-11-14T22:13:21.000Z"
      }
    ]
  },
  {
    "id": "1700000002.000001",
    "speaker": { "id": "UTWO" },
    "content": "A standalone post",
    "timestamp": "2023-11-14T22:13:22.000Z"
  }
]
```

`meta` is the only record with a `role`. `channel` appears once; `team` is not
emitted. Each following record is a top-level post. A thread root carries
`replies`; a post with no replies has no `replies` key. Replies use the same
message shape and never nest further. Slack's `thread_ts` is the root's `ts`, so
the thread's identity is the root's `id` and is not repeated on replies.

Replies whose root is not in the input become a thread fragment
`{ "id": "<root ts>", "replies": [...] }` with a `slack_missing_root` diagnostic.
Nothing about the root is invented.

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
Mentions inside `content` are left as source text.

When the source message has `reactions`, it is kept as `reactions` with
`name`, `count`, and `users`. Each reactor is `{ id, name? }`, resolved from the
same `users` list as speakers. Slack [may return only some reactor IDs](https://docs.slack.dev/reference/methods/reactions.get/),
so `count` is preserved, not recomputed from `users.length`. Reaction names and reactors
are sorted deterministically, and invalid/duplicate names or IDs are rejected.
Absent reactions are not the same as an explicitly empty reaction snapshot.

Posts and replies are sorted by exact Slack `ts`, including microseconds. ISO
timestamps use millisecond precision; the exact six-digit fractional `ts` is
retained losslessly as `id`. Identify a message by `(source, channel, id)`.
These source-native IDs are stable across retries, input reordering, file
reorganization, and edited snapshots.

Exact semantic duplicates are collapsed with `slack_duplicate_message` (including
a reply seen both through history and thread replies). A `thread_broadcast`'s
nested `root` is ignored: it is context, not a new post. Conflicting versions of
one message in a single dump fail, including conflicting names, reaction
snapshots, or thread membership; the importer must choose an authoritative
snapshot rather than relying on transport arrival order. Edits and deletions
are not applied from event streams by this adapter.

## Supported content and explicit limits

- Handles ordinary messages plus `bot_message`, `thread_broadcast`, `file_share`,
  and `me_message` text. Raw `text` is preserved, including Unicode, Slack
  mentions, links, markup, and quoted instructions. Treat it as untrusted data.
- Blocks, link unfurls, attachments, and file contents are not copied into prose.
  Blocks can contain more than the top-level fallback text; this is not a lossless
  conversion. Emoji shortcodes in `text` are preserved, and reactions stay
  structured instead of being appended to prose. Posts without nonempty `text`
  are skipped with `slack_message_dropped`, **including blocks-only or file-only
  posts**. A dropped root with surviving replies becomes a thread fragment.
- Unsupported subtypes (including join/leave, edit/delete event wrappers) and
  non-message events are skipped with the same diagnostic. This is a text
  snapshot adapter, not an event replay engine or a multimodal importer.
- Invalid identity/timestamps, a message whose own `channel` disagrees with the
  supplied one, replies dated before their root, or no supported text messages
  fail loudly. There is no conversation listing API; `listTrajectories` remains
  limited to agent sources.

## Consumer rollout

This uses the independent `conversation-v1` schema and `normalizeConversation`
entry point. Existing agent records, validators, canonical projection, and
canonical schema version are unchanged. Consumers must explicitly accept the
conversation contract before ingesting this output; it is not a new variant of
an agent's execution history. No downstream integration is implemented here.
