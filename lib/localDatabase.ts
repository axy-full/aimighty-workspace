import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** libSQL creates a local database file, but requires its parent to exist. */
export function prepareLocalDatabaseDirectory(url: string): void {
  if (!/^file:/i.test(url)) return;
  // libSQL also accepts relative file: URLs, which fileURLToPath resolves
  // differently. Keep those relative to the process's working directory.
  const value = url.slice(5);
  const path = value.startsWith("//")
    ? fileURLToPath(url)
    : decodeURIComponent(value.split(/[?#]/, 1)[0]);
  if (!path || path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}
