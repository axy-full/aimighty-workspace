import { test, expect, type Page, type Request } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";

/**
 * /workspace on a phone, wave M-C: the Make wall, Settings, and the Inspector,
 * Atomik and Library sheets.
 *
 * The composer, the Inspector and the draft are real: the wall's docked
 * composer prices through GET /api/workbench/engines, re-quotes POST
 * /api/generate/quote and dispatches a mocked render through POST
 * /api/generate against an ENGINE_MOCK server, and an Inspector edit goes
 * through the same revision-checked PUT /api/workbench/projects the desktop
 * uses. Only two things are intercepted, and only because the local mock has
 * no equivalent: the project library (so the wall has takes whose days and
 * billed credits are known) and the Atomik plan's own quote route (so the test
 * can prove what the browser sent, and when).
 *
 * The rules under test are the phone's non-negotiables — nothing under 12px,
 * no target under 44×44, one filled primary, the last row clearing the pinned
 * block, the dock behind an open sheet's scrim — plus the one acceptance item
 * the design calls out twice: the action bar's approve button APPROVES, and
 * never starts or restarts a run.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";
const DAY = 86_400_000;

/* ── Fixtures. Tests only; the app reads these shapes from the real routes. ── */

function shot(id: string, title: string, note: string, y: number): CanvasNode {
  return {
    id, title, type: "scene", x: 100, y, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
    operations: [{ id: `op-${id}`, kind: "direction", enabled: true, values: { note } }],
    engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
  };
}

/** One row of GET /api/workbench/library's `generations`, as the wall reads it. */
function generation(over: Record<string, unknown> & { id: string }) {
  const now = Date.now();
  return {
    projectId: null, projectName: null, arkTaskId: null, kind: "video", reviewState: "", reviewBy: null,
    pickedBy: null, pickedAt: null, approvedBy: null, approvedAt: null, model: ENGINE,
    prompt: "Wide plate, warm daylight, no figure", title: null, params: { ratio: "16:9", duration: 5 },
    status: "succeeded", sourceUrl: null, storedUrl: null, totalTokens: null, costUsd: null, creditsBilled: 19,
    refineCostUsd: null, refineModel: null, refineInTokens: null, refineOutTokens: null, error: null,
    createdBy: "test", authorName: "You", shotId: null, shotCode: null, shotScene: null, shotTitle: null,
    version: 1, durationMs: null, durationS: null, provider: "mock", attempts: 1, task: "generate",
    sourceGenId: null, createdAt: now, updatedAt: now,
    ...over,
    id: over.id,
  };
}

async function seeded(page: Page, opts: { shots?: boolean } = {}) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 2000, "Local mock phone fixture", "admin", "test", Date.now()],
    });
  } finally {
    db.close();
  }
  const project: Project = {
    ...newProject(`Phone fixture ${randomUUID().slice(0, 6)}`),
    ...(opts.shots ? { nodes: [shot("rig-a", "Opening wide", "Wide. Hold still.", 100), shot("rig-b", "The encounter", "She enters.", 500)] } : {}),
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  return { project, scope, workspaceName: String(signed.workspace.name) };
}

/**
 * The project library, served from a list the test can grow. The real route is
 * not touched otherwise: the wall reads the same shapes, cursors and all.
 */
async function mockLibrary(page: Page, rows: Record<string, unknown>[]) {
  await page.route("**/api/workbench/library**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (source === "uploads") return route.fulfill({ json: { uploads: [], nextCursor: null } });
    return route.fulfill({ json: { generations: rows, nextPageCursor: null } });
  });
}

const makeUrl = (id: string) => `/workspace?project=${id}&level=make`;
const pageUrl = (id: string, suite: string, pageId: string, sel?: string) =>
  `/workspace?project=${id}&suite=${suite}&page=${pageId}${sel ? `&sel=${sel}` : ""}`;

/**
 * The filled primaries a thumb can actually reach. One per screen is the
 * non-negotiable, and a sheet's scrim is what makes the pinned one stop
 * counting: it is covered, so the hit test finds the sheet instead.
 */
