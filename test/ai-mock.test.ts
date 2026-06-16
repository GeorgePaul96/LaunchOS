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
});
