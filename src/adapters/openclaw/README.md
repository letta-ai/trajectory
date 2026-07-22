# openclaw

OpenClaw session transcripts are the pi-coding-agent SessionManager JSONL
files written to `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
(legacy state directories such as `~/.clawdbot` use the same layout): one
`type: "session"` header row carrying the session id, ISO timestamp, and cwd,
followed by `type: "message"` wrapper rows whose `message` holds `user`,
`assistant` (with `text`, `thinking`, and `toolCall` content blocks plus model
metadata), and `toolResult` messages. The whole file is the transcript string.

Compaction, custom, and other lifecycle entry types are ignored, matching
OpenClaw's own transcript readers. Failed tool results (`isError`) gain an
`Error:` prefix, and malformed JSONL lines are recoverable diagnostics —
OpenClaw's own session-file repair drops such lines. Assistant rows mirrored
from external CLI backends under the `delivery-mirror` placeholder model keep
their prose but do not contribute model metadata. Wrapper entry ids provide
native record identity; rows without ids anchor to the append-only byte
offset.
