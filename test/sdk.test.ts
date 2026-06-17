import { describe, it, expect } from "vitest";
import { LaunchOSClient } from "@/lib/sdk/client";
import { LaunchOSApiError } from "@/lib/sdk/errors";

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("LaunchOSClient", () => {
  it("sends the Bearer header and parses JSON", async () => {
    const { fn, calls } = stubFetch(200, { data: [{ id: "acc_1" }] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    const res = await client.accounts.list();
    expect(res).toEqual({ data: [{ id: "acc_1" }] });
    expect(calls[0].url).toBe("http://x/api/v1/accounts");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");
  });

  it("POSTs a body for create", async () => {
    const { fn, calls } = stubFetch(202, { post: { id: "post_1", status: "scheduled" } });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.posts.create({ profileId: "p", content: "hi", accountIds: ["a"] });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ profileId: "p", accountIds: ["a"] });
  });

  it("builds the report query string", async () => {
    const { fn, calls } = stubFetch(200, { model: "linear", channels: [] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.attribution.report("linear");
    expect(calls[0].url).toBe("http://x/api/v1/attribution/report?model=linear");
  });

  it("posts content.generate with the body", async () => {
    const { fn, calls } = stubFetch(201, { generation: { id: "gen_1" }, variants: [] });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.content.generate({ profileId: "p", intent: "hook", prompt: "hi" });
    expect(calls[0].url).toBe("http://x/api/v1/content/generate");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ profileId: "p", intent: "hook", prompt: "hi" });
  });

  it("posts content.choose to the variant path", async () => {
    const { fn, calls } = stubFetch(200, { variant: { id: "var_1", chosen: true } });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_test", fetch: fn });
    await client.content.choose("var_1");
    expect(calls[0].url).toBe("http://x/api/v1/content/variants/var_1/choose");
    expect(calls[0].init.method).toBe("POST");
  });

  it("throws LaunchOSApiError on non-2xx problem+json", async () => {
    const { fn } = stubFetch(401, { code: "unauthorized", detail: "Invalid API key" });
    const client = new LaunchOSClient({ baseUrl: "http://x", apiKey: "sk_bad", fetch: fn });
    await expect(client.accounts.list()).rejects.toBeInstanceOf(LaunchOSApiError);
    await expect(client.accounts.list()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});
