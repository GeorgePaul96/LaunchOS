import { createHash } from "node:crypto";
import type { ChannelProvider, PublishInput, PublishResult } from "./provider";

export class MockChannelProvider implements ChannelProvider {
  readonly name = "mock";
  private failAccounts: Set<string>;

  constructor(opts: { failAccounts?: string[] } = {}) {
    this.failAccounts = new Set(opts.failAccounts ?? []);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (this.failAccounts.has(input.accountPlatformUserId)) {
      return { ok: false, errorCode: "provider_rejected", errorDetail: "Mock provider rejected this account" };
    }
    const hash = createHash("sha256")
      .update(`${input.platform}:${input.accountPlatformUserId}`)
      .digest("hex")
      .slice(0, 16);
    const platformPostId = `${input.platform}_${hash}`;
    return {
      ok: true,
      platformPostId,
      permalink: `https://mock.local/${input.platform}/${platformPostId}`,
    };
  }
}
