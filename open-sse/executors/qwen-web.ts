/**
 * QwenWebExecutor — Alibaba Tongyi Qwen Chat via chat.qwen.ai (v2 API)
 *
 * Routes requests through Qwen's consumer chat API. The legacy v1 endpoint
 * (`/api/chat/completions`) was retired upstream in 2026 and now answers 504
 * HTML from Alibaba's gateway for every request, regardless of credentials
 * (#3288 / discussion #2768). The current contract is a two-step v2 flow:
 *
 *   1. POST /api/v2/chats/new                  → create a chat, returns chat_id
 *   2. POST /api/v2/chat/completions?chat_id=  → phase-based SSE stream
 *
 * The v2 endpoints sit behind Alibaba's "baxia" WAF, which requires the full
 * browser cookie jar from a real logged-in session (cna, ssxmod_itna,
 * ssxmod_itna2, token, ...). We therefore replay the captured/pasted Cookie
 * header verbatim plus the bearer token, mirroring how grok-web replays its
 * anti-bot cookies.
 *
 * SSE chunks carry `choices[0].delta` with a `phase` field: `think` /
 * `thinking_summary` map to reasoning, `answer` (or a null phase) carries the
 * assistant content.
 *
 * Reference implementations: gpt4free `g4f/Provider/Qwen.py`,
 * Chat2API `proxy/adapters/qwen-ai.ts`.
 *
 * Auth: full Cookie header from chat.qwen.ai + bearer token (localStorage
 *       `token`, also mirrored to a `token` cookie).
 * Format: OpenAI-compatible (translated from Qwen's phase protocol).
 */
import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import { createHash } from "node:crypto";
import { makeExecutorErrorResult as makeErrorResult } from "../utils/error.ts";
import {
  buildToolAwareResult,
  buildWebToolConversationPrompt,
  getRequestedToolNames,
  resolveRequestedToolName,
  toArgumentsString,
  WEB_TOOL_CONTINUATION_INSTRUCTION,
  type OpenAIToolCall,
  type WebToolConversationMessage,
} from "../translator/webTools.ts";
import { buildQwenCookieHeader, extractQwenToken } from "@/lib/providers/webCookieAuth";

const BASE_URL = "https://chat.qwen.ai";
const CHATS_NEW_URL = `${BASE_URL}/api/v2/chats/new`;
const CHAT_COMPLETIONS_URL = `${BASE_URL}/api/v2/chat/completions`;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Qwen SPA version — required by the v2 chat completion endpoint. Without this
// header the upstream returns HTTP 200 with `{"success":false,"data":{"code":"Bad_Request"}}`
// for every completion request, even with a valid session. The version string is
// the SPA build identifier shipped in the React client's `version` request header.
// Pinned from a live capture (2026-07); bump if Qwen ships a breaking change.
const QWEN_SPA_VERSION = "0.2.73";

const LOCAL_MCP_SERVER_NAME = "omniroute";
const CHAT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CHAT_SESSIONS = 256;

type QwenThinkingMode = "fast" | "auto" | "thinking";

type QwenChatState = {
  chatId: string;
  parentId: string | null;
  messageFingerprints: string[];
  updatedAt: number;
  busy: boolean;
};

// Persist rotated short-lived anti-bot cookies (x5sec / acw_tc / ssxmod_itna*)
// back to the DB at most once per window. The stable identity cookies
// (cna / aui / token / ...) are long-lived (180d / 30d) and are never touched.
const COOKIE_PERSIST_MIN_MS = 5 * 60 * 1000;
// Only these volatile names are merged from Set-Cookie responses; everything
// else in the jar stays exactly as the operator captured it.
const VOLATILE_COOKIE_RE = /^(x5sec|x5secdata|acw_tc|ssxmod_itna2?|atpsida|sca)$/i;

