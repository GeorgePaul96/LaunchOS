import { describe, it, expect } from "vitest";
import { allocate, type Touch } from "@/lib/attribution/models";

const touches: Touch[] = [
  { touchpointId: 1, channel: "organic_social", occurredAt: "2026-06-01T00:00:00Z" },
  { touchpointId: 2, channel: "paid_social", occurredAt: "2026-06-02T00:00:00Z" },
  { touchpointId: 3, channel: "email", occurredAt: "2026-06-03T00:00:00Z" },
];

describe("attribution models", () => {
  it("first_touch gives all credit to the earliest", () => {
    const a = allocate("first_touch", touches, 1000);
    expect(a).toEqual([{ touchpointId: 1, credit: 1, creditedValueCents: 1000 }]);
  });

  it("last_touch gives all credit to the latest", () => {
    const a = allocate("last_touch", touches, 1000);
    expect(a).toEqual([{ touchpointId: 3, credit: 1, creditedValueCents: 1000 }]);
  });

  it("linear splits credit evenly and conserves total value", () => {
    const a = allocate("linear", touches, 1000);
    expect(a).toHaveLength(3);
    expect(a.reduce((s, x) => s + x.credit, 0)).toBeCloseTo(1, 9);
    expect(a.reduce((s, x) => s + x.creditedValueCents, 0)).toBe(1000);
  });

  it("handles a single touch", () => {
    const a = allocate("linear", [touches[0]], 500);
    expect(a).toEqual([{ touchpointId: 1, credit: 1, creditedValueCents: 500 }]);
  });

  it("returns empty for no touches", () => {
    expect(allocate("first_touch", [], 1000)).toEqual([]);
  });

  it("linear remainder cents go to the last touch (conservation)", () => {
    // 1000 / 3 = 333.33 -> 333,333,334
    const a = allocate("linear", touches, 1000);
    const cents = a.map(x => x.creditedValueCents);
    expect(cents).toEqual([333, 333, 334]);
  });
});
