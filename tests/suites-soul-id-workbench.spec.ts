import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Studio › Cast › Build identity, in a managed workspace (credits), against a
 * local ENGINE_MOCK=1 server. Since D0.2 it is Particl's own identity
 * training (GET/POST /api/identities, then its /train): the card says what is
 * missing, the trainer's price is on the button before anything is sent, the
 * identity is made first (free) and its training sent once with that price as
 * the approval; a lost reply is recovered by asking about that saved request
 * (same key, same body), never by training twice. No family is chosen and no
 * old family word or vendor is read. The training request itself is answered
 * here by the test: a local server has no deployed store for the trainer's
 * photo archive, so the real route refuses before it charges anything.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const CONSUMER = /\/api\/higgsfield\/consumer\//;
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

type Terms = { configured: boolean; minPhotos: number; maxPhotos: number; trainCredits: number | null };
type Identity = { id: string; name: string; status: string };

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Identity test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const project = newProject(`Identity ${randomUUID().slice(0, 6)}`);
  project.production = { cast: { entries: [{ id: "cast-mira", kind: "character", name: "Mira", description: "", prompt: "Mira on the quay", takes: [] }] } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stills: { id: string }[] = [];
  /* The trainer takes five or more uploaded photos. */
  for (const [i, background] of ["#7a6152", "#52617a", "#617a52", "#7a5261", "#61527a"].entries()) {
    const buffer = await sharp({ create: { width: 360, height: 480, channels: 3, background } }).png().toBuffer();
    const uploaded = await page.request.post("/api/uploads", { headers, multipart: { file: { name: `mira-${i + 1}.png`, mimeType: "image/png", buffer } } });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const still = await uploaded.json();
    const filed = await page.request.post("/api/workbench/library", { headers, data: { projectId: project.id, uploadId: still.id } });
    expect(filed.ok(), await filed.text()).toBe(true);
    stills.push(still);
  }
  const consumer: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!CONSUMER.test(url.pathname)) return;
    /* The shell's collector (lib/shell/connected-collector.ts) lists the open project's earlier connected jobs on every page,
       so paid work already on the account still lands. That listing is not Cast's; anything else would be. */
    if (request.method() === "GET" && url.pathname === "/api/higgsfield/consumer/generation" && url.searchParams.has("draftId")) return;
    consumer.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get("/api/identities", { headers }).then((r) => r.json())) as { identities: Identity[]; terms: Terms };
  return { project, headers, stills, consumer, errors, read };
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  expect(await page.getByTestId("soul-card").evaluate((el) => el.scrollWidth - el.clientWidth), "the card keeps its content inside").toBeLessThanOrEqual(1);
}

test("Build identity: the reasons, the trainer's price on the button, the identity made then its training sent once at that price, a lost reply recovered by its saved request", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(180_000);
  const f = await setup(page);
  const { terms } = await f.read();
  expect(terms.trainCredits).toBeGreaterThan(0);
  const credits = terms.trainCredits!;
  const price = `${credits.toLocaleString("en-US")} cr`;
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  const card = page.getByTestId("soul-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole("heading", { name: "Build identity" })).toBeVisible();
  await expect(card.getByTestId("soul-list")).toContainText("No identity in this workspace yet.");
  /* No family to choose, and neither the old family word nor the vendor anywhere on the card. */
  await expect(card.getByRole("radiogroup", { name: "Renders with" })).toHaveCount(0);
  await expect(card).not.toContainText(/Soul|Higgsfield/i);

  /* What is missing, one thing at a time, before the button can be pressed. */
  const build = page.getByTestId("soul-build");
  await expect(page.getByTestId("soul-blocked")).toHaveText("Name the identity.");
  await expect(build).toBeDisabled();
  await page.getByTestId("soul-name").fill("Mira");
  await expect(page.getByTestId("soul-blocked")).toHaveText(`Pick ${terms.minPhotos}–${terms.maxPhotos} uploaded photos of the same person (0 picked).`);
  await expect(page.getByTestId("soul-stills").getByRole("button")).toHaveCount(5);
  for (const still of f.stills) await page.getByTestId(`soul-still-${still.id}`).click();
  await expect(page.getByTestId("soul-blocked")).toHaveText("Confirm you have the rights and consent to train this likeness.");
  await page.getByTestId("soul-consent").check();
  await expect(page.getByTestId("soul-blocked")).toHaveCount(0);
  await expect(build).toBeEnabled();
  /* The trainer's price, on the button, before anything is sent. */
  await expect(build).toHaveText(`Build identity · ${price}`);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="soul-card"]')).toEqual([]);
  expect(await dimLabels(page, '[data-testid="soul-card"]')).toEqual([]);
  await card.scrollIntoViewIfNeeded();
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("identity-ready-to-build.png") });

  /* The identity is made by the real route (free). Its training is answered here; the first reply is lost. */
  const made: Record<string, unknown>[] = [];
  await page.route("**/api/identities", async (route) => {
    if (route.request().method() === "POST") made.push(route.request().postDataJSON());
    return route.fallback();
  });
  const trains: { url: string; key: string | undefined; body: string }[] = [];
  let lose = true;
  await page.route("**/api/identities/*/train", async (route) => {
    const request = route.request();
    trains.push({ url: new URL(request.url()).pathname, key: request.headers()["idempotency-key"], body: request.postData() ?? "" });
    if (lose) { lose = false; return route.abort("connectionreset"); }
    const id = new URL(request.url()).pathname.split("/")[3];
    return route.fulfill({ status: 202, json: { identity: { id, name: "Mira", status: "training", error: null } } });
  });
  await build.click();
  const recover = page.getByTestId("soul-recover");
  await expect(recover).toContainText("A training request was sent but its reply was lost: Mira.");
  expect(made).toEqual([{ name: "Mira", description: "", photos: f.stills.map((s) => s.id), projectId: null, reuseDraft: true }]);
  expect(trains).toHaveLength(1);
  expect(trains[0].key).toBeTruthy();
  /* The price on the button is the approval the route holds the charge to. */
  expect(JSON.parse(trains[0].body)).toEqual({ consent: true, maxCredits: credits });
  const { identities } = await f.read();
  expect(identities.map((i) => i.name)).toEqual(["Mira"]);
  expect(trains[0].url).toBe(`/api/identities/${identities[0].id}/train`);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="soul-card"]')).toEqual([]);
  await noSideScroll(page);

  /* Recovering asks about that same request — the same address, key and body — makes no second identity and trains nothing new. */
  await page.getByTestId("soul-recover-run").click();
  await expect(recover).toHaveCount(0);
  expect(trains).toHaveLength(2);
  expect(trains[1]).toEqual(trains[0]);
  expect(made).toHaveLength(1);
  await expect(page.getByTestId("soul-outcome")).toHaveText("Mira is training. It is listed below.");
  await expect(page.getByTestId(`soul-row-${identities[0].id}`)).toContainText("Mira");
  await expect(page.getByTestId("soul-name")).toHaveValue("");

  /* The character above offers only identities that are ready; this one is not trained yet. */
  const mira = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Mira"]') });
  await expect(mira.getByTestId("cast-identity").locator("option")).toHaveText(["None"]);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("identity-building.png") });
  expect(f.consumer, "nothing of the connected account is read or sent").toEqual([]);
  expect(f.errors).toEqual([]);
});