async function filledPrimaries(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".pxm-primary, .pxm-filled, .pxm-gate-approve"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === el || el.contains(hit);
      })
      .map((el) => el.textContent?.trim().slice(0, 40) ?? ""),
  );
}

/* ══ Make ════════════════════════════════════════════════════════════════ */

test("the Make wall groups the unfiled takes by day and derives every count", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);
  /* The wall's day groups are the VIEWER's own local days (lib/workspace/make
     dayKey/dayLabel), so a fixture written against the wall-clock instant the
     run happens to start drifts across local midnight: at 00:20 a take "12 min
     ago" is today and one "26 min ago" is yesterday. The clock is pinned
     instead — local noon of the run's own day, read in the page so it is the
     browser's timezone and nobody's assumption — and every timestamp below is
     written against that same instant, which the page then reads as its `now`.
     Times only, never the timers: the ring, the polling and the composer's
     quote all keep running. The test therefore means the same thing at 00:01
     as at 23:59, anywhere on earth. */
  const now = await page.evaluate(() => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    return noon.getTime();
  });
  await page.clock.setFixedTime(now);
  await mockLibrary(page, [
    generation({ id: "g-today-1", createdAt: now - 12 * 60_000, creditsBilled: 19, prompt: "Mira enters. The landscape becomes a reflection." }),
    /* Still rendering: the ring goes over its well, and it carries no price. */
    generation({ id: "g-today-2", createdAt: now - 26 * 60_000, status: "queued", creditsBilled: null }),
    generation({ id: "g-yesterday", createdAt: now - DAY, creditsBilled: 11 }),
    /* Filed to a shot: not on the unfiled wall at all. */
    generation({ id: "g-filed", createdAt: now - 2 * 60_000, shotId: "shot-1", creditsBilled: 99 }),
    /* Another kind: the Images tab's, not Video's. */
    generation({ id: "g-still", kind: "image", createdAt: now - 3 * 60_000, creditsBilled: 4, params: { ratio: "3:2" } }),
  ]);

  await page.goto(makeUrl(project.id));
  await expect(page.locator('[data-screen="make"]')).toBeVisible();
  await expect(page.getByTestId("phone-shell")).toBeVisible();

  /* The header line is derived: two settled figures and a render in flight. */
  await expect(page.getByTestId("mobile-make-header")).toHaveText(/UNFILED.*3 TAKES.*30 CR/);
  /* Grouped by day, newest day first, 2-up. */
  const days = page.locator(".pxm-make-day");
  await expect(days).toHaveCount(2);
  await expect(days.nth(0)).toContainText("TODAY");
  await expect(days.nth(0)).toContainText("2 takes");
  await expect(days.nth(1)).toContainText("YESTERDAY");
  await expect(days.nth(1)).toContainText("1 take");
  await expect(page.getByTestId("mobile-take-card")).toHaveCount(3);
  /* The take still rendering carries the ring, and it is the only loader. */
  await expect(page.getByTestId("mobile-take-ring")).toHaveCount(1);
  expect(await page.locator(".pxm-take-loading svg").first().getAttribute("width")).toBe("36");
  const spinners = await page.locator('[class*="spin"], [class*="skeleton"], [class*="shimmer"]').count();
  expect(spinners).toBe(0);
  /* Spec chip, author and cost come off the generation. */
  const first = page.getByTestId("mobile-take-card").first();
  await expect(first.locator(".pxm-take-spec")).toHaveText("SEEDANCE 2.5 · 16:9 · 5S");
  await expect(first.locator(".pxm-take-by")).toHaveText(/^You · \d+ min$/);
  await expect(first.locator(".pxm-take-cost")).toHaveText("19 cr");

  /* One control: the tab is the composer's own type, so Images re-derives both. */
  await page.locator('.pxm-segment[data-kind="image"]').click();
  await expect(page.getByTestId("mobile-make-header")).toHaveText(/UNFILED.*1 TAKE.*4 CR/);
  await expect(page.getByTestId("mobile-take-card")).toHaveCount(1);
  await page.locator('.pxm-segment[data-kind="audio"]').click();
  await expect(page.getByTestId("mobile-make-header")).toHaveText(/UNFILED.*NO TAKES/);
  await expect(page.getByTestId("mobile-make-empty")).toBeVisible();
  await page.locator('.pxm-segment[data-kind="video"]').click();

  /* The floors, and the last row clearing both pinned blocks. */
  expect(await smallText(page)).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
  /* Exactly one filled primary, and its cost is inline. */
  expect(await filledPrimaries(page)).toHaveLength(1);
  await expect(page.getByTestId("mobile-primary")).toContainText("Render");
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("make-390x844.png"), animations: "disabled" });
  /* Last, because it scrolls the wall to its end. */
  expect(await lastRowClearsPinned(page)).toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("the docked composer runs the desktop machinery: one live quote, re-quoted, then a mocked render that files a take", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);
  const rows: Record<string, unknown>[] = [];
  await mockLibrary(page, rows);

  /* Every POST that could spend money, in the order the browser sent it. */
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (["/api/generate", "/api/generate/quote", "/api/audio", "/api/higgsfield/consumer/generation"].includes(path))
      sent.push({ path, body: request.postDataJSON() });
  });

  await page.goto(makeUrl(project.id));
  await expect(page.locator('[data-screen="make"]')).toBeVisible();

  /* The card docks above the pinned primary and says what would be sent. */
  const card = page.getByTestId("mobile-composer-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".pxm-composer-line")).toHaveText("Write what to make");
  /* Nothing is priced before there is something to price. */
  await expect(page.getByTestId("mobile-primary")).toHaveAttribute("aria-disabled", "true");

  /* Tapping the card opens the rest of the composer on the sheet chrome. */
  await card.click();
  const sheet = page.getByTestId("mobile-composer-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Charged to");
  /* This workspace's credits are the default; the connected account is a switch. */
  await expect(page.getByTestId("mobile-composer-billing-workspace")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("mobile-composer-billing-connected")).toHaveAttribute("aria-pressed", "false");
  /* Video, so the render lands as a take with a duration. */
  await sheet.locator('.pxm-segment[data-kind="video"]').click();
  await page.getByTestId("mobile-composer-prompt").fill("A dune ridge at first light, no figure");

  /* The live quote reaches both the sheet's button and the pinned primary. */
  const priced = /Render\s*\d[\d,]* cr · \d+s/;
  await expect(sheet.getByTestId("mobile-composer-render")).toHaveText(priced, { timeout: 30_000 });
  const label = (await sheet.getByTestId("mobile-composer-render").textContent())!;
  const credits = Number(/(\d[\d,]*) cr/.exec(label)![1].replace(/\D/g, ""));
  expect(credits).toBeGreaterThan(0);
  /* Exactly one filled primary while the sheet is up: the pinned one is behind
     the scrim. (Scrolled into the sheet's own view first — a landscape phone
     is 390 tall, so the form's last row starts below the fold.) */
  await sheet.getByTestId("mobile-composer-render").scrollIntoViewIfNeeded();
  expect(await filledPrimaries(page)).toEqual([expect.stringContaining("Render")]);
  await expect(card.locator(".pxm-composer-eyebrow")).toHaveText(/^COMPOSER · /);
  /* Nothing has been sent yet. */
  expect(sent).toEqual([]);

  await sheet.getByTestId("mobile-composer-render").click();
  /* The shared dispatch re-quotes with the exact body, then submits it. */
  await expect.poll(() => sent.map((s) => s.path), { timeout: 60_000 }).toEqual(["/api/generate/quote", "/api/generate"]);
  expect(sent[1].body.maxCredits).toBe(credits);
  expect(sent[1].body).toHaveProperty("quoteFingerprint");

  /* The render runs on the real job, and the shell's strip carries its phase. */
  await expect(page.getByTestId("mobile-gen")).toBeVisible({ timeout: 30_000 });
  /* Completion files a take for review — the repo's lifecycle, not an auto-approve. */
  await expect(page.locator(".pxw-toast")).toContainText("Filed in Takes for review", { timeout: 150_000 });

  /* Where it landed: the composer files its take to a shot, exactly as it does
     on the desktop, so the take opens in Takes and the UNFILED wall — which is
     takes with no shot — is still empty. The wall says that rather than
     leaving a person waiting for a card that is not coming. */
  await page.getByTestId("mobile-sheet-scrim").click({ position: { x: 20, y: 10 } });
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("mobile-make-empty")).toContainText("filed to its own shot and opens in Takes");
  await expect(page.getByTestId("mobile-make-header")).toHaveText(/UNFILED.*NO TAKES/);
  /* A generation that DOES arrive without a shot lands on the wall, and the
     header re-derives from it. (A fresh visit, because the project library is
     one store shared with Takes and it re-reads on arrival, not on every tab.) */
  rows.push(generation({ id: "g-new", createdAt: Date.now(), creditsBilled: 7, prompt: "Arrived without a shot" }));
  await page.goto(makeUrl(project.id));
  await expect.poll(async () => page.getByTestId("mobile-take-card").count(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId("mobile-make-header")).toHaveText(/UNFILED.*1 TAKE.*7 CR/);

  expect(errors).toEqual([]);
});

