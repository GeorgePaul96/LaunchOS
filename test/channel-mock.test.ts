import { describe, it, expect } from "vitest";
import { MockChannelProvider } from "@/lib/channel/mock";

describe("MockChannelProvider", () => {
  it("publishes successfully with a platform id + permalink", async () => {
    const p = new MockChannelProvider();
    const r = await p.publish({ platform: "twitter", accountPlatformUserId: "u1", content: "hi" });
    expect(r.ok).toBe(true);
    expect(r.platformPostId).toMatch(/^twitter_/);
    expect(r.permalink).toContain("twitter");
  });

  it("forces failure for accounts in the fail set", async () => {
    const p = new MockChannelProvider({ failAccounts: ["badacc"] });
    const r = await p.publish({ platform: "x", accountPlatformUserId: "badacc", content: "hi" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("provider_rejected");
  });

  it("is deterministic for a given account id", async () => {
    const p = new MockChannelProvider();
    const r1 = await p.publish({ platform: "li", accountPlatformUserId: "u9", content: "a" });
    const r2 = await p.publish({ platform: "li", accountPlatformUserId: "u9", content: "b" });
    expect(r1.platformPostId).toBe(r2.platformPostId);
  });
});
