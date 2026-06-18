import { describe, it, expect } from "vitest";
import { GET, PIXEL_SCRIPT } from "@/app/pixel.js/route";

describe("pixel.js", () => {
  it("serves JavaScript with the expected client surface", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("/api/v1/collect");
    expect(body).toContain("data-write-key");
    expect(body).toContain("navigator.sendBeacon");
    expect(body).toContain("track");
    expect(body).toContain("identify");
    expect(body).toContain("form_submit");
  });

  it("PIXEL_SCRIPT is the served body", async () => {
    const res = await GET();
    expect(await res.text()).toBe(PIXEL_SCRIPT);
  });
});
