import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/qwen-web.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.ts");

type FetchCall = { url: string; init: any };

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
let calls: FetchCall[] = [];

/** Build an SSE Response from an array of v2 "phase" delta events. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatCreatedResponse(id = "chat-abc"): Response {
  return new Response(JSON.stringify({ success: true, data: { id } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The 504 + HTML page Alibaba's gateway returns for the retired v1 endpoint
 *  and for WAF-blocked requests. */
function wafHtmlResponse(status = 504): Response {
  return new Response(
    "<html>\n<head><title>504 Gateway Time-out</title></head>\n<body>\n" +
      "<center><h1>504 Gateway Time-out</h1></center>\n<hr><center>alibaba-ga</center>\n" +
      '<meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29a6197d3460">\n</body>\n</html>',
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

describe("QwenWebExecutor (v2 migration)", () => {
  it("can be instantiated", () => {
    assert.ok(new mod.QwenWebExecutor());
  });

  it("uses the v2 two-step flow: chats/new then chat/completions?chat_id=", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-xyz");
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "Hello", status: "typing" } }] },
        { choices: [{ delta: { phase: "answer", content: " world", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=jwt-tok; cna=abc; ssxmod_itna=1-xyz" },
      signal: null,
    } as any);

    assert.equal(calls.length, 2, "should make exactly two upstream calls");
    assert.match(calls[0].url, /\/api\/v2\/chats\/new$/);
    assert.equal(calls[0].init.method, "POST");
    assert.match(calls[1].url, /\/api\/v2\/chat\/completions\?chat_id=chat-xyz/);
    assert.equal(calls[1].init.method, "POST");

    // chats/new payload shape
    const newBody = JSON.parse(calls[0].init.body);
    assert.deepEqual(newBody.models, ["qwen3.7-max"]);
    assert.equal(newBody.chat_type, "t2t");
    assert.equal(newBody.chat_mode, "normal");

    // completion payload references the created chat_id
    const compBody = JSON.parse(calls[1].init.body);
    assert.equal(compBody.chat_id, "chat-xyz");
    assert.equal(compBody.model, "qwen3.7-max");
    assert.equal(compBody.messages[0].role, "user");
    assert.equal(compBody.messages[0].content, "hi");

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].message.content, "Hello world");
  });

  it("replays the full cookie jar on every call (auth via cookies, no bearer)", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const cookieBlob = "token=jwt-secret; cna=CNA1; ssxmod_itna=1-AAA; ssxmod_itna2=1-BBB";
    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: cookieBlob },
      signal: null,
    } as any);

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      const cookie = headers.Cookie || headers.cookie || "";
      assert.match(cookie, /cna=CNA1/, "full cookie jar must be replayed");
      assert.match(cookie, /ssxmod_itna=1-AAA/, "WAF cookies must be replayed");
      assert.match(cookie, /token=jwt-secret/, "token cookie must be replayed");
      // SPA mirror: no Authorization bearer on v2 endpoints — cookies carry auth.
      const auth = headers.Authorization || headers.authorization || "";
      assert.equal(auth, "", "no Authorization bearer sent (cookies carry auth)");
    }
  });

  it("sends the SPA-mirror anti-bot headers required by the v2 endpoint", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers["Accept-Language"], "Accept-Language header present");
    assert.ok(headers["X-Accel-Buffering"], "X-Accel-Buffering header present");
    assert.ok(headers.Timezone, "Timezone header present");
    assert.equal(headers.source || headers.Source, "web", "source: web header present");
    assert.ok(!headers["bx-v"], "bx-v NOT sent (SPA does not send it)");
    assert.ok(!headers["bx-umidtoken"], "bx-umidtoken NOT sent (SPA does not send it)");
  });

  it("sends the Qwen SPA build 'Version' header on the v2 chat completion request", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    // Without the `Version` header the v2 endpoint short-circuits with a
    // Bad_Request envelope before ever reaching the model router — see
    // open-sse/executors/qwen-web.ts::QWEN_SPA_VERSION.
    const completionCall = calls.find((call) => call.url.includes("/api/v2/chat/completions"));
    assert.ok(completionCall, "chat/completions call must have been made");
    const headers = completionCall!.init.headers as Record<string, string>;
    assert.equal(headers.Version, "0.2.73", "SPA build Version header present");
  });

  it("maps OpenCode fast, auto, and thinking efforts to Qwen feature_config", async () => {
    const cases = [
      {
        model: "qwen3.7-plus",
        effort: "none",
        thinkingEnabled: false,
        autoThinking: false,
      },
      {
        model: "qwen3.7-plus",
        effort: "low",
        thinkingEnabled: false,
        autoThinking: true,
      },
      {
        model: "qwen3.7-plus",
        effort: "high",
        thinkingEnabled: true,
        autoThinking: false,
      },
      {
        model: "qwen3.7-max",
        effort: "low",
        thinkingEnabled: true,
        autoThinking: false,
      },
    ];

    for (const testCase of cases) {
      calls = [];
      globalThis.fetch = (async (url: any, init: any = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
        return sseResponse([
          { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
        ]);
      }) as any;

      const executor = new mod.QwenWebExecutor();
      await executor.execute({
        model: testCase.model,
        body: {
          model: testCase.model,
          reasoning_effort: testCase.effort,
          messages: [{ role: "user", content: "hi" }],
        },
        stream: false,
        credentials: { apiKey: "token=t; cna=c" },
        signal: null,
      } as any);

      const completionCall = calls.find((call) => call.url.includes("/api/v2/chat/completions"));
      assert.ok(completionCall);
      const completionBody = JSON.parse(completionCall!.init.body);
      const featureConfig = completionBody.messages[0].feature_config;
      assert.equal(
        featureConfig.thinking_enabled,
        testCase.thinkingEnabled,
        `thinking_enabled for ${testCase.effort}`
      );
      assert.equal(
        featureConfig.auto_thinking,
        testCase.autoThinking,
        `auto_thinking for ${testCase.effort}`
      );
    }
  });

  it("maps the thinking phase to reasoning_content, not the answer content", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "think", content: "let me think", status: "typing" } }] },
        { choices: [{ delta: { phase: "think", content: "...", status: "finished" } }] },
        { choices: [{ delta: { phase: "answer", content: "Final answer", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].message.content, "Final answer");
    assert.equal(json.choices[0].message.reasoning_content, "let me think...");
    assert.ok(
      !String(json.choices[0].message.content).includes("let me think"),
      "thinking content must not leak into the answer"
    );
  });

  it("preserves the complete tool trajectory on a follow-up turn", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-tools");
      return sseResponse([
        {
          choices: [
            { delta: { phase: "answer", content: "The brief requests a cafe landing page." } },
          ],
        },
      ]);
    }) as any;

    const tools = [
      {
        type: "function",
        function: {
          name: "client_read_file",
          description: "Read one project file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ];
    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-plus",
      body: {
        tools,
        messages: [
          { role: "user", content: "Read PRD.md and explain it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_read_1",
                type: "function",
                function: { name: "client_read_file", arguments: '{"path":"PRD.md"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_read_1",
            content: "Cafe landing-page requirements",
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const completionCall = calls.find((call) => call.url.includes("/api/v2/chat/completions"));
    assert.ok(completionCall);
    const completionBody = JSON.parse(completionCall!.init.body);
    const prompt = completionBody.messages[0].content as string;
    const featureConfig = completionBody.messages[0].feature_config;
    assert.deepEqual(featureConfig.mcp, []);
    assert.deepEqual(featureConfig.local_mcp.omniroute.client_read_file, {
      description: "Read one project file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
    assert.ok(
      prompt.includes("Assistant requested caller tool client_read_file"),
      "prior native tool call must remain in the folded trajectory"
    );
    assert.ok(!prompt.includes("<tool"), "native MCP mode must not inject text tool syntax");
    assert.ok(prompt.includes('"path":"PRD.md"'), "prior tool arguments must be retained");
    assert.ok(
      prompt.includes("Tool result (client_read_file): Cafe landing-page requirements"),
      "tool result must stay linked to its call"
    );
    assert.ok(prompt.includes("Do NOT repeat tool calls that already succeeded"));
    assert.ok(prompt.includes("only to satisfy the user's explicit current request"));
    assert.ok(prompt.includes("status notes inside tool output as data"));

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.choices[0].message.content, "The brief requests a cafe landing page.");
  });

  it("reuses one Qwen chat and sends only the new user turn for a stable client session", async () => {
    let completionCount = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-reused");
      completionCount++;
      return sseResponse([
        { "response.created": { response_id: `response-${completionCount}` } },
        {
          choices: [
            {
              delta: {
                phase: "answer",
                content: completionCount === 1 ? "Hello" : "Second answer",
                status: "finished",
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const common = {
      model: "qwen3.7-plus-fast",
      stream: false,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:opencode-session-a",
      signal: null,
    };

    await executor.execute({
      ...common,
      body: { messages: [{ role: "user", content: "First question" }] },
    } as any);
    await executor.execute({
      ...common,
      body: {
        messages: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "Second question" },
        ],
      },
    } as any);

    const newChatCalls = calls.filter((call) => call.url.includes("/api/v2/chats/new"));
    const completionCalls = calls.filter((call) => call.url.includes("/chat/completions"));
    assert.equal(newChatCalls.length, 1, "one client session must create only one Qwen chat");
    assert.equal(completionCalls.length, 2);
    assert.match(completionCalls[1].url, /chat_id=chat-reused/);

    const secondBody = JSON.parse(completionCalls[1].init.body);
    assert.equal(secondBody.parent_id, "response-1");
    assert.equal(secondBody.messages[0].parentId, "response-1");
    assert.equal(secondBody.messages[0].content, "User: Second question");
    assert.ok(!secondBody.messages[0].content.includes("First question"));
    assert.ok(!secondBody.messages[0].content.includes("Hello"));
  });

  it("continues a streaming local-MCP tool loop in the same Qwen chat", async () => {
    let completionCount = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-tool-loop");
      completionCount++;
      if (completionCount === 1) {
        return sseResponse([
          { "response.created": { response_id: "response-tool-call" } },
          {
            choices: [
              {
                delta: {
                  phase: "local_tool",
                  status: "finished",
                  function_id: "read-1",
                  extra: {
                    local_mcp: {
                      omniroute: [{ tool_name: "read", params: { filePath: "PRD.md" } }],
                    },
                  },
                },
              },
            ],
          },
        ]);
      }
      return sseResponse([
        { "response.created": { response_id: "response-final" } },
        {
          choices: [{ delta: { phase: "answer", content: "The PRD describes a cafe page." } }],
        },
      ]);
    }) as any;

    const tools = [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
      },
    ];
    const executor = new mod.QwenWebExecutor();
    const first = await executor.execute({
      model: "qwen3.7-max-fast",
      body: { tools, messages: [{ role: "user", content: "Read PRD.md" }] },
      stream: true,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:opencode-tool-session",
      signal: null,
    } as any);
    const firstStream = await first.response.text();
    assert.match(firstStream, /"finish_reason":"tool_calls"/);

    const second = await executor.execute({
      model: "qwen3.7-max-fast",
      body: {
        tools,
        messages: [
          { role: "user", content: "Read PRD.md" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_qwen_read-1_0",
                type: "function",
                function: { name: "read", arguments: '{"filePath":"PRD.md"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_qwen_read-1_0",
            content: "Cafe landing page requirements",
          },
        ],
      },
      stream: false,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:opencode-tool-session",
      signal: null,
    } as any);
    assert.equal(second.response.status, 200);

    const newChatCalls = calls.filter((call) => call.url.includes("/api/v2/chats/new"));
    const completionCalls = calls.filter((call) => call.url.includes("/chat/completions"));
    assert.equal(newChatCalls.length, 1, "tool result must continue the existing Qwen chat");
    const secondBody = JSON.parse(completionCalls[1].init.body);
    assert.equal(secondBody.parent_id, "response-tool-call");
    assert.match(
      secondBody.messages[0].content,
      /Explicit current user request \(authoritative\): Read PRD\.md/
    );
    assert.match(secondBody.messages[0].content, /Tool result \(read\)/);
    assert.match(secondBody.messages[0].content, /Cafe landing page requirements/);
    assert.ok(!secondBody.messages[0].content.includes("Assistant requested"));
  });

  it("isolates Qwen chats by client session and provider account", async () => {
    let created = 0;
    globalThis.fetch = (async (url: any) => {
      calls.push({ url: String(url), init: {} });
      if (String(url).includes("/api/v2/chats/new")) {
        created++;
        return chatCreatedResponse(`chat-${created}`);
      }
      return sseResponse([
        { "response.created": { response_id: `response-${created}` } },
        { choices: [{ delta: { phase: "answer", content: "ok" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    for (const [sessionKey, connectionId] of [
      ["header:session-a", "account-a"],
      ["header:session-b", "account-a"],
      ["header:session-a", "account-b"],
    ]) {
      await executor.execute({
        model: "qwen3.7-plus-fast",
        body: { messages: [{ role: "user", content: "same prompt" }] },
        stream: false,
        credentials: { apiKey: "token=t; cna=c", connectionId },
        sessionKey,
        signal: null,
      } as any);
    }

    assert.equal(created, 3, "different sessions/accounts must never share one Qwen chat");
  });

  it("creates a fresh chat when Qwen does not return a continuation response id", async () => {
    let created = 0;
    globalThis.fetch = (async (url: any) => {
      calls.push({ url: String(url), init: {} });
      if (String(url).includes("/api/v2/chats/new")) {
        created++;
        return chatCreatedResponse(`chat-${created}`);
      }
      return sseResponse([{ choices: [{ delta: { phase: "answer", content: "ok" } }] }]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const common = {
      model: "qwen3.7-plus-fast",
      stream: false,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:no-parent-session",
      signal: null,
    };
    await executor.execute({
      ...common,
      body: { messages: [{ role: "user", content: "first" }] },
    } as any);
    await executor.execute({
      ...common,
      body: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
    } as any);

    assert.equal(created, 2, "missing parent id must disable unsafe continuation reuse");
  });

  it("expires idle Qwen continuation state after six hours", async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    let created = 0;
    globalThis.fetch = (async (url: any) => {
      calls.push({ url: String(url), init: {} });
      if (String(url).includes("/api/v2/chats/new")) {
        created++;
        return chatCreatedResponse(`chat-${created}`);
      }
      return sseResponse([
        { "response.created": { response_id: `response-${created}` } },
        { choices: [{ delta: { phase: "answer", content: "ok" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const common = {
      model: "qwen3.7-plus-fast",
      stream: false,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:idle-session",
      signal: null,
    };
    await executor.execute({
      ...common,
      body: { messages: [{ role: "user", content: "first" }] },
    } as any);
    now += 6 * 60 * 60 * 1000 + 1;
    await executor.execute({
      ...common,
      body: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
    } as any);

    assert.equal(created, 2, "expired session state must create a fresh Qwen chat");
  });

  it("recreates the chat once when a cached Qwen continuation is rejected", async () => {
    let created = 0;
    let completions = 0;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) {
        created++;
        return chatCreatedResponse(`chat-${created}`);
      }
      completions++;
      if (completions === 2) {
        return new Response(JSON.stringify({ success: false, data: { code: "InvalidParent" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sseResponse([
        { "response.created": { response_id: `response-${completions}` } },
        { choices: [{ delta: { phase: "answer", content: "ok" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const common = {
      model: "qwen3.7-plus-fast",
      stream: false,
      credentials: { apiKey: "token=t; cna=c", connectionId: "account-a" },
      sessionKey: "header:stale-parent-session",
      signal: null,
    };
    await executor.execute({
      ...common,
      body: { messages: [{ role: "user", content: "first" }] },
    } as any);
    const recovered = await executor.execute({
      ...common,
      body: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
    } as any);

    assert.equal(recovered.response.status, 200);
    assert.equal(created, 2, "stale continuation should create one replacement chat");
    assert.equal(completions, 3, "replacement chat should retry the completion once");
    const completionCalls = calls.filter((call) => call.url.includes("/chat/completions"));
    assert.equal(JSON.parse(completionCalls[1].init.body).parent_id, "response-1");
    assert.equal(JSON.parse(completionCalls[2].init.body).parent_id, null);
    assert.match(completionCalls[2].url, /chat_id=chat-2/);
  });

  it("returns Qwen local MCP events as non-streaming OpenAI tool calls", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-native");
      return sseResponse([
        {
          choices: [
            {
              delta: {
                phase: "local_tool",
                status: "finished",
                extra: {
                  local_mcp: {
                    omniroute: [{ tool_name: "read", params: { filePath: "PRD.md" } }],
                  },
                },
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-plus",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: {
                type: "object",
                properties: { filePath: { type: "string" } },
                required: ["filePath"],
              },
            },
          },
        ],
        messages: [{ role: "user", content: "Read PRD.md" }],
      },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const json = (await result.response.json()) as any;
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.content, null);
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "read");
    assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"filePath":"PRD.md"}');
  });

  it("streams native reasoning and indexes multiple translated tool calls", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse("chat-multi");
      return sseResponse([
        { choices: [{ delta: { phase: "think", content: "I need two files." } }] },
        {
          choices: [
            {
              delta: {
                phase: "local_tool",
                status: "typing",
                tool_name: "client_read_file",
                function_call: { name: "client_read_file" },
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                phase: "local_tool",
                content: "",
                extra: {
                  local_mcp: {
                    omniroute: [{ tool_name: "client_read_file", params: { path: "PRD.md" } }],
                  },
                },
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                phase: "local_tool",
                content: "",
                extra: {
                  local_mcp: {
                    omniroute: [{ tool_name: "client_read_file", params: { path: "README.md" } }],
                  },
                },
              },
            },
          ],
        },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-plus",
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "client_read_file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
        messages: [{ role: "user", content: "Read both files" }],
      },
      stream: true,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const text = await result.response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)));
    const reasoning = events
      .map((event) => event.choices?.[0]?.delta?.reasoning_content || "")
      .join("");
    const toolCalls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || []);

    assert.equal(reasoning, "I need two files.");
    assert.deepEqual(
      toolCalls.map((call: { index?: number }) => call.index),
      [0, 1]
    );
    assert.equal(new Set(toolCalls.map((call: { id?: string }) => call.id)).size, 2);
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  });

  it("classifies the retired-v1 / WAF 504 HTML page as a clear auth error (not raw HTML)", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return wafHtmlResponse(504);
      return chatCreatedResponse();
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=stale; cna=c" },
      signal: null,
    } as any);

    assert.ok([401, 403].includes(result.response.status), "should map to an auth status");
    const json = (await result.response.json()) as any;
    const msg = String(json.error?.message || "");
    assert.ok(!msg.includes("<html"), "raw HTML must not be returned to the client");
    assert.match(msg, /session|expired|WAF|re-?login|cookie/i, "actionable error message");
  });

  it("streams answer-phase content as OpenAI chat.completion.chunk deltas", async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "Hi", status: "typing" } }] },
        { choices: [{ delta: { phase: "answer", content: " there", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    const result = await executor.execute({
      model: "qwen3.7-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const text = await result.response.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"content":" there"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("accepts a bare token (back-compat) without a cookie jar", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "barejwttoken" },
      signal: null,
    } as any);

    // Back-compat: a bare token is parsed without throwing, but the SPA mirror
    // does not send an Authorization bearer — cookies carry auth. (Token-only
    // requests do not pass Alibaba's baxia WAF; a full cookie jar is required.)
    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(!headers.Authorization && !headers.authorization, "no bearer sent");
    assert.ok(!headers.Cookie && !headers.cookie, "no cookie jar for bare token");
  });

  it("merges rotated Set-Cookie values into the jar and persists via onCredentialsRefreshed", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      // Completion response rotates x5sec + acw_tc via Set-Cookie.
      return new Response(
        "data: " + JSON.stringify({ choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] }) + "\n\ndata: [DONE]\n\n",
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "set-cookie":
              "x5sec=newx5token; Max-Age=60; Path=/; Domain=qwen.ai, acw_tc=newacw; Max-Age=60; Path=/; Domain=qwen.ai",
          },
        }
      );
    }) as any;

    let persisted: any = null;
    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c; x5sec=oldx5; acw_tc=oldacw; ssxmod_itna=1-A" },
      signal: null,
      onCredentialsRefreshed: async (updated: any) => {
        persisted = updated;
      },
    } as any);

    assert.ok(persisted, "onCredentialsRefreshed must fire with merged jar");
    const jar = persisted.apiKey as string;
    assert.match(jar, /x5sec=newx5token/, "x5sec rotated into jar");
    assert.match(jar, /acw_tc=newacw/, "acw_tc rotated into jar");
    assert.match(jar, /cna=c/, "long-lived cna untouched");
    assert.match(jar, /token=t/, "long-lived token untouched");
    assert.match(jar, /ssxmod_itna=1-A/, "ssxmod_itna untouched (no Set-Cookie for it)");
  });

  it("does NOT persist when Set-Cookie only carries long-lived cookies", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return new Response(
        "data: " + JSON.stringify({ choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] }) + "\n\ndata: [DONE]\n\n",
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "cna=newcna; Max-Age=15552000; Path=/; Domain=qwen.ai",
          },
        }
      );
    }) as any;

    let persisted: any = null;
    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3.7-plus",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
      onCredentialsRefreshed: async (updated: any) => {
        persisted = updated;
      },
    } as any);

    assert.equal(persisted, null, "long-lived-only Set-Cookie must not trigger persist");
  });

  it("normalizes virtual mode model IDs to the canonical Qwen upstream model", async () => {
    const cases = [
      {
        virtualModel: "qwen3.7-plus-fast",
        upstreamModel: "qwen3.7-plus",
        thinkingEnabled: false,
        autoThinking: false,
      },
      {
        virtualModel: "qwen3.7-plus-auto",
        upstreamModel: "qwen3.7-plus",
        thinkingEnabled: false,
        autoThinking: true,
      },
      {
        virtualModel: "qwen3.7-plus-thinking",
        upstreamModel: "qwen3.7-plus",
        thinkingEnabled: true,
        autoThinking: false,
      },
      {
        virtualModel: "qwen3.7-max-fast",
        upstreamModel: "qwen3.7-max",
        thinkingEnabled: false,
        autoThinking: false,
      },
      {
        virtualModel: "qwen3.7-max-thinking",
        upstreamModel: "qwen3.7-max",
        thinkingEnabled: true,
        autoThinking: false,
      },
    ];

    for (const testCase of cases) {
      calls = [];
      globalThis.fetch = (async (url: any, init: any = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
        return sseResponse([
          { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
        ]);
      }) as any;

      const executor = new mod.QwenWebExecutor();
      await executor.execute({
        model: testCase.virtualModel,
        body: {
          model: testCase.virtualModel,
          reasoning_effort: "high",
          messages: [{ role: "user", content: "hi" }],
        },
        stream: false,
        credentials: { apiKey: "token=t; cna=c" },
        signal: null,
      } as any);

      const newChatBody = JSON.parse(calls[0].init.body);
      const completionBody = JSON.parse(calls[1].init.body);
      const featureConfig = completionBody.messages[0].feature_config;
      assert.deepEqual(newChatBody.models, [testCase.upstreamModel]);
      assert.equal(completionBody.model, testCase.upstreamModel);
      assert.equal(featureConfig.thinking_enabled, testCase.thinkingEnabled);
      assert.equal(featureConfig.auto_thinking, testCase.autoThinking);
    }
  });

  it("registry points at the v2 endpoint and the current model catalog", () => {
    const provider = (REGISTRY as any)["qwen-web"];
    assert.ok(provider, "qwen-web must be registered");
    assert.match(
      provider.baseUrl,
      /\/api\/v2\/chat\/completions$/,
      "registry must use v2 endpoint"
    );
    const ids = provider.models.map((m: any) => m.id);
    assert.deepEqual(ids.sort(), [
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-max-fast",
      "qwen3.7-max-thinking",
      "qwen3.7-plus",
      "qwen3.7-plus-auto",
      "qwen3.7-plus-fast",
      "qwen3.7-plus-thinking",
    ]);
  });

  it("free-model catalog lists the current qwen-web ids (not the retired ones)", () => {
    const qwenModels = (FREE_MODEL_BUDGETS as any[]).filter((m) => m.provider === "qwen-web");
    const ids = qwenModels.map((m) => m.modelId);
    assert.ok(ids.includes("qwen3.7-max"), "catalog must list qwen3.7-max");
    assert.ok(!ids.includes("qwen-plus"), "retired qwen-plus must be gone");
    assert.ok(
      qwenModels.every((m) => m.freeType !== "discontinued"),
      "qwen-web is no longer discontinued after the v2 migration"
    );
  });

  it("maps legacy model ids to the current upstream catalog", async () => {
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/chats/new")) return chatCreatedResponse();
      return sseResponse([
        { choices: [{ delta: { phase: "answer", content: "ok", status: "finished" } }] },
      ]);
    }) as any;

    const executor = new mod.QwenWebExecutor();
    await executor.execute({
      model: "qwen3-max",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token=t; cna=c" },
      signal: null,
    } as any);

    const newBody = JSON.parse(calls[0].init.body);
    assert.match(newBody.models[0], /^qwen3\.[67]-/, "legacy qwen3-max maps to a current model id");
  });
});
