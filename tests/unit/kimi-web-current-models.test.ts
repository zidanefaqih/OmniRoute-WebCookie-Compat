import assert from "node:assert/strict";
import test from "node:test";

const { PROVIDER_MODELS_CONFIG } =
  await import("../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");

test("Kimi Web discovery uses the current public POST contract", () => {
  const config = PROVIDER_MODELS_CONFIG["kimi-web"];
  assert.ok(config);
  assert.equal(config.method, "POST");
  assert.deepEqual(config.body, {});
  assert.equal(config.authHeader, undefined);
});

test("Kimi Web discovery keeps K3, K3 Swarm, and K2.6 Fast", () => {
  const config = PROVIDER_MODELS_CONFIG["kimi-web"];
  const models = config.parseResponse({
    availableModels: [
      {
        scenario: "SCENARIO_OK_COMPUTER",
        displayName: "K3 · Max",
        key: "k3",
      },
      {
        scenario: "SCENARIO_OK_COMPUTER",
        displayName: "K3 Swarm · Max",
        key: "k3-agent-ultra",
      },
      {
        scenario: "SCENARIO_K2D5",
        displayName: "K2.6 · Fast",
        key: "k2d6",
        reasoningEffortOptions: [
          { effort: "REASONING_EFFORT_NONE" },
          { effort: "REASONING_EFFORT_LOW" },
        ],
      },
    ],
  });

  assert.deepEqual(
    models.map((model: { id: string }) => model.id),
    ["k3", "k3-agent-ultra", "k2d6"]
  );
  assert.ok(models.every((model: { supportsReasoning?: boolean }) => model.supportsReasoning));
});

test("Kimi Web static registry exposes the live K3 model IDs", () => {
  const ids = new Set(REGISTRY["kimi-web"].models.map((model) => model.id));
  assert.ok(ids.has("k3"));
  assert.ok(ids.has("k3-agent-ultra"));
  assert.ok(ids.has("k2d6"));
  assert.ok(ids.has("k2d6-thinking"), "legacy virtual thinking ID remains compatible");
});
