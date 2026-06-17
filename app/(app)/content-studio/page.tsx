"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Account { id: string; profileId: string; }
interface Variant { id: string; body: string; predictedScore: number; rationale: string; }

const INTENTS = ["hook", "thread", "reel_script", "carousel", "repurpose"] as const;
type Intent = typeof INTENTS[number];

export default function ContentStudioPage() {
  const router = useRouter();
  const [profileId, setProfileId] = useState("");
  const [intent, setIntent] = useState<Intent>("hook");
  const [prompt, setPrompt] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/v1/accounts").then(r => r.json()).then((d: { data?: Account[] }) => {
      if (d.data?.length) setProfileId(d.data[0].profileId);
    });
  }, []);

  async function generate() {
    setError(""); setVariants([]); setLoading(true);
    try {
      const res = await fetch("/api/v1/content/generate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId, intent, prompt, sourceRef: intent === "repurpose" ? sourceRef : undefined }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.detail ?? "Generation failed"); return; }
      setVariants(json.variants ?? []);
    } catch {
      setError("Generation failed");
    } finally { setLoading(false); }
  }

  async function useInComposer(v: Variant) {
    await fetch(`/api/v1/content/variants/${encodeURIComponent(v.id)}/choose`, { method: "POST" });
    router.push(`/compose?content=${encodeURIComponent(v.body)}`);
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">Content Studio</h1>
      <div className="mb-3 flex gap-2">
        <select className="rounded border p-2" value={intent} onChange={e => setIntent(e.target.value as Intent)}>
          {INTENTS.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
      </div>
      <textarea className="mb-3 h-24 w-full rounded border p-3" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="What should this content be about?" />
      {intent === "repurpose" && (
        <textarea className="mb-3 h-24 w-full rounded border p-3" value={sourceRef} onChange={e => setSourceRef(e.target.value)} placeholder="Paste the source content to repurpose…" />
      )}
      <button onClick={generate} disabled={loading || !prompt || !profileId} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {loading ? "Generating…" : "Generate"}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-6 space-y-3">
        {variants.map(v => (
          <div key={v.id} className="rounded border p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium">score {v.predictedScore}</span>
              <button onClick={() => useInComposer(v)} className="text-sm text-blue-600 hover:underline">Use in composer →</button>
            </div>
            <p className="whitespace-pre-wrap text-sm">{v.body}</p>
            {v.rationale && <p className="mt-2 text-xs text-neutral-500">{v.rationale}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
