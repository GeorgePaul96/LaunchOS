import { describe, it, expect } from "vitest";
import { route } from "@/lib/ai/router";

describe("router", () => {
  it("routes plan to opus with high effort + adaptive thinking", () => {
    expect(route("plan")).toEqual({ model: "claude-opus-4-8", effort: "high", thinking: true });
  });
  it("routes generate to opus, medium, no thinking", () => {
    expect(route("generate")).toEqual({ model: "claude-opus-4-8", effort: "medium", thinking: false });
  });
  it("routes classify to haiku with no effort (haiku rejects effort)", () => {
    expect(route("classify")).toEqual({ model: "claude-haiku-4-5", thinking: false });
  });
  it("falls back to a safe default for unknown tasks", () => {
    expect(route("something-new")).toEqual({ model: "claude-opus-4-8", effort: "medium", thinking: false });
  });
});
