import { describe, it, expect } from "vitest";
import { backoffMs } from "@/lib/jobs/backoff";

describe("backoffMs", () => {
  it("first attempt is the base delay", () => {
    expect(backoffMs(1, 1000, 60000)).toBe(1000);
  });
  it("doubles each attempt", () => {
    expect(backoffMs(2, 1000, 60000)).toBe(2000);
    expect(backoffMs(3, 1000, 60000)).toBe(4000);
    expect(backoffMs(4, 1000, 60000)).toBe(8000);
  });
  it("caps at max", () => {
    expect(backoffMs(20, 1000, 60000)).toBe(60000);
  });
  it("uses defaults", () => {
    expect(backoffMs(1)).toBe(1000);
  });
});
