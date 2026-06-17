import { describe, it, expect } from "vitest";
import { redact } from "@/lib/log";

describe("redact", () => {
  it("masks sensitive keys at the top level", () => {
    const out = redact({ user: "jo", password: "hunter2", apiKey: "sk_x" }) as Record<string, unknown>;
    expect(out.user).toBe("jo");
    expect(out.password).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
  });
  it("masks sensitive keys nested in objects and arrays", () => {
    const out = redact({ a: { authorization: "Bearer sk_x", ok: 1 }, list: [{ token: "t" }] }) as any;
    expect(out.a.authorization).toBe("[redacted]");
    expect(out.a.ok).toBe(1);
    expect(out.list[0].token).toBe("[redacted]");
  });
  it("is case-insensitive on key names", () => {
    const out = redact({ Authorization: "x", "set-cookie": "z" }) as Record<string, unknown>;
    expect(out.Authorization).toBe("[redacted]");
    expect(out["set-cookie"]).toBe("[redacted]");
  });
  it("passes through non-objects and tolerates cycles", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => redact(cyc)).not.toThrow();
  });
});
