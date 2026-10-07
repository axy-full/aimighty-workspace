import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
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
  board: '[data-testid="board"], [data-testid="board-no-project"]',
  make: '[data-testid="make-panel"], [data-testid="phone-make"]',
  settings: '[data-testid="settings-view"]',
  controlRoom: '[data-testid="control-room"]',
  atomik: '[data-testid="atomik-panel-global"], [data-testid="phone-atomik-home"]',
} as const;
type Screen = keyof typeof SCREEN;
/** What the phone draws for each (components/graphite/phone): its Project record is the board, and it draws no control room or Atomik page of its own, so those open its Home. */
const PHONE_SCREEN: Record<Screen, string> = { home: "home", board: "record", make: "make", settings: "page", controlRoom: "home", atomik: "home" };

/** [old address, the params the new address carries, the screen it shows]. */
const ROWS: [string, Record<string, string>, Screen][] = [
  ["/", { view: "home" }, "home"],
  ["/workspace", { view: "home" }, "home"],
  ["/workbench", { view: "home" }, "home"],
  ["/workbench?shell=legacy&new=1", { view: "home" }, "home"],
  ["/workbench?project={p}&stage=brief", { view: "board", region: "brief", project: "{p}" }, "board"],
  ["/workbench?project={p}&stage=cast", { view: "board", region: "cast", project: "{p}" }, "board"],
  ["/workbench?project={p}&stage=edit", { view: "board", region: "cut", project: "{p}" }, "board"],
  ["/workbench?project={p}&suite=moleculr", { view: "board", kind: "ads", project: "{p}" }, "board"],
  ["/atomik", { atomik: "1" }, "atomik"],
  ["/atomik?page=approvals", { suite: "atomik", page: "approvals" }, "controlRoom"],
  ["/subatomik", { make: "motion" }, "make"],
  ["/subatomik?project={p}&page=history", { view: "board", kind: "social", drawer: "history", project: "{p}" }, "board"],
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
  /* The owner's evening decision: the rows the audit left open are redirected too. */
  ["/projects/{pp}", { view: "workspace", tab: "rules" }, "settings"],
  ["/atomik/ideas?project={pp}", { view: "board", region: "brief", project: "{p}" }, "board"],
  ["/atomik/treatment?project={pp}", { view: "board", region: "brief", project: "{p}" }, "board"],
  ["/atomik/breakdown?project={pp}", { view: "board", region: "brief", project: "{p}" }, "board"],
  ["/atomik/shots?project={pp}", { view: "board", region: "brief", project: "{p}" }, "board"],
  ["/studio/shot?project={p}", { make: "video", project: "{p}" }, "make"],
  ["/workbench/movie?project={p}&snapshot=tok_1", { view: "board", region: "deliver", project: "{p}" }, "board"],
  ["/workbench/movie", { view: "board", region: "deliver" }, "board"],
];

/** A Studio project of this person's own, so a board has something to draw. */
async function studioProject(page: Page) {
  const me = await page.request.get("/api/me").then((response) => response.json());
  const draft = newProject("Old pages study");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return { id: draft.id, productionProjectId: String((await saved.json()).productionProjectId) };
}

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
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    /* The phone draws its own screens (components/graphite/phone): its shell is up, on the place the address names. */
    const app = page.getByTestId("phone-app");
    await expect(app, `${from} opens the phone shell`).toBeVisible({ timeout: 45_000 });
    await expect(app, `${from} is the phone's ${PHONE_SCREEN[screen]} screen`).toHaveAttribute("data-screen", PHONE_SCREEN[screen]);
  } else {
    await expect(page.locator(SCREEN[screen]).first(), `${from} shows ${screen}`).toBeVisible({ timeout: 45_000 });
  }
  await expect(page.getByText("Use the previous workspace")).toHaveCount(0);
  await noHorizontalOverflow(page);
  return info;
}

test("signed in, each old address lands on the new screen that holds its work", async ({ page }, info) => {
  only(info);
  test.setTimeout(900_000);
  await forbidPaid(page);
  await signInLocally(page.request);
  const { id, productionProjectId } = await studioProject(page);
  const fill = (text: string) => text.replaceAll("{pp}", productionProjectId).replaceAll("{p}", id);
  for (const [from, params, screen] of ROWS)
    await landed(page, fill(from), Object.fromEntries(Object.entries(params).map(([k, v]) => [k, fill(v)])), screen, info);
  await page.screenshot({ path: info.outputPath("last-landing.png") });
});

