import { test, expect } from "@playwright/test";
import { ALL_PAGES } from "../../lib/workspace/pages";
import { OLD_TO_NEW } from "../../lib/shell/ia";
import { planOldRoute } from "../../lib/shell/old-routes";
import { route } from "../../lib/shell/screens";

/**
 * Owner decision 21: no old page survives Release 1, so every address into a branch of the old shell (Crew, Business, Viral,
 * the Studio overview and its Home, the old Gen view) lands on its board, Make or Settings address, and `route` leaves nothing
 * that the shell would mount as one of those pages. One pure function (lib/shell/screens.ts › route) holds the whole mapping.
 */

/* [old address, where it lands] */
const TABLE: [string, string][] = [
  /* Crew: the room is the board's Crew review (frame m), sessions the Project record (frame n). */
  ["?view=crew", "?view=board&frame=m"],
  ["?view=crew&cp=room", "?view=board&frame=m"],
  ["?view=crew&cp=members", "?view=board&frame=m"],
  ["?view=crew&cp=sessions", "?view=board&frame=n"],
  ["?view=crew&cp=nonsense", "?view=board&frame=m"],
  ["?view=crew&crew=sessions", "?view=board&frame=n"],
  ["?view=crew&project=p1&room=r1&cp=room", "?project=p1&view=board&frame=m"],
  /* Business: the Ads board; the page a link named is the card that holds it. */
  ["?suite=business", "?view=board&kind=ads"],
  ["?suite=ads", "?view=board&kind=ads"],
  ["?suite=moleculr&page=marketing", "?view=board&kind=ads"],
  ["?suite=business&page=dtc", "?view=board&kind=ads&frame=2&card=image-ad"],
  ["?suite=business&page=setup", "?view=board&kind=ads&frame=1"],
  ["?suite=business&page=brand", "?view=board&kind=ads&frame=1&card=brand"],
  ["?suite=business&page=product", "?view=board&kind=ads&frame=1&card=product"],
  ["?suite=business&page=format", "?view=board&kind=ads&frame=2&card=formats"],
  ["?suite=business&page=hooks", "?view=board&kind=ads&frame=2&card=hooks"],
  ["?suite=business&page=reference", "?view=board&kind=ads&frame=1&card=reference"],
  ["?suite=business&page=design", "?view=board&kind=ads&frame=3"],
  ["?suite=moleculr&page=marketing&sp=ads", "?view=board&kind=ads&frame=2&card=image-ad"],
  ["?suite=moleculr&page=marketing&sp=hooks", "?view=board&kind=ads&frame=2&card=hooks"],
  ["?page=marketing", "?view=board&kind=ads"],
  /* Viral: Motion transfer and Object swap are Make's quick tools, History is the Social board's drawer. */
  ["?suite=viral", "?make=motion&view=home"],
  ["?suite=social", "?make=motion&view=home"],
  ["?suite=viral&page=motion", "?make=motion&view=home"],
  ["?suite=viral&page=swap", "?make=swap&view=home"],
  ["?suite=subatomik&sp=swap", "?make=swap&view=home"],
  ["?suite=viral&page=history", "?view=board&kind=social&drawer=history"],
  ["?suite=subatomik&sp=history", "?view=board&kind=social&drawer=history"],
  ["?page=history", "?view=board&kind=social&drawer=history"],
  /* Make's quick tools by their own address. */
  ["?make=motion", "?make=motion&view=home"],
  ["?make=swap", "?make=swap&view=home"],
  ["?make=upscale", "?make=upscale&view=home"],
  /* The Studio overview and the phone's Home: Home. */
  ["?suite=studio", "?view=home"],
  ["?suite=particl", "?view=home"],
  ["?suite=studio&page=stages", "?view=home"],
  ["?suite=studio&page=home", "?view=home"],
  ["?suite=particl&page=brief&sp=stages", "?view=home"],
  ["?suite=particl&page=brief&sp=home", "?view=home"],
  ["?page=brief&sp=stages", "?view=home"],
  ["?suite=particl&sp=home", "?view=home"],
  ["?view=suite", "?view=home"],
  ["?view=suite&suite=particl&page=brief", "?view=board&region=brief"],
  ["?view=nonsense", "?view=home"],
  ["?suite=nonsense&page=nonsense", "?view=home"],
  /* A take link with no page opens the board on it, never a suite page. */
  ["?asset=generation:t1", "?asset=generation%3At1&view=board"],
  ["?suite=particl&asset=generation:t1", "?asset=generation%3At1&view=board"],
  ["?sel=take:t1&project=p", "?sel=take%3At1&project=p&view=board"],
  /* The old Gen view is Make. */
  ["?view=gen", "?make=video&view=home"],
  ["?view=gen&mode=images", "?make=image&view=home"],
  ["?view=make", "?make=video&view=home"],
  ["?view=gen&mode=audio&project=p1", "?project=p1&make=audio&view=home"],
  /* Settings keeps its view. */
  ["?view=workspace&tab=team", "?view=workspace&tab=team"],
];

