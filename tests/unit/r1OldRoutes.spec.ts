import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PAGES as LEGACY_PAGES, MOLECULR_SECTIONS, PARTICL_STAGE_ALIASES } from "../../lib/suites";
import { redirectFor } from "../../lib/shell/ia";
import { fromMakeLink } from "../../lib/shell/make";
import { planOldRoute } from "../../lib/shell/old-routes";
import { route } from "../../lib/shell/screens";

/**
 * Release 1 has one design: every old address that has a new screen redirects to it, in ONE hop (OLD-PAGES audit, step 3).
 * Each row is [old address, final address]. The target is final when /suites would move it no further.
 */
const go = (pathname: string, search = "", project: string | null = null): string => planOldRoute(pathname, search)!.to(project);

const ROWS: [string, string, string][] = [
  /* The entry points. */
  ["/", "", "/suites?view=home"],
  ["/", "project=p1", "/suites?project=p1&view=home"],
  ["/", "suite=moleculr", "/suites?view=board&kind=ads"],
  ["/workspace", "", "/suites?view=home"],
  ["/workspace", "project=p1&suite=particl", "/suites?project=p1&view=home"],
  ["/workspace", "project=p1&suite=particl&page=cast", "/suites?project=p1&view=board&region=cast"],
  ["/workspace", "project=p1&suite=atomik&page=runs", "/suites?project=p1&suite=atomik&page=runs"],
  ["/workbench", "", "/suites?view=home"],
  ["/workbench", "project=p1", "/suites?project=p1&view=home"],
  ["/workbench", "project=p1&stage=cast", "/suites?project=p1&view=board&region=cast"],
  ["/workbench", "project=p1&stage=canvas", "/suites?project=p1&view=board"],
  ["/workbench", "stage=brief&shell=legacy&new=1", "/suites?view=board&region=brief"],
  ["/workbench", "stage=assets&sel=take:t_1&project=p", "/suites?project=p&sel=take%3At_1&view=board&region=shots"],
  ["/workbench", "suite=moleculr&page=brand&project=p1", "/suites?project=p1&view=board&kind=ads&frame=1&card=brand"],
  ["/workbench", "atomik=marketing", "/suites?view=board&kind=ads"],
  ["/workbench", "view=workspace&tab=team", "/suites?view=workspace&tab=team"],
  ["/atomik", "", "/suites?atomik=1&view=home"],
  ["/atomik", "project=p1", "/suites?project=p1&atomik=1&view=home"],
  ["/atomik", "page=approvals", "/suites?suite=atomik&page=approvals"],
  ["/atomik", "page=runs", "/suites?suite=atomik&page=runs"],
  ["/atomik", "page=memory", "/suites?suite=atomik&page=agent&sp=memory"],
  ["/atomik", "page=budget", "/suites?view=workspace&tab=rules"],
  ["/atomik", "page=models", "/suites?view=workspace&tab=advanced&open=models"],
  ["/subatomik", "", "/suites?make=motion&view=home"],
  ["/subatomic", "", "/suites?make=motion&view=home"],
  ["/subatomik", "page=object-swap&project=v1", "/suites?project=v1&make=swap&view=home"],
  ["/subatomik", "page=history", "/suites?view=board&kind=social&drawer=history"],
  ["/subatomik", "page=shorts&project=v1", "/suites?project=v1&make=motion&view=home"],
  /* Make: the type directly, the project and every handoff param kept. */
  ["/generate", "", "/suites?make=video&view=home"],
  ["/generate", "mode=images&project=p1&ref=lib_1", "/suites?project=p1&ref=lib_1&make=image&view=home"],
  ["/generate", "mode=audio", "/suites?make=audio&view=home"],
  ["/images", "project=p1", "/suites?project=p1&make=image&view=home"],
  ["/audio", "", "/suites?make=audio&view=home"],
  ["/make/video", "project=p1", "/suites?project=p1&make=video&view=home"],
  ["/make/image", "", "/suites?make=image&view=home"],
  ["/make/images", "", "/suites?make=image&view=home"],
  ["/make/audio", "", "/suites?make=audio&view=home"],
  /* The library wall and the productions list. */
  ["/library", "", "/suites?make=recent&view=home"],
  ["/library", "project=p1&view=unfiled", "/suites?project=p1&make=recent&view=home"],
  ["/all", "", "/suites?make=recent&view=home"],
  ["/productions", "", "/suites?view=home"],
  /* Runs, the dashboard and the settings folds. */
  ["/rig/run/r1", "project=x", "/suites?suite=atomik&page=runs"],
  ["/pipelines", "projectId=x", "/suites?suite=atomik&page=runs"],
  ["/dashboard", "", "/suites?suite=atomik&page=runs"],
  ["/settings", "", "/suites?view=workspace&tab=advanced&open=workspace"],
  ["/team", "", "/suites?view=workspace&tab=team"],
  ["/usage", "", "/suites?view=workspace&tab=credits&open=usage"],
  ["/connect", "", "/suites?view=workspace&tab=connections"],
];

