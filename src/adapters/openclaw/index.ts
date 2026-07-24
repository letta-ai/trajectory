import type { SourceAdapter } from "../../internal.js";
import { decodePiSessionTranscript } from "../pi-session-shared.js";

/**
 * OpenClaw mirrors assistant deliveries produced by external CLI backends into
 * the transcript under this placeholder model name. The prose is genuine
 * assistant output, but the value is not a model identifier, so it is kept out
 * of model metadata.
 */
const DELIVERY_MIRROR_MODEL = "delivery-mirror";

export const openClawAdapter: SourceAdapter = {
  source: "openclaw",

  decode(transcript: string) {
    return decodePiSessionTranscript(transcript, {
      source: "openclaw",
      sourceLabel: "OpenClaw",
      excludedModels: [DELIVERY_MIRROR_MODEL],
    });
  },
};
