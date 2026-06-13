"use client";
import { useEffect, useState } from "react";

const MODELS = ["first_touch", "last_touch", "linear"];

interface Report {
  model: string; totalConversionValueCents: number; totalConversions: number;
  channels: { channel: string; creditedValueCents: number; conversions: number }[];
}

export default function AnalyticsPage() {
  const [model, setModel] = useState("linear");
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    fetch(`/api/v1/attribution/report?model=${model}`).then(r => r.json()).then(setReport);
  }, [model]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Analytics & Attribution</h1>
      <div className="mb-4 flex gap-2">
        {MODELS.map(m => (
          <button key={m} onClick={() => setModel(m)}
            className={`rounded border px-3 py-1 text-sm ${model === m ? "bg-black text-white" : "bg-white"}`}>{m}</button>
        ))}
      </div>
      {report && (
        <>
          <div className="mb-4 text-sm text-neutral-600">
            {report.totalConversions} conversions · total value ${(report.totalConversionValueCents / 100).toFixed(2)}
          </div>
          <table className="w-full border-collapse text-sm">
            <thead><tr className="text-left text-neutral-500"><th className="p-2">Channel</th><th className="p-2">Attributed revenue</th><th className="p-2">Credited conversions</th></tr></thead>
            <tbody>
              {report.channels.map(c => (
                <tr key={c.channel} className="border-t">
                  <td className="p-2">{c.channel}</td>
                  <td className="p-2">${(c.creditedValueCents / 100).toFixed(2)}</td>
                  <td className="p-2">{c.conversions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
