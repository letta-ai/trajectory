import type {
  DecodedEvent,
  DecodedSession,
  SourceAdapter,
} from "../../internal.js";
import type { Diagnostic } from "../../types.js";
import { NormalizationError } from "../../types.js";
import {
  blocksText,
  isObject,
  jsonString,
  parseTimestamp,
} from "../shared.js";

const SUPPORTED_SCHEMA_VERSIONS = new Set(
  Array.from({ length: 8 }, (_, index) => `ATIF-v1.${index}`),
);

export const atifAdapter: SourceAdapter = {
  source: "atif",

  decode(transcript: string): DecodedSession {
    const document = parseAtifDocument(transcript);
    const diagnostics: Diagnostic[] = [];
    const events: DecodedEvent[] = [];
    const trajectoryId = atifNonemptyString(document.trajectory_id);
    const sessionId = atifNonemptyString(document.session_id);
    const rootModel = atifNonemptyString(document.agent.model_name);
    let createdAt: Date | undefined;

    for (let index = 0; index < document.steps.length; index += 1) {
      const step = document.steps[index];
      if (!isObject(step)) throw invalidAtifTranscript();
      const expectedStepId = index + 1;
      if (step.step_id !== expectedStepId) throw invalidAtifTranscript();
      if (
        step.source !== "system" &&
        step.source !== "user" &&
        step.source !== "agent"
      ) {
        throw invalidAtifTranscript();
      }
      if (typeof step.message !== "string" && !Array.isArray(step.message)) {
        throw invalidAtifTranscript();
      }

      const timestamp = parseTimestamp(step.timestamp);
      createdAt ??= timestamp;
      const model =
        step.source === "agent"
          ? atifNonemptyString(step.model_name) ?? rootModel
          : undefined;
      const sourceRecordId = trajectoryId
        ? `trajectory:${trajectoryId}:step:${expectedStepId}`
        : `step:${expectedStepId}`;
      let componentIndex = 0;
      const emit = (event: DecodedEvent): void => {
        events.push({
          ...event,
          sourceRecordId,
          sourceSequence: expectedStepId,
          componentIndex: componentIndex++,
        });
      };
      const shared = {
        ...(timestamp ? { timestamp } : {}),
        ...(model ? { model } : {}),
      };

      if (step.source === "user") {
        emit({
          type: "message",
          role: "user",
          content: atifContent(step.message),
          ...shared,
        });
        continue;
      }

      if (step.source === "system") {
        emit({
          type: "message",
          role: "system",
          content: atifContent(step.message),
          ...shared,
        });
      } else {
        if (typeof step.reasoning_content === "string") {
          emit({
            type: "reasoning",
            content: step.reasoning_content,
            ...shared,
          });
        }
        emit({
          type: "message",
          role: "assistant",
          content: atifContent(step.message),
          ...shared,
        });

        if (step.tool_calls != null && !Array.isArray(step.tool_calls)) {
          throw invalidAtifTranscript();
        }
        for (const rawCall of step.tool_calls ?? []) {
          if (!isObject(rawCall)) throw invalidAtifTranscript();
          const callId = atifNonemptyString(rawCall.tool_call_id);
          const name = atifNonemptyString(rawCall.function_name);
          emit({
            type: "tool_call",
            args: jsonString(rawCall.arguments),
            ...(callId ? { id: callId } : {}),
            ...(name ? { name } : {}),
            ...shared,
          });
        }
      }

      if (step.observation == null) continue;
      if (!isObject(step.observation) || !Array.isArray(step.observation.results)) {
        throw invalidAtifTranscript();
      }
      for (const rawResult of step.observation.results) {
        if (!isObject(rawResult)) throw invalidAtifTranscript();
        const callId = atifNonemptyString(rawResult.source_call_id);
        const content = observationContent(rawResult);
        emit(
          callId
            ? { type: "tool_result", callId, content, ...shared }
            : { type: "observation", content, ...shared },
        );
      }
    }

    if (
      Array.isArray(document.subagent_trajectories) &&
      document.subagent_trajectories.length > 0
    ) {
      diagnostics.push({
        code: "noise_record_dropped",
        message: `Did not flatten ${document.subagent_trajectories.length} embedded ATIF subagent trajectory(ies); only root steps are normalized.`,
        count: document.subagent_trajectories.length,
      });
    }

    const sourceGroupId = sessionId ?? trajectoryId;
    return {
      events,
      context: {
        source: "atif",
        ...(rootModel ? { model: rootModel } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(sourceGroupId ? { sourceGroupId } : { sourceGroupRequired: true }),
      },
      diagnostics,
    };
  },
};

interface AtifDocument extends Record<string, unknown> {
  agent: Record<string, unknown>;
  steps: unknown[];
}

function parseAtifDocument(transcript: string): AtifDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw invalidAtifTranscript();
  }
  if (
    !isObject(parsed) ||
    typeof parsed.schema_version !== "string" ||
    !SUPPORTED_SCHEMA_VERSIONS.has(parsed.schema_version) ||
    !isObject(parsed.agent) ||
    typeof parsed.agent.name !== "string" ||
    typeof parsed.agent.version !== "string" ||
    !Array.isArray(parsed.steps) ||
    parsed.steps.length === 0
  ) {
    throw invalidAtifTranscript();
  }
  return parsed as AtifDocument;
}

function atifContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return blocksText(value);
  return jsonString(value);
}

function observationContent(result: Record<string, unknown>): string {
  if (result.content != null) return atifContent(result.content);
  if (Array.isArray(result.subagent_trajectory_ref)) {
    return jsonString({ subagent_trajectory_ref: result.subagent_trajectory_ref });
  }
  return "";
}

function atifNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function invalidAtifTranscript(): NormalizationError {
  return new NormalizationError(
    "invalid_input",
    "ATIF transcript must be one ATIF-v1.0 through ATIF-v1.7 JSON trajectory object with agent metadata and sequential steps.",
  );
}
