import { ApiError } from "@/lib/errors";

export interface BrandVoice { tone?: string; bannedWords?: string[]; audience?: string; [k: string]: unknown; }
export interface PlanChannel { accountId: string; platform: string; }
export interface BuildPlanInput {
  objective: string;
  goalMetric?: string | null;
  goalTarget?: number | null;
  budgetCents?: number | null;
  channels: PlanChannel[];
  brandVoice: BrandVoice;
  horizonDays: number;
}

// JSON schema the gateway enforces on the model's output.
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    goalMetric: { type: "string" },
    goalTarget: { type: "integer" },
    channelMix: {
      type: "array",
      items: {
        type: "object",
        properties: { platform: { type: "string" }, budgetCents: { type: "integer" }, rationale: { type: "string" } },
        required: ["platform", "budgetCents", "rationale"],
      },
    },
    assets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          platform: { type: "string" }, dayOffset: { type: "integer" }, draftBody: { type: "string" },
          rationale: { type: "string" }, expectedOutcome: { type: "string" }, budgetCents: { type: "integer" },
        },
        required: ["platform", "dayOffset", "draftBody", "rationale", "expectedOutcome", "budgetCents"],
      },
    },
  },
  required: ["assets"],
} as const;

export function buildPlanPrompt(input: BuildPlanInput): {
  system: string;
  messages: { role: "user"; content: string }[];
  jsonSchema: Record<string, unknown>;
} {
  if (!input.channels || input.channels.length === 0) {
    throw new ApiError(400, "invalid_request", "Campaign has no target channels");
  }
  const bv = input.brandVoice ?? {};
  const voiceLines = [
    bv.tone ? `Tone: ${bv.tone}.` : "",
    bv.audience ? `Audience: ${bv.audience}.` : "",
    bv.bannedWords?.length ? `Never use these words: ${bv.bannedWords.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const platforms = [...new Set(input.channels.map((c) => c.platform))].join(", ");

  const system = [
    "You are a senior growth marketer for LaunchOS planning a multi-channel campaign.",
    `Available channels: ${platforms}.`,
    voiceLines,
    "Produce a concrete calendar of content assets. Assign each asset to one of the available platforms, with a dayOffset (days after launch), ready-to-edit draftBody copy, a one-sentence rationale, an expectedOutcome note, and a budgetCents allocation. Also return a channelMix splitting the budget across platforms, plus the overall goalMetric and goalTarget.",
    "Return only JSON matching the schema.",
  ].filter(Boolean).join(" ");

  const userParts = [
    `Objective: ${input.objective}`,
    input.goalMetric ? `Goal metric: ${input.goalMetric}${input.goalTarget != null ? ` (target ${input.goalTarget})` : ""}` : "",
    input.budgetCents != null ? `Total budget (cents): ${input.budgetCents}` : "",
    `Plan horizon: ${input.horizonDays} days.`,
  ].filter(Boolean);

  return {
    system,
    messages: [{ role: "user", content: userParts.join("\n") }],
    jsonSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,
  };
}
