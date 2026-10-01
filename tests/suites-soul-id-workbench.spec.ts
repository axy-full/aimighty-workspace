import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Studio › Cast › Build identity on the platform's key, in a managed
 * workspace (credits), against a local ENGINE_MOCK=1 server: the real
 * /api/soul/identities route with the mock trainer. The card says what is
 * missing; only versions with a training price are offered (Soul Standard;
 * Soul 2 and Soul Cinema once priced); the price is on the button before anything is
 * sent; a reply lost after the server took the request is recovered by asking
 * about that saved request (same key, same body), never by training twice; the
 * list is this workspace's own Soul IDs, and nothing of the connected account
 * is read.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const CONSUMER = /\/api\/higgsfield\/consumer\//;
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

type Terms = { versions: { version: string; trainingCredits: number }[] };
type Identity = { id: string; name: string; status: string; renderModel: string | null };

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Soul ID test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const project = newProject(`Soul ID ${randomUUID().slice(0, 6)}`);
  project.production = { cast: { entries: [{ id: "cast-mira", kind: "character", name: "Mira", description: "", prompt: "Mira on the quay", takes: [] }] } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stills: { id: string }[] = [];
  for (const [i, background] of ["#7a6152", "#52617a"].entries()) {
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
    /* No account route at all, not even a list of saved jobs: the shell's collector went with the sign-in. */
    consumer.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/soul/identities?projectId=${project.id}`, { headers }).then((r) => r.json())) as { identities: Identity[]; terms: Terms };
  return { project, headers, stills, consumer, errors, read };
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  expect(await page.getByTestId("soul-card").evaluate((el) => el.scrollWidth - el.clientWidth), "the card keeps its content inside").toBeLessThanOrEqual(1);
}

test("Build identity on the key: the reasons, the priced versions, the fixed price on the button, a lost reply recovered by its saved request, trained once in this workspace", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the five sizes");
  test.setTimeout(180_000);
  const f = await setup(page);
  const { terms } = await f.read();
  /* Soul 2 and Soul Cinema have no price until the operator sets one: only Soul Standard is offered here. */
  expect(terms.versions.map((v) => v.version)).toEqual(["v1"]);
  const credits = terms.versions.find((v) => v.version === "v1")!.trainingCredits;
  expect(credits).toBeGreaterThan(0);
  await page.goto(`/suites?suite=studio&page=cast&project=${f.project.id}`);
  const card = page.getByTestId("soul-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole("heading", { name: "Build identity" })).toBeVisible();
  await expect(card.getByTestId("soul-list")).toContainText("No Soul ID in this workspace yet. Particl lists only the ones trained here.");

  /* What is missing, one thing at a time, before the button can be pressed. */
  const build = page.getByTestId("soul-build");
  await expect(page.getByTestId("soul-blocked")).toHaveText("Name the Soul ID.");
  await expect(build).toBeDisabled();
  await page.getByTestId("soul-name").fill("Mira");
  await expect(page.getByTestId("soul-blocked")).toHaveText("Pick 1–40 stills of the same person (0 picked).");
  await expect(card.getByRole("radiogroup", { name: "Renders with" }).getByRole("radio")).toHaveText(["Soul Standard"]);
  await expect(page.getByTestId("soul-version-v1")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("soul-versions-unpriced")).toHaveText("Soul 2 and Soul Cinema training is not offered until it has a price.");
  await expect(page.getByTestId("soul-stills").getByRole("button")).toHaveCount(2);
  for (const still of f.stills) await page.getByTestId(`soul-still-${still.id}`).click();
  await expect(page.getByTestId("soul-blocked")).toHaveText("Confirm you have the rights and consent to train this likeness.");
  await page.getByTestId("soul-consent").check();
  await expect(page.getByTestId("soul-blocked")).toHaveCount(0);
  await expect(build).toBeEnabled();
  /* The fixed training price, on the button, before anything is sent. */
  await expect(build).toHaveText(`Train · Soul Standard · about ${credits} cr`);
  await expect(page.getByTestId("soul-terms")).toHaveText("Charged once the trainer accepts it, even if training then fails.");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="soul-card"]')).toEqual([]);
  expect(await dimLabels(page, '[data-testid="soul-card"]')).toEqual([]);
  await card.scrollIntoViewIfNeeded();
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("soul-id-ready-to-train.png") });

  /* The first reply is lost after the server took the request. */
  const posts: { key: string | undefined; body: string }[] = [];
  let lose = true;
  await page.route("**/api/soul/identities", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    posts.push({ key: request.headers()["idempotency-key"], body: request.postData() ?? "" });
    const response = await route.fetch();
    if (lose) { lose = false; return route.abort("connectionreset"); }
    return route.fulfill({ response });
  });
  await build.click();
  const recover = page.getByTestId("soul-recover");
  await expect(recover).toContainText("A training request was sent but its reply was lost: Mira.");
  expect(posts).toHaveLength(1);
  expect(posts[0].key).toBeTruthy();
  expect(JSON.parse(posts[0].body)).toEqual({ projectId: f.project.id, name: "Mira", description: "", subjectType: "character", consent: true, modelVersion: "v1",
    maxCredits: credits, references: f.stills.map((s) => ({ uploadId: s.id })) });
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="soul-card"]')).toEqual([]);
  await noSideScroll(page);

  /* Recovering asks about that same request — the same key and body — and trains nothing new. */
  await page.getByTestId("soul-recover-run").click();
  await expect(recover).toHaveCount(0);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  await expect(page.getByTestId("soul-outcome")).toHaveText("Mira is training for Soul Standard. It is listed below; characters can render with it once it is ready.");
  const { identities } = await f.read();
  expect(identities.map((i) => [i.name, i.renderModel])).toEqual([["Mira", "hf-soul-standard"]]);
  const row = page.getByTestId(`soul-row-${identities[0].id}`);
  await expect(row).toContainText("Mira");
  await expect(row).toContainText(`Soul Standard · Ready · ${credits} cr`, { timeout: 45_000 });
  await expect(page.getByTestId("soul-name")).toHaveValue("");

  /* Ready: the character above can choose it now, by the family it renders with. */
  const mira = page.getByTestId("cast-entry").filter({ has: page.locator('input[value="Mira"]') });
  await expect(mira.getByTestId("cast-identity").locator("option")).toHaveText(["None", "Mira · Soul Standard"]);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("soul-id-trained.png") });
  expect(f.consumer, "nothing of the connected account is read or sent").toEqual([]);
  expect(f.errors).toEqual([]);
});
