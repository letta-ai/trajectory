# Sanitized real DSH rc.8 capture

This fixture is derived from a real `session.jsonl.zstd` produced on an
`x86_64` desktop by DeepSeek Harness `0.1.0-rc.8` using
`qwen38-local/qwen3.8-27b-nvfp4` through SGLang.

The physical JSONL row envelopes, ordering, packed `reasoning-chunks`, event
sequences, timestamps, turn/step coordinates, source kinds, route metadata,
content block order, and token usage are retained. Workspace paths, content,
attachments, response IDs, message IDs, and RPC IDs are replaced; log-only
event payloads are reduced to empty objects. The source artifact itself is not
distributed because it contains private user content.
