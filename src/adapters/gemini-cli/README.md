# gemini-cli

The adapter accepts one native Gemini CLI session JSON document:

```json
{
  "sessionId": "...",
  "projectHash": "...",
  "startTime": "...",
  "messages": []
}
```

Only `messages` is required for trajectory-v1 normalization. Some native
exports omit the surrounding session metadata; canonical callers must then
supply the authoritative export identity through `sourceContext.groupId`.
When present, `sessionId` supplies canonical session identity and `startTime`
supplies the creation-time fallback. User messages may contain a string or text
blocks. `gemini` messages preserve plaintext `thoughts` as reasoning, `content`
as assistant prose, and the message model as metadata.

Each `toolCalls` item emits a call using its native `id`, `name`, `args`, and
timestamp. Inline `functionResponse.response.output` values become linked tool
results. Other nonempty response objects, including structured errors, remain
JSON. Terminal `success`, `error`, and `cancelled` statuses map to source-native
`ok` values.

`info` messages are CLI/harness notices and are dropped. Unknown message types
are dropped with a diagnostic.

This adapter accepts only the native whole-session shape. A session labelled
“Gemini CLI” by an external corpus but containing Claude Code or another wire
format must be routed to that format's adapter by the caller. Local-store
discovery and format sniffing are intentionally out of scope.
