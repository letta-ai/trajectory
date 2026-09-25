import type { SourceAdapter } from "../../internal.js";
import { decodePiSessionTranscript } from "../pi-session-shared.js";

/**
 * Prime Agent is a fork of pi-mono and shares its SessionManager JSONL
 * lineage, so it reuses the pi/openclaw shared decoder. Unlike OpenClaw, Prime
 * writes no placeholder mirror model, so nothing is excluded from model
 * metadata.
 */
export const primeAdapter: SourceAdapter = {
  source: "prime",

  decode(transcript: string) {
    return decodePiSessionTranscript(transcript, {
      source: "prime",
      sourceLabel: "Prime Agent",
    });
  },
};
