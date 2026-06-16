import { createHash } from "node:crypto";
import type { AIProvider, CompletionRequest, AIResult } from "./provider";

// Deterministic, offline provider for dev/test.
export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  async complete(req: CompletionRequest): Promise<AIResult> {
    const prompt = (req.system ? req.system + "\n" : "") + req.messages.map((m) => `${m.role}:${m.content}`).join("\n");
    const text = req.jsonSchema
      ? JSON.stringify(mockJsonForSchema(req.jsonSchema))
      : `mock(${req.model}):${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
    return { text, model: req.model, usage: { inputTokens: tokens(prompt), outputTokens: tokens(text) } };
  }
}

function tokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

// Build a minimal valid object for a JSON schema (objects/properties only; enough for tests).
function mockJsonForSchema(schema: Record<string, unknown>): unknown {
  const type = schema.type as string | undefined;
  if (type === "object") {
    const out: Record<string, unknown> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      out[key] = mockJsonForSchema(propSchema);
    }
    return out;
  }
  if (type === "array") return [];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return ""; // string and unspecified
}
