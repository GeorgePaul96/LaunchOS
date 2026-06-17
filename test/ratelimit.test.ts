import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, assertRateLimit, __resetRateLimits } from "@/lib/ratelimit";
import { ApiError } from "@/lib/errors";

beforeEach(() => __resetRateLimits());

describe("rate limit", () => {
  it("allows up to the limit then blocks", () => {
    const t = 1000;
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(true);
    expect(rateLimit("k", 3, 60000, t).allowed).toBe(false);
  });
  it("resets after the window", () => {
    expect(rateLimit("k", 1, 1000, 1000).allowed).toBe(true);
    expect(rateLimit("k", 1, 1000, 1000).allowed).toBe(false);
    expect(rateLimit("k", 1, 1000, 2000).allowed).toBe(true); // new window
  });
  it("keys are independent", () => {
    expect(rateLimit("a", 1, 1000, 1000).allowed).toBe(true);
    expect(rateLimit("b", 1, 1000, 1000).allowed).toBe(true);
  });
  it("assertRateLimit throws a 429 ApiError past the limit", () => {
    assertRateLimit("z", 1, 60000);
    let err: unknown;
    try { assertRateLimit("z", 1, 60000); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).headers?.["Retry-After"]).toBeTruthy();
  });
});
