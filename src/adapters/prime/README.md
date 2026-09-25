# prime

Prime Agent session transcripts are the SessionManager JSONL files written to
`~/.prime/agent/sessions/<sessionId>.jsonl`. Prime is a fork of pi-mono and
shares its SessionManager lineage, so the wire format is byte-compatible with
pi: one `type: "session"` header row (carrying `version`, `id`, ISO
`timestamp`, and `cwd`) followed by `type: "message"` wrapper rows whose
`message` holds `user`, `assistant` (with `text`, `thinking`, and `toolCall`
content blocks plus model metadata), and `toolResult` messages. The whole file
is the transcript string. Prime therefore reuses the pi/openclaw shared
decoder (see [`../pi-session-shared.ts`](../pi-session-shared.ts)); unlike
OpenClaw, Prime writes no placeholder mirror model, so nothing is masked.

Prime adds its own entry types on top of the shared format —
`service_tier_change` and `session_state`. All non-`message` entry types are
ignored, matching the format's own transcript readers, and message roles other
than `user`/`assistant`/`toolResult` (for example `bashExecution` rows written
for user-typed `!` commands) are skipped. The shared `model_change` and
`thinking_level_change` lifecycle rows are ignored for the same reason.
Entries are decoded in file order; a session whose tree was branched in place
contributes every recorded branch, not just the active path. Failed tool
results (`isError`) gain an `Error:` prefix, and malformed JSONL lines are
recoverable diagnostics — the upstream session-file repair drops such lines.
Wrapper entry ids provide native record identity; rows without ids anchor to
the append-only byte offset.

Prime headers carry only `cwd` (no `git_branch`), so the `meta` record exposes
`cwd` but never a git branch.

## Listing

`listTrajectories({ source: "prime" })` scans `<agentDir>/sessions/` for
`.jsonl` transcripts. Default discovery mirrors Prime's directory inputs:
`$PRIME_AGENT_CODING_AGENT_DIR` (else `~/.prime/agent`), with
`$PRIME_AGENT_SESSION_DIR` / `$PRIME_AGENT_CODING_AGENT_SESSION_DIR`
relocating the sessions root. A caller-supplied `root` continues to mean the
agent directory itself. Only flat session files in that directory are
enumerated; legacy per-cwd session trees and `session-artifacts/` are not
walked.
