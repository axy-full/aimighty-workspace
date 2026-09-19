import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * ⌘K palette and the keyboard map (workspace redesign, wave 2). Desktop:
 * the palette opens from inside a text field, runs its highlighted row on
 * Enter, moves with ↑ ↓ and closes on Esc; plan entries navigate and then
 * run to their gate without dispatching; single keys never fire while
 * typing. Phones keep the existing phone surface.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

/* Test fixtures only — the app reads these from the real projects route. */
const primary = { ...newProject("Coastal light study"), id: "ws-palette-a", description: "Product film · Spot 02", aspect: "16:9", fps: 24 };
const list = [
  { id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" },
  { id: "ws-palette-b", name: "Harbour", revision: 1, updatedAt: "2026-09-12T10:00:00Z" },
];

async function setup(page: Page) {
  const sent: string[] = [];
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) =>
    route.fulfill({ json: { projects: list, productions: [], project: primary, revision: 1, shared: null } }),
  );
  await page.route("**/api/workbench/atomik**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { jobs: [] } });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) return route.fulfill({ json: { estimateCredits: 9, quoteOnly: true } });
    sent.push("dispatch");
    return route.fulfill({ status: 202, json: { job: { id: "job-1", requestId: body.requestId, status: "queued" } } });
  });
  page.on("request", (request) => {
    if (request.method() === "GET" || !request.url().includes("/api/")) return;
    let quote = false;
    try {
      quote = (request.postDataJSON() as { quoteOnly?: unknown } | null)?.quoteOnly === true;
    } catch {
      /* not JSON */
    }
    if (!quote) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return sent;
}

async function typeIntoFreshInput(page: Page, text: string) {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Shot name");
    document.querySelector('[data-testid="content"]')!.appendChild(input);
  });
  const field = page.getByRole("textbox", { name: "Shot name" });
  await field.click();
  await field.pressSequentially(text);
  return field;
}

test("phones keep the existing phone surface", async ({ page }, info) => {
  test.skip(DESKTOP.includes(info.project.name), "phone viewports");
  await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
  await expect(page).toHaveURL(/\/workbench\?project=ws-palette-a$/);
  await expect(page.locator(".pxw")).toHaveCount(0);
});

test("⌘K opens from inside an input; ↑ ↓ move; Enter runs the highlighted row; Esc closes", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent = await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  const inspector = page.getByTestId("inspector");

  /* Typing never fires single keys: a, g, i, 5 and Space land in the field. */
  const field = await typeIntoFreshInput(page, "a gi5");
  await expect(field).toHaveValue("a gi5");
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("atomik-panel")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await expect(page.locator(".pxw-toast")).toHaveCount(0);

  /* ⌘K / Ctrl+K works from inside the field. */
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  const input = page.getByRole("textbox", { name: "Search suites, tools and actions" });
  await expect(input).toBeFocused();
  const rows = page.getByTestId("palette-row");
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toContainText("STUDIO");
  await expect(rows.nth(0)).toContainText("Brief & Script");
  if (info.project.name === "workbench-1440x900") await page.screenshot({ path: info.outputPath("palette.png") });

  /* The query filters; typing i/g/a inside the palette fires nothing. */
  await input.pressSequentially("ri");
  await expect(rows.nth(0)).toHaveText(/STUDIO\s*Brief & Script/);
  await expect(rows.nth(1)).toHaveText(/STUDIO\s*Rig/);
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  await expect(inspector).toBeVisible();

  /* Esc closes; ⌘K toggles; the Search button opens it too. */
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toHaveCount(0);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(palette).toBeVisible();
  await input.fill("all projects");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Pick a project to work in" })).toBeVisible();

  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});

test("a plan entry navigates to its page, then runs to its gate without dispatching", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const sent = await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Search suites, tools and actions" }).fill("plan the rest");
  const rows = page.getByTestId("palette-row");
  await expect(rows.nth(0)).toHaveText(/ATOMIK\s*Plan the rest of the project/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("9 cr");
  await expect(page.getByTestId("run-chip")).toHaveText("Approve 9 cr");
  expect(sent).toEqual([]);
});

test("the keyboard map: Enter on home, 1–9, A, I, G, Esc, and the status-bar legend", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const sent = await setup(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl");
  await expect(page.getByRole("heading", { name: "Pick a project to work in" })).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");

  await page.keyboard.press("5");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await page.keyboard.press("a");
  await expect(page.getByTestId("atomik-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("atomik-panel")).toHaveCount(0);
  await page.keyboard.press("A");
  await expect(page.getByTestId("atomik-panel")).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.getByTestId("atomik-panel")).toHaveCount(0);
  await page.keyboard.press("i");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await page.keyboard.press("i");
  await expect(page.getByTestId("inspector")).toBeVisible();
  /* G has no shot to generate in this view: it says why instead of doing nothing. */
  await page.keyboard.press("g");
  await expect(page.locator(".pxw-toast")).toHaveText(/shot/i);

  const legend = page.locator('[data-row="status"]');
  for (const text of ["1–8", "stage", "A", "atomik", "I", "inspector", "⌘K", "commands"]) await expect(legend).toContainText(text);
  /* Keys whose seams are not connected here are not advertised. */
  await expect(legend).not.toContainText("generate");
  await expect(legend).not.toContainText("Space");
  expect(sent).toEqual([]);
});
