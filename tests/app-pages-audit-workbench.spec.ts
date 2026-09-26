import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { handoffKey } from "../lib/composeHandoff";

/**
 * The app-pages audit, in a real browser against a local ENGINE_MOCK=1 server.
 * Nothing here submits paid work: projects, shots and boards are free rows, and
 * every paid route is refused below.
 */
const DESKTOP = "workbench-1440x900";

async function forbidPaid(page: Page) {
  await page.route(/\/api\/(generate|atomik\/(ideas|shots)\/draft|atomik\/treatment\/scene)(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") throw new Error("This spec must not submit paid work.");
    return route.fallback();
  });
}

async function projectWithShots(page: Page) {
  const made = await page.request.post("/api/projects", { data: { name: "Audit film" } });
  expect(made.ok(), await made.text()).toBe(true);
  const project = (await made.json()) as { id: string };
  for (const planned of [5, 8]) {
    const shot = await page.request.post("/api/shots", { data: { projectId: project.id, scene: "1", title: `Shot ${planned}`, description: "A courier runs through rain", planned, engine: "seedance" } });
    expect(shot.ok(), await shot.text()).toBe(true);
  }
  const listed = (await (await page.request.get("/api/projects")).json()) as { projects: { id: string; productionId: string | null }[] };
  return listed.projects.find((p) => p.id === project.id)!;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("Atomik shot list and breakdown price a credit workspace in credits, never dollars", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "One pass for the money; the layout pass is below.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), project.id);
  /* Takes with a vendor cost are exercised in tests/unit/appPagesAuditDb.spec.ts; here the lists carry no dollar figure field at all for this workspace. */
  const listed = (await (await page.request.get("/api/projects")).json()) as { unit: string; projects: { id: string; spend: number }[] };
  expect(listed.unit).toBe("cr");
  expect(listed.projects.every((p) => p.spend === 0)).toBe(true);

  await page.goto("/atomik/shots");
  await expect(page.getByRole("heading", { name: "Shot list" })).toBeVisible();
  const list = page.locator(".ak-page");
  await expect(list.locator(".ak-table-foot")).toContainText(/EST\. \d+ CR · SPENT 0 CR/);
  await expect(list).not.toContainText("$");

  await page.goto("/atomik/breakdown");
  const bar = page.locator(".ak-bar");
  await expect(bar).toContainText(/EST\. \d+ CR AT ONE TAKE EACH/);
  await expect(bar).not.toContainText("$");
});

test("a project's legacy pages point at this project's own views, and an unknown project says so", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links and states, once.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  const base = `/productions/${project.productionId}/${project.id}`;

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("link", { name: "Render in Shots" })).toHaveAttribute("href", `${base}/shots`);
  await expect(page.locator("a.chip").filter({ hasText: /^Takes$/ })).toHaveAttribute("href", `${base}/media`);
  await expect(page.getByRole("link", { name: "Open in Generate" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Project dashboard" })).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Project" });
  await expect(nav.getByRole("link", { name: "Elements" })).toHaveAttribute("href", `/projects/${project.id}/rig/elements`);
  await expect(nav.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/studio/shot");

  await page.goto(`/projects/${project.id}/canvas`);
  await expect(page.getByRole("link", { name: "Open takes" })).toHaveAttribute("href", `${base}/media`);
  await expect(page.getByRole("link", { name: "Render in Shots" })).toHaveAttribute("href", `${base}/shots`);

  await page.goto(`${base}/media`);
  const tabs = page.getByRole("group", { name: "Project" }).first();
  await expect(tabs.getByRole("button")).toHaveText(["Shots", "Media"]);
  await expect(page.getByText("By shot ▾")).toHaveCount(0);

  await page.goto("/projects/proj_does_not_exist");
  await expect(page.getByText("No such project.")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Projects" })).toBeVisible();

  /* A list served stale by another instance's memo, without a project made a moment ago, does not declare it gone. */
  await page.route("**/api/projects", (route) => route.request().method() === "GET" ? route.fulfill({ json: { unit: "cr", projects: [] } }) : route.fallback());
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "Audit film" })).toBeVisible();
  await expect(page.getByText("No such project.")).toHaveCount(0);
});