function splitSetCookieHeaders(headers: Headers): string[] {
  const maybeGetSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  let raw: string[];
  if (typeof maybeGetSetCookie === "function") {
    raw = maybeGetSetCookie.call(headers).filter(Boolean);
  } else {
    const combined = headers.get("set-cookie");
    raw = combined ? [combined] : [];
  }
  // Each entry may itself contain multiple concatenated Set-Cookie values
  // (Node's getSetCookie returns a single joined string). Split on ", " only
  // when it is followed by a cookie-name= pattern, so commas inside cookie
  // values are preserved.
  const out: string[] = [];
  for (const entry of raw) {
    const parts = entry.split(/,\s*(?=[^;=,\s]+=)/g);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function mergeSetCookieIntoCookieJar(cookieHeader: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }
  for (const setCookie of setCookieHeaders) {
    const pair = setCookie.split(";", 1)[0]?.trim() || "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!value || !VOLATILE_COOKIE_RE.test(name)) continue;
    jar.set(name, value);
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

class QwenRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly url: string
  ) {
    super(message);
  }
}

const MODEL_ALIASES: Record<string, string> = {
  // Legacy OmniRoute ids → current upstream catalog (GET /api/models).
  "qwen-plus": "qwen3.7-plus",
  "qwen-max": "qwen3.7-max",
  "qwen-turbo": "qwen3.6-plus",
  "qwen3-plus": "qwen3.7-plus",
  "qwen3-max": "qwen3.7-max",
  "qwen3-flash": "qwen3.6-plus",
  // Note: `qwen3-coder-plus` is a real upstream model id (Qwen3-Coder) and
  // must NOT be aliased — the previous `"qwen3-coder-plus": "qwen3.7-max"`
  // entry silently rewrote valid coder requests to the wrong model.
  "qwen3-coder-flash": "qwen3.6-plus",
  qwen: "qwen3.7-max",
  qwen3: "qwen3.7-max",
};

const DEFAULT_MODEL = "qwen3.7-max";

const VIRTUAL_MODEL_MODES: Record<
  string,
  { upstreamModel: string; thinkingMode: QwenThinkingMode }
> = {
  "qwen3.7-plus-fast": { upstreamModel: "qwen3.7-plus", thinkingMode: "fast" },
  "qwen3.7-plus-auto": { upstreamModel: "qwen3.7-plus", thinkingMode: "auto" },
  "qwen3.7-plus-thinking": { upstreamModel: "qwen3.7-plus", thinkingMode: "thinking" },
  "qwen3.7-max-fast": { upstreamModel: "qwen3.7-max", thinkingMode: "fast" },
  "qwen3.7-max-thinking": { upstreamModel: "qwen3.7-max", thinkingMode: "thinking" },
  "qwen3.8-max-fast": { upstreamModel: "qwen3.8-max", thinkingMode: "fast" },
  "qwen3.8-max-thinking": { upstreamModel: "qwen3.8-max", thinkingMode: "thinking" },
  "qwen3.8-max-auto": { upstreamModel: "qwen3.8-max", thinkingMode: "auto" },
};

function bareQwenModelId(modelId: string): string {
  return modelId.startsWith("qwen-web/") ? modelId.slice("qwen-web/".length) : modelId;
}

function getVirtualModelMode(
  modelId: string
): { upstreamModel: string; thinkingMode: QwenThinkingMode } | null {
  return VIRTUAL_MODEL_MODES[bareQwenModelId(modelId)] ?? null;
}

function mapModel(modelId: string): string {
  const bareModelId = bareQwenModelId(modelId);
  return (
    getVirtualModelMode(bareModelId)?.upstreamModel || MODEL_ALIASES[bareModelId] || bareModelId
  );
}

function uuid(): string {
  return crypto.randomUUID();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function fingerprintMessage(message: WebToolConversationMessage): string {
  return hashText(
    JSON.stringify({
      role: message.role,
      content: message.content ?? null,
      name: message.name ?? null,
      tool_call_id: message.tool_call_id ?? null,
      tool_calls: message.tool_calls ?? null,
    })
  );
}

function findContinuationStart(previous: string[], current: string[]): number | null {
  if (previous.length === 0 || current.length <= previous.length) return null;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== current[index]) return null;
  }
  return previous.length;
}

