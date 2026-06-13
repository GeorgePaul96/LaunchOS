import { describe, it, expect } from "vitest";
import { uuid, publicId } from "@/lib/ids";

describe("ids", () => {
  it("uuid returns a v4 uuid", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("uuid values are unique", () => {
    expect(uuid()).not.toBe(uuid());
  });
  it("publicId prefixes and strips dashes", () => {
    const id = publicId("post");
    expect(id.startsWith("post_")).toBe(true);
    expect(id.includes("-")).toBe(false);
    expect(id.length).toBeGreaterThan(20);
  });
});
