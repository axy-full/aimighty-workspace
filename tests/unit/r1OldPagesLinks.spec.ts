import { test, expect } from "@playwright/test";
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
