"use client";
import { useEffect, useState, use } from "react";

interface Asset { id: string; platform: string; dayOffset: number; draftBody: string; rationale: string; expectedOutcome: string; budgetCents: number; postId: string | null; }
interface ChannelMix { platform: string; budgetCents: number; share: number; }
interface Campaign { id: string; name: string; objective: string; status: string; goalMetric: string | null; goalTarget: number | null; }
interface ResultsChannel { channel: string; creditedValueCents: number; conversions: number; }
interface Results { totalConversionValueCents: number; totalConversions: number; channels: ResultsChannel[]; }

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [channelMix, setChannelMix] = useState<ChannelMix[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [model, setModel] = useState("linear");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch(`/api/v1/campaigns/${id}`);
    const json = await res.json();
    if (!res.ok) { setError(json.detail ?? "Load failed"); return; }
    setCampaign(json.campaign); setAssets(json.assets ?? []); setChannelMix(json.channelMix ?? []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function loadResults(m: string) {
    setModel(m);
    const res = await fetch(`/api/v1/campaigns/${id}/results?model=${m}`);
    if (res.ok) setResults(await res.json());
  }

  async function act(path: string) {
    setError(""); setBusy(true);
    try {
      const res = await fetch(`/api/v1/campaigns/${id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const json = await res.json();
      if (!res.ok) { setError(json.detail ?? `${path} failed`); return; }
      await load();
    } catch {
      setError(`${path} failed`);
    } finally { setBusy(false); }
  }

  if (!campaign) return <div className="max-w-3xl">{error ? <p className="text-red-600">{error}</p> : "Loading…"}</div>;
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{campaign.name}</h1>
          <p className="text-sm text-neutral-500">{campaign.objective}{campaign.goalMetric ? ` · ${campaign.goalMetric}${campaign.goalTarget != null ? ` (target ${campaign.goalTarget})` : ""}` : ""}</p>
        </div>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs">{campaign.status}</span>
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => act("plan")} disabled={busy || campaign.status !== "planning"} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {assets.length ? "Re-plan" : "Generate plan"}
        </button>
        <button onClick={() => act("approve")} disabled={busy || campaign.status !== "planning" || assets.length === 0} className="rounded border px-4 py-2 disabled:opacity-50">
          Approve plan
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {channelMix.length > 0 && (
        <div className="mb-4 rounded border p-3">
          <h2 className="mb-2 text-sm font-semibold">Channel mix</h2>
          {channelMix.map(c => (
            <div key={c.platform} className="flex justify-between text-sm">
              <span>{c.platform}</span><span className="text-neutral-500">{dollars(c.budgetCents)} · {c.share}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {assets.map(a => (
          <div key={a.id} className="rounded border p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium">{a.platform} · day {a.dayOffset}</span>
              <span className="text-xs text-neutral-500">{dollars(a.budgetCents)}{a.postId ? " · draft created" : ""}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{a.draftBody}</p>
            {a.rationale && <p className="mt-2 text-xs text-neutral-500">{a.rationale}</p>}
            {a.expectedOutcome && <p className="mt-1 text-xs text-neutral-400">Expected: {a.expectedOutcome}</p>}
          </div>
        ))}
      </div>

      <div className="mt-8 rounded border p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Results (attributed)</h2>
          <select className="rounded border p-1 text-sm" value={model} onChange={e => loadResults(e.target.value)}>
            {["linear", "first_touch", "last_touch"].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        {!results && <button onClick={() => loadResults(model)} className="text-sm text-blue-600 hover:underline">Load results</button>}
        {results && (
          <div className="text-sm">
            <p className="mb-2 text-neutral-600">{results.totalConversions} conversions · {dollars(results.totalConversionValueCents)} total value</p>
            {results.channels.map(ch => (
              <div key={ch.channel} className="flex justify-between"><span>{ch.channel}</span><span className="text-neutral-500">{dollars(ch.creditedValueCents)}</span></div>
            ))}
            {results.channels.length === 0 && <p className="text-neutral-400">No attributed touchpoints yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