function buildContinuationPrompt(
  messages: WebToolConversationMessage[],
  continuationStart: number
): string {
  const callNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call.id && typeof call.function?.name === "string") {
        callNameById.set(call.id, call.function.name);
      }
    }
  }

  const continuation: string[] = [];
  let currentUserRequest = "";
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message.content).trim();
    if (text) currentUserRequest = text;
  }
  let sawToolResult = false;
  for (const message of messages.slice(continuationStart)) {
    const text = messageText(message.content).trim();
    if (message.role === "user") {
      if (text) continuation.push(`User: ${text}`);
    } else if (message.role === "tool" || message.role === "function") {
      const name =
        (message.tool_call_id && callNameById.get(message.tool_call_id)) || message.name || "tool";
      continuation.push(`Tool result (${name}): ${text || "(no output)"}`);
      sawToolResult = true;
    } else if ((message.role === "system" || message.role === "developer") && text) {
      continuation.push(`Instruction update: ${text}`);
    }
  }

  if (sawToolResult) {
    if (currentUserRequest) {
      continuation.unshift(`Explicit current user request (authoritative): ${currentUserRequest}`);
    }
    continuation.push(WEB_TOOL_CONTINUATION_INSTRUCTION);
  }
  return continuation.join("\n\n");
}

function buildQwenLocalMcpConfig(
  tools: unknown
): Record<string, Record<string, { description: string; input_schema: unknown }>> | null {
  if (!Array.isArray(tools)) return null;

  const serverTools: Record<string, { description: string; input_schema: unknown }> = {};
  for (const tool of tools) {
    const toolRecord = asRecord(tool);
    const fn = asRecord(toolRecord?.function);
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    serverTools[name] = {
      description: typeof fn?.description === "string" ? fn.description : "",
      input_schema: fn?.parameters ?? { type: "object", properties: {} },
    };
  }

  return Object.keys(serverTools).length > 0 ? { [LOCAL_MCP_SERVER_NAME]: serverTools } : null;
}

function appendNativeToolCalls(
  destination: OpenAIToolCall[],
  seenCalls: Set<string>,
  incoming: OpenAIToolCall[]
): void {
  const usedIds = new Set(destination.map((call) => call.id));
  for (const toolCall of incoming) {
    const key = `${toolCall.function.name}:${toolCall.function.arguments}`;
    if (seenCalls.has(key)) continue;
    seenCalls.add(key);
    let id = toolCall.id;
    if (usedIds.has(id)) id = `${id}_${destination.length}`;
    usedIds.add(id);
    destination.push(id === toolCall.id ? toolCall : { ...toolCall, id });
  }
}

function resolveQwenThinkingMode(
  body: Record<string, unknown>,
  requestedModel: string
): QwenThinkingMode {
  const virtualMode = getVirtualModelMode(requestedModel);
  if (virtualMode) return virtualMode.thinkingMode;

  const reasoning = asRecord(body.reasoning);
  const rawEffort = body.reasoning_effort ?? reasoning?.effort;
  const effort = typeof rawEffort === "string" ? rawEffort.trim().toLowerCase() : "";

  if (["none", "minimal", "off", "disabled", "fast"].includes(effort)) return "fast";
  if (["low", "auto"].includes(effort)) {
    return /max/i.test(requestedModel) ? "thinking" : "auto";
  }
  if (["medium", "high", "xhigh", "max", "thinking"].includes(effort)) return "thinking";

  if (typeof body.thinking === "boolean") return body.thinking ? "thinking" : "fast";
  const thinking = asRecord(body.thinking);
  if (thinking?.type === "disabled") return "fast";
  if (thinking?.type === "enabled") return "thinking";

  return /think|reason|r1/i.test(requestedModel) ? "thinking" : "fast";
}

/** Detect Alibaba's WAF / retired-v1 gateway page so we never surface raw HTML. */
function isWafResponse(status: number, contentType: string, bodyText: string): boolean {
  if (contentType.includes("text/html")) return true;
  if (status === 504) return true;
  return /aliyun_waf|baxia|<html/i.test(bodyText);
}

const WAF_ERROR_MESSAGE =
  "Qwen session expired or blocked by Alibaba's WAF. Re-login at https://chat.qwen.ai and " +
  "paste a fresh full Cookie header (must include cna, ssxmod_itna and token) — a bearer token " +
  "alone is no longer accepted by the v2 endpoint.";

export class QwenWebExecutor extends BaseExecutor {
  private readonly chatSessions = new Map<string, QwenChatState>();
  private lastCookiePersistAt = 0;

  constructor() {
    super("qwen-web", { id: "qwen-web", baseUrl: BASE_URL });
  }

