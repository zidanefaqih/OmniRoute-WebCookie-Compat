// Pure JSONL stream translation (HuggingChat NDJSON -> OpenAI SSE).

import { buildToolAwareResult } from "../../translator/webTools.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";

export interface HuggingChatTextParts {
  content: string;
  reasoning: string;
}

export function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function parseJsonlLine(line: string): {
  token?: string;
  reasoningToken?: string;
  done?: boolean;
  error?: string;
  statusCode?: number;
  text?: string;
} {
  try {
    const event = JSON.parse(line);

    if (event.type === "stream" && typeof event.token === "string") {
      const token = event.token.replace(/\0/g, "");
      if (token) return { token };
    }

    if (
      event.type === "reasoning" &&
      event.subtype === "stream" &&
      typeof event.token === "string"
    ) {
      const reasoningToken = event.token.replace(/\0/g, "");
      if (reasoningToken) return { reasoningToken };
    }

    if (event.type === "finalAnswer" && typeof event.text === "string") {
      return { text: event.text, done: true };
    }

    if (event.type === "status") {
      if (event.status === "error") {
        const statusCode =
          typeof event.statusCode === "number" &&
          Number.isInteger(event.statusCode) &&
          event.statusCode >= 400 &&
          event.statusCode <= 599
            ? event.statusCode
            : 502;
        return {
          error: sanitizeErrorMessage(event.message || "HuggingChat generation error"),
          statusCode,
        };
      }
      if (event.status === "finished") {
        return { done: true };
      }
    }
  } catch {
    // Skip non-JSON lines
  }

  return {};
}

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const lower = value.toLowerCase();
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
    if (lower.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

class ThinkTagSplitter {
  private pending = "";
  private inReasoning = false;

  feed(value: string, final = false): Array<{ kind: "content" | "reasoning"; text: string }> {
    if (value) this.pending += value;
    const parts: Array<{ kind: "content" | "reasoning"; text: string }> = [];

    while (this.pending) {
      const marker = this.inReasoning ? "</think>" : "<think>";
      const markerIndex = this.pending.toLowerCase().indexOf(marker);
      if (markerIndex >= 0) {
        const text = this.pending.slice(0, markerIndex);
        if (text) parts.push({ kind: this.inReasoning ? "reasoning" : "content", text });
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.inReasoning = !this.inReasoning;
        continue;
      }

      if (final) {
        parts.push({
          kind: this.inReasoning ? "reasoning" : "content",
          text: this.pending,
        });
        this.pending = "";
        break;
      }

      const keep = longestMarkerPrefixSuffix(this.pending, marker);
      const emitLength = this.pending.length - keep;
      if (emitLength > 0) {
        parts.push({
          kind: this.inReasoning ? "reasoning" : "content",
          text: this.pending.slice(0, emitLength),
        });
        this.pending = this.pending.slice(emitLength);
      }
      break;
    }

    return parts;
  }
}

export function splitHuggingChatThinking(text: string): HuggingChatTextParts {
  const splitter = new ThinkTagSplitter();
  const parts = splitter.feed(text || "", true);
  return {
    content: parts
      .filter((part) => part.kind === "content")
      .map((part) => part.text)
      .join("")
      .trim(),
    reasoning: parts
      .filter((part) => part.kind === "reasoning")
      .map((part) => part.text)
      .join("")
      .trim(),
  };
}

export async function* streamJsonlToOpenAi(
  body: ReadableStream<Uint8Array>,
  model: string,
  id: string,
  created: number,
  signal?: AbortSignal | null,
  requestedTools?: unknown
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedRole = false;
  let fullText = "";
  let explicitReasoning = "";
  let finished = false;
  const hasTools = Array.isArray(requestedTools) && requestedTools.length > 0;
  const thinkSplitter = new ThinkTagSplitter();

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    sseChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  const roleChunk = () => chunk({ role: "assistant" });

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseJsonlLine(trimmed);

        if (parsed.error) {
          if (!emittedRole) {
            emittedRole = true;
            yield roleChunk();
          }
          yield chunk(
            {
              content: `[HuggingChat error ${parsed.statusCode || 502}: ${parsed.error}]`,
            },
            "stop"
          );
          yield "data: [DONE]\n\n";
          finished = true;
          return;
        }

        if (parsed.token) {
          fullText += parsed.token;
          if (!hasTools) {
            for (const part of thinkSplitter.feed(parsed.token)) {
              if (!part.text) continue;
              if (!emittedRole) {
                emittedRole = true;
                yield roleChunk();
              }
              yield chunk(
                part.kind === "reasoning"
                  ? { reasoning_content: part.text }
                  : { content: part.text }
              );
            }
          }
        }

        if (parsed.reasoningToken) {
          explicitReasoning += parsed.reasoningToken;
          if (!hasTools) {
            if (!emittedRole) {
              emittedRole = true;
              yield roleChunk();
            }
            yield chunk({ reasoning_content: parsed.reasoningToken });
          }
        }

        if (parsed.text) {
          const remaining = parsed.text.slice(fullText.length);
          if (remaining) {
            fullText += remaining;
            if (!hasTools) {
              for (const part of thinkSplitter.feed(remaining)) {
                if (!part.text) continue;
                if (!emittedRole) {
                  emittedRole = true;
                  yield roleChunk();
                }
                yield chunk(
                  part.kind === "reasoning"
                    ? { reasoning_content: part.text }
                    : { content: part.text }
                );
              }
            }
          }
          finished = true;
          break;
        }

        if (parsed.done) {
          finished = true;
          break;
        }
      }

      if (finished) break;
    }

    if (!finished && buffer.trim()) {
      const parsed = parseJsonlLine(buffer.trim());
      if (parsed.token && !signal?.aborted) {
        fullText += parsed.token;
        if (!hasTools) {
          for (const part of thinkSplitter.feed(parsed.token)) {
            if (!part.text) continue;
            if (!emittedRole) {
              emittedRole = true;
              yield roleChunk();
            }
            yield chunk(
              part.kind === "reasoning" ? { reasoning_content: part.text } : { content: part.text }
            );
          }
        }
      }
      if (parsed.reasoningToken && !signal?.aborted) {
        explicitReasoning += parsed.reasoningToken;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!signal?.aborted) {
    if (!emittedRole) {
      emittedRole = true;
      yield roleChunk();
    }

    if (hasTools) {
      const parts = splitHuggingChatThinking(fullText);
      const reasoning = `${explicitReasoning}${parts.reasoning}`;
      const result = buildToolAwareResult(parts.content, requestedTools, "huggingchat");
      if (reasoning) yield chunk({ reasoning_content: reasoning });
      if (result.content) yield chunk({ content: result.content });
      if (result.toolCalls) {
        yield chunk({
          tool_calls: result.toolCalls.map((toolCall, index) => ({ index, ...toolCall })),
        });
      }
      yield chunk({}, result.finishReason);
    } else {
      for (const part of thinkSplitter.feed("", true)) {
        if (!part.text) continue;
        yield chunk(
          part.kind === "reasoning" ? { reasoning_content: part.text } : { content: part.text }
        );
      }
      yield chunk({}, "stop");
    }
    yield "data: [DONE]\n\n";
  }
}

export async function readJsonlResponse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseJsonlLine(trimmed);
        if (parsed.token) fullText += parsed.token;
        if (parsed.reasoningToken) fullText += `<think>${parsed.reasoningToken}</think>`;
        if (parsed.text) return parsed.text;
        if (parsed.error) throw new Error(parsed.error);
      }
    }

    if (buffer.trim()) {
      const parsed = parseJsonlLine(buffer.trim());
      if (parsed.text) return parsed.text;
      if (parsed.token) fullText += parsed.token;
      if (parsed.reasoningToken) fullText += `<think>${parsed.reasoningToken}</think>`;
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}
