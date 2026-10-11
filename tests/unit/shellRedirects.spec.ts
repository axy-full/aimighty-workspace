import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OLD_TO_NEW, PENDING, SHELL_PATH, normalize, redirectFor } from "../../lib/shell/ia";
import { resolveSuite } from "../../lib/workspace/pages";
import { fromSearch } from "../../lib/workspace/navigation";

/**
 * Old links → new (design/particl-graphite/README.md § 1.2; lib/shell/ia.ts). Every old page and link is either
 * rewritten (OLD_TO_NEW) or still served by its old page until the package that replaces it ships (PENDING);
 * D0 PR 3a ships only the rewrites of the design file's spellings into the app's.
 */
const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8");
/** Two searches name the same place when they carry the same params, whatever their order. */
const same = (a: string, b: string) => {
  const sorted = (s: string) => [...new URLSearchParams(s).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return sorted(a) === sorted(b);
};
const inOld = (url: string) => OLD_TO_NEW.filter((r) => same(r.from, url)).length;
const inPending = (url: string) => PENDING.filter((r) => (url.startsWith("/") ? r.from === url : !r.from.startsWith("/") && same(r.from, url))).length;

test("each normalisation row rewrites its design-form link to the app's form, as a 307 the server sends", () => {
  for (const row of OLD_TO_NEW) {
    expect(normalize(row.from), row.from).toBe(row.to);
    expect(redirectFor(SHELL_PATH, row.from), row.from).toBe(SHELL_PATH + row.to);
    expect(row.ships, row.from).toBe("D0-3");
  }
});

test("the design file's spellings land on the app's pages", () => {
  const cases: [string, string][] = [
    ["?suite=atomik&page=memory", "?suite=atomik&page=agent&sp=memory"],
    ["?suite=atomik&page=saved-skills", "?suite=atomik&page=agent&sp=saved-skills"],
    ["?suite=studio&page=beats", "?suite=particl&page=brief&sp=beats"],
    ["?suite=studio&page=env", "?suite=particl&page=boards&sp=environment"],
    ["?suite=studio&page=stages", "?suite=particl&page=brief&sp=stages"],
    ...["design", "setup", "brand", "product", "reference", "format", "hooks", "dtc"].map((p): [string, string] => [`?suite=business&page=${p}`, `?suite=moleculr&page=marketing&sp=${p}`]),
    ["?suite=business", "?suite=moleculr"],
    ["?suite=viral", "?suite=subatomik"],
    ["?suite=studio", "?suite=particl"],
    ["?suite=particl&page=rig&palette=1", "?suite=particl&page=rig&find=1"],
    ["?suite=particl&page=rig&lib=0&insp=0", "?suite=particl&page=rig"],
    ["?suite=particl&page=rig&lib=assets", "?suite=particl&page=rig"],
    ["?view=crew&crew=members", "?view=crew&cp=members"],
    ["?view=workspace&ws=people", "?view=workspace&tab=people"],
    ["?view=make", "?view=gen"],
  ];
  for (const [from, to] of cases) expect(normalize(from), from).toBe(to);
  /* What the app reads from the rewritten link is the page the design file named. */
  expect(fromSearch(normalize("?suite=business&page=hooks"))).toMatchObject({ suite: "moleculr", page: "marketing", view: "studio" });
  expect(fromSearch(normalize("?suite=atomik&page=memory"))).toMatchObject({ suite: "atomik", page: "agent", view: "studio" });
  expect(fromSearch(normalize("?suite=studio&page=beats"))).toMatchObject({ suite: "particl", page: "brief", view: "studio" });
});

test("the suite spellings agree with the state layer's aliases", () => {
  for (const [from, to] of [["studio", "particl"], ["business", "moleculr"], ["viral", "subatomik"], ["agent", "atomik"], ["subatomic", "subatomik"]]) {
    expect(new URLSearchParams(normalize(`?suite=${from}`)).get("suite")).toBe(to);
    expect(resolveSuite(from)).toBe(to);
  }
});

test("the app's own links are left alone: no redirect, and a rewrite is never rewritten again", () => {
  for (const search of ["", "?suite=particl&page=brief&sp=beats", "?suite=moleculr&page=marketing&sp=hooks", "?view=gen", "?view=workspace&tab=credits", "?view=crew&cp=room", "?find=1", "?page=takes&sp=takes&asset=generation:gen_1"]) {
    expect(redirectFor(SHELL_PATH, search), search).toBeNull();
  }
  for (const row of [...OLD_TO_NEW.map((r) => r.from), "?suite=studio&page=beats&lib=0&palette=1&crew=room"]) {
    const once = normalize(row);
    /* Idempotent, and no chains: the target needs no redirect of its own. */
    expect(normalize(once), row).toBe(once);
    expect(redirectFor(SHELL_PATH, once), row).toBeNull();
  }
  /* Only the shell's own path is rewritten; every old route is PENDING (docs/old-shells.md). */
  expect(redirectFor("/workspace", "?suite=studio&page=beats")).toBeNull();
  expect(redirectFor("/suites/other", "?suite=studio")).toBeNull();
});

test("every other param rides along: project, asset, sel, ws, production, import, find, q, higgsfield", () => {
  const carried = { project: "ws-1", asset: "generation:gen_1", sel: "shot:s1", ws: "w_42", production: "prod_7", import: "board_3", find: "1", q: "go to cast", higgsfield: "1" };
  for (const row of OLD_TO_NEW) {
    /* A Workspace row's own `ws` is its section; the link's workspace is checked on its own below. */
    const extra = Object.fromEntries(Object.entries(carried).filter(([key]) => !new URLSearchParams(row.from).has(key)));
    const out = new URLSearchParams(normalize(`${row.from || "?"}${row.from ? "&" : ""}${new URLSearchParams(extra)}`));
    for (const [key, value] of Object.entries(extra)) expect(out.get(key), `${row.from} keeps ${key}`).toBe(value);
  }
  /* A link to a take keeps its workspace (`ws`), even on the Workspace view, where `ws` is otherwise the design file's section. */
  expect(new URLSearchParams(normalize("?view=workspace&ws=people&asset=generation:gen_1")).get("ws")).toBe("people");
  /* A workspace id that is not an old section is never read as one. */
  expect(normalize("?view=workspace&ws=w_42")).toBe("?view=workspace&ws=w_42");
});

/**
 * README § 1.2, row by row: each row's old links in the design file's form and, where it differs, the app's form.
 * The keys are the rows' first cells, so a row added to or taken from the README fails here until it is mapped.
 */
const README_ROWS: Record<string, string[]> = {
  "`?suite=studio&page=stages` (Studio overview)": ["?suite=studio&page=stages", "?suite=particl&page=brief&sp=stages"],
  "`?suite=studio&page=brief` (01 Brief & Script)": ["?suite=studio&page=brief", "?suite=particl&page=brief"],
  "`?suite=studio&page=beats` (02 Beats & Shots)": ["?suite=studio&page=beats", "?suite=particl&page=brief&sp=beats"],
  "`?suite=studio&page=boards` (03 Storyboards)": ["?suite=studio&page=boards", "?suite=particl&page=boards"],
  "`?suite=studio&page=env` (04 Environment)": ["?suite=studio&page=env", "?suite=studio&page=environment", "?suite=particl&page=boards&sp=environment"],
  "`?suite=studio&page=cast` (05 Cast & Elements)": ["?suite=studio&page=cast", "?suite=particl&page=cast"],
  "`?suite=studio&page=astra` (06 Astra 3D)": ["?suite=studio&page=astra", "?suite=particl&page=astra"],
  "`?suite=studio&page=rig` (07 Rig · canvas / `&rig=list`)": ["?suite=studio&page=rig", "?suite=studio&page=rig&rig=list", "?suite=particl&page=rig", "?suite=particl&page=rig&rig=list"],
  "`?suite=studio&page=takes` (08 Takes)": ["?suite=studio&page=takes", "?suite=particl&page=takes"],
  "`?suite=studio&page=edit` (09 Edit & Sound)": ["?suite=studio&page=edit", "?suite=particl&page=edit"],
  "`?suite=studio&page=deliver` (10 Deliver)": ["?suite=studio&page=deliver", "?suite=particl&page=deliver"],
  "`?view=gen&mode=video\\|images\\|audio` (Gen), `&task=edit\\|upscale`, `&sheet=1`": ["?view=gen", "?view=gen&mode=video", "?view=gen&mode=images", "?view=gen&mode=audio", "?view=gen&task=edit", "?view=gen&task=upscale", "?view=gen&sheet=1"],
  "`?suite=business&page=dtc` (Image ads)": ["?suite=business&page=dtc", "?suite=moleculr&page=marketing&sp=dtc"],
  "`?suite=business&page=setup`": ["?suite=business&page=setup", "?suite=moleculr&page=marketing&sp=setup"],
  "`?suite=business&page=brand \\| product \\| reference`": ["brand", "product", "reference"].flatMap((p) => [`?suite=business&page=${p}`, `?suite=moleculr&page=marketing&sp=${p}`]),
  "`?suite=business&page=format \\| hooks`": ["format", "hooks"].flatMap((p) => [`?suite=business&page=${p}`, `?suite=moleculr&page=marketing&sp=${p}`]),
  "`?suite=business&page=design` (poster Designer)": ["?suite=business&page=design", "?suite=moleculr&page=marketing&sp=design"],
  "`?suite=viral&page=motion \\| swap` (Genjutsu)": ["motion", "swap"].flatMap((p) => [`?suite=viral&page=${p}`, `?suite=subatomik&page=${p}`]),
  "`?suite=viral&page=history`": ["?suite=viral&page=history", "?suite=subatomik&page=history"],
  "`?view=crew&crew=room \\| members \\| sessions`": ["room", "members", "sessions"].flatMap((p) => [`?view=crew&crew=${p}`, `?view=crew&cp=${p}`]),
  "`?suite=atomik&page=agent`": ["?suite=atomik&page=agent"],
  "`?suite=atomik&page=runs`": ["?suite=atomik&page=runs"],
  "`?suite=atomik&page=approvals`": ["?suite=atomik&page=approvals"],
  "`?suite=atomik&page=budget`": ["?suite=atomik&page=budget"],
  "`?suite=atomik&page=models`": ["?suite=atomik&page=models"],
  "`?suite=atomik&page=skills` (Tools & connections)": ["?suite=atomik&page=skills"],
  "`?suite=atomik&page=memory`, `page=saved-skills`": ["memory", "saved-skills"].flatMap((p) => [`?suite=atomik&page=${p}`, `?suite=atomik&page=agent&sp=${p}`]),
  "`?view=workspace&ws=general \\| people \\| credits \\| usage \\| dashboard \\| engines \\| security`":
    ["general", "people", "credits", "usage", "dashboard", "engines", "security"].flatMap((t) => [`?view=workspace&ws=${t}`, `?view=workspace&tab=${t}`]),
  /* The no-op params have no page of their own: the design form alone, which drops to the page it was on. */
  "`&lib=0 \\| assets`, `&insp=0`": ["?lib=0", "?lib=assets", "?insp=0"],
  "`&palette=1`, `&beats=graph`": ["?palette=1", "?find=1", "?suite=studio&page=beats&beats=graph", "?suite=particl&page=brief&sp=beats&beats=graph"],
};

test("every README § 1.2 link, in the design file's form and the app's, is in exactly one of OLD_TO_NEW and PENDING", () => {
  const readme = read("design", "particl-graphite", "README.md");
  const section = readme.slice(readme.indexOf("### 1.2"), readme.indexOf("## 2 ·"));
  const rows = section.split("\n").filter((line) => line.startsWith("| `") || line.startsWith("| &")).map((line) => line.slice(2, line.indexOf(" | ")));
  expect(rows.sort()).toEqual(Object.keys(README_ROWS).sort());
  for (const [row, urls] of Object.entries(README_ROWS)) {
    for (const url of urls) {
      const old = inOld(url), pending = inPending(url);
      expect(old + pending, `${row}: ${url} is in exactly one list (OLD_TO_NEW ${old}, PENDING ${pending})`).toBe(1);
      /* A rewrite lands on the app's form, which its old page still serves until its package ships. */
      if (old) {
        const to = normalize(url);
        if (to) expect(inPending(to), `${url} → ${to} is PENDING`).toBe(1);
      }
    }
  }
});

test("every route docs/old-shells.md lists is PENDING, retired in D1", () => {
  const doc = read("docs", "old-shells.md");
  const routes = doc.split("\n").filter((line) => /^\| `\//.test(line)).flatMap((line) => line.slice(2, line.indexOf(" | ")).match(/`[^`]+`/g)!.map((r) => r.slice(1, -1)));
  expect(routes.length).toBeGreaterThan(40);
  for (const route of routes) {
    const rows = PENDING.filter((r) => r.from === route);
    expect(rows, route).toHaveLength(1);
    expect(rows[0].ships, route).toBe("D1");
  }
  /* And nothing else is listed as an old route. */
  expect(PENDING.filter((r) => r.from.startsWith("/")).map((r) => r.from).sort()).toEqual([...routes].sort());
});

test("PENDING names the package that retires each old link, and lists each once", () => {
  const froms = PENDING.map((r) => r.from);
  expect(new Set(froms).size).toBe(froms.length);
  const counts = PENDING.reduce<Record<string, number>>((n, r) => ({ ...n, [r.ships]: (n[r.ships] ?? 0) + 1 }), {});
  expect(Object.keys(counts).sort()).toEqual(["D0-5", "D1", "S3", "S4", "U1"]);
  /* Nothing is pending on the PR that ships the rewrites. */
  expect(counts["D0-3"]).toBeUndefined();
});