  private buildHeaders(
    token: string,
    cookieHeader: string,
    chatId?: string
  ): Record<string, string> {
    // Mirror the Qwen SPA's exact completion-request header set (captured live
    // from the browser): Accept-Language, X-Accel-Buffering, X-Request-Id,
    // Accept, Content-Type, Version, source, Timezone, sec-ch-ua*, Sec-Fetch-*.
    // The SPA does NOT send bx-v/bx-umidtoken or an Authorization bearer on the
    // v2 endpoints, and sending the static fallbacks (or a stale token) trips
    // Alibaba's baxia WAF (FAIL_SYS_USER_VALIDATE + punish redirect). Cookies
    // carry the auth. Verified live (2026-08-08): fresh cookie jar + this exact
    // header set completes without x5sec.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": USER_AGENT,
      "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Origin: BASE_URL,
      Referer: chatId ? `${BASE_URL}/c/${chatId}` : `${BASE_URL}/`,
      source: "web",
      Version: QWEN_SPA_VERSION,
      "X-Request-Id": uuid(),
      "X-Accel-Buffering": "no",
      Timezone: "Asia/Jakarta",
    };
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    return headers;
  }

  private getChatSessionKey(
    input: ExecuteInput,
    modelId: string,
    rawCredential: string
  ): string | null {
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    // A first-prompt fingerprint can collide across unrelated clients. Reuse only
    // explicit header/body session identities; otherwise preserve one-chat-per-call.
    if (!sessionKey || sessionKey.startsWith("input:sha256:")) return null;
    const accountKey =
      input.credentials.connectionId ||
      `credential:${hashText(rawCredential || input.credentials.accessToken || "anonymous")}`;
    return `${accountKey}\u0000${modelId}\u0000${sessionKey}`;
  }

  private cleanupChatSessions(now = Date.now()): void {
    for (const [key, state] of this.chatSessions) {
      if (!state.busy && now - state.updatedAt > CHAT_SESSION_TTL_MS) {
        this.chatSessions.delete(key);
      }
    }
    if (this.chatSessions.size <= MAX_CHAT_SESSIONS) return;
    const idle = [...this.chatSessions.entries()]
      .filter(([, state]) => !state.busy)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of idle) {
      if (this.chatSessions.size <= MAX_CHAT_SESSIONS) break;
      this.chatSessions.delete(key);
    }
  }

  private finishChatState(
    key: string | null,
    state: QwenChatState | null,
    responseId: string | null,
    messageFingerprints: string[],
    completed: boolean
  ): void {
    if (!key || !state || this.chatSessions.get(key) !== state) return;
    if (!completed || !responseId) {
      this.chatSessions.delete(key);
      return;
    }
    state.parentId = responseId;
    state.messageFingerprints = messageFingerprints;
    state.updatedAt = Date.now();
    state.busy = false;
  }

  private async createChat(
    modelId: string,
    token: string,
    cookieHeader: string,
    signal: AbortSignal | null | undefined
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(CHATS_NEW_URL, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader),
        body: JSON.stringify({
          title: "New Chat",
          models: [modelId],
          chat_mode: "normal",
          chat_type: "t2t",
          timestamp: Date.now(),
        }),
        signal,
      });
    } catch (error) {
      throw new QwenRequestError(
        502,
        `Qwen create-chat error: ${error instanceof Error ? error.message : "unknown"}`,
        CHATS_NEW_URL
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("text/html")) {
      const text = await response.text().catch(() => "");
      if (isWafResponse(response.status, contentType, text)) {
        throw new QwenRequestError(401, WAF_ERROR_MESSAGE, CHATS_NEW_URL);
      }
      throw new QwenRequestError(
        response.status || 502,
        `Qwen create-chat failed: ${text.slice(0, 300)}`,
        CHATS_NEW_URL
      );
    }

    const data = (await response.json()) as { data?: { id?: string } };
    const chatId = data?.data?.id ?? "";
    if (!chatId) {
      throw new QwenRequestError(502, "Qwen create-chat returned no chat id", CHATS_NEW_URL);
    }
    return chatId;
  }

  private async sendCompletion(
    chatId: string,
    payload: Record<string, unknown>,
    token: string,
    cookieHeader: string,
    signal: AbortSignal | null | undefined
  ): Promise<{ response: Response; url: string }> {
    const url = `${CHAT_COMPLETIONS_URL}?chat_id=${chatId}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(token, cookieHeader, chatId),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      throw new QwenRequestError(
        502,
        `Qwen completion fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
        url
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      !response.ok ||
      contentType.includes("text/html") ||
      contentType.includes("application/json")
    ) {
      const text = await response.text().catch(() => "");
      if (isWafResponse(response.status, contentType, text)) {
        throw new QwenRequestError(401, WAF_ERROR_MESSAGE, url);
      }
      throw new QwenRequestError(
        response.status >= 400 ? response.status : 502,
        `Qwen error: ${text.slice(0, 300)}`,
        url
      );
    }
    return { response, url };
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, signal, stream: wantStream, log } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;

    const rawCred = String(credentials?.apiKey ?? "").trim();
    const cookieHeader = buildQwenCookieHeader(rawCred);
    let token = extractQwenToken(rawCred);
    if (!token && credentials?.accessToken) token = String(credentials.accessToken).trim();

    const messages = (bodyObj.messages as WebToolConversationMessage[]) || [];
    const requestedModel = (bodyObj.model as string) || DEFAULT_MODEL;
    const modelId = mapModel(requestedModel);
    const thinkingMode = resolveQwenThinkingMode(bodyObj, requestedModel);

    const requestedTools = bodyObj.tools;
    const hasTools = Array.isArray(requestedTools) && requestedTools.length > 0;

    const fullPrompt = hasTools
      ? buildWebToolConversationPrompt(messages, "", { historyFormat: "plain" })
      : this.foldMessages(messages);
    const messageFingerprints = messages.map(fingerprintMessage);
    const chatSessionKey = this.getChatSessionKey(input, modelId, rawCred);
    this.cleanupChatSessions();

    let trackedState: QwenChatState | null = null;
    let reusedChat = false;
    let chatId = "";
    let parentId: string | null = null;
    let prompt = fullPrompt;

    if (chatSessionKey) {
      const candidate = this.chatSessions.get(chatSessionKey);
      if (candidate && !candidate.busy && Date.now() - candidate.updatedAt <= CHAT_SESSION_TTL_MS) {
        const continuationStart = findContinuationStart(
          candidate.messageFingerprints,
          messageFingerprints
        );
        const continuationPrompt =
          continuationStart == null ? "" : buildContinuationPrompt(messages, continuationStart);
        if (candidate.parentId && continuationPrompt) {
          trackedState = candidate;
          trackedState.busy = true;
          reusedChat = true;
          chatId = candidate.chatId;
          parentId = candidate.parentId;
          prompt = continuationPrompt;
        } else {
          this.chatSessions.delete(chatSessionKey);
        }
      }
    }

    let msgPayload: Record<string, unknown>;
    let upstream: Response;
    let completionUrl: string;
    try {
      if (!reusedChat) {
        chatId = await this.createChat(modelId, token, cookieHeader, signal);
        parentId = null;
        if (chatSessionKey && !this.chatSessions.has(chatSessionKey)) {
          trackedState = {
            chatId,
            parentId: null,
            messageFingerprints: [],
            updatedAt: Date.now(),
            busy: true,
          };
          this.chatSessions.set(chatSessionKey, trackedState);
        }
      }

      msgPayload = this.buildMessagePayload(
        chatId,
        modelId,
        prompt,
        thinkingMode,
        requestedTools,
        parentId
      );
      ({ response: upstream, url: completionUrl } = await this.sendCompletion(
        chatId,
        msgPayload,
        token,
        cookieHeader,
        signal
      ));

      // Qwen rotates short-lived anti-bot cookies (x5sec / acw_tc / ssxmod_itna*)
      // via Set-Cookie on successful responses. Merge them into the jar and
      // persist to the DB at most once per window so the account stays healthy
      // without any active refresh loop.
      const setCookies = splitSetCookieHeaders(upstream.headers);
      if (setCookies.length > 0) {
        const merged = mergeSetCookieIntoCookieJar(cookieHeader, setCookies);
        if (merged !== cookieHeader) {
          const now = Date.now();
          if (now - this.lastCookiePersistAt >= COOKIE_PERSIST_MIN_MS) {
            this.lastCookiePersistAt = now;
            const updated: ProviderCredentials = { ...credentials, apiKey: merged };
            try {
              await input.onCredentialsRefreshed?.(updated);
              log?.info?.("QWEN-WEB", "Refreshed volatile Qwen cookies (x5sec/acw_tc/ssxmod_itna)");
            } catch (err) {
              log?.warn?.(
                "QWEN-WEB",
                `Failed to persist refreshed Qwen cookie: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      }
    } catch (error) {
      if (
        chatSessionKey &&
        trackedState &&
        this.chatSessions.get(chatSessionKey) === trackedState
      ) {
        this.chatSessions.delete(chatSessionKey);
      }
      const qwenError =
        error instanceof QwenRequestError
          ? error
          : new QwenRequestError(502, "Qwen request failed", CHAT_COMPLETIONS_URL);
      const canRecoverStaleChat =
        reusedChat && qwenError.status !== 401 && qwenError.status !== 429 && !signal?.aborted;
      if (!canRecoverStaleChat) {
        return makeErrorResult(qwenError.status, qwenError.message, body, qwenError.url);
      }

      try {
        chatId = await this.createChat(modelId, token, cookieHeader, signal);
        parentId = null;
        prompt = fullPrompt;
        trackedState = chatSessionKey
          ? {
              chatId,
              parentId: null,
              messageFingerprints: [],
              updatedAt: Date.now(),
              busy: true,
            }
          : null;
        if (chatSessionKey && trackedState) this.chatSessions.set(chatSessionKey, trackedState);
        msgPayload = this.buildMessagePayload(
          chatId,
          modelId,
          prompt,
          thinkingMode,
          requestedTools,
          parentId
        );
        ({ response: upstream, url: completionUrl } = await this.sendCompletion(
          chatId,
          msgPayload,
          token,
          cookieHeader,
          signal
        ));
      } catch (fallbackError) {
        if (
          chatSessionKey &&
          trackedState &&
          this.chatSessions.get(chatSessionKey) === trackedState
        ) {
          this.chatSessions.delete(chatSessionKey);
        }
        const finalError =
          fallbackError instanceof QwenRequestError
            ? fallbackError
            : new QwenRequestError(502, "Qwen request failed", CHAT_COMPLETIONS_URL);
        return makeErrorResult(finalError.status, finalError.message, body, finalError.url);
      }
    }

    if (!wantStream) {
      const { content, reasoning, nativeToolCalls, responseId, completed } =
        await this.collectStream(upstream, requestedTools);
      this.finishChatState(
        chatSessionKey,
        trackedState,
        responseId,
        messageFingerprints,
        completed
      );
      const finalText = content;

      if (hasTools) {
        const fallback = buildToolAwareResult(finalText, requestedTools, "qwen");
        const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : fallback.toolCalls;
        const toolContent = nativeToolCalls.length > 0 ? finalText : fallback.content;
        const finishReason = toolCalls ? "tool_calls" : "stop";
        const message: Record<string, unknown> = {
          role: "assistant",
          content: toolContent || null,
        };
        if (reasoning) message.reasoning_content = reasoning;
        if (toolCalls) {
          message.tool_calls = toolCalls;
        }
        return this.jsonResponse(modelId, message, finishReason, completionUrl, msgPayload);
      }

      const message: Record<string, unknown> = { role: "assistant", content: finalText };
      if (reasoning) message.reasoning_content = reasoning;
      return this.jsonResponse(modelId, message, "stop", completionUrl, msgPayload);
    }

    // Streaming: transform Qwen phase SSE → OpenAI chat.completion.chunk SSE.
    const stream = this.buildClientStream(
      upstream,
      modelId,
      hasTools,
      requestedTools,
      signal,
      (responseId, completed) =>
        this.finishChatState(
          chatSessionKey,
          trackedState,
          responseId,
          messageFingerprints,
          completed
        )
    );
    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: completionUrl,
      headers: this.buildHeaders(token, cookieHeader, chatId),
      transformedBody: msgPayload,
    };
  }

  /** Flatten OpenAI-style content (string | Array<{type,text}>) into plain text.
   *  A bare String() on an array of content parts yields "[object Object]" — the
   *  serialization bug reported on the support mesh. */
  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const p = part as { type?: unknown; text?: unknown };
            if (typeof p.text === "string") return p.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return content == null ? "" : String(content);
  }

  private foldMessages(messages: WebToolConversationMessage[]): string {
    let systemContent = "";
    let userContent = "";
    for (const m of messages) {
      const text = this.contentToText(m.content);
      if (m.role === "system") {
        systemContent += (systemContent ? "\n\n" : "") + text;
      } else if (m.role === "user") {
        userContent = text;
      }
    }
    return systemContent ? `${systemContent}\n\nUser: ${userContent}` : userContent;
  }

  private buildMessagePayload(
    chatId: string,
    modelId: string,
    prompt: string,
    thinkingMode: QwenThinkingMode,
    requestedTools?: unknown,
    parentId: string | null = null
  ): Record<string, unknown> {
    const fid = uuid();
    const enableThinking = thinkingMode === "thinking";
    const autoThinking = thinkingMode === "auto";
    const featureConfig: Record<string, unknown> = {
      thinking_enabled: enableThinking,
      output_schema: "phase",
      auto_thinking: autoThinking,
      research_mode: "normal",
      auto_search: false,
    };
    const localMcp = buildQwenLocalMcpConfig(requestedTools);
    if (localMcp) {
      // Qwen's SPA sends an empty remote-MCP selection alongside locally
      // connected MCP schemas. The model returns `phase: local_tool` events;
      // execution remains with the OpenAI-compatible caller.
      featureConfig.mcp = [];
      featureConfig.local_mcp = localMcp;
    }
    return {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: modelId,
      parent_id: parentId,
      messages: [
        {
          fid,
          parentId,
          childrenIds: [],
          role: "user",
          content: prompt,
          user_action: "chat",
          files: [],
          timestamp: Math.floor(Date.now() / 1000),
          models: [modelId],
          chat_type: "t2t",
          feature_config: featureConfig,
          sub_chat_type: "t2t",
          parent_id: parentId,
        },
      ],
    };
  }

  /** Read the whole upstream SSE stream, returning the joined answer + reasoning. */
  private async collectStream(
    upstream: Response,
    requestedTools?: unknown
  ): Promise<{
    content: string;
    reasoning: string;
    nativeToolCalls: OpenAIToolCall[];
    responseId: string | null;
    completed: boolean;
  }> {
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";
    let responseId: string | null = null;
    let completed = false;
    const nativeToolCalls: OpenAIToolCall[] = [];
    const seenToolCalls = new Set<string>();
    if (!reader) return { content, reasoning, nativeToolCalls, responseId, completed };

    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          responseId = parseQwenResponseId(line) || responseId;
          const delta = parseSseDelta(line, requestedTools);
          if (!delta) continue;
          if (delta.kind === "answer") content += delta.text;
          else if (delta.kind === "think") reasoning += delta.text;
          else appendNativeToolCalls(nativeToolCalls, seenToolCalls, delta.toolCalls);
        }
      }
    } catch {
      /* upstream closed mid-stream — return what we have */
    }
    return { content, reasoning, nativeToolCalls, responseId, completed };
  }

  /** Transform the Qwen phase SSE into OpenAI chat.completion.chunk SSE. */
  private buildClientStream(
    upstream: Response,
    modelId: string,
    hasTools: boolean,
    requestedTools: unknown,
    signal: AbortSignal | null | undefined,
    onSettled: (responseId: string | null, completed: boolean) => void
  ): ReadableStream {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const id = `chatcmpl-qwen-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const emitChunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let settled = false;
    let responseId: string | null = null;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      onSettled(responseId, completed);
    };

    return new ReadableStream({
      async start(controller) {
        reader = upstream.body?.getReader() ?? null;
        if (!reader) {
          settle(false);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        let buffer = "";
        let fullContent = "";
        const nativeToolCalls: OpenAIToolCall[] = [];
        const seenToolCalls = new Set<string>();
        controller.enqueue(encoder.encode(emitChunk({ role: "assistant", content: "" }, null)));
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              responseId = parseQwenResponseId(line) || responseId;
              const delta = parseSseDelta(line, requestedTools);
              if (!delta) continue;
              if (delta.kind === "answer") {
                fullContent += delta.text;
                if (!hasTools && delta.text) {
                  controller.enqueue(encoder.encode(emitChunk({ content: delta.text }, null)));
                }
              } else if (delta.kind === "think") {
                if (delta.text) {
                  controller.enqueue(
                    encoder.encode(emitChunk({ reasoning_content: delta.text }, null))
                  );
                }
              } else {
                appendNativeToolCalls(nativeToolCalls, seenToolCalls, delta.toolCalls);
              }
            }
          }
        } catch (err) {
          if (!signal?.aborted) {
            settle(false);
            controller.error(err);
            return;
          }
          settle(false);
          controller.close();
          return;
        }

        if (hasTools) {
          const fallback = buildToolAwareResult(fullContent, requestedTools, "qwen");
          const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : fallback.toolCalls;
          const content = nativeToolCalls.length > 0 ? fullContent : fallback.content;
          const finishReason = toolCalls ? "tool_calls" : "stop";
          if (content) {
            controller.enqueue(encoder.encode(emitChunk({ content }, null)));
          }
          const delta = toolCalls
            ? {
                tool_calls: toolCalls.map((toolCall, index) => ({ index, ...toolCall })),
              }
            : {};
          if (toolCalls) controller.enqueue(encoder.encode(emitChunk(delta, null)));
          controller.enqueue(encoder.encode(emitChunk({}, finishReason)));
        } else {
          controller.enqueue(encoder.encode(emitChunk({}, "stop")));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        settle(true);
        controller.close();
      },
      async cancel(reason) {
        settle(false);
        await reader?.cancel(reason).catch(() => undefined);
      },
    });
  }

  private jsonResponse(
    modelId: string,
    message: Record<string, unknown>,
    finishReason: string,
    url: string,
    transformedBody: unknown
  ) {
    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-qwen-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message, finish_reason: finishReason }],
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
      url,
      headers: {} as Record<string, string>,
      transformedBody,
    };
  }
}

