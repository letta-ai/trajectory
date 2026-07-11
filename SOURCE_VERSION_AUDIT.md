# Source-version audit

Audit date: 2026-07-11.

This audit asks whether native transcript versions require different decoding
logic. It records aggregate structure only. Transcript prose, tool arguments,
tool results, identifiers, and paths were neither printed nor retained.

## Method

The audit groups transcripts by an embedded producer version, fingerprints
record and content-block shapes, and optionally runs the current normalizer.

```sh
bun run audit:versions claude-code --normalize ~/.claude/projects
bun run audit:versions codex --normalize ~/.codex/sessions
bun run audit:versions letta --normalize ~/.letta/lc-local-backend/conversations
```

The output contains counts and structural signatures only. A signature includes
discriminator values such as record type and content-block type plus sorted key
names; it does not recurse into tool arguments or emit field values.

Harbor was used as a secondary implementation reference. Its Claude Code and
Codex converters extract producer versions and tolerate known structures in a
single rolling converter; they do not publish a source-version compatibility
matrix:

- <https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/claude_code.py>
- <https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/codex.py>

## Claude Code

Coverage:

- 1,008 JSONL files and 140,687 records.
- 18 embedded versions from `2.1.139` through `2.1.206`.
- 872 top-level session files and 136 standalone subagent files.
- Two sessions contain records from two producer versions, consistent with a
  session being resumed after Claude Code was upgraded.

The normalized concepts are structurally stable throughout the observed
range:

- Assistant blocks: `text`, `thinking`, and `tool_use`.
- User content: strings, `text` blocks, and `tool_result` blocks.
- Tool-use inputs remain JSON objects.
- Tool-result content remains either text or an array of content blocks.

Later versions add metadata and transport records without changing those core
concepts. Examples include system/compaction records, session-kind metadata,
relocation/worktree state, and an assistant `fallback` block first observed in
`2.1.202`. The current adapter intentionally ignores those records; the
`fallback` block describes a model fallback and contains no assistant prose.

Normalization outcome:

- All 869 complete top-level sessions normalized successfully.
- The other three top-level files were incomplete: two lacked a user turn and
  one lacked an assistant turn.
- The 136 subagent files are not complete standalone trajectories and account
  for the remaining missing-user failures.

Conclusion: the observed Claude Code versions do not justify separate decoder
implementations. Continue using structural decoding. Producer version should
still be extracted because a future structural change may require a branch.
Version-aware decoding must not assume one version per file because resumed
sessions can contain mixed-version records.

## Codex

Coverage:

- 47 JSONL files and 48,616 records.
- 14 embedded CLI versions from `0.101.0` through `0.144.1`.
- Every file contains one `session_meta.payload.cli_version` value.

The main conversation format remains stable:

- Messages use `response_item` with payload type `message`.
- Tool calls/results use `function_call` and `function_call_output`.
- `custom_tool_call` and `custom_tool_call_output` are present from `0.107.0`
  in this corpus.
- `web_search_call` is also present and is supported by the current adapter.

New transport or state events appear over time and can remain ignored. Examples
include patch/command completion events, thread rollback/settings events, MCP
completion events, and top-level `world_state` records.

One decoder gap was found: `0.140.0` contains a paired
`tool_search_call`/`tool_search_output`. This is a semantic tool event, not
merely metadata. The adapter now preserves it as a `tool_search` call and linked
result, covered by a sanitized fixture.

Normalization outcome:

- All 43 complete sessions normalized successfully.
- Four incomplete files lacked an assistant record.

Conclusion: the observed Codex versions also do not require whole-version
decoders. Keep dispatch structural unless an incompatible representation is
found.

## Letta

Only actual conversation transcripts are in scope. The
`~/.letta/transcripts` tree is produced for reflection and was excluded from
the corrected audit. The local conversation store is:

```text
~/.letta/lc-local-backend/conversations/*/messages.jsonl
```

Coverage:

- 24 conversation manifests, of which 11 had a `messages.jsonl` file.
- Eight files use `pi-session-entry-jsonl`. Their session header embeds local
  transcript version `3`; together they contain 84 records.
- Three files use the legacy headerless `pi-ai-message-jsonl` format. Only one
  legacy message remained on this device, so historical coverage is limited.
- Seven complete version 3 conversations normalized successfully. One
  incomplete conversation lacked an assistant record.

Version 3 contains a `session` header followed by `message` entries. Messages
use `user`, `assistant`, and `toolResult` roles. Assistant content contains
`text`, `thinking`, and `toolCall` blocks; tool calls use structured
`arguments`, and results link through `toolCallId`. `compaction` entries contain
derived context summaries and are deliberately excluded from normalized output
because the original message entries remain in the append-only transcript.

The adapter now accepts both observed local formats. It also continues to
accept cloud/API message arrays with native `message_type` objects. Those API
objects do not embed a Letta server or client version, so their source version
must come from collection metadata or a caller-supplied value.

Conclusion: Letta already demonstrates the intended routing model. Headerless
legacy rows are detected structurally; local version 3 is selected from the
session header; unknown explicit local versions fail rather than being guessed.
The reflection transcript tree is never used as decoder evidence or input.

## Decisions supported by this audit

1. Prefer one tolerant structural decoder per source. Add version branches only
   after observing an incompatible representation.
2. Extract embedded versions automatically: Claude Code top-level `version` and
   Codex `session_meta.payload.cli_version`.
3. Accept a caller-supplied source version for formats such as Letta that do not
   embed one, but do not infer a release from shape alone.
4. Record unknown semantic record and content-block types as diagnostics. Silent
   drops make future format drift difficult to detect.
5. Add sanitized fixtures for each distinct format family, not for every
   producer release.
6. Run a fixed probe task against pinned releases when local corpora lack a
   version or do not exercise messages, reasoning, tool calls/results, errors,
   compaction, and subagents.

## Open questions

- Define provenance for the rare mixed-version Claude session. Decoding can use
  each record's embedded version even if normalized metadata remains singular.
- Decide how to represent source versions across producer release versions
  (Claude/Codex) and an explicit transcript-format version (Letta local v3).
  Decoder selection should prefer an embedded format version when one exists.
