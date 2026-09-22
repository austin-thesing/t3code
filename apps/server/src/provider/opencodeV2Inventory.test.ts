import { describe, expect, it } from "vite-plus/test";

import { createOpenCodeV2Client } from "./opencodeV2Client.ts";
import { toOpenCodeV1Model } from "./opencodeV2Events.ts";

const model = {
  id: "chat",
  modelID: "upstream-chat",
  providerID: "fixture",
  name: "Fixture Chat",
  enabled: true,
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
  limit: { context: 32000, output: 4000 },
};

describe("OpenCode v2 inventory projection", () => {
  it("preserves named variants, multimodal capabilities, and numeric costs", () => {
    const projected = toOpenCodeV1Model(model);
    expect(Object.keys(projected?.variants ?? {})).toEqual(["high"]);
    expect(projected?.capabilities.input.image).toBe(true);
    expect(projected?.capabilities.output.image).toBe(false);
    expect(projected?.capabilities.toolcall).toBe(true);
    expect(projected?.cost).toEqual(model.cost[0]);
    expect(projected?.api.id).toBe("upstream-chat");
  });

  it("builds the legacy provider catalog consumed by the settings and composer", async () => {
    const client = createOpenCodeV2Client({
      baseUrl: "http://opencode.test",
      directory: "/workspace",
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          return Response.json({
            location: { directory: "/workspace" },
            data:
              url.pathname === "/api/provider"
                ? [{ id: "fixture", name: "Fixture", activation: "enabled", package: "test" }]
                : [model],
          });
        },
        { preconnect: () => undefined },
      ),
    });
    const result = await client.provider.list();
    expect(result.data?.connected).toEqual(["fixture"]);
    expect(result.data?.all[0]?.models.chat?.variants).toEqual({
      high: { reasoningEffort: "high" },
    });
    expect(Object.values(result.data?.all[0]?.models ?? {}).map((entry) => entry.name)).toEqual([
      "Fixture Chat",
    ]);
  });
});
