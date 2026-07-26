# Native Tool Result Status Implementation Notes

## Canonical unknown representation

The initial RED test expected `tool_result_ok: null` for Codex. During the first GREEN pass the field was made optional and the assertion changed to `undefined`. Review identified that this would introduce the canonical schema's first optional flattened field and leave workers to distinguish missing from null.

The final contract keeps normalized trajectory-v1 additive with optional `ToolResultRecord.ok`, but canonical schema v2 makes `tool_result_ok` required and nullable like the existing flattened fields. Sources with authoritative booleans emit `true` or `false`; Codex and other sources without one emit `null`. Native status remains part of semantic content hashing, so canonical schema version advances to 2.
