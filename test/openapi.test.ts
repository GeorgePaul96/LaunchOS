import { describe, it, expect } from "vitest";
import { openapiSpec } from "@/lib/openapi/spec";
import { routeApiPaths } from "@/lib/openapi/paths";

describe("openapi spec", () => {
  it("is a valid OpenAPI 3.1 document", () => {
    expect(openapiSpec.openapi).toBe("3.1.0");
    expect(openapiSpec.info.title).toBeTruthy();
    expect(Object.keys(openapiSpec.paths).length).toBeGreaterThan(0);
    expect(openapiSpec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("documents every /v1 route (drift guard)", () => {
    const documented = Object.keys(openapiSpec.paths).sort();
    const implemented = routeApiPaths();
    expect(documented).toEqual(implemented);
  });
});
