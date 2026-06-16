import { openapiSpec } from "@/lib/openapi/spec";

export function GET() {
  return new Response(JSON.stringify(openapiSpec), { headers: { "content-type": "application/json" } });
}
