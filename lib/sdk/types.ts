export interface CreatePostInput {
  profileId: string;
  content?: string;
  accountIds: string[];
  scheduledFor?: string | null;
  campaignId?: string | null;
}
export interface IdentifyInput { anonymousId: string; contactId?: string; externalUserId?: string }
export interface TouchpointInput { identityId: string; channel: string; platform?: string; sourceType?: string; sourceId?: string; campaignId?: string }
export interface ConversionInput { identityId: string; eventName: string; valueCents?: number; currency?: string }
export interface CreateApiKeyInput { name: string; scopes?: string[] }
export type AttributionModel = "first_touch" | "last_touch" | "linear";
export type ContentIntent = "hook" | "thread" | "reel_script" | "carousel" | "repurpose";
export interface GenerateContentInput {
  profileId: string;
  intent: ContentIntent;
  prompt: string;
  sourceRef?: string;
  count?: number;
}

export interface ClientOptions {
  baseUrl?: string;            // origin, e.g. http://localhost:3000
  apiKey: string;
  fetch?: typeof fetch;        // injectable for tests
}
