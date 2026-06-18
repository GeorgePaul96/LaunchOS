import { describe, it, expect } from "vitest";
import { OPTIONS, withCors, CORS_HEADERS } from "@/app/api/v1/collect/route";

describe("collect route CORS", () => {
  it("OPTIONS returns 204 with permissive CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("withCors stamps CORS headers onto any response", () => {
    const res = withCors(new Response("x", { status: 500 }));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("content-type");
  });
});
