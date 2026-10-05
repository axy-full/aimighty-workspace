import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bannedNamesIn, type BannedName } from "./uiStrings";

/**
 * Where a person reads a name, grouped by surface, for the banned-names check
 * (tests/unit/ui-names-guard.spec.ts). Every tracked .ts and .tsx file under SCAN_ROOTS is scanned; a
 * file belongs to the first surface below that claims it, and to the ratchet when none does.
 *
 * STRICT surfaces allow nothing. The old screens keep a per-file ratchet with a deletion date
 * (tests/unit/ui-names-ratchet.json) until the board and the D0 pull requests delete them.
 */
export const SCAN_ROOTS = ["app/", "components/", "lib/"];

/** Exempt: the design folder names what it replaced, and two documents are history. Code identifiers and comments are never read as UI. */
export const EXEMPT = ["design/particl-graphite/", "docs/handoff-diff.md", "docs/handover-2026-10-05.md"];

export type Surface = {
  id: string;
  /** What the failure says the surface is. */
  name: string;
  /** True for navigation data: a label that is only "Generate" is the old Gen page there. */
  navigation: boolean;
  claims: (path: string) => boolean;
};

const under = (path: string, prefixes: string[]) => prefixes.some((prefix) => path.startsWith(prefix));
const is = (path: string, names: string[]) => names.includes(path);

/**
 * The new design's own directories (one stream each): code written for the new screens never carries an old
 * name, so these are strict from the first commit, whether or not the directory exists yet.
 */
export const NEW_DESIGN_DIRS = [
  "components/graphite/home/", "components/graphite/board/", "components/graphite/make/", "components/graphite/settings/",
  "components/graphite/control-room/", "components/graphite/atomik/panel/", "components/graphite/phone/",
];

export const SURFACES: Surface[] = [
  {
    id: "phone-bar", name: "the phone bar and the phone's own screens", navigation: true,
    claims: (path) => path === "components/graphite/TabBar.tsx" || path.startsWith("components/graphite/mobile/") || path.startsWith("components/graphite/phone/"),
  },
  {
    id: "command-k", name: "⌘K (the palette and its index)", navigation: true,
    claims: (path) => is(path, ["components/graphite/Palette.tsx", "lib/shell/palette.ts"]),
  },
  {
    id: "shell", name: "the shell (header, avatar menu, stage strip, page heads, overlays, the new design's directories)", navigation: false,
    /* GenView is the Gen page that the Make panel (#512) deletes: it stays on the ratchet until then. */
    claims: (path) =>
      (/^components\/graphite\/[^/]+\.tsx?$/.test(path) && path !== "components/graphite/GenView.tsx")
      || under(path, NEW_DESIGN_DIRS) || path.startsWith("app/suites/"),
  },
  {
    id: "labels", name: "tab, page and header labels (lib/shell and the old suite and page tables)", navigation: true,
    claims: (path) => path.startsWith("lib/shell/") || is(path, ["lib/suites.ts", "lib/nav.ts", "lib/workspace/pages.ts", "lib/workspace/navigation.ts"]),
  },
  {
    /* Not navigation data as a whole: the hero's "Generate" is a button there. Its tab and menu labels are Gen-checked all the same. */
    id: "marketing", name: "the marketing site and its navigation", navigation: false,
    claims: (path) => path.startsWith("components/marketing/") || path.startsWith("lib/marketing/") || path.startsWith("app/(marketing)/") || path === "lib/site.ts",
  },
];

export function isExempt(path: string): boolean {
  return EXEMPT.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** The source files whose strings a person can read. Tests, type files and exempt paths are out. */
export function scannedFiles(files: string[]): string[] {
  return files.filter((path) => /\.tsx?$/.test(path) && !/\.d\.ts$|\.(spec|test)\.tsx?$/.test(path) && under(path, SCAN_ROOTS) && !isExempt(path));
}

export function repoFiles(): string[] {
  const run = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.split("\n").filter(Boolean).filter((path) => existsSync(path));
}

export function surfaceOf(path: string): Surface | null {
  return SURFACES.find((surface) => surface.claims(path)) ?? null;
}

export type Hit = BannedName & { path: string };

export const format = (hit: Hit) => `${hit.path}:${hit.line} [${hit.word}] ${hit.text}`;

export type Scan = {
  /** Strict hits per surface id, plus "titles" for page titles found in files no strict surface claims. */
  strict: Record<string, Hit[]>;
  /** Hits in the files the ratchet covers (page titles excluded: they are strict). */
  ratchet: Record<string, Hit[]>;
};

/** One pass over every scanned file. */
export function scanAll(files = scannedFiles(repoFiles())): Scan {
  const strict: Record<string, Hit[]> = { titles: [] };
  for (const surface of SURFACES) strict[surface.id] = [];
  const ratchet: Record<string, Hit[]> = {};
  for (const path of files) {
    const surface = surfaceOf(path);
    const hits = bannedNamesIn(path, readFileSync(path, "utf8"), { navigation: surface?.navigation ?? false }).map((hit): Hit => ({ ...hit, path }));
    if (!hits.length) continue;
    if (surface) {
      strict[surface.id].push(...hits);
      continue;
    }
    for (const hit of hits) {
      if (hit.title) strict.titles.push(hit);
      else (ratchet[path] ??= []).push(hit);
    }
  }
  return { strict, ratchet };
}

/** The manifest's name and description are read on a phone's home screen. */
export function manifestStrings(): { path: string; text: string }[] {
  const path = "public/manifest.json";
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return ["name", "short_name", "description"].flatMap((key) => (typeof manifest[key] === "string" ? [{ path: `${path}#${key}`, text: manifest[key] as string }] : []));
}