test("each old address goes to the exact new address it names", () => {
  for (const [pathname, search, final] of ROWS) expect(go(pathname, search), `${pathname}?${search}`).toBe(final);
});

test("every target is final: /suites moves none of them again", () => {
  for (const [pathname, search] of ROWS) {
    const [, query = ""] = go(pathname, search).split("?");
    expect(redirectFor("/suites", query), `${pathname}?${search}: spelling`).toBeNull();
    expect(fromMakeLink(query), `${pathname}?${search}: make link`).toBeNull();
    const settled = route(query);
    expect(new URLSearchParams(settled).toString(), `${pathname}?${search}: screen registry`).toBe(new URLSearchParams(query).toString());
  }
});

/* The pages whose id belongs to a production project (or a board) are sent to the Studio project that holds its work. */
const LOOKUPS: [string, string, { kind: string; id: string }, string, string][] = [
  ["/productions/pr1/pj1/media", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board&region=shots", "/suites?view=home"],
  ["/productions/pr1/pj1/shots", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board&region=shots", "/suites?view=home"],
  ["/projects/pj1/canvas", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board", "/suites?view=home"],
  ["/canvas/pj1", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board", "/suites?view=home"],
  ["/projects/pj1/rig/elements", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board&region=cast", "/suites?view=home"],
  ["/rig/canvas/brd1", "", { kind: "board", id: "brd1" }, "/suites?project=w1&view=board", "/suites?view=home"],
  ["/rig/canvas/new", "project=pj1", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board", "/suites?view=home"],
  ["/rig/recipes/pj1", "", { kind: "production-project", id: "pj1" }, "/suites?project=w1&view=board", "/suites?view=home"],
];

test("an address that names a production project or a board looks the Studio project up, and falls back to Home", () => {
  for (const [pathname, search, lookup, found, none] of LOOKUPS) {
    const plan = planOldRoute(pathname, search)!;
    expect(plan.lookup, pathname).toEqual(lookup);
    expect(plan.to("w1"), pathname).toBe(found);
    expect(plan.to(null), `${pathname} (nothing linked)`).toBe(none);
    for (const target of [found, none]) {
      const [, query = ""] = target.split("?");
      expect(new URLSearchParams(route(query)).toString(), `${pathname}: ${target} is final`).toBe(new URLSearchParams(query).toString());
    }
  }
  /* The routes with a fixed address look nothing up. */
  for (const [pathname, search] of ROWS) expect(planOldRoute(pathname, search)!.lookup, pathname).toBeNull();
});

test("every old Studio stage and its aliases opens the board's region that took its job", () => {
  const region: Record<string, string> = {
    brief: "brief", storyboard: "storyboard", characters: "cast", "astra-blender": "shots", canvas: "", assets: "shots", edit: "cut", export: "deliver",
  };
  for (const stage of LEGACY_PAGES.particl) {
    const url = new URL(go("/workbench", `project=p1&stage=${stage.id}`), "https://particl.test");
    expect(url.pathname).toBe("/suites");
    expect(url.searchParams.get("project")).toBe("p1");
    expect(url.searchParams.get("view")).toBe("board");
    expect(url.searchParams.get("region") ?? "", stage.id).toBe(region[stage.id]);
    expect(url.searchParams.has("suite") || url.searchParams.has("page"), "no old page left in the address").toBe(false);
  }
  /* script / moodboard / elements were retired before; they still land on the board. */
  for (const alias of Object.keys(PARTICL_STAGE_ALIASES))
    expect(new URL(go("/workbench", `stage=${alias}`), "https://particl.test").searchParams.get("view"), alias).toBe("board");
});

test("every Business section opens the Ads board", () => {
  for (const section of MOLECULR_SECTIONS) {
    const url = new URL(go("/workbench", `project=m1&suite=moleculr&page=${section.id}`), "https://particl.test");
    expect(url.searchParams.get("view")).toBe("board");
    expect(url.searchParams.get("kind")).toBe("ads");
    expect(url.searchParams.get("project")).toBe("m1");
  }
});

test("the old escapes are dropped, the rest of the query rides along, and no Home link keeps a stale page", () => {
  const url = new URL(go("/workbench", "project=p1&shell=legacy&new=1&account=particl"), "https://particl.test");
  expect(url.searchParams.has("shell")).toBe(false);
  expect(url.searchParams.has("new")).toBe(false);
  expect(url.searchParams.get("account")).toBe("particl");
  expect(go("/atomik", "atomik=marketing")).not.toContain("atomik=marketing");
  /* A selection is only meaningful with a stage: Home drops it rather than lie. */
  expect(new URL(go("/workbench", "sel=take:t_1"), "https://particl.test").searchParams.has("sel")).toBe(false);
});

test("what stays where it is: no redirect for a KEEP or owner-to-decide route, a public page or an auth page", () => {
  const stays = [
    "/workbench/movie", "/projects/pj1", "/takes/t1", "/shots/s1", "/elements/e1", "/atomik/ideas", "/atomik/treatment", "/atomik/breakdown",
    "/atomik/shots", "/studio/shot", "/statements/2026-10", "/admin", "/platform", "/report", "/policy", "/privacy", "/terms", "/billing",
    "/pricing", "/login", "/signup", "/reset", "/reset/tok", "/invite/abc", "/setup", "/welcome", "/account/security", "/review/tok", "/suites",
    "/studio", "/business", "/viral", "/site", "/site/atomik", "/management/engines",
  ];
  for (const pathname of stays) expect(planOldRoute(pathname, ""), pathname).toBeNull();
  /* A kind Make has not got stays a 404 (the page asks notFound() for a null plan). */
  expect(planOldRoute("/make/nope", "")).toBeNull();
});

test("every row is temporary (307): nothing is final until the owner has decided the places the audit leaves open", () => {
  for (const [pathname, search] of [...ROWS.map(([p, s]) => [p, s]), ...LOOKUPS.map(([p, s]) => [p, s])]) expect(planOldRoute(pathname, search)!.permanent, pathname).toBe(false);
});

const PAGE_OF: Record<string, string> = {
  "app/(app)/page.tsx": "/", "app/workspace/page.tsx": "/workspace", "app/(app)/atomik/page.tsx": "/atomik", "app/(app)/subatomik/page.tsx": "/subatomik",
  "app/(app)/subatomic/page.tsx": "/subatomik", "app/(app)/generate/page.tsx": "/generate", "app/(app)/images/page.tsx": "/images", "app/(app)/audio/page.tsx": "/audio",
  "app/(app)/library/page.tsx": "/library", "app/(app)/all/page.tsx": "/all", "app/(app)/productions/page.tsx": "/productions",
  "app/(app)/pipelines/page.tsx": "/pipelines", "app/(app)/dashboard/page.tsx": "/dashboard", "app/(app)/settings/page.tsx": "/settings",
  "app/(app)/team/page.tsx": "/team", "app/(app)/usage/page.tsx": "/usage", "app/(app)/connect/page.tsx": "/connect",
};
const DYNAMIC: Record<string, string> = {
  "app/(app)/make/[kind]/page.tsx": "`/make/${kind}`",
  "app/(app)/productions/[prod]/[project]/media/page.tsx": "`/productions/${prod}/${project}/media`",
  "app/(app)/productions/[prod]/[project]/shots/page.tsx": "`/productions/${prod}/${project}/shots`",
  "app/(app)/projects/[id]/canvas/page.tsx": "`/projects/${id}/canvas`",
  "app/(app)/canvas/[id]/page.tsx": "`/canvas/${id}`",
  "app/(app)/projects/[id]/rig/elements/page.tsx": "`/projects/${id}/rig/elements`",
  "app/(app)/rig/canvas/[boardId]/page.tsx": "`/rig/canvas/${boardId}`",
  "app/(app)/rig/recipes/[projectId]/page.tsx": "`/rig/recipes/${projectId}`",
  "app/(app)/rig/run/[runId]/page.tsx": "`/rig/run/${runId}`",
};

test("each old page file only redirects: it draws nothing and names the address it carries out", () => {
  for (const [file, pathname] of Object.entries(PAGE_OF)) {
    const source = readFileSync(file, "utf8");
    expect(source, file).toContain(`followOldRoute("${pathname}", await searchParams)`);
    expect(source.split("\n").length, file).toBeLessThan(20);
    expect(source, file).not.toMatch(/from "@\/components/);
  }
  for (const [file, expr] of Object.entries(DYNAMIC)) {
    const source = readFileSync(file, "utf8");
    expect(source, file).toContain(`followOldRoute(${expr}, await searchParams)`);
    expect(source, file).not.toMatch(/from "@\/components/);
  }
});

test("/workbench still draws the Studio for one account only: a signed-in account with no workspace", () => {
  const page = readFileSync("app/workbench/page.tsx", "utf8");
  expect(page).toContain("await enterSuites('/workbench',await searchParams,ctx);");
  const server = readFileSync("lib/shell/old-routes.server.ts", "utf8");
  expect(server).toContain("if (ctx && !ctx.workspace) return;");
  /* /suites sends that account to /workbench, so sending it back would loop. */
  expect(readFileSync("lib/signIn.ts", "utf8")).toContain("`/workbench${search ? `?${search}` : \"\"}`");
});
