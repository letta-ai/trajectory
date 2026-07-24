import type { SourceAdapter } from "../../internal.js";
import { decodePiSessionTranscript } from "../pi-session-shared.js";

export const piAdapter: SourceAdapter = {
  source: "pi",

  decode(transcript: string) {
    return decodePiSessionTranscript(transcript, {
      source: "pi",
      sourceLabel: "pi",
    });
  },
};
