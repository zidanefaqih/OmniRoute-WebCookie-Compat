import type { RegistryEntry } from "../../../shared.ts";

export const kimi_webProvider: RegistryEntry = {
  id: "kimi-web",
  // Distinct alias: the primary "kimi" provider (dedicated KimiExecutor) keeps
  // the short "kimi" alias; this web/cookie variant is addressed by its own id.
  alias: "kimi-web",
  format: "openai",
  executor: "kimi-web",
  // International consumer chat — the legacy `kimi.moonshot.cn` domain now
  // redirects every non-CN visitor to www.kimi.com, which speaks a different
  // Connect-RPC API. See `open-sse/executors/kimi-web.ts` for the wire format.
  baseUrl: "https://www.kimi.com",
  authType: "apikey",
  authHeader: "cookie",
  models: [
    // IDs and labels are the live `key` / `displayName` fields returned by
    // GetAvailableModels. K3 uses SCENARIO_OK_COMPUTER; Swarm additionally
    // enables Kimi's PARALLEL_AGENT_V2 tool in the executor.
    { id: "k3", name: "K3 · Max", supportsReasoning: true },
    { id: "k3-agent-ultra", name: "K3 Swarm · Max", supportsReasoning: true },
    { id: "k2d6", name: "K2.6 · Fast" },
    // Backward-compatible virtual mode retained for plain chat clients. The
    // executor rejects caller tools because this legacy mode fabricates tool
    // execution instead of reliably returning the external-action handoff.
    {
      id: "k2d6-thinking",
      name: "K2.6 Thinking Legacy · Chat only",
      supportsReasoning: true,
    },
  ],
};
