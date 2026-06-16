import { LaunchOSApiError } from "./errors";
import type {
  ClientOptions, CreatePostInput, IdentifyInput, TouchpointInput, ConversionInput,
  CreateApiKeyInput, AttributionModel,
} from "./types";

export class LaunchOSClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new LaunchOSApiError(res.status, json.code ?? "error", json.detail ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  accounts = {
    list: () => this.req<{ data: unknown[] }>("GET", "/accounts"),
  };

  posts = {
    list: () => this.req<{ data: unknown[] }>("GET", "/posts"),
    create: (input: CreatePostInput) => this.req<{ post: { id: string; status: string } }>("POST", "/posts", input),
    retry: (publicId: string) => this.req<{ retried: number }>("POST", `/posts/${encodeURIComponent(publicId)}/retry`),
  };

  attribution = {
    identify: (input: IdentifyInput) => this.req<{ identity_id: string }>("POST", "/attribution/identify", input),
    touchpoint: (input: TouchpointInput) => this.req<{ touchpoint_id: number }>("POST", "/attribution/touchpoints", input),
    conversion: (input: ConversionInput) => this.req<{ conversion_id: number }>("POST", "/attribution/conversions", input),
    report: (model: AttributionModel) => this.req<unknown>("GET", `/attribution/report?model=${encodeURIComponent(model)}`),
  };

  journeys = {
    timeline: (contactId: string) => this.req<{ data: unknown[] }>("GET", `/journeys/contacts/${encodeURIComponent(contactId)}/timeline`),
  };

  apiKeys = {
    create: (input: CreateApiKeyInput) => this.req<{ id: string; key: string; key_prefix: string }>("POST", "/api-keys", input),
  };
}
