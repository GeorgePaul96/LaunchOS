import { eq, and } from "drizzle-orm";
import { schema } from "@/db/client";
import { getOrgContextOrRedirect } from "@/lib/page-data";
import { contactTimeline } from "@/lib/journey/timeline";

export const dynamic = "force-dynamic";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { db, orgId } = await getOrgContextOrRedirect();
  const { id } = await params;
  const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, id), eq(schema.contacts.orgId, orgId)));
  if (!contact) return <div>Contact not found.</div>;
  const timeline = await contactTimeline(db, orgId, id);

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold">{contact.name ?? "Contact"}</h1>
      <div className="mb-6 text-sm text-neutral-500">{contact.email} · {contact.lifecycleStage}</div>
      <h2 className="mb-2 text-lg font-semibold">Journey</h2>
      <ol className="relative space-y-3 border-l pl-4">
        {timeline.map((e, i) => (
          <li key={i} className="text-sm">
            <span className="text-neutral-400">{e.occurredAt.slice(0, 16).replace("T", " ")}</span>{" — "}
            {e.kind === "touchpoint"
              ? <span><b>{e.channel}</b>{e.platform ? ` (${e.platform})` : ""} touch</span>
              : <span className="text-green-700"><b>{e.eventName}</b>{e.valueCents ? ` $${(e.valueCents/100).toFixed(2)}` : ""}</span>}
          </li>
        ))}
        {timeline.length === 0 && <li className="text-neutral-500">No journey events.</li>}
      </ol>
    </div>
  );
}
