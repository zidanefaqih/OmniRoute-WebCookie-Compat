import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie.ts";

describe("web-session agent compatibility isolation", () => {
  test("the base chat route contains no provider-specific web interception", () => {
    const source = readFileSync(
      new URL("../../src/app/api/v1/chat/completions/route.ts", import.meta.url),
      "utf8"
    );

    assert.doesNotMatch(source, /prepareToolMessages|buildWebToolConversationPrompt/);
    assert.doesNotMatch(source, /includes\(["']-web["']\)/);
    assert.doesNotMatch(source, /<tool_call>|MITM HACK/);
  });

  test("Qwen Web and OpenCode Free resolve to separate executor paths", () => {
    assert.ok(Object.hasOwn(WEB_COOKIE_PROVIDERS, "qwen-web"));
    assert.ok(!Object.hasOwn(WEB_COOKIE_PROVIDERS, "opencode"));
    assert.equal(REGISTRY["qwen-web"].executor, "qwen-web");
    assert.equal(REGISTRY.opencode.executor, "opencode");
  });
});