test("an address that names a production project opens that project's board; one with no Studio project opens Home", async ({ page }, info) => {
  only(info);
  test.setTimeout(300_000);
  await forbidPaid(page);
  await signInLocally(page.request);
  const { id: studioId, productionProjectId } = await studioProject(page);
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
  ] as [string, Record<string, string>][]) await landed(page, from, { ...params, project: studioId }, "board", info);

  /* A shot (and a take, an element) goes to its project's board region; one that is not found still opens the region. */
  const shot = await page.request.post("/api/shots", { data: { projectId: productionProjectId, scene: "1", title: "Old pages shot", description: "A courier runs through rain", planned: 5, engine: "seedance" } });
  expect(shot.ok(), await shot.text()).toBe(true);
  const made = (await shot.json()) as { id?: string; shot?: { id: string } };
  const shotId = String(made.id ?? made.shot?.id);
  for (const [from, location] of [
    [`/shots/${shotId}`, `/suites?project=${studioId}&view=board&region=shots`],
    ["/shots/no_such_shot", "/suites?view=board&region=shots"],
    ["/takes/no_such_take", "/suites?view=board&region=shots&asset=generation%3Ano_such_take"],
    ["/elements/no_such_element", "/suites?view=board&region=cast"],
  ]) {
    const res = await page.request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers().location, from).toBe(location);
  }
  await landed(page, `/shots/${shotId}`, { view: "board", region: "shots", project: studioId }, "board", info);

  /* A production project that has no Studio project: Home, never a board with somebody else's id or an error. */
  await landed(page, "/projects/no_such_project/canvas", { view: "home" }, "home", info);
  await landed(page, "/rig/canvas/no_such_board", { view: "home" }, "home", info);
  /* The redirect itself names no project (the shell chooses its own once it is open). */
  for (const from of ["/projects/no_such_project/canvas", "/rig/canvas/no_such_board"]) {
    const res = await page.request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers().location, from).toBe("/suites?view=home");
  }
});

test("what stays is served where it is: the statement, the report form and the legal pages", async ({ page }, info) => {
  only(info);
  await signInLocally(page.request);
  for (const path of ["/statements/2026-10", "/report", "/policy", "/privacy", "/terms"]) {
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

    /* An old app address with a project asks a visitor to sign in, and comes back to the final address. A fresh server with
       no account at all sends everyone to /setup, so one person exists first (in a context of their own). */
    const member = await browser.newContext();
    try { await signInLocally(member.request); } finally { await member.close(); }
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

const PASSWORD = "a local browser test passphrase 42";

test("a signed-in account with no workspace is told so by the shell: no old Studio, no redirect loop, and it can sign out", async ({ page }, info) => {
  only(info);
  test.setTimeout(300_000);
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  /* A verified account that belongs to no workspace (the way tests/management-scope.spec.ts leaves one). */
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.batch([
      { sql: "DELETE FROM memberships WHERE account_id=?", args: [me.id] },
      { sql: "UPDATE p_sessions SET workspace_id=NULL WHERE account_id=?", args: [me.id] },
    ], "write");
  } finally {
    db.close();
  }
  /* Every entry, old and new, ends on the same plain screen in one /suites address (nothing bounces back to /workbench). */
  for (const from of ["/suites", "/suites?view=home", "/workbench", "/workbench?stage=cast", "/", "/workspace", "/generate", "/settings"]) {
    await page.goto(from);
    await expect(page, from).toHaveURL(/\/suites(\?|$)/);
    await expect(page.getByTestId("no-workspace-title"), from).toHaveText("You’re not in a workspace yet");
  }
  const create = page.getByTestId("no-workspace-create");
  await expect(create).toHaveAttribute("href", "/billing?new=1");
  for (const control of [create, page.getByTestId("no-workspace-sign-out")]) {
    const box = (await control.boundingBox())!;
    if ((page.viewportSize()?.width ?? 1440) < 768) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("no-workspace.png") });
  await page.getByTestId("no-workspace-sign-out").click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
});

test("sign-in follows a next that is a path on this site and nothing else", async ({ page, browser }, info) => {
  only(info);
  test.setTimeout(300_000);
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  await page.request.post("/api/auth/logout", { data: {} });
  const here = new URL(info.project.use.baseURL ?? process.env.PW_BASE_URL ?? "http://localhost:4551").origin;
  for (const next of ["https://evil.test/x", "//evil.test", "/\\evil.test", "/.//evil.test", "javascript:alert(1)", "/a/..//evil.test"]) {
    const visitor = await browser.newPage();
    try {
      await visitor.goto(`/login?next=${encodeURIComponent(next)}`);
      await visitor.getByLabel("EMAIL", { exact: true }).fill(me.email);
      await visitor.getByLabel("PASSWORD", { exact: true }).fill(PASSWORD);
      await visitor.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect.poll(() => new URL(visitor.url()).pathname, { message: next }).not.toBe("/login");
      expect(new URL(visitor.url()).origin, next).toBe(here);
      expect(visitor.url(), next).not.toContain("evil.test");
      await visitor.context().clearCookies();
    } finally {
      await visitor.close();
    }
  }
  /* A path on this site is followed. */
  const visitor = await browser.newPage();
  try {
    await visitor.goto(`/login?next=${encodeURIComponent("/suites?make=video&view=home")}`);
    await visitor.getByLabel("EMAIL", { exact: true }).fill(me.email);
    await visitor.getByLabel("PASSWORD", { exact: true }).fill(PASSWORD);
    await visitor.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(visitor).toHaveURL(/\/suites\?(?=.*make=video)/);
  } finally {
    await visitor.close();
  }
});
