"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@launchos.com");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) router.push("/dashboard");
    else setError((await res.json()).detail ?? "Login failed");
  }

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-6">
      <h1 className="mb-4 text-xl font-bold">Sign in to LaunchOS</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input className="rounded border px-3 py-2" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
        <input className="rounded border px-3 py-2" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-black px-3 py-2 text-white">Sign in</button>
      </form>
      <p className="mt-3 text-sm">No account? <a className="underline" href="/signup">Sign up</a></p>
    </main>
  );
}
