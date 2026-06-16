export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// Cents per million tokens (from the claude-api model table).
export const PRICING: Record<string, { inputCentsPerMTok: number; outputCentsPerMTok: number }> = {
  "claude-opus-4-8": { inputCentsPerMTok: 500, outputCentsPerMTok: 2500 },
  "claude-haiku-4-5": { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
  "claude-sonnet-4-6": { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
};

// Integer cents, rounded up, with a 1-cent floor so every successful call is metered.
export function costCents(model: string, usage: Usage): number {
  const p = PRICING[model];
  if (!p) throw new Error(`no pricing for model ${model}`);
  const raw = (usage.inputTokens * p.inputCentsPerMTok + usage.outputTokens * p.outputCentsPerMTok) / 1_000_000;
  return Math.max(1, Math.ceil(raw));
}
