import { SESSION_COOKIE } from "@/lib/auth";
import { ok } from "@/lib/request";

export async function POST() {
  const res = ok({ ok: true });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  return res;
}
