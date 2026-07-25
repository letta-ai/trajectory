import type { SourceAdapter } from "../../internal.js";
import { decodePiSessionTranscript } from "../pi-session-shared.js";

/**
 * OMP (Oh My Pi) is a fork of pi-mono and shares its SessionManager JSONL
 * lineage, so it reuses the pi/openclaw shared decoder. Unlike OpenClaw, OMP
 * writes no placeholder mirror model, so nothing is excluded from model
 * metadata.
 */
export const ompAdapter: SourceAdapter = {
  source: "omp",

  decode(transcript: string) {
    return decodePiSessionTranscript(transcript, {
      source: "omp",
      sourceLabel: "omp",
    });
  },
};
