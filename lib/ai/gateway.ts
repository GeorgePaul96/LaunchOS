import type { DB } from "@/db/client";
import { schema } from "@/db/client";
import { ApiError } from "@/lib/errors";
import type { AIProvider } from "./provider";
import type { Usage } from "./pricing";
import { route } from "./router";
import { costCents } from "./pricing";
import { assertWithinBudget } from "./budget";
import { MockAIProvider } from "./mock";
import { AnthropicProvider } from "./anthropic";

// Conservative pre-dispatch budget estimate (exact cost recorded post-call).
const ESTIMATE_CENTS = 5;

let cachedProvider: AIProvider | null = null;
export function getProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;
  if (process.env.ANTHROPIC_API_KEY) {
    cachedProvider = new AnthropicProvider();
  } else {
    console.warn("[ai] ANTHROPIC_API_KEY not set — using MockAIProvider");
    cachedProvider = new MockAIProvider();
  }
  return cachedProvider;
}

export interface AIRunInput {
  orgId: string;
  feature: string;
  task: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  provider?: AIProvider; // injectable for tests
}

export interface AIRunResult {
  text: string;
  json?: unknown;
  model: string;
  usage: Usage;
  costCents: number;
}

export async function run(db: DB, input: AIRunInput): Promise<AIRunResult> {
  const r = route(input.task);
  const provider = input.provider ?? getProvider();
  const t0 = Date.now();
  try {
    await assertWithinBudget(db, input.orgId, ESTIMATE_CENTS); // throws 402 if over
    const result = await provider.complete({
      model: r.model,
      system: input.system,
      messages: input.messages,
      effort: r.effort,
      thinking: r.thinking,
      jsonSchema: input.jsonSchema,
      maxTokens: input.maxTokens,
    });
    const cost = costCents(r.model, result.usage);
    await db.insert(schema.aiJobs).values({
      orgId: input.orgId, feature: input.feature, task: input.task, model: r.model,
      status: "succeeded", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      costCents: cost, latencyMs: Date.now() - t0,
    });
    return {
      text: result.text,
      json: input.jsonSchema ? JSON.parse(result.text) : undefined,
      model: r.model,
      usage: result.usage,
      costCents: cost,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.insert(schema.aiJobs).values({
      orgId: input.orgId, feature: input.feature, task: input.task, model: r.model,
      status: "failed", costCents: 0, latencyMs: Date.now() - t0, error: msg,
    });
    if (e instanceof ApiError) throw e; // budget_exceeded passes through as 402
    throw new ApiError(502, "ai_provider_error", msg);
  }
}
