import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession, sessionSecret } from "@/lib/auth";

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

  it("signSession stamps an exp and verifySession rejects expired tokens", () => {
    const fresh = signSession({ userId: "u1", orgId: "o1" }, "secret", 3600);
    expect(verifySession(fresh, "secret")).toMatchObject({ userId: "u1", orgId: "o1" });
    const expired = signSession({ userId: "u1", orgId: "o1" }, "secret", -1);
    expect(verifySession(expired, "secret")).toBeNull();
  });

  it("sessionSecret throws in production without SESSION_SECRET, falls back otherwise", () => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.SESSION_SECRET;
    try {
      delete process.env.SESSION_SECRET;
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(() => sessionSecret()).toThrow();
      (process.env as Record<string, string>).NODE_ENV = "development";
      expect(sessionSecret()).toBe("dev-only-secret-change-me");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = origEnv ?? "test";
      if (origSecret !== undefined) process.env.SESSION_SECRET = origSecret;
    }
  });
});
