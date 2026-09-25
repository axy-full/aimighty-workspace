import { test, expect, type Page, type Request } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * The Suites shell's Atomik gate. "+ Run stage" and the Inspector's plan button
 * start the run engine; a paid plan stops at its gate, which the Suites shell
 * now mounts (it used to wait there with nothing on screen to approve it).
 * POST /api/workbench/atomik is intercepted: the test proves nothing paid
 * leaves before Approve, Not now sends nothing, and Approve sends exactly the
 * quoted credits. Also ⌘K: "Ask Atomik: …" keeps the words, a model row opens
 * Gen on that model, and the phone-only pages are not desktop rows.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-gate", productionProjectId: "prod-gate", shotMappings: {} });
type Mock = { quoteCalls: number; dispatches: Record<string, unknown>[]; paid: string[] };

async function setup(page: Page): Promise<{ mock: Mock; errors: string[] }> {
  const mock: Mock = { quoteCalls: 0, dispatches: [], paid: [] };
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workbench/atomik**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const requestId = new URL(request.url()).searchParams.get("requestId");
      const last = mock.dispatches.at(-1);
      return route.fulfill({ json: { configured: false, models: [], jobs: requestId && last ? [{ id: "job-1", requestId, status: "succeeded", request: String(last.request), plan: { steps: ["Board the film", "Render the shots"] } }] : [] } });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) { mock.quoteCalls += 1; return route.fulfill({ json: { estimateCredits: 12, estimateUsd: 1.2, quoteOnly: true } }); }
    mock.dispatches.push(body);
    return route.fulfill({ status: 202, json: { job: { id: "job-1", requestId: body.requestId, status: "queued" } } });
  });
  page.on("request", (request: Request) => {
    if (request.method() === "GET" || !request.url().includes("/api/workbench/atomik")) return;
    let quote = false;
    try { quote = (request.postDataJSON() as { quoteOnly?: unknown } | null)?.quoteOnly === true; } catch { /* not JSON */ }
    if (!quote) mock.paid.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { mock, errors };
}

test("+ Run stage opens the gate in the Suites shell: Not now sends nothing, Approve sends the quoted credits", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { mock, errors } = await setup(page);
  await page.goto("/suites?suite=atomik&page=agent&sp=agent");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await page.getByTestId("primary-action").click();
  const panel = page.getByTestId("atomik-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("atomik-gate")).toBeVisible();
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("12 cr");
  expect(mock.dispatches).toEqual([]);
  expect(mock.paid).toEqual([]);
  /* The panel fits the phone: nothing off either edge, no page scroll. */
  const box = (await panel.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (info.project.name === "workbench-390x844" || info.project.name === "workbench-1440x900") await page.screenshot({ path: info.outputPath("suites-atomik-gate.png") });

  await panel.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("atomik-gate")).toHaveCount(0);
  expect(mock.dispatches).toEqual([]);

  /* Esc closes the panel; pressing the primary again reopens the gate. */
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("primary-action").click();
  await expect(page.getByTestId("atomik-gate")).toBeVisible();
  await page.getByTestId("atomik-panel").getByRole("button", { name: "Approve 12 cr" }).click();
  await expect(page.getByTestId("atomik-state")).toHaveText("DONE");
  expect(mock.dispatches).toHaveLength(1);
  expect(mock.dispatches[0].maxCredits).toBe(12);
  expect(mock.paid).toEqual(["POST /api/workbench/atomik"]);
  expect(errors).toEqual([]);
});

test("⌘K: Ask Atomik keeps the words; a model row opens Gen on that model; no phone-only rows", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the palette is a desktop key");
  const { mock, errors } = await setup(page);
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  const palette = page.getByRole("dialog", { name: "Search" });
  const open = async () => { await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k"); await expect(palette).toBeVisible(); };

  await open();
  await expect(palette.getByRole("option").first()).toBeVisible();
  expect((await palette.getByRole("option").allTextContents()).some((t) => t.includes("Where to?"))).toBe(false);
  await palette.getByRole("textbox").fill("Kling 3.0 Pro");
  await palette.getByRole("option").filter({ hasText: "MODEL" }).first().click();
  await expect(page.getByTestId("gen-model")).toContainText("Kling 3.0 Pro");

  await open();
  await palette.getByRole("textbox").fill("zz make a thirty second teaser");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(page.locator("[data-tool-body=\"agent\"] textarea").first()).toHaveValue("zz make a thirty second teaser");
  expect(mock.dispatches).toEqual([]);
  expect(errors).toEqual([]);
});
