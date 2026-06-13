"use client";
import { useEffect, useState } from "react";

interface Account { id: string; publicId: string; platform: string; username: string | null; profileId: string; }

export default function ComposePage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    fetch("/api/v1/accounts").then(r => r.json()).then(d => setAccounts(d.data ?? []));
  }, []);

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function publish() {
    setResult("");
    if (!accounts.length || !selected.length) { setResult("Select at least one account."); return; }
    const profileId = accounts.find(a => selected.includes(a.id))!.profileId;
    const res = await fetch("/api/v1/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ profileId, content, accountIds: selected }),
    });
    const json = await res.json();
    setResult(res.ok ? `Queued ${json.post.id} (${json.post.status}); the scheduler will publish within a few seconds.` : json.detail);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold">Compose</h1>
      <textarea className="mb-4 h-32 w-full rounded border p-3" value={content} onChange={e => setContent(e.target.value)} placeholder="Write once, publish everywhere…" />
      <div className="mb-4">
        <div className="mb-2 text-sm font-medium">Target accounts</div>
        <div className="flex flex-wrap gap-2">
          {accounts.map(a => (
            <button key={a.id} onClick={() => toggle(a.id)}
              className={`rounded-full border px-3 py-1 text-sm ${selected.includes(a.id) ? "bg-black text-white" : "bg-white"}`}>
              {a.platform} · {a.username}
            </button>
          ))}
        </div>
      </div>
      <button onClick={publish} className="rounded bg-black px-4 py-2 text-white">Publish</button>
      {result && <p className="mt-3 text-sm">{result}</p>}
    </div>
  );
}
