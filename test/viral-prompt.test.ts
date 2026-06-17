import { describe, it, expect } from "vitest";
import { buildPrompt, VARIANT_SCHEMA, type Intent } from "@/lib/viral/prompt";

describe("buildPrompt", () => {
  it("injects brand voice fields into the system prompt", () => {
    const { system } = buildPrompt({
      intent: "hook",
      prompt: "launch our new pricing",
      brandVoice: { tone: "punchy", bannedWords: ["synergy"], audience: "founders" },
      count: 3,
    });
    expect(system).toContain("punchy");
    expect(system).toContain("synergy");
    expect(system).toContain("founders");
  });

  it("includes an intent-specific instruction", () => {
    const a = buildPrompt({ intent: "thread", prompt: "x", brandVoice: {}, count: 3 });
    const b = buildPrompt({ intent: "reel_script", prompt: "x", brandVoice: {}, count: 3 });
    expect(a.system).not.toBe(b.system);
    expect(a.system.toLowerCase()).toContain("thread");
    expect(b.system.toLowerCase()).toContain("reel");
  });

  it("puts the brief and requested count in the user message", () => {
    const { messages } = buildPrompt({ intent: "hook", prompt: "launch day", brandVoice: {}, count: 5 });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("launch day");
    expect(messages[0].content).toContain("5");
  });

  it("includes sourceRef for repurpose", () => {
    const { messages } = buildPrompt({ intent: "repurpose", prompt: "make it shorter", brandVoice: {}, count: 2, sourceRef: "ORIGINAL BLOG TEXT" });
    expect(messages[0].content).toContain("ORIGINAL BLOG TEXT");
  });

  it("exposes a variants json schema with body/predictedScore/rationale", () => {
    const items = (VARIANT_SCHEMA.properties as any).variants.items.properties;
    expect(items).toHaveProperty("body");
    expect(items).toHaveProperty("predictedScore");
    expect(items).toHaveProperty("rationale");
  });

  it("rejects an unknown intent", () => {
    expect(() => buildPrompt({ intent: "haiku" as Intent, prompt: "x", brandVoice: {}, count: 1 })).toThrow();
  });
});
