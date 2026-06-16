import { db, schema } from "../db/client";
import { generateApiKey } from "../lib/auth";
import { uuid } from "../lib/ids";

const [org] = await db.select().from(schema.organizations).limit(1);
if (!org) {
  console.error("No organization found. Run `npm run db:seed` first.");
  process.exit(1);
}
const { secret, hash, prefix } = generateApiKey();
await db.insert(schema.apiKeys).values({
  id: uuid(), orgId: org.id, name: "cli", keyHash: hash, keyPrefix: prefix, createdBy: null,
});
console.log(`API key for org ${org.slug} (save it now — shown once):`);
console.log(secret);
process.exit(0);
