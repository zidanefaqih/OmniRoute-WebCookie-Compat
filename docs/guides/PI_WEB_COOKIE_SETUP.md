# Web-Cookie Providers for Coding Agents (pi / OpenCode)

This fork adds tool-loop compatibility for web-session providers (Qwen Web,
Kimi Web, HuggingChat, ZenMux Free) so agentic coding CLIs can use them with
real tool calling, session continuity, and low-maintenance cookies.

Verified with **pi** (`@earendil-works/pi-coding-agent`) and OpenCode.

## What this adds

| Feature | Description |
|---|---|
| **Session continuity** | One upstream web chat per client session via `x-session-id` — no more "new chat per prompt" clutter in your Qwen/Kimi history |
| **SPA-mirror headers** | Qwen v2 requests mirror the real web app (sec-ch-ua, Sec-Fetch-*, Version, Timezone) so Alibaba's baxia WAF accepts them |
| **Self-refreshing cookies** | Volatile anti-bot cookies (`x5sec`, `acw_tc`, `ssxmod_itna*`) are merged from `Set-Cookie` responses and persisted (rate-limited) — long-lived cookies (`cna`/`token`) are never touched |
| **Virtual model modes** | `qwen3.8-max-fast`, `qwen3.8-max-thinking`, `qwen3.8-max-auto`, plus 3.7 equivalents — pick Fast/Thinking/Auto explicitly |
| **Isolation** | Web-cookie interception stays inside the web-cookie executors; providers like OpenCode Free / Kiro are never affected |

## Setup

### 1. Build & run OmniRoute

```bash
npm install
OMNIROUTE_USE_TURBOPACK=0 npm run build   # webpack escape hatch (Turbopack build is unreliable on this fork)
PORT=20128 node .build/next/standalone/server.js
```

### 2. Add a Qwen Web account

1. Open `https://chat.qwen.ai` in your browser and sign in.
2. Open DevTools → Network → send a chat message → find any request to
   `chat.qwen.ai` → **Copy as cURL** → copy the full `Cookie:` value.
   (Must include `cna`, `ssxmod_itna`, `token`; `x5sec` is optional — a fresh
   jar plus the SPA headers is enough.)
3. In the OmniRoute dashboard → **Providers → qwen-web** → paste the cookie
   header into the credential field → **Check connection**.

### 3. Configure pi

Add the `omniroute` provider to `~/.pi/agent/models.json` (see
`examples/pi-web-cookie-models.json` in this repo):

```json
{
  "providers": {
    "omniroute": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",                    // any OmniRoute API key
      "headers": { "x-session-id": "pi-main" },  // ← session continuity
      "models": [
        { "id": "qwen-web/qwen3.8-max-thinking", "name": "Qwen3.8 Max Thinking (Web)", "reasoning": true, "input": ["text"], "contextWindow": 1000000, "maxTokens": 65536 },
        { "id": "qwen-web/qwen3.8-max-fast", "name": "Qwen3.8 Max Fast (Web)", "reasoning": false, "input": ["text"], "contextWindow": 1000000, "maxTokens": 65536 },
        { "id": "qwen-web/qwen3.7-plus-auto", "name": "Qwen3.7 Plus Auto (Web)", "reasoning": true, "input": ["text"], "contextWindow": 128000, "maxTokens": 16384 }
      ]
    }
  }
}
```

Then:

```bash
pi --provider omniroute --model qwen-web/qwen3.8-max-thinking "halo"
```

> **Tip:** use `-thinking` or `-auto` for agentic tool loops. `-fast` replies
> faster but can return empty follow-ups after tool calls.

## Cookie maintenance

During active use the executor auto-refreshes the short-lived anti-bot cookies
from upstream `Set-Cookie` responses — nothing to do. Long-lived cookies
(`cna`, `aui`, `token`) last 30–180 days.

If a machine was off long enough for the cookies to expire, the first request
may be rejected. Fix: re-capture the cookie header from the browser (same as
step 2) and paste it again in the dashboard.

## Notes

- Web-cookie providers are tied to your own account sessions — every user needs
  their own cookie. Treat the cookie like a password.
- HuggingChat and ZenMux Free are included in this branch but were last live-
  verified before 2026-08-08; re-test per account.
- OpenCode HA (multi-fingerprint account pool) lives in a separate commit and
  is not part of this branch.