/* ══ The Atomik sheet ════════════════════════════════════════════════════ */

type AtomikMock = { quoteCalls: number; dispatches: Record<string, unknown>[]; paid: string[] };

async function mockAtomik(page: Page): Promise<AtomikMock> {
  const mock: AtomikMock = { quoteCalls: 0, dispatches: [], paid: [] };
  await page.route("**/api/workbench/atomik**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const requestId = new URL(request.url()).searchParams.get("requestId");
      const last = mock.dispatches.at(-1);
      return route.fulfill({
        json: {
          jobs: requestId && last
            ? [{ id: "job-1", requestId, status: "succeeded", request: String(last.request), plan: { steps: ["Board the film", "Render the shots"] } }]
            : [],
        },
      });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) {
      mock.quoteCalls += 1;
      return route.fulfill({ json: { estimateCredits: 12, estimateUsd: 1.2, quoteOnly: true } });
    }
    mock.dispatches.push(body);
    return route.fulfill({ status: 202, json: { job: { id: "job-1", requestId: body.requestId, status: "queued" } } });
  });
  page.on("request", (request: Request) => {
    if (request.method() === "GET" || !request.url().includes("/api/")) return;
    let quote = false;
    try {
      quote = (request.postDataJSON() as { quoteOnly?: unknown } | null)?.quoteOnly === true;
    } catch { /* not JSON */ }
    if (!quote) mock.paid.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return mock;
}

test("the Atomik sheet reaches its gate, and the action bar's approve APPROVES — it never restarts the run", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);
  await mockLibrary(page, []);
  const mock = await mockAtomik(page);

  await page.goto(pageUrl(project.id, "atomik", "agent"));
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Agent");

  /* The action bar's Atomik control starts the plan and opens the sheet. */
  const ask = page.getByTestId("mobile-ask-atomik");
  await expect(ask).toHaveAttribute("data-tone", "idle");
  await ask.click();
  const sheet = page.getByTestId("mobile-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("mobile-atomik-body")).toBeVisible();

  /* It stops at the gate with the live price, and nothing paid has left. */
  await expect(page.getByTestId("mobile-atomik-gate")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("mobile-gate-price")).toHaveText("12 cr");
  const steps = page.getByTestId("mobile-atomik-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toHaveAttribute("data-tone", "done");
  await expect(steps.nth(1)).toHaveAttribute("data-tone", "gate");
  expect(mock.quoteCalls).toBe(1);
  expect(mock.dispatches).toEqual([]);
  expect(mock.paid).toEqual([]);
  /* The dock badges the waiting approval, and hides behind the scrim. */
  await expect(page.getByTestId("mobile-gate-badge")).toBeVisible();
  const dockCovered = await page.evaluate(() => {
    const tab = document.querySelector<HTMLElement>('[data-tab="atomik"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(tab.left + tab.width / 2, tab.top + tab.height / 2);
    return hit?.closest('[data-testid="mobile-sheet"]') !== null;
  });
  expect(dockCovered).toBe(true);
  expect(await smallText(page)).toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("atomik-gate-390x844.png"), animations: "disabled" });

  /* Close the sheet: the action bar now carries the approval, in amber. */
  await page.locator(".pxm-sheet-close").click();
  await expect(sheet).toHaveCount(0);
  await expect(ask).toHaveAttribute("data-tone", "waiting");
  await expect(ask).toHaveText("Approve 12 cr");

  /* THE acceptance item: this button approves. It does not start, and it does
     not restart — a restart would re-quote (quoteCalls 2) and take step 0 back
     to idle. Neither happens: the run resumes from the gate it was held at. */
  await ask.click();
  await expect.poll(() => mock.dispatches.length, { timeout: 30_000 }).toBe(1);
  expect(mock.quoteCalls).toBe(1);
  expect(mock.dispatches[0].maxCredits).toBe(12);
  expect(mock.dispatches[0].quoteOnly).toBeUndefined();
  /* Exactly one paid request in the whole run, and it came after the approval. */
  expect(mock.paid).toEqual(["POST /api/workbench/atomik"]);

  /* The run finished from the gate onwards, so every step is done. */
  await page.locator('[data-tab="atomik"]').click();
  await expect(page.getByTestId("mobile-atomik-step")).toHaveCount(4);
  for (const tone of await page.getByTestId("mobile-atomik-step").evaluateAll((els) => els.map((el) => el.getAttribute("data-tone"))))
    expect(tone).toBe("done");
  await expect(page.getByTestId("mobile-atomik-activity")).toContainText("Plan ready · 2 steps");
  /* Still exactly one dispatch after all of that. */
  expect(mock.dispatches).toHaveLength(1);
  expect(errors).toEqual([]);
});