test("the Rig canvas opens, carries a Library reference, offers only runnable nodes and says when a save fails", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "The board is built on a desktop.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);

  await page.goto("/rig/canvas/new");
  await expect(page.getByText("A board belongs to a project.")).toBeVisible();

  /* A real Library reference: a free upload of a still that ships with the app. */
  const me = await (await page.request.get("/api/me")).json();
  const uploaded = await page.request.post("/api/uploads", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    multipart: { file: { name: "Rain reference.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/character.webp") } },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const ref = ((await uploaded.json()) as { id: string }).id;

  /* A failed board list is said, with a retry, instead of spinning. */
  let failList = true;
  await page.route("**/api/rig/boards?projectId=*", (route) => (failList ? route.fulfill({ status: 500, json: { error: "The database is busy." } }) : route.fallback()));
  await page.goto(`/rig/canvas/new?project=${project.id}&ref=${ref}`);
  await expect(page.getByText("Couldn’t open the board. The database is busy.")).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(new RegExp(`/rig/canvas/brd_[^?]+\\?ref=${ref}$`));
  /* The reference lands as a note on the board, named for the upload, and the board saves. */
  await expect(page.getByRole("article", { name: "Note node" })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Note node" }).getByRole("textbox")).toHaveValue("REF · Rain reference.webp");
  await expect.poll(async () => ((await (await page.request.get(page.url().replace(/.*\/rig\/canvas\/([^?]+).*/, "/api/rig/boards/$1"))).json()).board.nodes as unknown[]).length).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: /Not saved|Someone else/ })).toHaveCount(0);

  /* The add menu offers only what a board runs, and choosing an item adds it. */
  await page.getByRole("button", { name: /Add node/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /^Image/ })).toBeVisible();
  for (const kind of ["Upscale", "Audio", "Voice", "Compare", "Edit"]) await expect(menu.getByRole("menuitem", { name: new RegExp(`^${kind}`) })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: /^Image/ }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect.poll(async () => ((await (await page.request.get(page.url().replace(/.*\/rig\/canvas\/([^?]+).*/, "/api/rig/boards/$1"))).json()).board.nodes as unknown[]).length).toBe(2);

  /* A save the server refuses leaves a visible Not saved with a retry. */
  let failSave = true;
  await page.route("**/api/rig/boards/brd_*", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    return failSave ? route.fulfill({ status: 500, json: { error: "The database is busy." } }) : route.fallback();
  });
  await page.getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Prompt/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not saved · The database is busy." })).toBeVisible();
  failSave = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not saved" })).toHaveCount(0);

  /* A teammate saved first: the board says so and does not overwrite them. */
  const boardId = page.url().match(/brd_[^?/]+/)![0];
  const current = (await (await page.request.get(`/api/rig/boards/${boardId}`)).json()).board as { nodes: unknown[]; updatedAt: number };
  const teammate = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes: current.nodes, wires: [], baseUpdatedAt: current.updatedAt } });
  expect(teammate.ok()).toBe(true);
  await page.getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Note/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone else changed this board." })).toBeVisible();
  /* Reloading takes the teammate's board and puts back the note added here, which then saves. */
  const before = current.nodes.length;
  await page.getByRole("button", { name: "Reload the board" }).click();
  await expect(page.getByText("Reloaded · 1 node you added put back")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /Someone else|Not saved/ })).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get(`/api/rig/boards/${boardId}`)).json()).board.nodes as unknown[]).length).toBe(before + 1);
});

test("on a phone, a node a board cannot run says so and carries no price", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-390x844", "The phone board, once.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  const made = await page.request.post("/api/rig/boards", { data: { projectId: project.id, name: "Phone board" } });
  const board = ((await made.json()) as { board: { id: string; updatedAt: number } }).board;
  const gen = (id: string, kind: string, x: number) => ({ id, kind, x, y: 0, label: id, ports: [], inputs: [], settings: {}, state: "idle", credits: 0, staleSince: null, output: null });
  const put = await page.request.put(`/api/rig/boards/${board.id}`, { data: { nodes: [gen("up1", "upscale", 0), gen("img1", "image", 300)], wires: [] } });
  expect(put.ok(), await put.text()).toBe(true);
  await page.goto(`/rig/canvas/${board.id}`);
  const upscale = page.locator("[data-phone-board]").getByRole("button", { name: /Doesn’t run on a board/ });
  await expect(upscale).toBeVisible();
  await expect(upscale).toBeDisabled();
  await expect(upscale).not.toContainText(/cr/i);
  /* An image node still runs, priced. */
  await expect(page.locator("[data-phone-board]").getByRole("button", { name: /^Generate/ })).toContainText(/\d+ CR/i);
});

test("the shot builder hands its subject line to Generate and keeps the picks", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "One hand-off pass.");
  await forbidPaid(page);
  await signInLocally(page.request);
  /* Generate composes into a saved Studio project, remembered for this workspace and person. */
  const production = await projectWithShots(page);
  const me = await (await page.request.get("/api/me")).json();
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const saved = { ...newProject("Hand-off film"), productionProjectId: production.id };
  const put = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project: saved, revision: 0 } });
  expect(put.ok(), await put.text()).toBe(true);
  /* The builder is scoped to that production, and Generate remembers no project: only the builder's own lookup can open the right one. */
  await page.addInitScript((production) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("aw_project", production); sessionStorage.setItem("seeded", "1"); } }, production.id);

  await page.goto("/studio/shot");
  await expect(page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "Cast", exact: true })).toHaveAttribute("href", "/suites?suite=particl&page=cast");
  /* The drafts are kept per project selection; let it settle before typing. */
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByLabel("Subject line").fill("A courier runs through the rain");
  await page.getByRole("button", { name: "Open in Generate" }).click();
  /* Opened on this production's own Studio project. */
  await expect(page).toHaveURL(new RegExp(`/generate\\?mode=video&project=${saved.id}`));
  await expect.poll(() => page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).toContain("A courier runs through the rain");
  /* Taken once: a second visit to Generate does not paste it again. */
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("particl:compose-handoff")).length)).toBe(0);
  await page.goto("/studio/shot");
  await expect(page.getByLabel("Subject line")).toHaveValue("A courier runs through the rain");

  /* Words written for another production wait rather than render, bill and file here. */
  await page.evaluate(({ key, at }) => sessionStorage.setItem(key, JSON.stringify({ prompt: "A second courier", kind: "video", at, productionProjectId: "prj_elsewhere" })), { key: handoffKey(me.workspace.id, me.email), at: Date.now() });
  await page.goto(`/generate?mode=video&project=${saved.id}`);
  await expect(page.getByText("Your Setup is for another production. Choose its project to use it.")).toBeVisible();
  expect(await page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).not.toContain("A second courier");
});

