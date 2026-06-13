import { eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { buildReport } from "@/lib/attribution/report";
import { listPosts } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { db, orgId } = await getOrgContextOrRedirect();
  const report = await buildReport(db, orgId, "linear");
  const posts = await listPosts(db, orgId);
  const accounts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.orgId, orgId));
  const scheduled = posts.filter(p => p.status === "scheduled");
  const attributedRevenue = report.channels.reduce((s, c) => s + c.creditedValueCents, 0);

  const tiles = [
    ["Connected accounts", String(accounts.length)],
    ["Posts", String(posts.length)],
    ["Conversions", String(report.totalConversions)],
    ["Attributed revenue", `$${(attributedRevenue / 100).toFixed(2)}`],
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-4 gap-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-white p-4">
            <div className="text-sm text-neutral-500">{label}</div>
            <div className="text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 mt-8 text-lg font-semibold">Scheduled posts ({scheduled.length})</h2>
      <ul className="space-y-1 text-sm">
        {scheduled.map(p => <li key={p.id} className="rounded border bg-white px-3 py-2">{p.content} — {p.scheduledFor}</li>)}
        {scheduled.length === 0 && <li className="text-neutral-500">Nothing scheduled.</li>}
      </ul>
    </div>
  );
}
