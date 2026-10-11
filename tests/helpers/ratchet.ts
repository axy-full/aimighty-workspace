import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A dated ratchet: a count per file that only goes down, with the date the file must be at zero and who gets it there.
 * Shared by the banned-names check (tests/unit/ui-names-guard.spec.ts) and the priced-buttons check
 * (tests/unit/spend-buttons.spec.ts). A file not on the ratchet has an allowance of zero.
 */
export type Entry = { count: number; until: string; by: string };
export type Section = Record<string, Entry>;

/** Today at the end of the day in UTC, or the day a test pretends it is (RATCHET_TODAY=YYYY-MM-DD). */
export const today = () => (process.env.RATCHET_TODAY ? new Date(process.env.RATCHET_TODAY + "T23:59:59Z") : new Date());
export const past = (until: string) => new Date(until + "T23:59:59Z").getTime() < today().getTime();

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Files whose count is above the allowance (with `describe` saying what is new), and files whose count fell below it. */
export function compare(now: Record<string, number>, allowed: Section, describe: (path: string) => string) {
  const worse: string[] = [];
  const better: string[] = [];
  for (const path of [...new Set([...Object.keys(now), ...Object.keys(allowed)])].sort()) {
    const n = now[path] ?? 0;
    const was = allowed[path]?.count ?? 0;
    if (n > was) worse.push(`${path}: allowed ${was}, now ${n}\n    ${describe(path)}`);
    else if (n < was) better.push(`${path}: ${was} -> ${n}`);
  }
  return { worse, better };
}

export const shapeProblems = (section: Section) =>
  Object.entries(section).filter(([, e]) => !/^\d{4}-\d{2}-\d{2}$/.test(e.until) || !e.by?.trim() || !(e.count > 0)).map(([path]) => path);

export const expired = (section: Section, now: Record<string, number>) =>
  Object.entries(section).filter(([path, e]) => past(e.until) && (now[path] ?? 0) > 0).map(([path, e]) => `${path}: ${now[path]} left after ${e.until} (${e.by})`);

/** The same section with every count lowered to what is there now, and finished files dropped. Never raises, never adds. */
export function lowered(section: Section, now: Record<string, number>): Section {
  const next: Section = {};
  for (const [path, entry] of Object.entries(section)) if ((now[path] ?? 0) > 0) next[path] = { ...entry, count: Math.min(entry.count, now[path]) };
  return next;
}

/** What a section of a ratchet file held where this branch left main, or null when main has no such file (or no checkout). */
export function onMain<T>(file: string): T | null {
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" });
  if (base.status !== 0) return null;
  const before = spawnSync("git", ["show", `${base.stdout.trim()}:${file}`], { encoding: "utf8", maxBuffer: 1 << 24 });
  return before.status === 0 ? (JSON.parse(before.stdout) as T) : null;
}

/** Entries added, counts raised or dates moved later, against main's. */
export function growth(now: Section, then: Section) {
  return {
    added: Object.keys(now).filter((path) => !(path in then)),
    raised: Object.entries(now).filter(([path, e]) => path in then && e.count > then[path].count).map(([path, e]) => `${path}: ${then[path].count} -> ${e.count}`),
    later: Object.entries(now).filter(([path, e]) => path in then && e.until > then[path].until).map(([path, e]) => `${path}: ${then[path].until} -> ${e.until}`),
  };
}
