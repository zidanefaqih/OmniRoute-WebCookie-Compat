import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/huggingchat.ts");

function jsonlResponse(lines: Array<Record<string, unknown>>): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
    status: 200,
    headers: { "Content-Type": "application/jsonl" },
  });
}

function installHuggingChatFlow(
  lines: Array<Record<string, unknown>>,
  onMessagePayload?: (payload: Record<string, unknown>) => void
): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/chat/conversation")) {
      return Response.json({ conversationId: "conv-tool-test" });
    }
    if (method === "GET" && url.endsWith("/chat/api/v2/conversations/conv-tool-test")) {
      return Response.json({ json: { rootMessageId: "root-tool-test" } });
    }
    if (method === "POST" && url.endsWith("/chat/conversation/conv-tool-test")) {
      const form = init?.body as FormData;
      const data = form.get("data");
      if (typeof data === "string") onMessagePayload?.(JSON.parse(data));
      return jsonlResponse(lines);
    }
    return Response.json({ error: "unexpected mock request", url }, { status: 500 });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a local file",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
};

describe("HuggingChatExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.HuggingChatExecutor();
    assert.ok(executor);
  });

  it("returns 400 when messages are missing", async () => {
    const executor = new mod.HuggingChatExecutor();
    const result = await executor.execute({
      model: "meta-llama/Llama-3.3-70B-Instruct",
      body: {},
      stream: false,
      credentials: { apiKey: "hf-chat=fake-cookie" },
      signal: null,
    });
    assert.equal(result.response.status, 400);
    const json = await result.response.json();
    assert.ok(json.error.message.includes("Missing or empty messages"));
  });

  it("returns 400 when messages array is empty", async () => {
    const executor = new mod.HuggingChatExecutor();
    const result = await executor.execute({
      model: "test",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "hf-chat=fake" },
      signal: null,
    });
    assert.equal(result.response.status, 400);
  });

  it("returns 401 when cookie is missing", async () => {
    const executor = new mod.HuggingChatExecutor();
    const result = await executor.execute({
      model: "test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    });
    assert.equal(result.response.status, 401);
    const json = await result.response.json();
    assert.ok(json.error.message.includes("session cookie"));
  });

  it("uses imported providerSpecificData cookie credentials", async () => {
    const realFetch = globalThis.fetch;
    let capturedCookie = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedCookie = new Headers(init?.headers).get("cookie") || "";
      return Response.json({ error: "stop after credential assertion" }, { status: 403 });
    }) as typeof globalThis.fetch;

    try {
      const executor = new mod.HuggingChatExecutor();
      await executor.execute({
        model: "test",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {
          apiKey: null,
          providerSpecificData: {
            cookie: "hf-chat=imported-session; token=imported-token; aws-waf-token=imported-waf",
          },
        },
        signal: null,
      });

      assert.equal(
        capturedCookie,
        "hf-chat=imported-session; token=imported-token; aws-waf-token=imported-waf"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns { response, url, headers, transformedBody } shape", async () => {
    const executor = new mod.HuggingChatExecutor();
    const result = await executor.execute({
      model: "test",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    });
    assert.ok(result.response instanceof Response);
    assert.ok(typeof result.url === "string");
    assert.ok(typeof result.headers === "object");
  });

  // PR #5592: after a conversation is created, the executor GETs
  // /chat/api/v2/conversations/{id} to obtain the root parent message id.
  // When that GET fails or returns malformed data, fetchInitialParentMessageId
  // returns null and the executor must surface a 502 instead of proceeding with
  // an undefined parent id. This defensive path was previously untested.
  it("returns 502 when the initial parent message id cannot be fetched", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST") {
        // Step 1: conversation creation succeeds.
        return new Response(JSON.stringify({ conversationId: "conv-test-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Step 2: the parent-message GET fails -> fetchInitialParentMessageId -> null.
      return new Response("", { status: 500 });
    }) as typeof globalThis.fetch;

    try {
      const executor = new mod.HuggingChatExecutor();
      const result = await executor.execute({
        model: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "hf-chat=fake-cookie" },
        signal: null,
      });
      assert.equal(result.response.status, 502);
      const json = await result.response.json();
      assert.ok(
        json.error.message.includes("initial parent message id"),
        `expected the parent-message 502 message, got: ${json.error.message}`
      );
      // Rule #12 sanity: the error body carries a static message, never a stack frame.
      assert.ok(!json.error.message.includes("at /"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("serializes caller tools and returns a non-streaming OpenAI tool call", async () => {
    let sentPayload: Record<string, unknown> | null = null;
    const restore = installHuggingChatFlow(
      [
        {
          type: "stream",
          token:
            '<think>Need to inspect the file.</think><omniroute_action>{"name":"read","arguments":{"filePath":"PRD.md"}}</omniroute_action>',
        },
        { type: "status", status: "finished" },
      ],
      (payload) => {
        sentPayload = payload;
      }
    );

    try {
      const executor = new mod.HuggingChatExecutor();
      const result = await executor.execute({
        model: "moonshotai/Kimi-K2.7-Code",
        body: {
          messages: [{ role: "user", content: "Read PRD.md" }],
          tools: [READ_TOOL],
          tool_choice: "auto",
        },
        stream: false,
        credentials: { apiKey: "hf-chat=fake-cookie" },
        signal: null,
      });

      assert.equal(result.response.status, 200);
      assert.match(String(sentPayload?.inputs), /CALLER-RUNTIME TOOLS/);
      assert.match(String(sentPayload?.inputs), /read/);
      assert.match(String(sentPayload?.inputs), /Read PRD\.md/);

      const json = await result.response.json();
      assert.equal(json.choices[0].finish_reason, "tool_calls");
      assert.equal(json.choices[0].message.content, null);
      assert.equal(json.choices[0].message.reasoning_content, "Need to inspect the file.");
      assert.equal(json.choices[0].message.tool_calls[0].function.name, "read");
      assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), {
        filePath: "PRD.md",
      });
    } finally {
      restore();
    }
  });

  it("preserves tool-result history and strips thinking tags from the final answer", async () => {
    let sentPayload: Record<string, unknown> | null = null;
    const restore = installHuggingChatFlow(
      [
        { type: "stream", token: "<think>The read already succeeded.</think>PRD summary" },
        { type: "status", status: "finished" },
      ],
      (payload) => {
        sentPayload = payload;
      }
    );

    try {
      const executor = new mod.HuggingChatExecutor();
      const result = await executor.execute({
        model: "zai-org/GLM-5.2",
        body: {
          messages: [
            { role: "user", content: "Read PRD.md" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-read-1",
                  type: "function",
                  function: { name: "read", arguments: '{"filePath":"PRD.md"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call-read-1", content: "Cafe landing page PRD" },
          ],
          tools: [READ_TOOL],
        },
        stream: false,
        credentials: { apiKey: "hf-chat=fake-cookie" },
        signal: null,
      });

      assert.match(String(sentPayload?.inputs), /Tool result \(read\): Cafe landing page PRD/);
      assert.match(String(sentPayload?.inputs), /Do NOT repeat tool calls that already succeeded/);
      const json = await result.response.json();
      assert.equal(json.choices[0].finish_reason, "stop");
      assert.equal(json.choices[0].message.content, "PRD summary");
      assert.equal(json.choices[0].message.reasoning_content, "The read already succeeded.");
      assert.equal(json.choices[0].message.tool_calls, undefined);
    } finally {
      restore();
    }
  });

  it("buffers tool-aware streams and emits reasoning plus tool_calls", async () => {
    const restore = installHuggingChatFlow([
      { type: "stream", token: "<thi" },
      { type: "stream", token: "nk>Use the caller tool.</th" },
      {
        type: "stream",
        token:
          'ink><omniroute_action>{"name":"read","arguments":{"filePath":"PRD.md"}}</omniroute_action>',
      },
      { type: "status", status: "finished" },
    ]);

    try {
      const executor = new mod.HuggingChatExecutor();
      const result = await executor.execute({
        model: "moonshotai/Kimi-K2.7-Code",
        body: {
          messages: [{ role: "user", content: "Read PRD.md" }],
          tools: [READ_TOOL],
        },
        stream: true,
        credentials: { apiKey: "hf-chat=fake-cookie" },
        signal: null,
      });

      const text = await result.response.text();
      assert.match(text, /reasoning_content.*Use the caller tool/);
      assert.match(text, /tool_calls/);
      assert.match(text, /\"name\":\"read\"/);
      assert.match(text, /\"finish_reason\":\"tool_calls\"/);
      assert.doesNotMatch(text, /<think>|<\/think>|omniroute_action/);
      assert.match(text, /data: \[DONE\]/);
    } finally {
      restore();
    }
  });

  it("surfaces upstream JSONL errors in streaming mode instead of returning an empty answer", async () => {
    const restore = installHuggingChatFlow([
      {
        type: "status",
        status: "error",
        statusCode: 402,
        message: "Monthly included credits are depleted.",
      },
    ]);

    try {
      const executor = new mod.HuggingChatExecutor();
      const result = await executor.execute({
        model: "zai-org/GLM-5.2",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: { apiKey: "hf-chat=fake-cookie" },
        signal: null,
      });

      const text = await result.response.text();
      assert.match(text, /"choices"/);
      assert.match(text, /HuggingChat error/);
      assert.match(text, /402/);
      assert.match(text, /Monthly included credits are depleted/);
      assert.match(text, /"finish_reason":"stop"/);
      assert.match(text, /data: \[DONE\]/);
    } finally {
      restore();
    }
  });
});
