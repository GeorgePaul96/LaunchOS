// The single seam between "what to post" and "how each platform wants it" (spec §5).
// V1 wraps a provider (Zernio/Ayrshare/Unipile); this slice ships a MockChannelProvider.
export interface PublishInput {
  platform: string;
  accountPlatformUserId: string;
  content: string;
  options?: Record<string, unknown>;
}

export interface PublishResult {
  ok: boolean;
  platformPostId?: string;
  permalink?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface ChannelProvider {
  readonly name: string;
  publish(input: PublishInput): Promise<PublishResult>;
}
