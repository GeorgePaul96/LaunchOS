import { describe, it, expect } from "vitest";
import { ApiError, problem, toProblemResponse } from "@/lib/errors";

describe("errors", () => {
  it("problem() builds an RFC-9457 body", () => {
    const body = problem({ status: 400, code: "invalid_request", detail: "bad" });
    expect(body).toMatchObject({
      type: "about:blank",
      title: "invalid_request",
      status: 400,
      detail: "bad",
      code: "invalid_request",
    });
    expect(typeof body.request_id).toBe("string");
  });

  it("ApiError carries status + code", () => {
    const e = new ApiError(404, "not_found", "missing");
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
  });

  it("toProblemResponse maps an ApiError to a Response", async () => {
    const res = toProblemResponse(new ApiError(401, "unauthorized", "no session"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const json = await res.json();
    expect(json.code).toBe("unauthorized");
  });

  it("toProblemResponse maps unknown errors to 500", async () => {
    const res = toProblemResponse(new Error("boom"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("internal_error");
  });
});
