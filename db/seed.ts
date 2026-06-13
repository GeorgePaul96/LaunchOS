import { eq } from "drizzle-orm";
import { db, schema } from "./client";
import { uuid, publicId } from "../lib/ids";
import { hashPassword } from "../lib/auth";

const CHANNELS = ["organic_social", "paid_social", "email"] as const;
const PLATFORMS = ["twitter", "linkedin", "instagram", "tiktok"] as const;

async function main() {
  // Idempotent: no-op if an org already exists. Delete launchos.db to reseed.
  const existing = await db.select().from(schema.organizations).limit(1);
  if (existing.length > 0) {
    console.log("Seed: organization already present; skipping. Delete launchos.db to reseed.");
    return;
  }

  const orgId = uuid();
  await db.insert(schema.organizations).values({
    id: orgId, publicId: publicId("org"), name: "Demo Co", slug: "demo-co",
  });

  const userId = uuid();
  await db.insert(schema.users).values({
    id: userId, publicId: publicId("user"), email: "demo@launchos.com",
    name: "Demo Operator", passwordHash: await hashPassword("demo1234"),
  });
  await db.insert(schema.memberships).values({
    id: uuid(), orgId, userId, role: "owner", status: "active",
  });

  const profileId = uuid();
  await db.insert(schema.profiles).values({
    id: profileId, publicId: publicId("prof"), orgId, name: "Demo Co Brand",
  });

  await db.insert(schema.platforms).values(
    PLATFORMS.map(p => ({ key: p, displayName: p, category: "social" as const })),
  );

  const accountIds: string[] = [];
  for (const platform of ["twitter", "linkedin", "instagram"]) {
    const id = uuid();
    accountIds.push(id);
    await db.insert(schema.socialAccounts).values({
      id, publicId: publicId("acc"), orgId, profileId, platform,
      platformUserId: `u_${platform}`, username: `${platform}_demo`, displayName: `Demo on ${platform}`,
    });
    // daily metric rollup for the dashboard
    await db.insert(schema.accountMetricsDaily).values({
      id: uuid(), orgId, accountId: id, day: new Date().toISOString().slice(0, 10),
      followers: 1000 + Math.floor(Math.random() * 5000), impressions: 8000, reach: 6000, engagement: 400,
    });
  }

  const campaignId = uuid();
  await db.insert(schema.campaigns).values({
    id: campaignId, publicId: publicId("cmp"), orgId, profileId,
    name: "Summer Launch", objective: "launch", goalMetric: "signups", goalTarget: 300,
    budgetCents: 200000, status: "running",
  });

  // a few published posts
  const postSourceIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const postId = uuid();
    postSourceIds.push(postId);
    await db.insert(schema.posts).values({
      id: postId, publicId: publicId("post"), orgId, profileId, createdBy: userId,
      content: `Launch update #${i + 1}`, status: "published", origin: "manual",
      campaignId, scheduledFor: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    });
    for (const accId of accountIds) {
      const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accId));
      await db.insert(schema.postTargets).values({
        id: uuid(), postId, orgId, accountId: accId, platform: acc.platform,
        status: "published", platformPostId: `${acc.platform}_${postId.slice(0, 8)}`,
        permalink: `https://mock.local/${acc.platform}/${postId.slice(0, 8)}`,
        publishedAt: new Date().toISOString(),
      });
    }
  }

  // ~30 identities with multi-touch journeys; ~40% convert
  for (let i = 0; i < 30; i++) {
    const identityId = uuid();
    let contactId: string | null = null;
    if (i % 2 === 0) {
      contactId = uuid();
      await db.insert(schema.contacts).values({
        id: contactId, publicId: publicId("contact"), orgId, profileId,
        name: `Lead ${i}`, email: `lead${i}@example.com`, lifecycleStage: "lead",
      });
    }
    await db.insert(schema.identities).values({
      id: identityId, orgId, anonymousId: `anon-${i}`, contactId,
    });

    const touchCount = 1 + (i % 3); // 1..3 touches
    const baseTime = Date.now() - (10 - (i % 10)) * 86400000;
    for (let t = 0; t < touchCount; t++) {
      await db.insert(schema.touchpoints).values({
        orgId, identityId,
        channel: CHANNELS[(i + t) % CHANNELS.length],
        platform: PLATFORMS[(i + t) % PLATFORMS.length],
        sourceType: "post", sourceId: postSourceIds[(i + t) % postSourceIds.length],
        campaignId,
        occurredAt: new Date(baseTime + t * 3600000).toISOString(),
      });
    }
    if (i % 5 < 2) { // ~40% convert
      await db.insert(schema.conversions).values({
        orgId, identityId, eventName: i % 2 === 0 ? "signup" : "purchase",
        valueCents: i % 2 === 0 ? 0 : 2500 + i * 100,
        occurredAt: new Date(baseTime + touchCount * 3600000 + 7200000).toISOString(),
      });
    }
  }

  console.log("Seed complete. Login: demo@launchos.com / demo1234");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
