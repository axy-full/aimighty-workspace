import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { seedBoard, desktop } from "./helpers/s03-board";

/**
 * Integration · the seams between streams, in a browser, with the new interface on. Local ENGINE_MOCK server; a person
 * presses Make once, on the board, at the price the panel shows, and the engine is the mock: nothing real is spent.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function fund(page: Page, credits = 5000) {
  const me = await (await page.request.get("/api/me")).json() as { workspace: { id: string } };
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    /* Stamped 0, never "now": a grant dated now makes a later spec's ledger seed treat the record as the old rate. */
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), me.workspace.id, credits, "Integration fixture", "manual", "test", 0] });
  } finally { db.close(); }
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

test("seam g: Make pressed on the board tells the board, which lights the card Make filed and opens the Library on it", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  test.setTimeout(240_000);
  const { project } = await seedBoard(page);
  await fund(page);
  const problems = watch(page);
  /* What Make says to the window, recorded beside the board's own reaction. */
  await page.addInitScript(() => {
    (window as unknown as { __made: unknown[] }).__made = [];
    window.addEventListener("particl:board-made", (event) => (window as unknown as { __made: unknown[] }).__made.push((event as CustomEvent).detail));
  });
  await page.goto(`/suites?project=${project.id}&view=board&make=video`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible({ timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await expect(box).toBeVisible({ timeout: 60_000 });
  await box.click();
  await box.fill("make the first stall at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 90_000 });
  await go.click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0, { timeout: 60_000 });
  const made = await page.evaluate(() => (window as unknown as { __made: { projectId: string; nodeId: string; name: string }[] }).__made);
  expect(made, "Make tells the window once").toHaveLength(1);
  expect(made[0].projectId).toBe(project.id);
  /* The board took it: a card for that node is on the board, lit, in the Made in Make band, with the Library open. */
  const card = page.locator(`[data-card-id="made:${made[0].nodeId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-card-id="group:made"]')).toContainText("Made in Make");
  await expect(page.getByTestId("board-library")).toBeVisible();
  expect(problems).toEqual([]);
  void info;
});

test("seam b: on a phone, Make and Atomik are the phone's own: the desktop Make panel and Atomik panel are not mounted", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  test.setTimeout(180_000);
  const { project } = await seedBoard(page);
  await fund(page);
  const problems = watch(page);
  await page.goto(`/suites?project=${project.id}&screen=make`);
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("phone-make-prompt")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await expect(page.getByTestId("atomik-panel-global")).toHaveCount(0);
  /* The address that opens the desktop panels on a laptop opens the phone's screens here. */
  await page.goto(`/suites?project=${project.id}&make=video`);
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await page.goto(`/suites?project=${project.id}&atomik=1`);
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-panel-global")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("seam b, framed: ?device=phone on a laptop is the phone, with no desktop Make or Atomik panel behind it", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one laptop run");
  test.setTimeout(180_000);
  const { project } = await seedBoard(page);
  await fund(page);
  await page.goto(`/suites?project=${project.id}&device=phone&make=video`);
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await page.goto(`/suites?project=${project.id}&device=phone&atomik=1`);
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-panel-global")).toHaveCount(0);
});
