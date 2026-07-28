# copilot-cli

The adapter accepts GitHub Copilot CLI's native event JSONL. Each line carries
an event `id`, `type`, `timestamp`, and `data`.

The model-context stream is reconstructed from:

- `hook.start` with `hookType: "userPromptSubmitted"` for user prompts.
- `assistant.message` for plaintext `reasoningText`, assistant `content`, and
  `toolRequests`.
- `tool.execution_complete` for linked results, model metadata, and the
  authoritative `success` status.

`session.start` provides session ID, creation time, working directory, and git
branch. Event IDs provide canonical source identity; headerless or sanitized
exports fall back to JSONL byte offsets.

`user.message` duplicates the submitted-prompt hook and is dropped. Hook ends,
turn boundaries, execution starts, notifications, compaction, session
lifecycle, and planning/mode events are transport or state records and are
dropped. Unknown event types produce a diagnostic. Failed executions preserve
their structured error message and emit `ok: false`.

Local-store discovery is intentionally not provided; callers pass the exported
event stream directly to
`normalizeTranscript({ source: "copilot-cli", transcript })`.
