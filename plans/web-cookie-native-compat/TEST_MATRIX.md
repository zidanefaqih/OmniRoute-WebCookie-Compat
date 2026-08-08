# Acceptance Test Matrix

| Area           | Scenario                                        | Expected result                                        |
| -------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Isolation      | OpenCode Free request with tools                | No web-session serialization or transform              |
| Isolation      | Combo falls back from Qwen Web to OpenCode Free | Each target uses only its executor behavior            |
| Qwen request   | First tool-enabled turn                         | Dynamic schemas reach `feature_config.local_mcp`       |
| Qwen request   | Assistant call plus matching tool result        | Both are present and linked in the next prompt         |
| Qwen request   | Successful prior call                           | Continuation guard prevents intentional replay         |
| Qwen response  | Plain final answer                              | Visible content with `finish_reason: stop`             |
| Qwen response  | One native `local_tool` call                    | Canonical call with `finish_reason: tool_calls`        |
| Qwen response  | Two native `local_tool` calls                   | Two unique IDs and stream indexes 0/1                  |
| Qwen response  | Partial event before final call                 | No empty-argument call reaches the client              |
| Qwen response  | Native thinking plus tool call                  | Reasoning delta precedes canonical tool-call delta     |
| Qwen session   | Same client session, normal follow-up           | Reuse chat/parent IDs and send only the new user turn  |
| Qwen session   | Streaming tool call followed by tool result     | Continue the same chat without replaying the call      |
| Qwen session   | Different client session or provider account    | Create isolated Qwen chats                             |
| Qwen session   | Missing/stale parent response ID                | Safely create or retry with a fresh Qwen chat          |
| Qwen Plus      | Virtual Fast / Auto / Thinking IDs              | Same upstream model with the selected Qwen mode        |
| Qwen Max       | Virtual Fast / Thinking IDs                     | Same upstream model with the selected Qwen mode        |
| Kimi discovery | Public available-models POST                    | K3, K3 Swarm, and K2.6 Fast are retained               |
| Kimi request   | K3 caller action required                       | Neutral action text becomes an OpenAI tool call        |
| Kimi follow-up | Linked result follows a K3 action               | Final answer uses result without repeating the action  |
| Kimi stream    | K3 emits a neutral external action              | Canonical SSE tool call followed by one `[DONE]`       |
| Kimi isolation | K3 request has no caller tools                  | Existing Kimi consumer-web behavior remains active     |
| Parser         | Tag split across upstream chunks                | Complete call is parsed after collection               |
| Parser         | Loose JSON and trailing comma                   | Arguments normalize to valid JSON when recoverable     |
| Parser         | Unknown invented tool name                      | Call is rejected as a tool and retained as text        |
| Lifecycle      | Client abort                                    | Upstream reader stops without a synthetic success      |
| Regression     | DeepSeek Web variants                           | Existing specialized parser suites pass                |
| Live client    | OpenCode Read -> result -> answer               | Agent completes without interruption or duplicate Read |
| Live client    | MiMoCode Read -> result -> answer               | Agent completes through custom OpenAI provider         |
