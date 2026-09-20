import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * /workspace shell (workspace redesign 1/n). Desktop: the four layout rules
 * hold — no toolbar child clips, nothing runs under the Inspector, titles
 * never truncate — navigation writes the URL and survives Back, and single
 * keys stay out of the way while typing. Phones: the phone shell (tests/workspace-mobile-shell-workbench.spec.ts).
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

/* Test fixtures only — the app reads these from the real projects route. */
const primary = { ...newProject("Coastal light study"), id: "ws-shell-a", description: "Product film · Spot 02", aspect: "16:9", fps: 24 };
const list = [
  { id: primary.id, name: primary.name, revision: 3, updatedAt: "2026-09-18T10:00:00Z" },
  { id: "ws-shell-b", name: "Harbour", revision: 1, updatedAt: "2026-09-12T10:00:00Z" },
  { id: "ws-shell-c", name: "Night market", revision: 5, updatedAt: "2026-09-02T10:00:00Z" },
];

async function signedInWithProjects(page: Page) {
  await signInLocally(page.request);
  await page.route("**/api/workbench/projects**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    const project = id === primary.id || !id ? primary : { ...newProject(list.find((p) => p.id === id)?.name ?? "Project"), id: id ?? "x" };
    return route.fulfill({ json: { projects: list, productions: [], project, revision: 1, shared: null } });
  });
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
        if (right > row.scrollWidth + 0.5) out.push(`${name}: ${child.className || child.tagName} ends at ${right} past scrollWidth ${row.scrollWidth}`);
        if (inspector && ["project", "page", "crumbs"].includes(name) && rect.right > inspector.left + 0.5)
          out.push(`${name}: ${child.className || child.tagName} overlaps the Inspector (${rect.right} > ${inspector.left})`);
      }
      if (["project", "page", "crumbs"].includes(name) && row.scrollWidth > row.clientWidth + 0.5)
        out.push(`${name}: row content ${row.scrollWidth} wider than the row ${row.clientWidth}`);
    }
    for (const id of ["project-title", "page-title"]) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${id} truncated: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    return out;
  });
  expect(problems).toEqual([]);
}

/** Relative luminance, WCAG. */
function luminance(rgb: string) {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("phones render the phone shell", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signedInWithProjects(page);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=rig");
  /* The phone shell renders here now (wave M-A): /workspace is the phone's
     surface below 768px, and the desktop studio row is not mounted. */
  await expect(page.getByTestId("phone-shell")).toBeVisible();
  await expect(page.getByTestId("studio-row")).toHaveCount(0);
});

test("desktop shell: layout rules, navigation, URL, keyboard and label contrast", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signedInWithProjects(page);

  const configured = page.viewportSize()!;
  /* The configured size, then 1200×800 explicitly: the shell scrolls there, it never squeezes. */
  for (const size of [configured, { width: 1200, height: 800 }]) {
    await page.setViewportSize(size);
    await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
    await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
    await expect(page.getByTestId("project-title")).toHaveText(primary.name);
    await assertNoClipping(page);
    /* Rig carries the widest header: the view segmented and Generate. */
    await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Rig/ }).click();
    await expect(page.getByTestId("page-title")).toHaveText("Rig");
    await assertNoClipping(page);
  }

  await page.setViewportSize(configured);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=brief");
  const tabs = page.getByRole("navigation", { name: "Pages" });
  await expect(tabs.getByRole("button")).toHaveCount(9); // eight stages + ✦ Atomik
  await tabs.getByRole("button", { name: /Rig/ }).click();
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  await expect(page).toHaveURL(/[?&]project=ws-shell-a(&|$)/);
  /* No shots are loaded in this view yet: Generate is disabled and says why. */
  /* The top bar's Generate (the global composer) is always live; the page's own
     Generate needs a shot, so it is disabled and says why. */
  await expect(page.getByTestId("topbar-generate")).toBeEnabled();
  await expect(page.getByTestId("studio-row").getByRole("button", { name: "Generate" })).toBeDisabled();
  await expect(page.locator("#pxw-action-reason")).toBeVisible();
  await tabs.getByRole("button", { name: /Takes/ }).click();
  await expect(page).toHaveURL(/[?&]page=takes(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await page.goBack();
  await expect(page).toHaveURL(/[?&]page=rig(&|$)/);
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await page.goForward();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");

  /* Aliases resolve and the URL is rewritten to the current id. */
  await page.goto("/workspace?project=" + primary.id + "&page=storyboard");
  await expect(page.getByTestId("page-title")).toHaveText("Boards");
  await expect(page).toHaveURL(/[?&]suite=particl&page=boards(&|$)/);

  /* Keyboard: 1–9 and I, never while typing. */
  await page.keyboard.press("5");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await page.keyboard.press("i");
  await expect(inspector).toHaveCount(0);
  await page.keyboard.press("i");
  await expect(inspector).toBeVisible();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Shot name");
    document.querySelector('[data-testid="content"]')!.appendChild(input);
  });
  const field = page.getByRole("textbox", { name: "Shot name" });
  await field.click();
  await field.pressSequentially("i2");
  await expect(field).toHaveValue("i2");
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");

  /* Every functional label is at least as light as #7C7C84. */
  const floor = luminance("rgb(124,124,132)");
  const colours = await page.locator("[data-functional-label]").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  expect(colours.length).toBeGreaterThan(8);
  for (const colour of colours) expect(luminance(colour), colour).toBeGreaterThanOrEqual(floor - 1e-6);

  /* Home: project selector first, then the active suite's pages. */
  await page.goto("/workspace?project=" + primary.id + "&suite=particl");
  await expect(page.getByRole("heading", { name: "Pick a project to work in" })).toBeVisible();
  await expect(page.locator(".pxw-project-card")).toHaveCount(list.length);
  await expect(page.locator('.pxw-project-card[aria-current="true"]')).toContainText(primary.name);
  await expect(page.getByRole("link", { name: "New project" })).toHaveAttribute("href", "/workbench?new=1");
  await expect(page.locator(".pxw-feature")).toHaveCount(8);
  const homeColours = await page.locator("[data-functional-label]").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  for (const colour of homeColours) expect(luminance(colour), colour).toBeGreaterThanOrEqual(floor - 1e-6);
  await page.screenshot({ path: info.outputPath("workspace-home.png") });
  await page.getByRole("group", { name: "Suites" }).getByRole("button", { name: "Agent" }).click();
  await expect(page.locator(".pxw-feature")).toHaveCount(9);
  await page.locator('.pxw-feature[data-feature="generate"]').click();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page).toHaveURL(/[?&]suite=atomik&page=generate(&|$)/);
  await page.goto("/workspace?project=" + primary.id + "&suite=particl&page=rig");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await page.screenshot({ path: info.outputPath("workspace-rig.png") });
  expect(errors).toEqual([]);
});
