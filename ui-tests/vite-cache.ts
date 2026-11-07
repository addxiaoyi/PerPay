import { resolve } from "node:path";

export function viteFixtureCache(suite: string): string {
  // Concurrent Vite configurations must not invalidate another worker's served dependencies.
  return resolve(".ui-audit", "vite", String(process.pid), suite);
}
