import { defineConfig } from "drizzle-kit";

const raw = process.env.DATABASE_URL ?? "./launchos.db";
const url = raw === ":memory:" || raw.includes("://") || raw.startsWith("file:") ? raw : `file:${raw}`;

export default defineConfig({
  dialect: "turso", // libsql driver; supports local file: urls
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url },
});
