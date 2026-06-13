import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

export function publicId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
