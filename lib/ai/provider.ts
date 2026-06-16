import type { Usage } from "./pricing";
import type { Effort } from "./router";

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  effort?: Effort;
  thinking?: boolean;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface AIResult {
  text: string;
  model: string;
  usage: Usage;
}

export interface AIProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<AIResult>;
}
