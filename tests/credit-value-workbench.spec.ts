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

test("the phone says what a credit is worth on the card that decides to spend", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  await page.goto(`/workspace?project=${project.id}&level=settings`);
  await expect(page.locator('[data-screen="settings"]')).toBeVisible();

  /* One short line, derived — not a paragraph (CLAUDE.md ground rule 9). */
  const line = page.getByTestId("mobile-settings-rate");
  await expect(line).toHaveText(rateLine(rate));
  expect((await line.innerText()).split("\n")).toHaveLength(1);

  /* And the card's own dollar figure agrees with it: balance × the same rate.
     A card that stated one rate and computed with another would be worse than
     one that stated none. */
  const balance = Number((await page.getByTestId("mobile-settings-balance").innerText()).replace(/[^\d.]/g, ""));
  /* The grant plus whatever the sign-up itself granted — the point is not the
     figure but that the dollars beside it come from the rate on the line. */
  expect(balance).toBeGreaterThanOrEqual(GRANT);
  await expect(page.getByTestId("mobile-settings-usd")).toHaveText(`$${(balance * rate).toFixed(2)}`);

  /* The rate line clears the phone's floors like every other functional label. */
  const box = (await line.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  expect(await line.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("the phone's credit slot carries the rate in its own tooltip", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  await page.goto(`/workspace?project=${project.id}&suite=particl`);
  const slot = page.getByTestId("mobile-credits");
  await expect(slot).toBeVisible();
  await expect(slot).toHaveText(/^[\d,]+ cr$/);
  /* The figure and the unit it is in, in one place: the balance is where most
     people meet the credit, and a figure in an undefined unit is not a figure. */
  await expect(slot).toHaveAttribute("title", `Workspace credits · ${rateLine(rate)}`);
  /* The slot itself stays a figure — the rate lives in the tooltip, not in the
     54px header, which has no room for a sentence. */
  await expect(slot).not.toHaveText(/credit =/);
});

test("the desktop top bar's balance carries the same rate, from the same field", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { project } = await seeded(page);
  const rate = await servedRate(page);

  await page.goto(`/workspace?project=${project.id}&suite=particl`);
  const credits = page.getByTestId("workspace-credits");
  await expect(credits).toBeVisible();
  await expect(credits).toHaveText(/^[\d,]+ cr$/);
  /* Since #269 the desktop slot is the same always-mounted label as the
     phone's, so it carries the same title — one rate, one sentence. */
  await expect(credits).toHaveAttribute("title", `Workspace credits · ${rateLine(rate)}`);
  /* It still goes where the rate can be acted on. */
  await expect(credits).toHaveAttribute("href", "/billing");
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
