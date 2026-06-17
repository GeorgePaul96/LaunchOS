import { ApiError } from "@/lib/errors";

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export interface RateResult { allowed: boolean; remaining: number; resetAt: number }

// In-memory fixed-window limiter. `now` is injectable for testing.
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}

export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  const r = rateLimit(key, limit, windowMs);
  if (!r.allowed) {
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", `Too many requests; retry in ${retryAfter}s`, {
      "Retry-After": String(retryAfter),
    });
  }
}

// Test helper.
export function __resetRateLimits(): void {
  buckets.clear();
}
