import { describe, it, expect } from "vitest";
import { costCents, PRICING } from "@/lib/ai/pricing";

describe("pricing", () => {
  it("prices opus-4-8 input+output", () => {
    // 1M input @ 500c + 1M output @ 2500c = 3000c
    expect(costCents("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3000);
  });
  it("rounds up to the next cent", () => {
    expect(costCents("claude-opus-4-8", { inputTokens: 1000, outputTokens: 0 })).toBe(1); // 0.5c -> 1
  });
  it("has a 1-cent minimum so every call is metered", () => {
    expect(costCents("claude-haiku-4-5", { inputTokens: 1, outputTokens: 1 })).toBe(1);
  });
  it("throws on an unknown model", () => {
    expect(() => costCents("gpt-foo", { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
  it("has pricing for the routed models", () => {
    expect(PRICING["claude-opus-4-8"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5"]).toBeDefined();
  });
});
