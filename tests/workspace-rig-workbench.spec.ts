import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * /workspace Rig (workspace redesign, Rig track). Real local routes against
 * an ENGINE_MOCK server: the draft is saved through PUT /api/workbench/projects,
 * quotes come from the engines and quote routes, and Generate dispatches a
 * mocked render through POST /api/generate. Nothing here is intercepted.
 * Desktop asserts the page; phones assert the existing redirect.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";

/* Test fixtures only. */
function shot(id: string, title: string, note: string, y: number, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, title, type: "scene", x: 100, y, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
    operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note } }],
    engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p", ...extra,
  };
}

async function seeded(page: Page, graph: (nodes: CanvasNode[]) => CanvasNode[] = (nodes) => nodes) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const db = createClient({ url: localPlatformDbUrl() });
  try {
    await db.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock Rig fixture", "admin", "test", Date.now()],
    });
  } finally {
    db.close();
  }
  const project: Project = {
    ...newProject(`Rig fixture ${randomUUID().slice(0, 6)}`),
    nodes: graph([
      shot("rig-a", "Opening wide", "Wide. Hold still.", 100),
      shot("rig-b", "The encounter", "She enters. The landscape becomes a reflection.", 500, { look: "Warm daylight" }),
      shot("rig-c", "Departure", "Wide again.", 900, { durationS: 8 }),
    ]),
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  return { project, scope };
}

const rigUrl = (id: string, sel?: string) => `/workspace?project=${id}&suite=particl&page=rig${sel ? `&sel=shot:${sel}` : ""}`;
const row = (page: Page, name: string | RegExp) => page.getByTestId("rig-list").getByRole("button", { name });

