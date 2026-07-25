# omp

OMP (Oh My Pi) session transcripts are the OMP coding-agent SessionManager
JSONL files written to
`~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`. OMP is a fork
of pi-mono and shares its SessionManager lineage, so the wire format is
byte-compatible with pi: one `type: "session"` header row (carrying `version`,
`id`, ISO `timestamp`, and `cwd`) followed by `type: "message"` wrapper rows
whose `message` holds `user`, `assistant` (with `text`, `thinking`, and
`toolCall` content blocks plus model metadata), and `toolResult` messages. The
whole file is the transcript string. OMP therefore reuses the pi/openclaw
shared decoder (see [`../pi-session-shared.ts`](../pi-session-shared.ts));
unlike OpenClaw, OMP writes no placeholder mirror model, so nothing is masked.

OMP adds its own entry types on top of the shared format — `session_init`,
`title`, `service_tier_change`, `mode_change`, `ttsr_injection`, and
`custom`/`custom_message` rows (the last carry extension-injected content and
tool-execution side data). All non-`message` entry types are ignored, matching
OMP's own transcript readers, and message roles other than
`user`/`assistant`/`toolResult` (for example `bashExecution` rows written for
user-typed `!` commands) are skipped. The shared `model_change` and
`thinking_level_change` lifecycle rows are ignored for the same reason.
Entries are decoded in file order; a session whose tree was branched in place
contributes every recorded branch, not just the active path. Failed tool
results (`isError`) gain an `Error:` prefix, and malformed JSONL lines are
recoverable diagnostics — OMP's own session-file repair drops such lines.
Wrapper entry ids provide native record identity; rows without ids anchor to
the append-only byte offset.

OMP headers carry only `cwd` (no `git_branch`), so the `meta` record exposes
`cwd` but never a git branch.

## Listing

`listTrajectories({ source: "omp" })` scans `<agentDir>/sessions/*/` for
`.jsonl` transcripts, resolving the agent directory like OMP does
(`$OMP_CODING_AGENT_DIR`, then the pi-compat `$PI_CODING_AGENT_DIR`, then
`~/.omp/agent`). Only primary session transcripts (one directory level under
each escaped-cwd project directory) are enumerated; OMP's per-session
subagent transcripts, nested one level deeper under `<timestamp>_<uuid>/`,
are not listed by default. Pass `root` pointing at a session subdirectory to
enumerate those nested transcripts.
