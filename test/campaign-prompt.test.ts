import { describe, it, expect } from "vitest";
import { buildPlanPrompt, PLAN_SCHEMA } from "@/lib/campaign/prompt";

describe("campaign prompt", () => {
  it("includes objective, brand voice, and channel platforms", () => {
    const { system, messages } = buildPlanPrompt({
      objective: "drive beta signups",
      goalMetric: "signups", goalTarget: 500, budgetCents: 100000,
      channels: [{ accountId: "a1", platform: "twitter" }, { accountId: "a2", platform: "linkedin" }],
      brandVoice: { tone: "punchy-xyz", bannedWords: ["synergy"] },
      horizonDays: 14,
    });
    expect(system).toContain("punchy-xyz");
    expect(system).toContain("twitter");
    expect(system).toContain("linkedin");
    expect(messages[0].content).toContain("drive beta signups");
    expect(messages[0].content).toContain("14");
  });

  it("throws 400 when there are no channels", () => {
    expect(() => buildPlanPrompt({
      objective: "x", channels: [], brandVoice: {}, horizonDays: 7,
    })).toThrow();
  });

  it("PLAN_SCHEMA requires an assets array of objects", () => {
    expect((PLAN_SCHEMA as any).properties.assets.type).toBe("array");
    expect((PLAN_SCHEMA as any).required).toContain("assets");
  });
});
