# hermes

Hermes (the `hermes-agent` harness) persists sessions in a SQLite store
(`~/.hermes/state.db`), so the caller exports one session as JSON: either the
message-row array for a session (`SELECT * FROM messages WHERE session_id = ?
ORDER BY id`, or the rows returned by `HermesState.get_messages()`), or an
envelope `{"session": <sessions row>, "messages": [<message rows>]}` whose
session row supplies the model, working directory, start time, and group
identity.

The adapter accepts both raw column values (JSON-string `tool_calls`,
`\x00json:`-prefixed multimodal content, epoch-second timestamps) and their
decoded forms. It handles both persisted tool-call shapes — OpenAI Chat
Completions dicts (including Codex Responses `call_id` extras) and the
simplified id-less `{name, arguments}` flush form, adopting call ids from the
answering tool rows only when the counts match unambiguously. It prefers
`reasoning_content` over `reasoning` while ignoring single-space thinking-mode
pads, skips soft-deleted (`active = 0`) rewound rows that Hermes itself
excludes from replay, and orders rows by the AUTOINCREMENT id, which also
provides native record identity.

## Listing

`listTrajectories({ source: "hermes" })` reads the `sessions` table of
`~/.hermes/state.db` (id, title, timestamps); each item's `path` is the SQLite
store, and the item `id` is the session id to export.
