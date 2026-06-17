import { clearedCookie } from "@/lib/auth";
import { ok } from "@/lib/request";

export async function POST() {
  const res = ok({ ok: true });
  res.headers.append("set-cookie", clearedCookie());
  return res;
}
