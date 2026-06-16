import { getOrgContextOrRedirect } from "@/lib/page-data";
import { listPosts } from "@/lib/publishing/service";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const ctx = await getOrgContextOrRedirect();
  const posts = (await ctx.withOrg((db) => listPosts(db, ctx.orgId)))
    .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Calendar</h1>
      <table className="w-full border-collapse text-sm">
        <thead><tr className="text-left text-neutral-500"><th className="p-2">When</th><th className="p-2">Content</th><th className="p-2">Status</th><th className="p-2">Targets</th></tr></thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="border-t">
              <td className="p-2">{p.scheduledFor?.slice(0, 16).replace("T", " ")}</td>
              <td className="p-2">{p.content}</td>
              <td className="p-2"><span className="rounded bg-neutral-100 px-2 py-0.5">{p.status}</span></td>
              <td className="p-2">
                {p.targets.map((t) => (
                  <span key={t.id} className={`mr-1 rounded px-2 py-0.5 text-xs ${t.status === "published" ? "bg-green-100" : t.status === "failed" ? "bg-red-100" : "bg-neutral-100"}`}>
                    {t.platform}:{t.status}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