/* ══ The Inspector and Library sheets ════════════════════════════════════ */

test("the Inspector sheet is the desktop Inspector, and an edit made in it persists", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, scope } = await seeded(page, { shots: true });
  await mockLibrary(page, []);

  const rigLink = pageUrl(project.id, "particl", "rig", "shot:rig-b");
  await page.goto(rigLink);
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Rig");

  /* The Library sheet first, from the dock. */
  await page.locator('[data-tab="library"]').click();
  await expect(page.getByTestId("mobile-library-body")).toBeVisible();
  /* The Library sheet lists the page's own tools, from the desktop's config. */
  await expect(page.getByTestId("mobile-library-tool").first()).toBeVisible();
  const tools = await page.getByTestId("mobile-library-tool").count();
  expect(tools).toBeGreaterThan(3);
  await expect(page.locator(".pxm-lib-group").first()).toContainText("REFERENCES");
  /* Media is the same store, and reads empty rather than guessing. */
  await page.getByTestId("mobile-library-media").click();
  await expect(page.getByTestId("mobile-library-body")).toContainText("No media in this project yet");
  expect(await smallText(page)).toEqual([]);
  /* A scrim tap closes it — what a thumb reaches. */
  await page.getByTestId("mobile-sheet-scrim").click({ position: { x: 20, y: 10 } });
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

  /* Now the Inspector, over the same selection the URL carried. */
  await openInspector(page, rigLink);
  await expect(page.getByTestId("mobile-inspector-body")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");
  /* Controls / Inputs / Versions is the desktop's own control, over state.inspTab. */
  const tabs = page.getByRole("group", { name: "Inspector tabs" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Controls/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Inputs/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Versions/ })).toBeVisible();
  expect(await smallText(page)).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("inspector-sheet-390x844.png"), animations: "disabled" });

  /* The edit goes through the same revision-checked draft save as the desktop's. */
  await page.getByRole("textbox", { name: "Direction note" }).fill("She enters, and the ridge answers.");
  await expect.poll(async () => {
    const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json())).project as Project;
    const node = saved.nodes.find((n) => n.id === "rig-b");
    return node?.operations?.[0]?.values?.note;
  }, { timeout: 60_000 }).toBe("She enters, and the ridge answers.");

  /* And it survives a reload, read back from the saved draft. */
  await openInspector(page, rigLink);
  await expect(page.getByRole("textbox", { name: "Direction note" })).toHaveValue("She enters, and the ridge answers.");
  expect(errors).toEqual([]);
});

