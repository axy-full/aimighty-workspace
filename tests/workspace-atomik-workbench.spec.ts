import { test, expect, type Page, type Request } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * Atomik panel, gates and agent surfaces (workspace redesign, wave 2).
 *
 * The Agent page's plan is paid: it prices one planning pass at
 * POST /api/workbench/atomik {quoteOnly} and dispatches at the same route.
 * Both are intercepted here, so the test proves what the browser sends:
 * nothing paid leaves before Approve, Not now sends nothing, Approve sends
 * exactly the quoted credits, and a stale quote is re-quoted before any
 * dispatch. Desktop assertions skip on phones, which keep the phone surface.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

/* Test fixtures only — the app reads these from the real projects route. */
const primary = { ...newProject("Coastal light study"), id: "ws-atomik-a", description: "Product film · Spot 02", aspect: "16:9", fps: 24 };
const list = [{ id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" }];

type Mock = { quotes: number[]; quoteCalls: number; dispatches: Record<string, unknown>[]; paidRequests: string[] };

async function setup(page: Page): Promise<Mock> {
  const mock: Mock = { quotes: [12, 14], quoteCalls: 0, dispatches: [], paidRequests: [] };
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) =>
    route.fulfill({ json: { projects: list, productions: [], project: primary, revision: 1, shared: null } }),
  );
  await page.route("**/api/workbench/atomik**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const requestId = url.searchParams.get("requestId");
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
      const credits = mock.quotes[Math.min(mock.quoteCalls, mock.quotes.length - 1)];
      mock.quoteCalls += 1;
      return route.fulfill({ json: { estimateCredits: credits, estimateUsd: credits / 10, quoteOnly: true } });
    }
    mock.dispatches.push(body);
    return route.fulfill({ status: 202, json: { job: { id: "job-1", requestId: body.requestId, status: "queued" } } });
  });
  /* Every non-GET API request that is not a quote counts as a dispatch attempt. */
  page.on("request", (request: Request) => {
    if (request.method() === "GET" || !request.url().includes("/api/")) return;
    let quote = false;
    try {
      quote = (request.postDataJSON() as { quoteOnly?: unknown } | null)?.quoteOnly === true;
    } catch {
      /* not JSON */
    }
    if (!quote) mock.paidRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return mock;
}

/** Every child of every header row stays inside its row and left of the Inspector. */
async function assertNoClipping(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const inspector = document.querySelector('[data-testid="inspector"]')?.getBoundingClientRect() ?? null;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-row]"))) {
      const name = row.dataset.row!;
      const rowRect = row.getBoundingClientRect();
      for (const child of Array.from(row.children) as HTMLElement[]) {
        const rect = child.getBoundingClientRect();
        if (!rect.width) continue;
        const right = rect.right - rowRect.left + row.scrollLeft;
        if (right > row.scrollWidth + 0.5) out.push(`${name}: ${child.className || child.tagName} ends at ${right} past ${row.scrollWidth}`);
        if (inspector && ["project", "page", "crumbs"].includes(name) && rect.right > inspector.left + 0.5)
          out.push(`${name}: ${child.className || child.tagName} overlaps the Inspector`);
      }
      if (["project", "page", "crumbs"].includes(name) && row.scrollWidth > row.clientWidth + 0.5)
        out.push(`${name}: row content ${row.scrollWidth} wider than the row ${row.clientWidth}`);
    }
    for (const id of ["project-title", "page-title"]) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${id} truncated`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push("document scrolls horizontally");
    return out;
  });
  expect(problems).toEqual([]);
}

async function openAgentPage(page: Page) {
  await page.goto("/workspace?project=" + primary.id + "&suite=atomik&page=agent");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
}

async function reachGate(page: Page, credits: number) {
  await page.getByTestId("run-chip").click();
  const panel = page.getByTestId("atomik-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("atomik-gate")).toBeVisible();
  await expect(page.getByTestId("atomik-gate-price")).toHaveText(`${credits} cr`);
  await expect(panel.getByRole("button", { name: `Approve ${credits} cr` })).toBeVisible();
  await expect(page.getByTestId("atomik-state")).toHaveText("WAITING ON YOU");
}

test("phones render the phone shell", async ({ page }, info) => {
  test.skip(DESKTOP.includes(info.project.name), "phone viewports");
  await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=atomik&page=agent");
  /* The phone shell renders here now (wave M-A): /workspace is the phone's
     surface below 768px, and the desktop studio row is not mounted. */
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
});

test("a paid plan stops at its gate; Not now dispatches nothing", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mock = await setup(page);
  await openAgentPage(page);

  const button = page.getByTestId("atomik-button");
  await expect(button).toHaveAttribute("data-atomik-state", "idle");
  await expect(button).toContainText("ready");
  await expect(page.getByTestId("run-chip")).toHaveText("Run with Atomik");

  await reachGate(page, 12);
  /* Steps come from the engine: the read is done, the gate holds. */
  const steps = page.getByTestId("atomik-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toHaveAttribute("data-tone", "done");
  await expect(steps.nth(1)).toHaveAttribute("data-tone", "gate");
  await expect(steps.nth(1)).toContainText("$");
  await expect(steps.nth(2)).toHaveAttribute("data-tone", "idle");
  await expect(page.getByTestId("library-next")).toHaveText("Waiting on your approval — 12 cr.");
  expect(mock.quoteCalls).toBe(1);
  expect(mock.dispatches).toEqual([]);
  expect(mock.paidRequests).toEqual([]);
  if (info.project.name === "workbench-1440x900") await page.screenshot({ path: info.outputPath("atomik-gate-waiting.png") });

  /* The waiting surfaces: amber chip with the live price, "1 approval" badge; the header never clips. */
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("atomik-panel")).toHaveCount(0);
  await expect(page.getByTestId("run-chip")).toHaveText("Approve 12 cr");
  await expect(page.getByTestId("run-chip")).toHaveAttribute("data-tone", "waiting");
  await expect(button).toHaveAttribute("data-atomik-state", "waiting");
  await expect(button).toContainText("1 approval");
  const configured = page.viewportSize()!;
  for (const width of [1200, 1440, 1920]) {
    await page.setViewportSize({ width, height: configured.height });
    await assertNoClipping(page);
  }
  await page.setViewportSize(configured);

  /* Not now: the run is dropped and nothing is sent. */
  await page.getByTestId("run-chip").click();
  await page.getByTestId("atomik-panel").getByRole("button", { name: "Not now" }).click();
  await expect(page.locator(".pxw-toast")).toHaveText("Run held. Nothing was dispatched.");
  await expect(page.getByTestId("atomik-gate")).toHaveCount(0);
  await expect(page.getByTestId("atomik-state")).toHaveText("IDLE");
  await expect(page.getByTestId("run-chip")).toHaveText("Run with Atomik");
  expect(mock.dispatches).toEqual([]);
  expect(mock.paidRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("Approve sends exactly the quoted credits and completes the page", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const mock = await setup(page);
  await openAgentPage(page);
  await reachGate(page, 12);
  expect(mock.dispatches).toEqual([]);

  await page.getByTestId("atomik-panel").getByRole("button", { name: "Approve 12 cr" }).click();
  await expect(page.getByTestId("atomik-state")).toHaveText("DONE");
  expect(mock.dispatches).toHaveLength(1);
  expect(mock.dispatches[0].maxCredits).toBe(12);
  expect(mock.dispatches[0].quoteOnly).toBeUndefined();
  expect(mock.paidRequests).toEqual(["POST /api/workbench/atomik"]);
  await expect(page.getByTestId("atomik-step")).toHaveCount(4);
  for (const tone of await page.getByTestId("atomik-step").evaluateAll((els) => els.map((el) => el.getAttribute("data-tone"))))
    expect(tone).toBe("done");
  await expect(page.locator(".pxw-toast")).toHaveText("Plan ready · 2 steps");
  await expect(page.getByTestId("atomik-activity")).toContainText("Plan ready · 2 steps");
  await expect(page.getByTestId("atomik-activity")).toContainText("just now");
  await expect(page.getByTestId("atomik-panel").getByRole("button", { name: /Run again/ })).toBeEnabled();

  /* Completed: the stage tab carries the done mark and Home reads "Complete". */
  await page.keyboard.press("Escape");
  const tab = page.getByRole("navigation", { name: "Pages" }).locator('[data-page="agent"]');
  await expect(tab.getByLabel("Complete")).toBeVisible();
  await page.locator(".pxw-wordmark").click();
  await expect(page.locator('.pxw-feature[data-feature="agent"]')).toContainText("Complete");
  expect(mock.dispatches).toHaveLength(1);
});

test("a stale quote is re-quoted before anything is dispatched", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await page.clock.install();
  const mock = await setup(page);
  await openAgentPage(page);
  await reachGate(page, 12);

  /* Past the quote's lifetime: Approve re-quotes and waits again; nothing is sent. */
  await page.clock.fastForward("06:00");
  await page.getByTestId("atomik-panel").getByRole("button", { name: "Approve 12 cr" }).click();
  await expect(page.getByTestId("atomik-gate")).toContainText("Quote refreshed — price changed from 12 cr to 14 cr.");
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("14 cr");
  await expect(page.getByTestId("run-chip")).toHaveText("Approve 14 cr");
  expect(mock.quoteCalls).toBe(2);
  expect(mock.dispatches).toEqual([]);
  expect(mock.paidRequests).toEqual([]);

  await page.getByTestId("atomik-panel").getByRole("button", { name: "Approve 14 cr" }).click();
  await expect(page.getByTestId("atomik-state")).toHaveText("DONE");
  expect(mock.dispatches).toHaveLength(1);
  expect(mock.dispatches[0].maxCredits).toBe(14);
});

test("plans without their page's data are not runnable and say why", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const mock = await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=rig");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Atomik/ }).click();
  const panel = page.getByTestId("atomik-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Render every ready shot");
  /* Rig publishes its request bodies (#236), so the plan's own reason applies. */
  await expect(page.getByTestId("atomik-reason")).toHaveText("Not runnable yet — no shot is ready to render.");
  await expect(panel.getByRole("button", { name: /Run this page/ })).toBeDisabled();
  /* The chip still opens the panel and explains; the engine refuses to start. */
  await page.keyboard.press("Escape");
  await page.getByTestId("run-chip").click();
  await expect(panel.getByRole("alert")).toHaveText("Not runnable yet — no shot is ready to render.");
  await expect(page.getByTestId("atomik-state")).toHaveText("IDLE");
  /* A page that provides nothing still says whose data is missing. */
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Boards/ }).click();
  await page.getByTestId("run-chip").click();
  await expect(page.getByTestId("atomik-reason")).toHaveText("Needs Boards data");
  /* Astra without a saved scene: its own reason. */
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Astra/ }).click();
  await page.getByTestId("run-chip").click();
  await expect(page.getByTestId("atomik-reason")).toHaveText("Not runnable yet — save the scene in Astra first.");
  expect(mock.paidRequests).toEqual([]);
});
