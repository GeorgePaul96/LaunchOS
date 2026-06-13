import { randomUUID } from "node:crypto";

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  request_id: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export function problem(opts: { status: number; code: string; detail: string }): ProblemBody {
  return {
    type: "about:blank",
    title: opts.code,
    status: opts.status,
    detail: opts.detail,
    code: opts.code,
    request_id: randomUUID(),
  };
}

export function toProblemResponse(err: unknown): Response {
  const e =
    err instanceof ApiError
      ? err
      : new ApiError(500, "internal_error", "An unexpected error occurred");
  const body = problem({ status: e.status, code: e.code, detail: e.detail });
  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: { "content-type": "application/problem+json" },
  });
}
