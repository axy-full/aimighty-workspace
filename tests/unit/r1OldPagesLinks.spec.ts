import { test, expect } from "@playwright/test";
import { SCREENS, route } from "../../lib/shell/screens";
import { newPaletteIndex } from "../../lib/shell/palette";
import { STUDIO_RAIL } from "../../lib/board/regions";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Release 1 has one design (OLD-PAGES audit, step 2): the new shell links to no old page. This reads the source of the
 * new shell and fails on a link to a retired route. Routes that stay (the admin desk, printable statements, account
 * security, sign-in and the legal pages) are not in the list. `/workbench` is allowed only where it is the sign-in
 * hand-off for an account with no workspace (lib/signIn.ts).
 */
const ROOT = join(__dirname, "..", "..");
const DIRS = ["components/graphite", "lib/shell", "lib/board", "lib/control-room"];
const RETIRED = [
  "workbench", "workspace", "team", "connect", "settings", "usage", "library", "all", "productions", "pipelines",
  "generate", "images", "audio", "make", "dashboard", "atomik", "subatomik", "subatomic", "rig", "canvas", "projects",
];
/* A quoted string that starts with one of the retired paths: "/team", '/settings#x', `/projects/${id}/canvas`. */
const LINK = new RegExp("[\"'`]/(" + RETIRED.join("|") + ")([/?#\"'`]|$)", "m");
/* Files whose job is to name an old address in order to move it (the redirect tables and their readers). */
const NAMES_OLD_ADDRESSES = new Set([
  "lib/shell/ia.ts", "lib/shell/old-routes.ts", "lib/shell/bootstrap.server.ts", "lib/shell/screens.ts",
]);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) yield* files(rel);
    else if (/\.(ts|tsx)$/.test(name)) yield rel;
  }
}

test("the new shell links to no retired page", () => {
  const found: string[] = [];
  for (const dir of DIRS)
    for (const file of files(dir)) {
      if (NAMES_OLD_ADDRESSES.has(file)) continue;
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
        const text = line.trim();
        if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
        if (/\/api\//.test(text) || /^import /.test(text)) return;
        if (LINK.test(text)) found.push(`${file}:${i + 1}: ${text.slice(0, 120)}`);
      });
    }
  expect(found).toEqual([]);
});

test("the project picker has no old-dialog fallback, and the two Settings rows name their own folds", () => {
  const head = readFileSync(join(ROOT, "components/graphite/ProjectHead.tsx"), "utf8");
  expect(head).not.toContain("workbench?new=1");
  const team = readFileSync(join(ROOT, "components/graphite/settings/team/TeamSection.tsx"), "utf8");
  expect(team).not.toContain('"/team"');
  const connect = readFileSync(join(ROOT, "components/graphite/ConnectRow.tsx"), "utf8");
  expect(connect).toContain("view=workspace&tab=connections");
  expect(connect).not.toContain('href="/connect"');
});

/**
 * Owner decision 21 (no old page survives Release 1), second cut: Business, Viral, Crew, the Studio overview and its Home, the
 * Library column and the old Inspector are gone, so no in-app link or command may aim at them. Their addresses are rewritten by
 * `route` (tests/unit/r1OldShellRoutes.spec.ts); this reads the source for the in-app callers of the retired places.
 */
const RETIRED_CALLS: [string, RegExp][] = [
  ["goSuite to Business or Viral", /goSuite\(\s*["'`](business|viral)/],
  ["goSuite to the Studio overview or Home", /goSuite\(\s*["'`]studio["'`]\s*,\s*["'`](stages|home)["'`]/],
  ["goCrew", /goCrew\b/],
  ["the Crew view address", /view=crew|view:\s*["'`]crew["'`]/],
  ["the Studio overview or Home as a page id", /page:\s*["'`](stages|home)["'`]|page\.id\s*===\s*["'`](stages|home)["'`]|sp=(stages|home)\b/],
  ["the old Inspector and Library columns", /shell\.(toggleInspector|openInspector|toggleLibrary|openLibrary|closePanels)\b|\b(libOpen|inspOpen)\b/],
];
/* The redirect tables name old addresses to move them; they are not links. */
const MAY_NAME_RETIRED = new Set([...NAMES_OLD_ADDRESSES, "lib/shell/stage-redirects.ts", "lib/board/routes.ts", "components/graphite/home/routes.ts", "lib/shell/ads-social.ts", "lib/shell/make.ts"]);

test("no in-app link or command targets Business, Viral, Crew, the Studio overview or Home, or the old Inspector and Library", () => {
  const found: string[] = [];
  for (const dir of DIRS)
    for (const file of files(dir)) {
      if (MAY_NAME_RETIRED.has(file)) continue;
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
        const text = line.trim();
        if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
        for (const [what, pattern] of RETIRED_CALLS) if (pattern.test(text)) found.push(`${file}:${i + 1} (${what}): ${text.slice(0, 110)}`);
      });
    }
  expect(found).toEqual([]);
});

test("the shell's types no longer name the retired places", () => {
  const ia = readFileSync(join(ROOT, "lib/shell/ia.ts"), "utf8");
  expect(ia).toMatch(/export type ShellSuiteId = "studio" \| "atomik";/);
  expect(ia).toMatch(/export type ShellView = "suite" \| "workspace" \| "home" \| "board";/);
  expect(ia).not.toMatch(/CrewPageId|CREW_PAGES|SHELL_PAGE_ALIASES/);
  const state = readFileSync(join(ROOT, "lib/shell/state.tsx"), "utf8");
  expect(state).not.toMatch(/goCrew|crewPage|viralTool|fromMakeLink/);
});

test("no screen row and no ⌘K row targets a retired place", () => {
  /* A row's `to` is a board, Home, Settings, Make or Atomik's control room; never a Crew page, Business, Viral or the Studio overview. */
  for (const screen of SCREENS)
    for (const row of [...screen.rows, ...screen.fallback]) {
      const to = new URLSearchParams(row.to);
      const place = to.get("view") ?? (to.get("suite") === "atomik" ? "atomik" : to.get("make") ? "make" : to.get("atomik") ? "atomik" : null);
      expect(place, `${screen.id}: ${row.from} → ${row.to}`).toMatch(/^(home|board|workspace|atomik|make)$/);
      expect(to.get("view"), row.to).not.toBe("crew");
    }
  const palette = newPaletteIndex({ rail: STUDIO_RAIL, models: [], assets: [] });
  for (const row of palette) expect(["gen", "home", "region", "board", "atomik", "control", "settings", "model", "asset", "ask"], `${row.group}: ${row.label}`).toContain(row.run.type);
  /* …and a retired address in the palette's own words is still routed. */
  expect(route("?view=crew&cp=room")).toBe("?view=board&frame=m");
});