test("every old address into the Crew, Business, Viral, Studio-home and Gen branches lands on its board, Make or Settings address", () => {
  for (const [from, to] of TABLE) expect(route(from), from).toBe(to);
});

test("the redirect is final: routing a landing address moves it no further", () => {
  for (const [from] of TABLE) {
    const once = route(from);
    expect(route(once), `${from} → ${once}`).toBe(once);
  }
});

/* Every combination of the old suite names, page ids, shell page ids, views and sub-pages: what comes out names a place the shell still has. */
test("no combination of old suite, page, sp and view leaves an address that mounts an old page", () => {
  const suites = [undefined, "studio", "particl", "business", "moleculr", "ads", "viral", "subatomik", "subatomic", "social", "atomik", "agent", "nonsense"];
  const pages = [undefined, "home", "stages", "nonsense", ...ALL_PAGES.map((p) => p.id), "dtc", "setup", "brand", "product", "format", "hooks", "reference", "design", "ads", "motion", "swap", "history", "room", "members", "sessions"];
  const sps = [undefined, "home", "stages", "ads", "dtc", "history", "motion", "nonsense"];
  const views = [undefined, "crew", "suite", "gen", "make", "nonsense"];
  const bad: string[] = [];
  let n = 0;
  for (const suite of suites) for (const page of pages) for (const sp of sps) for (const view of views) {
    const q = new URLSearchParams();
    if (view) q.set("view", view);
    if (suite) q.set("suite", suite);
    if (page) q.set("page", page);
    if (sp) q.set("sp", sp);
    if (view === "crew") q.set("cp", "room");
    const from = `?${q}`;
    const to = new URLSearchParams(route(from));
    n++;
    const reason: string[] = [];
    const landed = to.get("view");
    if (landed ? !["home", "board", "workspace"].includes(landed) : to.get("suite") !== "atomik") reason.push("no place");
    if (to.has("cp") || to.has("room") || to.has("crew")) reason.push("crew param");
    /* The one suite a landing keeps is Atomik's control room, and only without a view. */
    if (!landed && to.get("suite") === "atomik" && ["particl", "moleculr", "subatomik"].includes(to.get("page") ?? "")) reason.push("old suite page");
    /* The suite and page left beside a view are the state layer's backing params (a mismatched pair like suite=viral&page=brief keeps them,
       respelt on a second pass); the place itself must not move again. */
    const again = new URLSearchParams(route(`?${to}`));
    if (again.get("view") !== to.get("view") || again.get("kind") !== to.get("kind") || again.get("region") !== to.get("region") || again.get("make") !== to.get("make")) reason.push("not final");
    if (reason.length) bad.push(`${from} → ?${to}: ${reason.join(", ")}`);
  }
  expect(n).toBeGreaterThan(10_000);
  expect(bad.slice(0, 20)).toEqual([]);
});

test("every design-file spelling in OLD_TO_NEW for a retired page lands on a place the shell has", () => {
  for (const row of OLD_TO_NEW) {
    const to = new URLSearchParams(route(row.from));
    const view = to.get("view");
    expect(view ? ["home", "board", "workspace"].includes(view) : to.get("suite") === "atomik", `${row.from} → ${route(row.from)}`).toBe(true);
  }
});

/* The old routes (paths) that carry the same params into /suites go through the same function: one hop, to the new address. */
const go = (pathname: string, search = ""): string => planOldRoute(pathname, search)!.to(null);
test("the old entry points hand these branches' params to the same function", () => {
  const ROWS: [string, string, string][] = [
    ["/workspace", "view=crew&cp=sessions", "/suites?view=board&frame=n"],
    ["/workspace", "view=crew", "/suites?view=board&frame=m"],
    ["/workspace", "suite=business&page=hooks", "/suites?view=board&kind=ads&frame=2&card=hooks"],
    ["/workspace", "suite=viral&page=swap", "/suites?make=swap&view=home"],
    ["/workspace", "suite=viral&page=history", "/suites?view=board&kind=social&drawer=history"],
    ["/workspace", "page=stages", "/suites?view=home"],
    ["/workspace", "page=home", "/suites?view=home"],
    ["/workbench", "stage=stages", "/suites?view=home"],
    ["/workbench", "stage=home", "/suites?view=home"],
    ["/workbench", "view=crew&project=p1", "/suites?project=p1&view=board&frame=m"],
    ["/workbench", "view=gen", "/suites?make=video&view=home"],
    ["/workbench", "make=swap", "/suites?make=swap&view=home"],
    ["/", "view=crew&cp=members", "/suites?view=board&frame=m"],
    ["/", "suite=viral", "/suites?make=motion&view=home"],
    ["/subatomik", "page=history", "/suites?view=board&kind=social&drawer=history"],
    ["/subatomik", "page=swap", "/suites?make=swap&view=home"],
  ];
  for (const [path, search, to] of ROWS) expect(go(path, search), `${path}?${search}`).toBe(to);
});
