export type Effort = "low" | "medium" | "high" | "max";

export interface Route {
  model: string;
  effort?: Effort; // omitted for models that reject effort (e.g. Haiku)
  thinking: boolean;
}

const ROUTES: Record<string, Route> = {
  plan: { model: "claude-opus-4-8", effort: "high", thinking: true },
  generate: { model: "claude-opus-4-8", effort: "medium", thinking: false },
  classify: { model: "claude-haiku-4-5", thinking: false },
};

export function route(task: string): Route {
  return ROUTES[task] ?? { model: "claude-opus-4-8", effort: "medium", thinking: false };
}