test("entry points: a workspace goes straight to Suites; a visitor signs in and comes back to the same page", async ({ page, browser }, info) => {
  test.skip(info.project.name !== DESKTOP, "Redirects, once.");
  const visitor = await browser.newPage();
  try {
    const link = "/suites?suite=atomik&page=runs&project=p1";
    await visitor.goto(link);
    await expect(visitor).toHaveURL(`/login?next=${encodeURIComponent(link)}`);
    await visitor.goto("/generate?mode=images&task=upscale");
    const signIn = visitor.getByRole("link", { name: "Sign in" }).first();
    await expect(signIn).toHaveAttribute("href", `/login?next=${encodeURIComponent("/generate?mode=images&task=upscale")}`);
  } finally {
    await visitor.close();
  }

  await signInLocally(page.request);
  /* The switch is the response itself — a 307 — not a 200 carrying a meta refresh. */
  for (const [entry, target] of [["/", /^\/suites\?suite=particl/], ["/atomik", /^\/suites\?suite=atomik/], ["/subatomik", /^\/suites\?suite=subatomik/], ["/workbench", /^\/suites\?suite=particl/]] as const) {
    const res = await page.request.get(entry, { maxRedirects: 0 });
    expect(res.status(), entry).toBe(307);
    expect(res.headers().location, entry).toMatch(target);
  }
  /* The other (app) redirect pages answer the same way now that the shell streams no boundary. */
  const moved = await page.request.get("/images", { maxRedirects: 0 });
  expect(moved.status()).toBe(307);
  const response = await page.goto("/workbench?stage=brief");
  expect(response?.request().redirectedFrom()?.url()).toContain("/workbench?stage=brief");
  await expect(page).toHaveURL(/\/suites\?suite=particl&page=brief/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/suites\?suite=particl/);
  await expect(page.getByTestId("switchover-note")).toHaveCount(0);
});

test("Suites Workspace › Engines links the token page; the platform desk is for the platform owner only", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links, once.");
  await signInLocally(page.request);
  await page.goto("/suites?view=workspace&tab=engines");
  const connect = page.getByTestId("workspace-connect-link");
  await expect(connect).toHaveAttribute("href", "/connect");
  await expect(connect).toContainText("No tokens yet");
  await page.getByRole("tab", { name: "General" }).click();
  await expect(page.getByTestId("platform-desk")).toHaveCount(0);
});

test("public metadata: robots, sitemap, one icon per URL, and client review pages without Particl's install card", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Metadata, once.");
  const robots = await (await page.request.get("/robots.txt")).text();
  for (const path of ["/api/", "/invite/", "/reset/"]) expect(robots).toContain(`Disallow: ${path}`);
  /* A review link may be fetched for its preview card; noindex (meta and header) keeps it out of every index. */
  expect(robots).not.toContain("Disallow: /review/");
  expect((await page.request.get("/review/not-a-real-token")).headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect((await page.request.get("/terms")).headers()["x-robots-tag"]).toBeUndefined();
  expect(robots).toContain("Sitemap: http://localhost:4803/sitemap.xml");
  expect(await (await page.request.get("/sitemap.xml")).text()).toContain("<loc>http://localhost:4803/terms</loc>");
  const icon = await page.request.get("/icon.png");
  expect(createHash("sha1").update(await icon.body()).digest("hex")).toBe(createHash("sha1").update(readFileSync("public/icon.png")).digest("hex"));

  await page.goto("/terms");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /^http:\/\/localhost:4803\/icon\.png/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Terms · Particl");
  expect(await page.title()).toBe("Terms · Particl");

  await page.goto("/review/not-a-real-token");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /^data:image\/svg\+xml/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).not.toHaveAttribute("content", /Particl/);
});

test("changed pages do not scroll sideways", async ({ page }) => {
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), project.id);
  for (const path of [
    `/projects/${project.id}`,
    `/projects/${project.id}/rig/elements`,
    `/productions/${project.productionId}/${project.id}/media`,
    "/atomik/shots",
    "/studio/shot",
    "/suites?view=workspace",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await noHorizontalOverflow(page);
  }
});
