import { describe, expect, test } from "bun:test";
import { normalizeLettaApi, normalizeTranscript } from "../src/index.js";

const userMessage = {
  id: "message-user",
  seq_id: 1,
  message_type: "user_message",
  content: "hello",
  date: "2026-07-12T20:00:00.000Z",
};
const assistantMessage = {
  id: "message-assistant",
  seq_id: 2,
  message_type: "assistant_message",
  content: "hi",
  date: "2026-07-12T20:00:01.000Z",
};

function systemMessage(index: number) {
  return {
    id: `message-system-${index}`,
    seq_id: index + 3,
    message_type: "system_message",
    content: "ignored",
    date: "2026-07-12T20:00:02.000Z",
  };
}

describe("Letta API adapter", () => {
  test("fetches every page and matches normalization of the same local transcript", async () => {
    const firstPage = [
      userMessage,
      assistantMessage,
      ...Array.from({ length: 98 }, (_, index) => systemMessage(index)),
    ];
    const secondPage = [systemMessage(98)];
    const requests: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        return Response.json(url.searchParams.has("after") ? secondPage : firstPage);
      },
    });

    try {
      const remote = await normalizeLettaApi({
        source: "letta-api",
        conversationId: "conv-test",
        apiKey: "test-key",
        baseUrl: server.url.toString(),
      });
      const local = normalizeTranscript({
        source: "letta",
        transcript: JSON.stringify([...firstPage, ...secondPage]),
      });

      expect(remote).toEqual(local);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.pathname).toBe(
        "/v1/conversations/conv-test/messages",
      );
      expect(requests[0]?.searchParams.get("order")).toBe("asc");
      expect(requests[1]?.searchParams.get("after")).toBe(
        "message-system-97",
      );
    } finally {
      server.stop(true);
    }
  });

  test("uses the legacy agent messages endpoint", async () => {
    let requestedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestedPath = new URL(request.url).pathname;
        return Response.json([userMessage, assistantMessage]);
      },
    });

    try {
      await normalizeLettaApi({
        source: "letta-api",
        agentId: "agent-test",
        apiKey: "test-key",
        baseUrl: server.url.toString(),
      });
      expect(requestedPath).toBe("/v1/agents/agent-test/messages");
    } finally {
      server.stop(true);
    }
  });

  test("requires exactly one remote history identifier", async () => {
    expect(
      normalizeLettaApi({ source: "letta-api", apiKey: "test-key" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      normalizeLettaApi({
        source: "letta-api",
        conversationId: "conv-test",
        agentId: "agent-test",
        apiKey: "test-key",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
