# Web-Session Native Agent Compatibility

## Status

Qwen Web and Kimi Web milestones are implemented on `codex/web-cookie-native-compat`; remaining
providers follow the provider-by-provider rollout below.

## Problem

OmniRoute exposes consumer web-session providers through the same OpenAI-compatible API used by
coding agents. Several executors can turn textual tool syntax into `tool_calls`, but support is not
consistent across providers or across turns. In particular, Qwen Web currently folds a request into
system text plus the latest user message. That loses the assistant tool call, its call ID, and the
following tool result before the next upstream request.

The observable failure is an agent that can issue an initial `Read`, `Write`, or `Bash` call but then
repeats work, returns an empty turn, or stops after the client sends the tool result.

## Product Goal

Make supported web-session providers behave like native OpenAI-compatible agent backends from the
client's perspective:

1. The client sends its own dynamic `tools[]` definitions.
2. OmniRoute translates those definitions and the complete agent trajectory for the selected web
   provider.
3. OmniRoute returns standard `tool_calls`, `reasoning_content`, and finish reasons.
4. The client executes its own tools and sends the result back.
5. The web model continues from that result without losing or duplicating completed work.

## Scope

### In scope

- Providers registered in `src/shared/constants/providers/web-cookie.ts`.
- OpenAI Chat Completions requests, streaming and non-streaming.
- Dynamic client tools; no OpenCode-specific tool-name allowlist.
- Multi-turn tool history, multiple calls, native web reasoning, aborts, and malformed textual calls.
- OpenCode and MiMoCode as live compatibility clients.
- Provider-specific adapters built on shared parsing and conversation helpers.

### Out of scope

- Changing OpenCode, MiMoCode, or another client application's source.
- Executing filesystem or terminal tools inside OmniRoute.
- Applying the bridge to API-key, OAuth, CLI, or ordinary OpenAI-compatible providers.
- Guaranteeing cookie lifetime, upstream availability, CAPTCHA avoidance, or parity with an official
  paid API's service level.
- Forcing a model to reveal private chain-of-thought. Only provider-native reasoning fields or safe
  summaries may be surfaced.

## Isolation Requirement

Compatibility behavior must be selected after routing resolves the actual provider target. Model
name substring checks such as `model.includes("-web")` are not an acceptable provider classifier.

- A Qwen Web target receives the Qwen Web adapter.
- A fallback from Qwen Web to OpenCode Free uses the ordinary OpenCode executor unchanged.
- A combo may contain both kinds of target; each target follows its own executor path.
- Requests without tools retain their existing provider behavior.

## Functional Requirements

### FR1: Preserve client tool contracts

- Forward the exact names, descriptions, and JSON schemas supplied in `tools[]` using the selected
  provider's native protocol when one exists.
- Return only names that resolve to a requested client tool.
- Keep `function.arguments` as a valid JSON string.
- Preserve unique call IDs across assistant-call and tool-result history.

### FR2: Preserve the complete agent trajectory

The prompt sent to a single-turn web UI must represent, in order:

- system instructions;
- user messages;
- assistant text;
- assistant tool calls;
- tool results linked to their call IDs; and
- an instruction to continue instead of repeating successful calls.

### FR3: Normalize responses

- A parsed call ends with `finish_reason: "tool_calls"`.
- A final answer ends with `finish_reason: "stop"`.
- Streaming calls include stable IDs and distinct tool-call indexes.
- Native reasoning is emitted as `reasoning_content` without leaking into visible answer content.
- SSE terminates exactly once with `data: [DONE]`.

### FR4: Safe recovery

- Never retry after a tool call has been delivered to a client unless idempotency can be proven.
- Never execute a tool in OmniRoute.
- Preserve abort propagation to the upstream request.
- Invalid upstream output must produce a sanitized error or visible final text, not silent data loss.

## Acceptance Criteria

- Qwen Web can complete `Read -> tool result -> final explanation` in OpenCode.
- Qwen Web can complete `Read -> Write/Edit -> final explanation` without repeating successful calls.
- The same configured Qwen Web model completes the equivalent flow in MiMoCode.
- Two requested tool calls are returned with indexes `0` and `1`.
- A tool result remains associated with the original call ID in the next upstream prompt.
- Provider-native Qwen reasoning appears as `reasoning_content` during a tool-enabled stream.
- One stable OpenCode/MiMoCode conversation reuses one Qwen `chat_id` across ordinary and tool
  turns, while different accounts and client sessions remain isolated.
- A reused Qwen turn sends only new user/tool-result information and the prior Qwen response ID;
  it does not replay the complete OpenAI history into the same upstream chat.
- OmniRoute exposes virtual Fast/Auto/Thinking model IDs for Qwen Plus and Fast/Thinking IDs for
  Qwen Max; each reaches Qwen's corresponding web feature configuration from any compatible client.
- Kimi Web discovers and exposes the live `k3`, `k3-agent-ultra`, and `k2d6` model IDs, while
  retaining the legacy `k2d6-thinking` alias.
- Kimi K3 can complete a caller-tool request and consume its linked result through the shared
  OpenAI-compatible contract.
- A non-web provider request does not receive a web-session prompt or response transform.
- Existing DeepSeek Web tool tests continue to pass.
- Formatting, lint, type checks, and targeted unit/integration tests pass.

## Rollout

1. Correct and verify Qwen Web.
2. Extract only proven reusable behavior into shared helpers.
3. Audit DeepSeek Web against the shared contract without regressing its specialized parser.
4. Add Kimi Web after capturing its Connect-RPC model and agent contracts in fixtures. Completed
   for K3 caller-tool translation; K3 Swarm remains payload-tested but is not invoked in live smoke
   tests because it can fan out into multiple paid agents.
5. Migrate remaining web-session executors provider by provider; do not enable a global transform.
