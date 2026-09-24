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
  channelName: "eng-deploys", // optional
  users: [{ id: "UONE", profile: { display_name: "Alice" } }], // optional
});
```

`transcript` is the channel dump as fetched or mirrored, mixing top-level posts
and thread replies in any order. An empty dump is an empty channel and returns
`meta` alone. Python exposes `normalize_conversation` with the same keyword
arguments (`channel_name` for `channelName`).

## Who does what

Slack requires `channel` to call `conversations.history` / `conversations.replies`
and does not echo it back on each message, so the caller already holds it. The
same goes for a readable channel name and any `users.list` data. The package owns everything that is Slack
message semantics; the caller owns everything about where the data came from.

```
Caller (importer, mirror, script)        @letta-ai/trajectory
- fetch pages or read files              - group by thread_ts ?? ts, nest replies
- channel (from the API call or the      - sort, dedupe, reconcile copies
  path the data was keyed by)            - participant labels, mentions
- channel name (conversations.info)      - reaction counts, file placeholders
- users (users.list, users.jsonl, ...)   - dropped-post diagnostics
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
  {
    "role": "meta",
    "source": "slack",
    "channel": "CEXAMPLE",
    "channel_name": "eng-deploys",
    "participants": { "Alice": { "id": "UONE" }, "UTWO": { "id": "UTWO" } }
  },
  {
    "id": "1700000000.000001",
    "speaker": "Alice",
    "content": "@UTWO can you check the deploy?",
    "timestamp": "2023-11-14T22:13:20Z",
    "reactions": { "eyes": 1 },
    "replies": [
      {
        "id": "1700000001.000001",
        "speaker": "UTWO",
        "content": "on it\n[file: deploy.log]",
        "timestamp": "2023-11-14T22:13:21Z"
      }
    ]
  },
  {
    "id": "1700000002.000001",
    "speaker": "UTWO",
    "content": "A standalone post",
    "timestamp": "2023-11-14T22:13:22Z"
  }
]
```

`meta` is the only record with a `role`. `channel` and `channel_name` appear
once; `team` is not emitted. Each following record is a top-level post. A thread
root carries `replies`; a post with no replies has no `replies` key. Replies use
the same message shape and never nest further. Slack's `thread_ts` is the root's
`ts`, so the thread's identity is the root's `id` and is not repeated on replies.

Replies whose root is not in the input become a thread fragment
`{ "id": "<root ts>", "missing_root": true, "replies": [...] }` with a
`slack_missing_root` diagnostic. Nothing about the root is invented.

A speaker's source ID is the raw `user` ID, falling back to `bot_id` only when no
user ID is available. At least one is required. A bot relaying `*User*` and
`*Agent*` sections stays the same speaker; those labels remain ordinary text.

`meta.participants` maps one label per participant to `{ id, bot? }`, and
`speaker` holds that label. Participants are every speaker plus every user
mentioned as `<@U…>` in `content`; those mentions are rewritten to `@label`.
To resolve names, callers may include `users`, an array of raw Slack `users.list`
objects (for example, loaded from the mirror's `users.jsonl`). A participant's
name is the user directory's display name, real name, or account name; then the
most recent inline `user_profile` display/real name, or for bot messages
`bot_profile.name` or the legacy `username`; then a legacy `<@U…|name>` mention
label. Blank names are ignored. Unnamed participants are labeled by ID, and
participants sharing a name get a suffix (`Alex (2)`) in sorted-ID order. No API
lookup is performed. Conflicting named directory entries fail. `bot: true` is set
from the directory's `is_bot`, a `bot_message` subtype, a `bot_profile`, or a
speaker known only by `bot_id`.

When the source message has `reactions`, it is kept as a map from reaction name
to Slack's reported `count`, sorted by name. Who reacted is not kept. Invalid or
duplicate names and invalid counts are rejected. Absent reactions are not the
same as an explicitly empty reaction snapshot (`{}`).

Posts and replies are sorted by exact Slack `ts`, including microseconds. ISO
timestamps have second precision; the exact six-digit fractional `ts` is
retained losslessly as `id`. Identify a message by `(source, channel, id)`.
These source-native IDs are stable across retries, input reordering, file
reorganization, and edited snapshots.

Exact semantic duplicates are collapsed with `slack_duplicate_message` (including
a reply seen both through history and thread replies). A `thread_broadcast`'s
nested `root` is ignored: it is context, not a new post. When copies of one
message differ in content or reactions, as when a reaction is added between the
history and replies fetches, one copy is kept with a `slack_conflicting_message`
diagnostic: the latest `edited.ts`, then the most total reactions, then a fixed
tiebreak, so the choice never depends on arrival order. Copies that disagree on
thread membership or speaker still fail. Edits and deletions are not applied
from event streams by this adapter.

## Supported content and explicit limits

- Handles ordinary messages plus `bot_message`, `thread_broadcast`, `file_share`,
  and `me_message` text. Apart from user mentions, raw `text` is preserved,
  including Unicode, channel and link markup, and quoted instructions. Treat it
  as untrusted data.
- Each entry in `files` appends a `[file: <name>]` line (or `[file]` when the
  file has no name or title), so file-only posts are kept. File contents, blocks,
  link unfurls, and legacy attachments are not copied into prose. Blocks can
  contain more than the top-level fallback text; this is not a lossless
  conversion. Emoji shortcodes in `text` are preserved, and reactions stay
  structured instead of being appended to prose. Posts with neither nonempty
  `text` nor `files` are skipped with `slack_message_dropped`, **including
  blocks-only posts**. A dropped root with surviving replies becomes a thread
  fragment.
- Unsupported subtypes (including join/leave, edit/delete event wrappers) and
  non-message events are skipped with the same diagnostic. This is a text
  snapshot adapter, not an event replay engine or a multimodal importer.
- Invalid identity/timestamps, a message whose own `channel` disagrees with the
  supplied one, or replies dated before their root fail loudly. A dump with no
  supported messages returns `meta` alone. There is no conversation listing API; `listTrajectories` remains
  limited to agent sources.

## Consumer rollout

This uses the independent `conversation-v1` schema and `normalizeConversation`
entry point. Existing agent records, validators, canonical projection, and
canonical schema version are unchanged. Consumers must explicitly accept the
conversation contract before ingesting this output; it is not a new variant of
an agent's execution history. No downstream integration is implemented here.
