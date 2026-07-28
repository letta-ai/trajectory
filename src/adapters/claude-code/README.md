# claude-code

Native Claude Code session JSONL, as written to
`~/.claude/projects/<project>/<sessionId>.jsonl`. The whole file is the
transcript string.

The adapter decodes `user` and `assistant` rows — including `thinking`,
`text`, `tool_use`, and `tool_result` content blocks — and links results to
calls by the native tool-use id. Line `uuid`s provide native record identity,
and session context (cwd, git branch) is resolved from source chronology so it
does not depend on transport-arrival order.

Standalone subagent JSONL is also supported. Claude Code marks every
conversational row in those files with `isSidechain: true`; when no ordinary
conversation rows are present, the adapter treats the sidechain as the primary
conversation and uses its `agentId` as the source group rather than the parent
`sessionId`.

Resumed or concatenated exports may contain records carrying multiple parent
`sessionId` values. They remain valid trajectory-v1 input. Canonical callers
must supply the authoritative export identity through
`sourceContext.groupId`; the adapter does not guess among the embedded ids.

Dropped input:

- Sidechain records embedded alongside an ordinary parent conversation,
  reported with a `sidechain_record_dropped` diagnostic.
- Transport/UI rows (`progress`, `summary`, `system`, `file-history-snapshot`,
  title/mode bookkeeping, and similar), skipped silently.
- Harness-noise user rows (local-command output, command wrappers), reported
  by the shared core as `noise_record_dropped`.

## Listing

`listTrajectories({ source: "claude-code" })` scans `~/.claude/projects/*/`
for parent `<sessionId>.jsonl` files and standalone `agent-<agentId>.jsonl`
transcripts. It recognizes both legacy project-level agent files and the
current `<sessionId>/subagents/` layout, including agent transcripts nested
under `subagents/workflows/<runId>/`. Workflow `journal.jsonl` files and
metadata sidecars are not listed. Each item's `path` is the transcript file,
and its `id` is the native session or agent id.
