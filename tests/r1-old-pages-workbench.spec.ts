import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaid, noHorizontalOverflow } from "./helpers/appPagesAudit";
import { newProject } from "../lib/workbench/studio";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

/**
 * Release 1 has one design (OLD-PAGES audit, step 5): every old address lands on the right new screen, in a real
 * browser against a local ENGINE_MOCK=1 server, signed in; and the public pages still work signed out. The table behind
 * it is lib/shell/old-routes.ts (unit spec tests/unit/r1OldRoutes.spec.ts). Nothing here submits paid work.
 * Run at 1440x900 and 390x844.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const only = (info: TestInfo) => test.skip(!SIZES.includes(info.project.name), "Desktop and phone, once each.");

const SCREEN = {
  home: '[data-testid="home"], [data-testid="phone-home"]',
  board: '[data-testid="board"]',
  make: '[data-testid="make-panel"], [data-testid="phone-make"]',
  settings: '[data-testid="settings-view"]',
  controlRoom: '[data-testid="control-room"]',
  atomik: '[data-testid="atomik-panel"], [data-testid="phone-atomik"]',
} as const;
type Screen = keyof typeof SCREEN;

/** [old address, the params the new address carries, the screen it shows]. */
const ROWS: [string, Record<string, string>, Screen][] = [
  ["/", { view: "home" }, "home"],
  ["/workspace", { view: "home" }, "home"],
  ["/workbench", { view: "home" }, "home"],
  ["/workbench?shell=legacy&new=1", { view: "home" }, "home"],
  ["/workbench?stage=brief", { view: "board", region: "brief" }, "board"],
  ["/workbench?stage=cast", { view: "board", region: "cast" }, "board"],
  ["/workbench?stage=edit", { view: "board", region: "cut" }, "board"],
  ["/workbench?suite=moleculr", { view: "board", kind: "ads" }, "board"],
  ["/atomik", { atomik: "1" }, "atomik"],
  ["/atomik?page=approvals", { suite: "atomik", page: "approvals" }, "controlRoom"],
  ["/subatomik", { make: "motion" }, "make"],
  ["/subatomik?page=history", { view: "board", kind: "social", drawer: "history" }, "board"],
  ["/generate", { make: "video" }, "make"],
  ["/generate?mode=images", { make: "image" }, "make"],
  ["/images", { make: "image" }, "make"],
  ["/audio", { make: "audio" }, "make"],
  ["/make/video", { make: "video" }, "make"],
  ["/library", { make: "recent" }, "make"],
  ["/all", { make: "recent" }, "make"],
  ["/productions", { view: "home" }, "home"],
  ["/pipelines", { suite: "atomik", page: "runs" }, "controlRoom"],
  ["/dashboard", { suite: "atomik", page: "runs" }, "controlRoom"],
  ["/rig/run/run_old", { suite: "atomik", page: "runs" }, "controlRoom"],
  ["/settings", { view: "workspace", tab: "advanced", open: "workspace" }, "settings"],
  ["/team", { view: "workspace", tab: "team" }, "settings"],
  ["/usage", { view: "workspace", tab: "credits", open: "usage" }, "settings"],
  ["/connect", { view: "workspace", tab: "connections" }, "settings"],
];

async function landed(page: Page, from: string, params: Record<string, string>, screen: Screen, info: TestInfo) {
  const first = await page.goto(from);
  /* One hop: the request the person made is answered by one redirect, and the address it names is the final one. */
  const redirect = first?.request().redirectedFrom();
  expect(redirect, `${from} redirects`).not.toBeNull();
  expect(redirect?.redirectedFrom(), `${from} is one hop`).toBeNull();
  const url = new URL(page.url());
  expect(url.pathname, from).toBe("/suites");
  for (const [key, value] of Object.entries(params)) expect(url.searchParams.get(key), `${from}: ${key}`).toBe(value);
  for (const dead of ["shell", "new", "stage"]) expect(url.searchParams.has(dead), `${from}: ${dead} is gone`).toBe(false);
  await expect(page.locator(SCREEN[screen]).first(), `${from} shows ${screen}`).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Use the previous workspace")).toHaveCount(0);
  await noHorizontalOverflow(page);
  return info;
}

