export type AttributionModel = "first_touch" | "last_touch" | "linear";

export interface Touch {
  touchpointId: number;
  channel: string;
  occurredAt: string; // ISO
}

export interface Allocation {
  touchpointId: number;
  credit: number;            // fraction 0..1
  creditedValueCents: number;
}

// Allocates `valueCents` across prior touches per model. Touches need not be sorted.
export function allocate(model: AttributionModel, touches: Touch[], valueCents: number): Allocation[] {
  if (touches.length === 0) return [];
  const sorted = [...touches].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  if (model === "first_touch") {
    return [{ touchpointId: sorted[0].touchpointId, credit: 1, creditedValueCents: valueCents }];
  }
  if (model === "last_touch") {
    const last = sorted[sorted.length - 1];
    return [{ touchpointId: last.touchpointId, credit: 1, creditedValueCents: valueCents }];
  }
  // linear: even split, with cent remainder assigned to the last touch to conserve total
  const n = sorted.length;
  const base = Math.floor(valueCents / n);
  const remainder = valueCents - base * n;
  return sorted.map((t, i) => ({
    touchpointId: t.touchpointId,
    credit: 1 / n,
    creditedValueCents: i === n - 1 ? base + remainder : base,
  }));
}
