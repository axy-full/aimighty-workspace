import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NAV_SUITES, SITE_SUITES } from "../../lib/marketing/site";
import { MOVED_PAGES } from "../../lib/marketing/moved";
import { SESSION_COOKIE } from "../../lib/sessionCookie";

/**
 * The public site's addresses and words (owner, 7 October). /business, /viral and /workspace became /ads, /social
 * and /settings; the old addresses move for good. The pages say nothing the product no longer has, and none of the
 * words the product retired. Sources only: tests/marketing-site-workbench.spec.ts checks the rendered pages.
 */
const ROOTS = ["app/(marketing)", "components/marketing", "lib/marketing"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(at) : /\.tsx?$/.test(entry.name) ? [at] : [];
  });
}

/** What a file can put on a page, or into a link: its string and template literals and its JSX text, never comments. */
function renderable(file: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** moved.ts is the one file that names the old addresses: it is the table that retires them. */
const files = () => ROOTS.flatMap(sources).filter((file) => !file.endsWith("moved.ts"));

/** Words the public site never prints (the product's one vocabulary; Astra only as "Topaz Astra 2"). */
const BANNED: readonly (readonly [string, RegExp])[] = [
  ["Moleculr", /\bmoleculr\b/i],
  ["Subatomik", /\bsubatomi[ck]\b/i],
  ["Rig", /\brig\b/i],
  ["Genjutsu", /\bgenjutsu\b/i],
  ["Soul", /\bsoul\b/i],
  ["Higgsfield", /\bhiggsfield\b/i],
  ["Persona", /\bpersona\b/i],
  ["Astra outside Topaz Astra 2", /(?<!\bTopaz )\bastra\b/i],
  ["Gen as a place", /\bgen\b(?!-)/],
  ["Generate as a place", /\b(?:open|in|to|from|the) generate\b|\bgenerate (?:page|tab|panel)\b/i],
  ["suite", /\bsuites?\b/i],
  ["stage", /\bstages?\b/i],
  ["Business", /\bbusiness\b/i],
  ["Viral", /\bviral\b/i],
  ["Workspace", /\bworkspaces?\b/i],
  ["a page Atomik no longer has", /\b(?:Crew|Recipes?|Builds)\b/],
  ["a project the site must not name", /\bdune studies\b/i],
];

/** Import paths, ids, class names and file names are not copy; everything else the files can print is. */
const isCode = (text: string) =>
  /^(?:@\/|\.{1,2}\/|node:|next\/|react)/.test(text) || /^[\w./-]+\.(?:css|webp|jpg|png)$/.test(text)
  || /^[a-z][\w:/.#-]*$/.test(text) || /^\/\S*$/.test(text) || text.split(/\s+/).every((token) => /^(?:mk|gx)-/.test(token));

test("the public site prints none of the words the product retired", () => {
  const all = files();
  expect(all.length, "the site's sources were found").toBeGreaterThan(10);
  const found = all.flatMap((file) => renderable(file).filter((text) => !isCode(text)).flatMap((text) =>
    BANNED.filter(([, pattern]) => pattern.test(text)).map(([name]) => `${file}: ${name} in "${text.slice(0, 80)}"`)));
  expect(found).toEqual([]);
});

test("no public page links to an address that moved", () => {
  const found = files().flatMap((file) => renderable(file).filter((text) => /^\/(?:business|viral|workspace)(?:[/?#]|$)/.test(text) || /\/site\/(?:business|viral|workspace)\b/.test(text))
    .map((text) => `${file}: ${text}`));
  expect(found).toEqual([]);
  expect(SITE_SUITES.map((suite) => suite.href)).toEqual(["/studio", "/ads", "/social", "/", "/atomik", "/settings"]);
  expect(NAV_SUITES.map((suite) => suite.tab)).toEqual(["Studio", "Ads", "Social", "Make", "Atomik"]);
});

test("each place lists only what the product has", () => {
  const pages = (id: string) => SITE_SUITES.find((suite) => suite.id === id)!.pages;
  expect(pages("studio")).toEqual(["Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver"]);
  expect(pages("atomik")).toEqual(["Approvals", "Activity", "Skills", "Memory"]);
  expect(pages("settings")).toEqual(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced"]);
  expect(pages("social")).toEqual(["Source", "Motion transfer", "Object swap", "History"]);
});

/* ── The addresses ──────────────────────────────────────────────────────────────────────────────────────────────── */

const ORIGIN = "http://localhost:4551";

async function run(pathAndQuery: string, headers: Record<string, string> = {}) {
  const { NextRequest } = await import("next/server.js");
  const { proxy } = await import("../../proxy");
  return proxy(new NextRequest(`${ORIGIN}${pathAndQuery}`, { headers }));
}
const where = (res: Response) => { const to = res.headers.get("location"); return to ? new URL(to).pathname + new URL(to).search : null; };
const rewritten = (res: Response) => { const to = res.headers.get("x-middleware-rewrite"); return to ? new URL(to).pathname : null; };

test("the old public addresses move for good, with the query kept", async () => {
  expect(Object.fromEntries(Object.entries(MOVED_PAGES).map(([from, { to }]) => [from, to]))).toEqual({
    "/business": "/ads", "/viral": "/social", "/workspace": "/settings",
  });
  for (const [from, to, query] of [
    ["/business", "/ads", ""], ["/viral", "/social", ""], ["/workspace", "/settings", ""],
    ["/business", "/ads", "?utm_source=mail&ref=a%20b"], ["/viral", "/social", "?x=1"], ["/workspace", "/settings", "?utm_campaign=launch"],
  ] as const) {
    const res = await run(`${from}${query}`);
    /* /workspace is the app's address for a member, so its move is temporary (307); the other two are final. */
    expect(res.status, `${from}${query}`).toBe(from === "/workspace" ? 307 : 308);
    expect(where(res), `${from}${query}`).toBe(`${to}${query}`);
  }
});

test("a signed-in member's /workspace is still the app's, and so is a link that names a project", async () => {
  for (const request of [
    () => run("/workspace", { cookie: `${SESSION_COOKIE}=anything` }),
    () => run("/workspace?project=p1&suite=particl"),
  ]) {
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(rewritten(res)).toBeNull();
  }
});

test("the new addresses show the site, and the old internal paths go straight to the new", async () => {
  for (const [from, to] of [["/ads", "/site/ads"], ["/social", "/site/social"], ["/studio", "/site/studio"], ["/settings", "/site/settings"]] as const) {
    expect(rewritten(await run(from)), from).toBe(to);
  }
  /* A member's /settings is the app's old route; the three always-public pages stay public for them too. */
  expect(rewritten(await run("/settings", { cookie: `${SESSION_COOKIE}=anything` }))).toBeNull();
  expect(rewritten(await run("/ads", { cookie: `${SESSION_COOKIE}=anything` }))).toBe("/site/ads");
  /* A doubled slash is not a host-relative address. */
  const doubled = await run("/site//evil.test/x");
  expect(where(doubled)).toBe("/evil.test/x");
  for (const [from, to] of [["/site/ads", "/ads"], ["/site/business", "/ads"], ["/site/viral?x=1", "/social?x=1"], ["/site/workspace", "/settings"], ["/site/studio", "/studio"]] as const) {
    const res = await run(from);
    expect(res.status, from).toBe(308);
    expect(where(res), from).toBe(to);
  }
});

test("a link that goes outside the app never names the public /settings or /workspace address", () => {
  /* /settings is the public page for anyone signed out, so a pushed or emailed link opens Settings in the app. */
  const held = readFileSync("lib/held.ts", "utf8");
  expect(held).not.toMatch(/["'`]\/(?:settings|workspace)\b|\}\/(?:settings|workspace)\b/);
  expect(held).toContain("SETTINGS_CREDITS");
  expect(readFileSync("lib/shell/settings.ts", "utf8")).toContain('SETTINGS_CREDITS = "/suites?view=workspace&tab=credits"');
});

test("every public page is served by the one site route", () => {
  const route = readFileSync("app/(marketing)/site/[[...slug]]/page.tsx", "utf8");
  for (const key of ["studio", "ads", "social", "atomik", "settings", "pricing"]) expect(route, key).toMatch(new RegExp(`\\n  ${key}: \\{ Page:`));
  for (const key of ["business", "viral", "workspace"]) expect(route, key).not.toMatch(new RegExp(`\\n  ${key}: \\{ Page:`));
  const config = readFileSync("proxy.ts", "utf8");
  for (const matcher of ['"/ads"', '"/social"', '"/settings"', '"/business"', '"/viral"', '"/workspace"']) expect(config, matcher).toContain(matcher);
});
