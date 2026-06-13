import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession } from "@/lib/auth";

describe("auth", () => {
  it("hash + verify round-trips", async () => {
    const h = await hashPassword("hunter2");
    expect(h).not.toBe("hunter2");
    expect(await verifyPassword("hunter2", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("signs and verifies a session token", () => {
    const token = signSession({ userId: "u1", orgId: "o1" }, "secret");
    const payload = verifySession(token, "secret");
    expect(payload).toMatchObject({ userId: "u1", orgId: "o1" });
  });

  it("rejects a tampered token", () => {
    const token = signSession({ userId: "u1", orgId: "o1" }, "secret");
    expect(verifySession(token + "x", "secret")).toBeNull();
    expect(verifySession(token, "other-secret")).toBeNull();
  });
});
