// Exponential backoff with a cap. attempt is 1-based.
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60000): number {
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, maxMs);
}
