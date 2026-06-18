"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Account { id: string; profileId: string; platform: string; username?: string; }
interface Campaign { id: string; name: string; objective: string; status: string; }

export default function CampaignsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [goalMetric, setGoalMetric] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [budget, setBudget] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/accounts").then(r => r.json()).then((d: { data?: Account[] }) => {
      if (d.data?.length) { setAccounts(d.data); setProfileId(d.data[0].profileId); }
    });
    fetch("/api/v1/campaigns").then(r => r.json()).then((d: { data?: Campaign[] }) => setCampaigns(d.data ?? []));
  }, []);

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function create() {
    setError(""); setSaving(true);
    try {
      const res = await fetch("/api/v1/campaigns", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId, name, objective,
          goalMetric: goalMetric || undefined,
          goalTarget: goalTarget ? Number(goalTarget) : undefined,
          budgetCents: budget ? Math.round(Number(budget) * 100) : undefined,
          accountIds: selected,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.detail ?? "Create failed"); return; }
      router.push(`/campaigns/${json.campaign.id}`);
    } catch {
      setError("Create failed");
    } finally { setSaving(false); }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">Campaigns</h1>

      <div className="mb-8 rounded border p-4">
        <h2 className="mb-3 font-semibold">New campaign</h2>
        <input className="mb-2 w-full rounded border p-2" value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
        <input className="mb-2 w-full rounded border p-2" value={objective} onChange={e => setObjective(e.target.value)} placeholder="Objective (e.g. drive beta signups)" />
        <div className="mb-2 flex gap-2">
          <input className="w-1/3 rounded border p-2" value={goalMetric} onChange={e => setGoalMetric(e.target.value)} placeholder="Goal metric" />
          <input className="w-1/3 rounded border p-2" value={goalTarget} onChange={e => setGoalTarget(e.target.value)} placeholder="Target" />
          <input className="w-1/3 rounded border p-2" value={budget} onChange={e => setBudget(e.target.value)} placeholder="Budget ($)" />
        </div>
        <div className="mb-3">
          <p className="mb-1 text-sm text-neutral-500">Channels</p>
          <div className="flex flex-wrap gap-2">
            {accounts.map(a => (
              <button key={a.id} onClick={() => toggle(a.id)}
                className={`rounded-full border px-3 py-1 text-sm ${selected.includes(a.id) ? "bg-black text-white" : ""}`}>
                {a.platform}{a.username ? ` · ${a.username}` : ""}
              </button>
            ))}
          </div>
        </div>
        <button onClick={create} disabled={saving || !name || !objective || !profileId || selected.length === 0}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {saving ? "Creating…" : "Create campaign"}
        </button>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      <div className="space-y-2">
        {campaigns.map(c => (
          <button key={c.id} onClick={() => router.push(`/campaigns/${c.id}`)}
            className="flex w-full items-center justify-between rounded border p-3 text-left hover:bg-neutral-50">
            <span><span className="font-medium">{c.name}</span> <span className="text-sm text-neutral-500">— {c.objective}</span></span>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{c.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
