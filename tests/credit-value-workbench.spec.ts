import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * What a credit is worth, said where a person needs it — and said once.
 *
 * The rate reaches the browser in one field: `creditUsd` on the rate table the
 * server built from `creditUsd()` (lib/rateTable.server.ts). Every figure below
 * is checked against THAT number rather than against ten cents, so this spec
 * passes on a deployment with another CREDIT_USD and fails the moment a surface
 * goes back to printing its own.
 *
 * Both shells, because a credit means the same thing on both: the phone's
 * Settings credits card and header slot, the desktop top bar's balance.
 */

const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const GRANT = 2000;

async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, GRANT, "Local credit-value fixture", "admin", "test", Date.now()],
    });
  } finally {
    db.close();
  }
  const project: Project = newProject(`Credit value ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  return { project, scope };
}

/** The rate this deployment actually serves, read the way the browser reads it. */
async function servedRate(page: Page): Promise<number> {
  const me = await page.request.get("/api/me").then((r) => r.json());
  const rate = Number(me?.rates?.creditUsd);
  expect(rate, "the rate table carries the credit rate").toBeGreaterThan(0);
  return rate;
}

/** "1 credit = $0.10" as the product writes it, from a number. */
function rateLine(perCredit: number): string {
  const trimmed = perCredit.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = trimmed.split(".")[1]?.length ?? 0;
  return `1 credit = $${decimals < 2 ? perCredit.toFixed(2) : trimmed}`;
}

/** "$2,000.00": the dollars of a balance at the served rate, as the shell words them (lib/shell/price-words.ts › creditsUsd). */
const dollarsOf = (credits: number, rate: number) => `$${(Math.round(credits * rate * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("the phone says what a credit is worth on Settings › Plan & credits, the card that decides to spend", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  /* Release 1: the phone's Settings is the shell's own five-section page under the phone header; its Plan & credits balance row holds the rate. */
  await page.goto(`/suites?project=${project.id}&view=workspace&tab=credits`);
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits");
  const row = page.getByTestId("settings-balance-credits");
  await expect(row).toBeVisible();

  /* One short line, derived — not a paragraph (CLAUDE.md ground rule 9). */
  const line = row.locator(".gs-row-line");
  await expect(line).toHaveText(rateLine(rate));
  expect((await line.innerText()).split("\n")).toHaveLength(1);

  /* And the row's own dollar figure agrees with it: balance × the same rate.
     A card that stated one rate and computed with another would be worse than
     one that stated none. */
  const value = row.locator(".gs-row-v");
  const balance = Number((await value.locator(":scope").innerText()).split("cr")[0].replace(/[^\d.]/g, ""));
  /* The grant plus whatever the sign-up itself granted — the point is not the
     figure but that the dollars beside it come from the rate on the line. */
  expect(balance).toBeGreaterThanOrEqual(GRANT);
  await expect(value.locator(".gs-usd")).toHaveText(`· ${dollarsOf(balance, rate)}`);

  /* The rate line clears the phone's floors like every other functional label. */
  expect((await line.boundingBox())!.width).toBeGreaterThan(0);
  expect(await line.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("the phone's credit slot is a figure in credits and its tooltip is that balance at the served rate", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  await page.goto(`/suites?project=${project.id}`);
  const slot = page.getByTestId("phone-credits");
  await expect(slot).toBeVisible();
  await expect(slot).toHaveText(/^[\d,]+\s?cr$/);
  /* The slot itself stays a figure (the rate lives on Plan & credits, not in the header, which has no room for a sentence). Its
     tooltip is the balance's dollars at the same served rate, beside what it does: it opens Top up. */
  const balance = Number((await slot.innerText()).replace(/[^\d.]/g, ""));
  expect(balance).toBeGreaterThanOrEqual(GRANT);
  await expect(slot).toHaveAttribute("title", `${dollarsOf(balance, rate)} · Top up`);
  await expect(slot).not.toHaveText(/credit =/);
});

test("the desktop top bar's balance carries the same rate, from the same field", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  await page.goto(`/suites?project=${project.id}&view=board`);
  const credits = page.getByTestId("workspace-credits");
  await expect(credits).toBeVisible();
  await expect(credits).toHaveText(/^[\d,]+\s?cr$/);
  /* Since #269 the desktop slot is the same always-mounted label as the
     phone's, so it carries the same title — one rate, one sentence. */
  await expect(credits).toHaveAttribute("title", `Workspace credits · ${rateLine(rate)}`);
  /* It still goes where the rate can be acted on: Settings › Plan & credits. */
  await credits.click();
  await expect(page).toHaveURL(/view=workspace.*tab=credits|tab=credits.*view=workspace/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test("the top-up surface prices its packs at the rate it states", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await seeded(page);
  const rate = await servedRate(page);
  const topups = await page.request.get("/api/workspaces/topups").then((r) => r.json());
  test.skip(!topups?.applies, "credits apply to this workspace");

  /* The route hands the screen the rate it priced the packs at, so the sentence
     and the prices beside it cannot disagree. */
  expect(topups.creditUsd).toBeCloseTo(rate, 9);
  for (const pack of topups.packs) expect(pack.usd).toBeCloseTo(pack.credits * rate, 2);

  await page.goto("/billing#credit-packs");
  const block = page.locator("#credit-packs");
  await expect(block).toBeVisible();
  await expect(block).toContainText(rateLine(rate));
  /* Stated once, on the block that sells them — not repeated down the page. */
  expect((await page.locator("body").innerText()).match(/1 credit = /g) ?? []).toHaveLength(1);
});