async function savedDraft(page: Page, scope: string, id: string) {
  return (await page.request.get(`/api/workbench/projects?id=${id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json())).project as Project;
}

/** Header rows never clip; the list scrolls inside the content pane instead of squeezing a column. */
async function assertNoClipping(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const inspector = document.querySelector('[data-testid="inspector"]')?.getBoundingClientRect() ?? null;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-row]"))) {
      const name = row.dataset.row!;
      if (["project", "page", "crumbs"].includes(name) && row.scrollWidth > row.clientWidth + 0.5) out.push(`${name}: ${row.scrollWidth} > ${row.clientWidth}`);
      for (const child of Array.from(row.children) as HTMLElement[]) {
        const rect = child.getBoundingClientRect();
        if (rect.width && inspector && ["project", "page", "crumbs"].includes(name) && rect.right > inspector.left + 0.5) out.push(`${name}: ${child.className} under the Inspector`);
      }
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".pxw-rig-row, .pxw-rig-head"))) {
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`rig row overflows: ${el.scrollWidth} > ${el.clientWidth}`);
      const shotCell = el.querySelector<HTMLElement>(".pxw-rig-shot")!;
      if (shotCell.getBoundingClientRect().width < 219.5) out.push(`SHOT column below its 220px floor: ${shotCell.getBoundingClientRect().width}`);
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="page-title"], [data-testid="project-title"]')))
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${el.dataset.testid} truncated`);
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls horizontally`);
    /* From 1440 up the whole shell fits: the Inspector is fully on screen. */
    const studio = document.querySelector<HTMLElement>(".pxw-studio")!;
    if (innerWidth >= 1440 && studio.scrollWidth > studio.clientWidth + 0.5) out.push(`studio row scrolls at ${innerWidth}: ${studio.scrollWidth}`);
    const body = document.querySelector<HTMLElement>(".pxw-inspector-body");
    if (body && body.scrollWidth > body.clientWidth + 0.5) out.push(`Inspector content overflows: ${body.scrollWidth} > ${body.clientWidth}`);
    return out;
  });
  expect(problems).toEqual([]);
}

test("phones render the phone shell", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const { project } = await seeded(page);
  await page.goto(rigUrl(project.id));
  /* The phone shell renders here now (wave M-A): /workspace is the phone's
     surface below 768px, and the desktop studio row is not mounted. */
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
});

test("shot list, selection, edits that persist and a live estimate", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, scope } = await seeded(page);
  await page.goto(rigUrl(project.id));

  /* The list renders from the saved draft, in draft order, with derived status. */
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.getByTestId("rig-list").locator(".pxw-rig-row")).toHaveCount(3);
  await expect(page.locator(".pxw-rig-row .pxw-rig-name")).toHaveText(["Opening wide", "The encounter", "Departure"]);
  await expect(page.locator(".pxw-rig-row .pxw-rig-num")).toHaveText(["01", "02", "03"]);
  await expect(page.locator(".pxw-rig-row .pxw-rig-engine").first()).toHaveText("2.5");
  await expect(page.locator(".pxw-rig-row .pxw-rig-dur")).toHaveText(["5s", "5s", "8s"]);
  /* Priced and resolved: every shot reads Ready once its live quote lands. */
  await expect(page.locator('.pxw-rig-row[data-status="ready"]')).toHaveCount(3);
  await expect(page.getByTestId("page-sub")).toHaveText("3 shots · 0 approved");
  await expect(page.locator(".pxw-crumb")).toHaveText("Main composition");
  /* The connected account's vocabulary appears nowhere a person reads; the
     engines we integrate directly appear under their real names (owner
     decision, 20 September 2026). */
  await expect(page.locator(".pxw")).not.toContainText(/Higgsfield|Supercomputer|Genjutsu|Soul ID|BytePlus|ModelArk/);
  await expect(page.getByLabel("Engine", { exact: true }).locator("option").first()).toHaveText("Seedance 2.5");

  /* Selecting a shot drives the Inspector and the URL. */
  await row(page, /The encounter/).click();
  await expect(row(page, /The encounter/)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");
  await expect(page).toHaveURL(/[?&]sel=shot%3Arig-b(&|$)/);
  await expect(page.getByRole("textbox", { name: "Direction note" })).toHaveValue("She enters. The landscape becomes a reflection.");

  /* ←/→ walk the shots. */
  await page.locator("body").press("ArrowRight");
  await expect(page.getByTestId("inspector-title")).toHaveText("Departure");
  await page.locator("body").press("ArrowLeft");
  await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");

  /* Typing in the name field never fires G or I. */
  const generations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") generations.push(request.url()); });
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("");
  await name.pressSequentially("Green light, inside");
  await expect(name).toHaveValue("Green light, inside");
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.locator(".pxw-gen")).toHaveCount(0);
  expect(generations).toEqual([]);
  await expect(row(page, /Green light, inside/)).toBeVisible();

  /* Duration moves the estimate. */
  const estimate = page.getByTestId("shot-estimate").locator(".pxw-insp-estimate-value");
  await expect(estimate).toHaveText(/^\d[\d,]* cr$/);
  const before = Number((await estimate.textContent())!.replace(/\D/g, ""));
  await expect(page.getByTestId("shot-estimate")).toContainText(/[\d,]+ tokens · billed on settle/);
  await page.getByRole("button", { name: "Longer" }).click();
  await page.getByRole("button", { name: "Longer" }).click();
  await expect(page.getByTestId("shot-duration")).toHaveText("7s");
  await expect.poll(async () => Number((await estimate.textContent())!.replace(/\D/g, ""))).toBeGreaterThan(before);
  await expect(page.locator(".pxw-rig-row").nth(1).locator(".pxw-rig-dur")).toHaveText("7s");

  /* Edits persist through the revision-checked draft save. */
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved");
  await expect.poll(async () => {
    const saved = await savedDraft(page, scope, project.id);
    const node = saved.nodes.find((n) => n.id === "rig-b");
    return [node?.title, node?.durationS];
  }).toEqual(["Green light, inside", 7]);
  await page.reload();
  await expect(page.getByTestId("inspector-title")).toHaveText("Green light, inside");
  await expect(page.getByTestId("shot-duration")).toHaveText("7s");

  /* Add shot creates a real node through the same save. */
  await page.getByRole("button", { name: "+ Add shot" }).click();
  await expect(page.getByTestId("rig-list").locator(".pxw-rig-row")).toHaveCount(4);
  await expect(page.getByTestId("page-sub")).toHaveText("4 shots · 0 approved");
  await expect.poll(async () => (await savedDraft(page, scope, project.id)).nodes.filter((n) => n.type === "scene").length).toBe(4);
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved");

  /* Another window saves first: the next save is refused, and the Rig merges its own edit into the saved version and
     saves again — the other window's rename is kept (never overwritten) and the note made here is kept too (never dropped). */
  const other = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json()) as { project: Project; revision: number };
  other.project.nodes = other.project.nodes.map((n) => (n.id === "rig-a" ? { ...n, title: "Renamed elsewhere" } : n));
  expect((await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: other })).ok()).toBeTruthy();
  await page.getByRole("textbox", { name: "Direction note" }).fill("A note made here");
  await expect.poll(async () => {
    const kept = await savedDraft(page, scope, project.id);
    return { title: kept.nodes.find((n) => n.id === "rig-a")!.title, note: JSON.stringify(kept).includes("A note made here") };
  }, { timeout: 15_000 }).toEqual({ title: "Renamed elsewhere", note: true });
  await expect(row(page, /Renamed elsewhere/)).toBeVisible();
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved");
  await expect(page.getByRole("status").filter({ hasText: "This project changed elsewhere" })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("Generate re-quotes, dispatches a mocked render, files a take, and still works after Takes → Rig", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  test.setTimeout(180_000);
  const { project, scope } = await seeded(page);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path === "/api/generate/quote")) sent.push({ path, body: request.postDataJSON() });
  });
  await page.goto(rigUrl(project.id, "rig-a"));
  await expect(page.getByTestId("inspector-title")).toHaveText("Opening wide");

  /* The exact live quote is on the button. */
  const header = page.locator('[data-row="page"]').getByRole("button", { name: /^Generate · \d[\d,]* cr$/ });
  await expect(header).toBeEnabled();
  const credits = Number((await header.textContent())!.replace(/.*· /, "").replace(/\D/g, ""));
  await expect(page.getByRole("button", { name: `Generate take · ${credits.toLocaleString("en-US")} cr` })).toBeEnabled();

  await header.click();
  const strip = page.locator(".pxw-gen");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Opening wide · Seedance 2.5");
  await expect.poll(() => sent.map((s) => s.path)).toEqual(["/api/generate/quote", "/api/generate"]);
  /* Same body quoted and sent; the approved ceiling and fingerprint ride along. */
  const [quoted, dispatched] = sent.map((s) => s.body);
  expect(quoted.maxCredits).toBeUndefined();
  expect(dispatched).toMatchObject({ model: ENGINE, duration: 5, ratio: "16:9", resolution: "720p", refine: false, maxCredits: credits });
  expect(dispatched.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const rest = { ...dispatched };
  delete rest.maxCredits;
  delete rest.quoteFingerprint;
  expect(rest).toEqual(quoted);

  /* The real job finishes; the take is filed and shows as a version. */
  await expect(page.getByRole("status").filter({ hasText: /Opening wide rendered/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /^Versions/ }).click();
  await expect(page.locator('.pxw-insp-version[data-state="rendered"]')).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(async () => {
    const library = await page.request.get(`/api/workbench/library?projectId=${project.id}&source=generations`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
    return (library.generations ?? []).filter((g: { status: string }) => g.status === "succeeded").length;
  }, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await savedDraft(page, scope, project.id)).assets.filter((a) => a.nodeId === "rig-a" && a.generationId).length, { timeout: 30_000 }).toBe(1);
  /* A finished take is filed for review; the shot is not auto-approved. */
  await expect(page.getByTestId("page-sub")).toHaveText("3 shots · 0 approved");

  /* Takes → Rig: selection repair leaves a shot selected and G still generates. */
  const tabs = page.getByRole("navigation", { name: "Pages" });
  await tabs.getByRole("button", { name: /Takes/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await tabs.getByRole("button", { name: /Rig/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.locator('[data-row="page"]').getByRole("button", { name: /^Generate · / })).toBeEnabled();
  await page.locator("body").press("g");
  await expect.poll(() => sent.filter((s) => s.path === "/api/generate").length, { timeout: 30_000 }).toBe(2);
  await expect(page.locator(".pxw-gen")).toBeVisible();
});

test("no clipping at 1200, 1440 and 1920 with a shot selected", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop project resizes through all three");
  const { project } = await seeded(page);
  for (const size of [{ width: 1200, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    await page.goto(rigUrl(project.id, "rig-b"));
    await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");
    await expect(page.locator('.pxw-rig-row[data-status="ready"]')).toHaveCount(3);
    await assertNoClipping(page);
  }
});

test("graph view: the real graph, edges from real boxes, selection shared with the list, connections by the graph's rules", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* Test fixtures only: a look board and a direction note feed the encounter; a colour node follows it. */
  const { project, scope } = await seeded(page, (shots) => [
    { id: "look", type: "moodboard", title: "Warm daylight board", x: -300, y: 100, width: 280, linked: [], text: "Warm sand. Cool chrome.", role: "Art director" },
    { id: "brief", type: "note", title: "Director's note", x: -300, y: 500, width: 280, linked: [], text: "Let the world feel impossible.", role: "Director" },
    ...shots.map((n) => (n.id === "rig-b" ? { ...n, linked: ["look", "brief"] } : n)),
    { id: "grade", type: "grade", title: "Desert daylight", x: 500, y: 500, width: 236, linked: ["rig-b"], operations: [{ id: "g1", kind: "grade", enabled: true, values: { brightness: 103, contrast: 105, saturation: 90 } }] },
  ]);
  await page.goto(rigUrl(project.id, "rig-b"));
  await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");
  await page.getByRole("group", { name: "Rig view" }).getByRole("button", { name: "Canvas" }).click();
  await expect(page.locator(".pxw-crumbs .pxw-kicker")).toHaveText("NODE GRAPH");
  const graph = page.getByTestId("rig-graph");
  await expect(graph.locator(".pxw-graph-node")).toHaveCount(6);
  await expect(graph.locator("path[data-edge]")).toHaveCount(3);
  await expect(graph.locator('.pxw-graph-node[data-selected]')).toHaveAttribute("aria-label", "Scene: The encounter");
  await expect(graph.locator(".pxw-graph-badge")).toHaveText("SCENE PREVIEW");
  await expect(graph.locator('path[data-active]')).toHaveCount(2);
  await expect(graph.getByRole("group", { name: "Colour: Desert daylight" })).toContainText("B103C105S90");
  await expect(graph).toContainText("The graph is the advanced view of the same 3 shots. Everything here can be done from the shot list.");

  /* Every edge runs from its source card's right edge to its target card's left edge, at their middles. */
  const mismatches = await page.evaluate(() => {
    const out: string[] = [];
    const canvas = document.querySelector<HTMLElement>(".pxw-graph-canvas")!.getBoundingClientRect();
    for (const path of Array.from(document.querySelectorAll<SVGPathElement>("path[data-edge]"))) {
      const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!.getBoundingClientRect();
      const from = box(path.dataset.source!), to = box(path.dataset.target!);
      const nums = (path.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
      const [x1, y1] = nums, [x2, y2] = nums.slice(-2);
      const near = (a: number, b: number) => Math.abs(a - b) < 1.5;
      if (!near(x1, from.right - canvas.left) || !near(y1, from.top + from.height / 2 - canvas.top) || !near(x2, to.left - canvas.left) || !near(y2, to.top + to.height / 2 - canvas.top))
        out.push(`${path.dataset.edge}: ${path.getAttribute("d")}`);
    }
    return out;
  });
  expect(mismatches).toEqual([]);

  /* The board fits the content pane and pans inside itself (zoom and pan); nothing widens or scrolls sideways. */
  const fit = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="content"]')!, studio = document.querySelector<HTMLElement>(".pxw-studio")!;
    const board = document.querySelector<HTMLElement>('[data-testid="rig-graph-surface"]')!;
    return { board: board.getBoundingClientRect().right, pane: content.getBoundingClientRect().right, studioScrolls: studio.scrollWidth > studio.clientWidth + 0.5, pageScrolls: document.documentElement.scrollWidth > innerWidth + 1, contentScrolls: content.scrollWidth > content.clientWidth + 1 };
  });
  expect(fit.board).toBeLessThanOrEqual(fit.pane + 0.5);
  expect(fit.studioScrolls).toBe(false);
  expect(fit.pageScrolls).toBe(false);
  expect(fit.contentScrolls).toBe(false);

  /* Selecting a node selects the same shot in the Inspector, and in the list. */
  await graph.getByRole("button", { name: "Select Departure" }).click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Departure");
  await expect(graph.getByRole("button", { name: "Select Departure" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]sel=shot%3Arig-c(&|$)/);
  await expect(graph.locator('path[data-active]')).toHaveCount(0);

  /* Connections follow the graph's rules and save through the draft. */
  await graph.getByRole("button", { name: "Connect from Departure" }).click();
  await graph.getByRole("button", { name: "Connect into Departure" }).click();
  await expect(graph.getByRole("status")).toHaveText("A node cannot connect to itself.");
  await graph.getByRole("button", { name: "Connect from Warm daylight board" }).click();
  await graph.getByRole("button", { name: "Connect into Departure" }).click();
  await expect(graph.locator("path[data-edge]")).toHaveCount(4);
  await expect(graph.locator('path[data-active]')).toHaveCount(1);
  await expect.poll(async () => (await savedDraft(page, scope, project.id)).nodes.find((n) => n.id === "rig-c")!.linked).toEqual(["look"]);

  /* Back to the list: the same shot is selected. */
  await page.getByRole("group", { name: "Rig view" }).getByRole("button", { name: "List" }).click();
  await expect(row(page, /Departure/)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".pxw-crumbs .pxw-kicker")).toHaveText("STUDIO");
  expect(errors).toEqual([]);
});
