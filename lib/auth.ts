import { scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const hashBuf = Buffer.from(hash, "hex");
  return hashBuf.length === derived.length && timingSafeEqual(hashBuf, derived);
}

export interface SessionPayload { userId: string; orgId: string; }

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "launchos_session";
export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-only-secret-change-me";
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  const secret = "sk_" + randomBytes(32).toString("hex");
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 8) };
}
