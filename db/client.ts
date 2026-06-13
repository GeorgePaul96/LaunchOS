import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// Accept either a libsql url (file:/http(s)/:memory:) or a bare path from .env.
function normalizeUrl(raw: string | undefined): string {
  const url = raw ?? "./launchos.db";
  if (url === ":memory:" || url.includes("://") || url.startsWith("file:")) return url;
  return `file:${url}`;
}

const client = createClient({ url: normalizeUrl(process.env.DATABASE_URL) });

export const db = drizzle(client, { schema });
export type DB = typeof db;
export { schema };
