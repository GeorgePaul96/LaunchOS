import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Returns the set of /v1 API paths implemented as route.ts handlers, with [x] -> {x}.
// Excludes /auth/* and /openapi.json (auth is intentionally undocumented; the spec serves itself).
export function routeApiPaths(root = "app/api/v1"): string[] {
  const out: string[] = [];
  function walk(dir: string, segs: string[]) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, [...segs, entry.replace(/^\[(.+)\]$/, "{$1}")]);
      } else if (entry === "route.ts") {
        out.push("/" + segs.join("/"));
      }
    }
  }
  walk(root, []);
  return out.filter((p) => !p.startsWith("/auth") && p !== "/openapi.json").sort();
}
