// Hand-authored OpenAPI 3.1 contract for the /v1 API. Source of truth for SDK consumers.
const problem = {
  type: "object",
  properties: {
    type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
    detail: { type: "string" }, code: { type: "string" }, request_id: { type: "string" },
  },
};

function jsonBody(props: Record<string, unknown>, required: string[]) {
  return { required: true, content: { "application/json": { schema: { type: "object", properties: props, required } } } };
}
function resp(ok = 200) {
  return {
    [String(ok)]: { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
    "4XX": { description: "Error", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
  };
}
function pathParam(name: string) {
  return { name, in: "path", required: true, schema: { type: "string" } };
}
function queryParam(name: string) {
  return { name, in: "query", required: false, schema: { type: "string" } };
}

export const openapiSpec = {
  openapi: "3.1.0",
  info: { title: "LaunchOS API", version: "0.1.0", description: "Compose, publish, and attribute." },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "sk_*" } },
    schemas: { Problem: problem },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/accounts": { get: { summary: "List connected accounts", responses: resp() } },
    "/posts": {
      get: { summary: "List posts", responses: resp() },
      post: {
        summary: "Create + queue a post",
        requestBody: jsonBody({
          profileId: { type: "string" }, content: { type: "string" },
          accountIds: { type: "array", items: { type: "string" } },
        }, ["profileId", "accountIds"]),
        responses: resp(202),
      },
    },
    "/posts/{id}/retry": { post: { summary: "Retry failed targets", parameters: [pathParam("id")], responses: resp() } },
    "/attribution/identify": { post: { summary: "Identify / stitch", requestBody: jsonBody({ anonymousId: { type: "string" }, contactId: { type: "string" } }, ["anonymousId"]), responses: resp() } },
    "/attribution/touchpoints": { post: { summary: "Record a touchpoint", requestBody: jsonBody({ identityId: { type: "string" }, channel: { type: "string" } }, ["identityId", "channel"]), responses: resp(201) } },
    "/attribution/conversions": { post: { summary: "Record a conversion", requestBody: jsonBody({ identityId: { type: "string" }, eventName: { type: "string" }, valueCents: { type: "integer" } }, ["identityId", "eventName"]), responses: resp(201) } },
    "/attribution/report": { get: { summary: "Attribution report", parameters: [queryParam("model")], responses: resp() } },
    "/journeys/contacts/{cid}/timeline": { get: { summary: "Contact journey", parameters: [pathParam("cid")], responses: resp() } },
    "/api-keys": { post: { summary: "Mint an API key", requestBody: jsonBody({ name: { type: "string" }, scopes: { type: "array", items: { type: "string" } } }, ["name"]), responses: resp(201) } },
  },
} as const;
