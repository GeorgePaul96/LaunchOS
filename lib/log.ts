const SENSITIVE = /^(authorization|password|passwordhash|password_hash|token|secret|key|apikey|api_key|set[-_]?cookie|cookie)$/i;

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, seen);
  }
  return out;
}

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as Fields) : {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
