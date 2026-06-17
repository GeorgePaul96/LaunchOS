import { ApiError } from "@/lib/errors";

export type Intent = "hook" | "thread" | "reel_script" | "carousel" | "repurpose";

const INTENT_INSTRUCTIONS: Record<Intent, string> = {
  hook: "Write scroll-stopping one-line hooks that open a short social post.",
  thread: "Write multi-tweet threads; number each tweet; first tweet is the hook.",
  reel_script: "Write a short-form video (reel) script with an on-screen hook and spoken voiceover beats.",
  carousel: "Write a swipeable carousel; one slide per line, slide 1 is the hook, last slide is a CTA.",
  repurpose: "Rework the supplied source content into fresh native posts for social.",
};

export interface BrandVoice {
  tone?: string;
  bannedWords?: string[];
  audience?: string;
  [k: string]: unknown;
}

export interface BuildPromptInput {
  intent: Intent;
  prompt: string;
  brandVoice: BrandVoice;
  count: number;
  sourceRef?: string;
}

// JSON schema the gateway enforces on the model's output.
export const VARIANT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          body: { type: "string" },
          predictedScore: { type: "integer" },
          rationale: { type: "string" },
        },
        required: ["body", "predictedScore", "rationale"],
      },
    },
  },
  required: ["variants"],
} as const;

export function buildPrompt(input: BuildPromptInput): {
  system: string;
  messages: { role: "user"; content: string }[];
  jsonSchema: Record<string, unknown>;
} {
  const instruction = INTENT_INSTRUCTIONS[input.intent];
  if (!instruction) throw new ApiError(400, "invalid_intent", `Unknown intent: ${input.intent}`);

  const bv = input.brandVoice ?? {};
  const voiceLines = [
    bv.tone ? `Tone: ${bv.tone}.` : "",
    bv.audience ? `Audience: ${bv.audience}.` : "",
    bv.bannedWords?.length ? `Never use these words: ${bv.bannedWords.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  const system = [
    "You are a senior social media copywriter for LaunchOS.",
    instruction,
    voiceLines,
    "For each variant, give an honest predictedScore from 0-100 estimating its virality/engagement, and a one-sentence rationale.",
    "Return only JSON matching the schema.",
  ].filter(Boolean).join(" ");

  const userParts = [
    `Brief: ${input.prompt}`,
    input.sourceRef ? `Source content to repurpose:\n${input.sourceRef}` : "",
    `Generate up to ${input.count} distinct variants.`,
  ].filter(Boolean);

  return {
    system,
    messages: [{ role: "user", content: userParts.join("\n\n") }],
    jsonSchema: VARIANT_SCHEMA as unknown as Record<string, unknown>,
  };
}