/**
 * Open the Inspector sheet. The dock has five tabs and none of them is the
 * Inspector, so on the phone the sheet is opened by whatever owns a selection:
 * a take card on the Make wall, a row in a page template, or — as here and as
 * a shareable "look at this shot" link — the URL's own `?sheet=inspector`.
 */
async function openInspector(page: Page, url: string) {
  await page.goto(`${url}&sheet=inspector`);
  await expect(page.getByTestId("mobile-inspector-body")).toBeVisible();
}

/* ══ Settings ════════════════════════════════════════════════════════════ */

test("Settings reads the real account: balance, its dollar value, the workspace rows and the three rules", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, workspaceName } = await seeded(page);
  await mockLibrary(page, []);

  await page.goto(`/workspace?project=${project.id}&level=settings`);
  await expect(page.locator('[data-screen="settings"]')).toBeVisible();

  /* The balance is the granted credits the fixture paid in, and its own USD. */
  await expect(page.getByTestId("mobile-settings-balance")).toHaveText(/^[\d,]+ CR$/);
  await expect(page.getByTestId("mobile-settings-usd")).toHaveText(/^\$[\d,]+\.\d{2}$/);
  /* Top up names a real pack and links to the flow that owns it. */
  const topup = page.getByTestId("mobile-settings-topup");
  if (await topup.count()) {
    await expect(topup).toHaveText(/^Top up · [\d,]+ CR · \$\d/);
    await expect(topup).toHaveAttribute("href", "/billing#credit-packs");
  }
  /* The workspace rows are the routes' own answers, starting with this workspace. */
  await expect(page.getByTestId("mobile-settings-workspace")).toContainText(workspaceName);
  await expect(page.locator('[data-row="Cost approval"]')).toBeVisible();
  /* The three Atomik rules, in order. */
  const rules = page.getByTestId("mobile-settings-rules").locator(".pxm-rule-label");
  await expect(rules).toHaveText(["EVERY PAID STEP", "PROPOSE ONLY", "NEVER WITHOUT YOU"]);
  /* Nothing is invented: there is no auto top-up switch, because nothing holds one. */
  await expect(page.locator('[data-screen="settings"]')).not.toContainText("Auto top-up");

  expect(await smallText(page)).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
  /* Settings spends nothing, so it pins no action bar; Top up is its one filled control. */
  expect((await filledPrimaries(page)).length).toBeLessThanOrEqual(1);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("settings-390x844.png"), animations: "disabled" });
  /* Last, because it scrolls the screen to its end. */
  expect(await lastRowClearsPinned(page)).toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

/* ══ The desktop is untouched ════════════════════════════════════════════ */

test("the desktop surfaces above the breakpoint are unchanged", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page, { shots: true });
  await mockLibrary(page, []);

  await page.goto(pageUrl(project.id, "particl", "rig", "shot:rig-b"));
  /* The desktop shell, its rows, its Library rail and its Inspector. */
  await expect(page.getByTestId("studio-row")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.locator(".pxw-library")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText("The encounter");
  /* Nothing of the phone exists here: no dock, no phone shell, no wall. */
  await expect(page.getByTestId("phone-shell")).toHaveCount(0);
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await expect(page.getByTestId("mobile-composer-card")).toHaveCount(0);
  await expect(page.locator('[data-screen="make"], [data-screen="settings"]')).toHaveCount(0);
  /* The desktop composer is still the desktop's overlay, opened from the top bar. */
  await page.getByTestId("topbar-generate").click();
  await expect(page.getByTestId("generate-composer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("generate-composer")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
