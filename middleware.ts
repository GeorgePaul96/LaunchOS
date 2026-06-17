import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  let id = requestHeaders.get("x-request-id");
  if (!id) {
    id = crypto.randomUUID();
    requestHeaders.set("x-request-id", id);
  }
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", id);
  return res;
}

export const config = { matcher: "/api/:path*" };
