import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { buildRateTable } from "../lib/rateTable.server";
import { takeCost } from "../lib/breakdownCost";

/* Money on two screens, at every size: the printable statement leads back to
   where statements are listed, and drafted shots are priced in credits as
   they will bill, never the vendor's dollars printed as credits. */

const overflow = (page: Page) => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));

test("a statement's back link opens Workspace › Plans & credits, and the page fits the screen", async ({ page }) => {
  await signInLocally(page.request);
  const month = new Date().toISOString().slice(0, 7);
  await page.goto(`/statements/${month}`);
  const back = page.getByRole("link", { name: "← Statements" });
  await expect(back).toHaveAttribute("href", "/suites?view=workspace&tab=credits");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (page.viewportSize()!.width < 900) {
    // A phone's targets: the way back, the project filter, the CSV and Print.
    for (const [name, control] of [
      ["back", back], ["project", page.getByRole("combobox", { name: "Project" }).locator("..")],
      ["csv", page.getByRole("link", { name: "Download CSV" })], ["print", page.getByRole("button", { name: "Print" })],
    ] as const) expect((await control.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  const width = await overflow(page);
  expect(width.scrollWidth).toBe(width.clientWidth);
  await back.click();
  /* A link from another page into the Suites keeps its view and tab: the
     shell used to read the page being left and open the Brief. A first visit
     to /suites compiles it on a dev server. */
  await expect(page.getByTestId("ws-plans")).toBeVisible({ timeout: 90_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/suites");
  expect(url.searchParams.get("view")).toBe("workspace");
  expect(url.searchParams.get("tab")).toBe("credits");
});

test("drafted shots are priced in credits per take, as they bill", async ({ page }) => {
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name: "Dawn ride" } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const projectId = ((await made.json()) as { id: string }).id;
  expect(projectId).toBeTruthy();
  const saved = await page.request.put("/api/atomik/treatment", {
    data: { projectId, title: "Dawn ride", logline: "A courier crosses a flooded city at dawn.", scenes: [{ n: 1, title: "Street", secs: 12, prose: "The street at dawn; a bicycle cuts through a flooded gutter." }] },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), projectId!);
  await page.goto("/atomik/breakdown");
  /* A scene's action only asks for its quote once it is on screen, which on a
     short landscape phone is below the fold. */
  await page.getByRole("button", { name: /^Draft shots/ }).scrollIntoViewIfNeeded();
  const draft = page.getByRole("button", { name: /^Draft shots · \d+ cr reserved$/ });
  await draft.click();
  const proposal = page.locator(".ak-proposal");
  await expect(proposal).toBeVisible({ timeout: 60_000 });

  const rates = buildRateTable("cr");
  /* One take, as the ledger bills it: whole credits, rounded up per take. */
  const take = (planned: number, engine: string) => Math.max(1, Math.ceil(takeCost(rates, planned, engine) - 1e-9));
  const seedance = take(5, "seedance"), kling = take(4, "kling");
  expect(seedance).toBe(43);
  await expect(proposal.getByText(`5s · Seedance · ${seedance} cr`)).toBeVisible();
  await expect(proposal.getByText(`4s · Kling · ${kling} cr`)).toBeVisible();
  await expect(proposal).toContainText(`SCENE ≈ ${seedance + kling} cr AT ONE TAKE EACH · WRITING 1 cr`);
  await expect(proposal).not.toContainText("$");
  const width = await overflow(page);
  expect(width.scrollWidth).toBe(width.clientWidth);
});
