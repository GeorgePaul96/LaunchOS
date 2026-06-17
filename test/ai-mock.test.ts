import { describe, it, expect } from "vitest";
import { MockAIProvider } from "@/lib/ai/mock";

describe("MockAIProvider", () => {
  it("returns deterministic text + usage for a request", async () => {
    const p = new MockAIProvider();
    const req = { model: "claude-opus-4-8", messages: [{ role: "user" as const, content: "hello" }] };
    const a = await p.complete(req);
    const b = await p.complete(req);
    expect(a.text).toBe(b.text);
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.usage.outputTokens).toBeGreaterThan(0);
  });

  it("returns valid parseable JSON when a jsonSchema is given", async () => {
    const p = new MockAIProvider();
    const r = await p.complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "extract" }],
      jsonSchema: { type: "object", properties: { name: { type: "string" }, count: { type: "integer" } } },
    });
    const parsed = JSON.parse(r.text);
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("count");
    expect(typeof parsed.name).toBe("string");
    expect(typeof parsed.count).toBe("number");
  });

  it("fills arrays with shaped, non-empty items", async () => {
    const p = new MockAIProvider();
    const r = await p.complete({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "gen" }],
      jsonSchema: {
        type: "object",
        properties: {
          variants: {
            type: "array",
            items: {
              type: "object",
              properties: { body: { type: "string" }, predictedScore: { type: "integer" }, rationale: { type: "string" } },
            },
          },
        },
      },
    });
    const parsed = JSON.parse(r.text);
    expect(Array.isArray(parsed.variants)).toBe(true);
    expect(parsed.variants.length).toBeGreaterThan(0);
    expect(typeof parsed.variants[0].body).toBe("string");
    expect(parsed.variants[0].body.length).toBeGreaterThan(0);
    expect(typeof parsed.variants[0].predictedScore).toBe("number");
  });
});
