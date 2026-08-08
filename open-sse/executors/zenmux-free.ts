/**
 * ZenmuxFreeExecutor — ZenMux Free (web-cookie) provider
 *
 * Accesses ZenMux's free-tier LLM gateway via session cookies exported from
 * the browser. Uses ZenMux's Anthropic-compatible SSE endpoint, translating
 * the response to OpenAI-format chunks for OmniRoute consumers.
 *
 * Endpoint: POST https://zenmux.ai/api/anthropic/v1/messages
 * Auth: Full cookie header string from zenmux.ai (must include ctoken)
 */
import { randomUUID } from "crypto";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult, normalizeCookie } from "../utils/error.ts";
import { FORMATS } from "../translator/formats.ts";
import { initState } from "../translator/index.ts";
import { openaiToClaudeRequestForAntigravity } from "../translator/request/openai-to-claude.ts";
import { claudeToOpenAIResponse } from "../translator/response/claude-to-openai.ts";

const CHAT_URL = "https://zenmux.ai/api/anthropic/v1/messages";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function extractCtoken(cookieStr: string): string {
  const m = cookieStr.match(/ctoken=([^;]+)/);
  return m ? m[1] : "";
}

function translateAnthropicSseToOpenAI(
  upstream: Response,
  modelId: string,
  signal?: AbortSignal | null
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = initState(FORMATS.CLAUDE) as Record<string, unknown>;
  state.messageId = `zmf-${randomUUID().slice(0, 12)}`;
  state.model = modelId;
  state.suppressThinkClose = true;
  let buffer = "";
  let finished = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, converted: unknown) => {
    const chunks = Array.isArray(converted) ? converted : [converted];
    for (const chunk of chunks) {
      if (!chunk) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
  };

  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    if (state.finishReasonSent !== true) {
      const toolCalls = state.toolCalls instanceof Map ? state.toolCalls : new Map();
      emit(controller, {
        id: `chatcmpl-${String(state.messageId)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: String(state.model || modelId),
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCalls.size > 0 ? "tool_calls" : "stop",
          },
        ],
      });
      state.finishReasonSent = true;
    }
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    finished = true;
  };

  const processLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trimStart();
    if (raw === "[DONE]") {
      finish(controller);
      return;
    }
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      emit(controller, claudeToOpenAIResponse(event, state));
    } catch {
      // Ignore malformed/non-JSON SSE metadata lines from the upstream.
    }
  };

  if (!upstream.body) {
    const fallback = new ReadableStream<Uint8Array>({
      start(controller) {
        const toolCalls = state.toolCalls instanceof Map ? state.toolCalls : new Map();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: `chatcmpl-${String(state.messageId)}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: toolCalls.size > 0 ? "tool_calls" : "stop",
                },
              ],
            })}\n\ndata: [DONE]\n\n`
          )
        );
        controller.close();
      },
    });
    return new Response(fallback, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const translated = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (signal?.aborted || finished) return;
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          processLine(line, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) processLine(buffer, controller);
        finish(controller);
      },
    })
  );

  return new Response(translated, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

interface CollectedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function collectOpenAICompletion(
  body: ReadableStream<Uint8Array> | null,
  modelId: string
): Promise<Response> {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, CollectedToolCall>();
  let buffer = "";
  let id = `chatcmpl-zmf-${randomUUID().slice(0, 12)}`;
  let created = Math.floor(Date.now() / 1000);
  let responseModel = modelId;
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trimStart();
    if (!raw || raw === "[DONE]") return;
    try {
      const chunk = JSON.parse(raw) as Record<string, unknown>;
      if (typeof chunk.id === "string") id = chunk.id;
      if (typeof chunk.created === "number") created = chunk.created;
      if (typeof chunk.model === "string") responseModel = chunk.model;
      if (chunk.usage && typeof chunk.usage === "object") {
        usage = chunk.usage as Record<string, unknown>;
      }
      const choice = Array.isArray(chunk.choices)
        ? (chunk.choices[0] as Record<string, unknown> | undefined)
        : undefined;
      if (!choice) return;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta =
        choice.delta && typeof choice.delta === "object"
          ? (choice.delta as Record<string, unknown>)
          : {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (!Array.isArray(delta.tool_calls)) return;
      for (const value of delta.tool_calls) {
        if (!value || typeof value !== "object") continue;
        const call = value as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : toolCalls.size;
        const fn =
          call.function && typeof call.function === "object"
            ? (call.function as Record<string, unknown>)
            : {};
        const existing = toolCalls.get(index) || {
          id: typeof call.id === "string" ? call.id : `call_zmf_${index}`,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (typeof call.id === "string") existing.id = call.id;
        if (typeof fn.name === "string") existing.function.name = fn.name;
        if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
        toolCalls.set(index, existing);
      }
    } catch {
      // Ignore malformed translated chunks; valid chunks still form a response.
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
  }

  const orderedToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: orderedToolCalls.length > 0 && !content ? null : content,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (orderedToolCalls.length > 0) message.tool_calls = orderedToolCalls;
  const completion = {
    id,
    object: "chat.completion",
    created,
    model: responseModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || (orderedToolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  };
  return new Response(JSON.stringify(completion), {
    headers: { "Content-Type": "application/json" },
  });
}

export class ZenmuxFreeExecutor extends BaseExecutor {
  constructor() {
    super("zenmux-free", { id: "zenmux-free", baseUrl: CHAT_URL });
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;

    // Bulk web-session imports intentionally store cookie credentials in
    // providerSpecificData.cookie (apiKey stays null for cookie-kind providers).
    // Keep the apiKey fallback for legacy/manual connections.
    const importedCookie = credentials?.providerSpecificData?.cookie;
    const rawCookie = normalizeCookie(
      String(
        (typeof importedCookie === "string" && importedCookie) || credentials?.apiKey || ""
      ).trim()
    );
    const ctoken = extractCtoken(rawCookie);
    if (!ctoken) {
      return makeErrorResult(
        401,
        "ZenMux Free: ctoken not found in cookies. Export all cookies from zenmux.ai and paste as the credential.",
        body,
        CHAT_URL
      );
    }

    const modelId = (bodyObj.model as string) || "deepseek/deepseek-chat";
    const requestedMaxTokens =
      typeof bodyObj.max_tokens === "number"
        ? bodyObj.max_tokens
        : typeof bodyObj.max_completion_tokens === "number"
          ? bodyObj.max_completion_tokens
          : 4096;

    const reqId = randomUUID().replace(/-/g, "");

    // ZenMux exposes an Anthropic-compatible Messages endpoint. Reuse the
    // canonical translator so OpenCode tools, assistant tool calls, and linked
    // tool results survive the round trip instead of flattening everything to
    // the latest user string. Disable Claude OAuth's proxy_ name prefix because
    // ZenMux expects the caller's original tool names.
    const anthropicBody = openaiToClaudeRequestForAntigravity(
      modelId,
      { ...bodyObj, _disableToolPrefix: true },
      true
    ) as Record<string, unknown>;
    delete anthropicBody._toolNameMap;
    anthropicBody.model = modelId;
    anthropicBody.max_tokens = requestedMaxTokens;
    anthropicBody.stream = true;

    const url = new URL(CHAT_URL);
    url.searchParams.set("ctoken", ctoken);

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: "text/event-stream",
      Origin: "https://zenmux.ai",
      Referer: "https://zenmux.ai/platform/chat",
      "anthropic-version": "2023-06-01",
      "chat-request-id": reqId,
      "x-zenmux-accept-processing": "true, true",
      "x-zenmux-apikey-source": "subscription",
    };
    if (rawCookie) reqHeaders.Cookie = rawCookie;

    let upstream: Response;
    try {
      upstream = await fetch(url.toString(), {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(anthropicBody),
        signal,
      });
    } catch (err) {
      return makeErrorResult(
        502,
        `ZenMux Free fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
        body,
        CHAT_URL
      );
    }

    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) {
        return makeErrorResult(401, "ZenMux Free: cookies expired or invalid", body, CHAT_URL);
      }
      if (upstream.status === 402) {
        return makeErrorResult(402, "ZenMux Free: free-tier quota exhausted", body, CHAT_URL);
      }
      const errText = await upstream.text().catch(() => "");
      return makeErrorResult(upstream.status, `ZenMux Free error: ${errText}`, body, CHAT_URL);
    }

    const translatedResponse = translateAnthropicSseToOpenAI(upstream, modelId, signal);
    const response = wantStream
      ? translatedResponse
      : await collectOpenAICompletion(translatedResponse.body, modelId);

    return {
      response,
      url: CHAT_URL,
      headers: reqHeaders,
      transformedBody: anthropicBody,
    };
  }
}
