import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

/**
 * Production › Environment (owner, 24 September): where the world is built,
 * before Cast & Elements. Places come from the beat sheet or the agent (or by
 * hand); a plate is rendered at a quoted price, uploaded, or taken from the
 * library — renders and uploads alike — and references follow the render.
 * Real local routes, mock engine.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n\nINT. HUT - NIGHT\n\nMara watches.\n";
const png = (fill: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer();

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Environment test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`World ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  project.production = {
    scriptApproval: { at: new Date().toISOString(), source: "hand", sha256 },
    beats: { scriptSha256: sha256, updatedAt: new Date().toISOString(), scenes: [
      { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [], characters: ["Fox"], locations: ["Frozen harbour"], props: [] },
      { id: "scene-b", heading: "INT. HUT - NIGHT", summary: "Mara watches", beats: [{ id: "beat-b", text: "Mara watches" }], shots: [], characters: ["Mara"], locations: ["Hut"], props: [] },
    ] },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const quotes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/generate/quote")) quotes.push(request.postDataJSON()); });
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
  await expect(page.getByTestId("environment-stage")).toBeVisible();
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { errors, quotes, read };
}

test("Environment: places from the beat sheet and the agent, a plate uploaded, a plate rendered at its price with a library reference, filed as Environment", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(180_000);
  const { errors, quotes, read } = await setup(page);
  await expect(page.getByTestId("page-title")).toHaveText("Environment");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Environment/ })).toHaveAttribute("aria-current", "page");

  /* Free: the beat sheet's two locations. */
  await page.getByTestId("environment-from-beats").click();
  const places = page.getByTestId("environment-entry");
  await expect(places).toHaveCount(2);
  await expect(page.getByTestId("environment-counts")).toHaveText("2 places · 0 with a plate");
  await page.getByTestId("environment-world-text").fill("Late winter on a northern coast: low sun, salt haze.");

  /* The agent (optional): priced first, keeps the world already written and the places already here. */
  await page.getByTestId("environment-agent-estimate").click();
  await expect(page.getByTestId("environment-agent-quote")).toContainText("agent steps");
  await page.getByTestId("environment-agent-start").click();
  await expect(places).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("environment-world-text")).toHaveValue("Late winter on a northern coast: low sun, salt haze.");

  /* An upload is a plate: filed as Environment and chosen for the place. */
  const hut = places.filter({ has: page.locator('input[value="Hut"]') });
  await hut.getByTestId("environment-upload-plate").setInputFiles({ name: "hut.png", mimeType: "image/png", buffer: await png("#553322") });
  await hut.locator(".pd-frame-image").scrollIntoViewIfNeeded();
  await expect(hut.locator(".pd-frame-image img")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("environment-counts")).toHaveText("3 places · 1 with a plate");

  /* The harbour: an uploaded reference, then a rendered plate at its quoted price that follows the reference and the world. */
  const harbour = places.filter({ has: page.locator('input[value="Frozen harbour"]') });
  await harbour.getByTestId("environment-upload-reference").setInputFiles({ name: "ice.png", mimeType: "image/png", buffer: await png("#99bbdd") });
  await expect(harbour.getByTestId("environment-references")).toContainText("References 1/6");
  await harbour.getByTestId("environment-price").click();
  await expect(harbour.getByTestId("environment-render")).toContainText(/Render a plate · \d+ credits/);
  const quote = [...quotes].reverse().find((q) => String(q.prompt ?? "").includes("An environment plate")) as { prompt: string; references: { uploadId?: string; role: string }[]; model: string; ratio: string };
  expect(quote, "the plate's own quote request").toBeTruthy();
  expect(quote).toMatchObject({ model: "gemini-3.1-flash-image", ratio: "16:9", shotId: "" });
  expect(quote.prompt).toContain("The world of the film: Late winter on a northern coast");
  expect(quote.references).toHaveLength(1);
  expect(quote.references[0]).toMatchObject({ role: "reference_image" });
  await harbour.getByTestId("environment-render").click();
  await harbour.locator(".pd-frame-image").scrollIntoViewIfNeeded();
  await expect(harbour.locator(".pd-frame-image img")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("environment-counts")).toHaveText("3 places · 2 with a plate", { timeout: 30_000 });

  /* Saved: the world, the places, and both plates filed in the library as Environment. */
  await expect.poll(async () => (await read()).assets.filter((a: { category: string }) => a.category === "Environment").length, { timeout: 30_000 }).toBe(2);
  const saved = await read();
  expect(saved.production.environment.world).toContain("Late winter");
  expect(saved.production.environment.entries.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(["Frozen harbour", "Hut"]));
  /* A render already in the library can be the plate of another place (a render, not only uploads). */
  const third = places.nth(2);
  const pick = third.getByTestId("environment-use-plate");
  await expect.poll(async () => (await pick.locator("option").allTextContents()).some((t) => t.startsWith("Render · "))).toBe(true);
  const renderOption = (await pick.locator("option").allTextContents()).find((t) => t.startsWith("Render · "))!;
  await pick.selectOption({ label: renderOption });
  await third.locator(".pd-frame-image").scrollIntoViewIfNeeded();
  await expect(third.locator(".pd-frame-image img")).toBeVisible();
  await expect(page.getByTestId("environment-counts")).toHaveText("3 places · 3 with a plate");
  expect(errors).toEqual([]);
});