test("signed in, each old address lands on the new screen that holds its work", async ({ page }, info) => {
  only(info);
  test.setTimeout(900_000);
  await forbidPaid(page);
  await signInLocally(page.request);
  for (const [from, params, screen] of ROWS) await landed(page, from, params, screen, info);
  await page.screenshot({ path: info.outputPath("last-landing.png") });
});

test("an address that names a production project opens that project's board; one with no Studio project opens Home", async ({ page }, info) => {
  only(info);
  test.setTimeout(300_000);
  await forbidPaid(page);
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const draft = newProject("Old pages study");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  expect(productionProjectId).toBeTruthy();
  const board = await page.request.post("/api/rig/boards", { data: { projectId: productionProjectId, name: "Board" } });
  expect(board.ok(), await board.text()).toBe(true);
  const boardId = String((await board.json()).board.id);

  for (const [from, params] of [
    [`/projects/${productionProjectId}/canvas`, { view: "board" }],
    [`/canvas/${productionProjectId}`, { view: "board" }],
    [`/projects/${productionProjectId}/rig/elements`, { view: "board", region: "cast" }],
    [`/rig/canvas/${boardId}`, { view: "board" }],
    [`/rig/canvas/new?project=${productionProjectId}`, { view: "board" }],
    [`/rig/recipes/${productionProjectId}`, { view: "board" }],
    [`/productions/any/${productionProjectId}/media`, { view: "board", region: "shots" }],
    [`/productions/any/${productionProjectId}/shots`, { view: "board", region: "shots" }],
  ] as [string, Record<string, string>][]) await landed(page, from, { ...params, project: draft.id }, "board", info);

  /* A production project that has no Studio project: Home, never a board with somebody else's id or an error. */
  await landed(page, "/projects/no_such_project/canvas", { view: "home" }, "home", info);
  await landed(page, "/rig/canvas/no_such_board", { view: "home" }, "home", info);
  expect(new URL(page.url()).searchParams.has("project")).toBe(false);
});

test("what the audit leaves for the owner is still served where it is", async ({ page }, info) => {
  only(info);
  await signInLocally(page.request);
  for (const path of ["/workbench/movie", "/takes/none", "/shots/none", "/elements/none", "/atomik/ideas", "/atomik/treatment", "/studio/shot", "/statements/2026-10", "/report", "/policy", "/privacy", "/terms"]) {
    const response = await page.goto(path);
    expect(new URL(page.url()).pathname, path).toBe(path);
    expect(response?.request().redirectedFrom(), `${path} is not redirected`).toBeNull();
  }
});

test("signed out, the public pages work and an old app address asks for sign-in and brings you back", async ({ browser }, info) => {
  only(info);
  test.setTimeout(300_000);
  const visitor = await browser.newPage();
  try {
    /* The four public pages answer where they are: no redirect to the shell or to sign-in. */
    for (const [path, heading] of [["/", /./], ["/pricing", /./], ["/atomik", /./], ["/studio", /./]] as const) {
      const response = await visitor.goto(path);
      expect(response?.status(), path).toBe(200);
      expect(new URL(visitor.url()).pathname, path).toBe(path);
      expect(response?.request().redirectedFrom(), `${path} is not redirected`).toBeNull();
      await expect(visitor.locator("h1").first(), path).toHaveText(heading);
      await noHorizontalOverflow(visitor);
    }
    /* The September workspace address, bare, is the public site's page too. */
    const workspace = await visitor.goto("/workspace");
    expect(workspace?.status()).toBe(200);
    expect(new URL(visitor.url()).pathname).toBe("/workspace");

    /* An old app address with a project asks a visitor to sign in, and comes back to the final address. */
    for (const [from, next] of [
      ["/workbench?project=p1&stage=cast", "/suites?project=p1&view=board&region=cast"],
      ["/generate?mode=images", "/suites?make=image&view=home"],
      ["/settings", "/suites?view=workspace&tab=advanced&open=workspace"],
      ["/workbench?project=p1&shell=legacy", "/suites?project=p1&view=home"],
    ]) {
      await visitor.goto(from);
      await expect(visitor, from).toHaveURL(`/login?next=${encodeURIComponent(next)}`);
    }
  } finally {
    await visitor.close();
  }
});
