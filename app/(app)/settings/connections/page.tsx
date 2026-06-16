import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const ctx = await getOrgContextOrRedirect();
  const { accounts, contacts } = await ctx.withOrg(async (db) => ({
    accounts: await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, ctx.orgId)),
    contacts: await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, ctx.orgId)).limit(20),
  }));
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Connections</h1>
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
