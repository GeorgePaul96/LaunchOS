import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, CompletionRequest, AIResult } from "./provider";

// Real provider. Constructed only when ANTHROPIC_API_KEY is present (see gateway.getProvider).
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client = new Anthropic();

  async complete(req: CompletionRequest): Promise<AIResult> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) params.system = req.system;
    if (req.thinking) params.thinking = { type: "adaptive" };
    const outputConfig: Record<string, unknown> = {};
    if (req.effort) outputConfig.effort = req.effort;
    if (req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

    // output_config is newer than the installed SDK's types; cast at the boundary.
    const resp = (await this.client.messages.create(params as never)) as Anthropic.Message;
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: resp.model,
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
    };
  }
}
