import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const ctx = await getOrgContextOrRedirect();
  const { accounts, contacts, org } = await ctx.withOrg(async (db) => ({
    accounts: await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, ctx.orgId)),
    contacts: await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, ctx.orgId)).limit(20),
    org: (await db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)))[0],
  }));
  const snippet = `<script async src="/pixel.js" data-write-key="${org?.writeKey ?? ""}"></script>`;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Connections</h1>

      <section className="mb-8 rounded-lg border bg-white p-4">
        <h2 className="mb-1 text-lg font-semibold">Tracking pixel</h2>
        <p className="mb-2 text-sm text-neutral-500">Embed this on your site to attribute visits and conversions. Then call <code>launchos.track("signup")</code> or <code>launchos.identify(email)</code>.</p>
        <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{snippet}</pre>
        <p className="mt-2 text-xs text-neutral-400">Write key: <code>{org?.writeKey}</code> (publishable — safe to expose).</p>
      </section>

      <div className="mb-8 grid grid-cols-3 gap-4">
        {accounts.map((a) => (
          <div key={a.id} className="rounded-lg border bg-white p-4">
            <div className="font-medium">{a.platform}</div>
            <div className="text-sm text-neutral-500">{a.username}</div>
            <div className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs">{a.status}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 text-lg font-semibold">Contacts</h2>
      <ul className="text-sm">
        {contacts.map((c) => (
          <li key={c.id}><a className="underline" href={`/contacts/${c.id}`}>{c.name} · {c.email}</a></li>
        ))}
      </ul>
    </div>
  );
}