/** Parse one SSE line into a typed delta, or null if it carries no content. */
type ParsedQwenSseDelta =
  { kind: "answer" | "think"; text: string } | { kind: "tool"; toolCalls: OpenAIToolCall[] };

function parseNativeToolCalls(
  delta: Record<string, unknown>,
  requestedTools: unknown
): OpenAIToolCall[] {
  const requestedNames = getRequestedToolNames(requestedTools);
  const calls: OpenAIToolCall[] = [];
  const seen = new Set<string>();
  const functionId =
    typeof delta.function_id === "string" ? delta.function_id.replace(/[^a-zA-Z0-9_-]/g, "") : "";

  const addCall = (emittedName: unknown, args: unknown) => {
    if (typeof emittedName !== "string" || !emittedName.trim()) return;
    const name = resolveRequestedToolName(emittedName.trim(), requestedNames);
    if (!name) return;
    const argumentsString = toArgumentsString(args);
    const key = `${name}:${argumentsString}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({
      id: `call_qwen_${functionId || "local"}_${calls.length}`,
      type: "function",
      function: { name, arguments: argumentsString },
    });
  };

  const extra = asRecord(delta.extra);
  const localMcp = asRecord(extra?.local_mcp);
  if (localMcp) {
    for (const serverCalls of Object.values(localMcp)) {
      if (!Array.isArray(serverCalls)) continue;
      for (const serverCall of serverCalls) {
        const call = asRecord(serverCall);
        addCall(call?.tool_name, call?.params);
      }
    }
  }

  if (calls.length === 0) {
    const functionCall = asRecord(delta.function_call);
    if (delta.status === "finished" && functionCall?.arguments !== undefined) {
      addCall(functionCall.name ?? delta.tool_name, functionCall.arguments);
    }
  }

  return calls;
}

function parseQwenResponseId(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = asRecord(JSON.parse(payload));
    const created = asRecord(parsed?.["response.created"]);
    return typeof created?.response_id === "string" && created.response_id.trim()
      ? created.response_id.trim()
      : null;
  } catch {
    return null;
  }
}

function parseSseDelta(line: string, requestedTools?: unknown): ParsedQwenSseDelta | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed: { choices?: Array<{ delta?: Record<string, unknown> }> };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return null;
  const phase = delta.phase;
  const content = typeof delta.content === "string" ? delta.content : "";
  if (phase === "local_tool") {
    const toolCalls = parseNativeToolCalls(delta, requestedTools);
    return toolCalls.length > 0 ? { kind: "tool", toolCalls } : null;
  }
  if (phase === "think" || phase === "thinking_summary") {
    return { kind: "think", text: content };
  }
  // `answer` phase or a null/absent phase both carry assistant content.
  if (phase === "answer" || phase === null || phase === undefined) {
    return { kind: "answer", text: content };
  }
  return null;
}
