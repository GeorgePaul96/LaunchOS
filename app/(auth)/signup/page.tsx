"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/v1/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).detail ?? "Signup failed");
  }

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-6">
      <h1 className="mb-4 text-xl font-bold">Create your LaunchOS org</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input className="rounded border px-3 py-2" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
        <input className="rounded border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
        <input className="rounded border px-3 py-2" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-black px-3 py-2 text-white">Create org</button>
      </form>
    </main>
  );
}
