import { test, expect, type Locator, type Page } from "@playwright/test";
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
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n\nINT. HUT - NIGHT\n\nKeeper watches.\n";
const png = (fill: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer();
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);

/** `first`: what the first scene says in place of the harbour at dusk. */
async function setup(page: Page, first: { heading?: string } = {}) {
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
      { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [], characters: ["Fox"], locations: ["Frozen harbour"], props: [], ...first },
      { id: "scene-b", heading: "INT. HUT - NIGHT", summary: "Keeper watches", beats: [{ id: "beat-b", text: "Keeper watches" }], shots: [], characters: ["Keeper"], locations: ["Hut"], props: [] },
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
  await expect(harbour.getByTestId("environment-render")).toContainText(/Render a plate · \d+ credits/);
  /* Every place is priced on its own, so the harbour's quote is picked by its place, not by being the last one read. */
  const quote = [...quotes].reverse().find((q) => String(q.prompt ?? "").startsWith("Frozen harbour:") && String(q.prompt ?? "").includes("An environment plate")) as { prompt: string; references: { uploadId?: string; role: string }[]; model: string; ratio: string };
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

/**
 * "Add N places from the beat sheet" appended the list its render counted.
 * When the agent's world landed between that render and the click, React ran
 * the handler from the render before, and a place both listed was added
 * twice. The click now decides on the list as it is when its update applies.
 * This test keeps the button's click handler from the render before the
 * agent's places landed and runs it after them: that order, every time.
 */
test("Add places from the beat sheet clicked from a render before the agent's places landed lists each place once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  test.setTimeout(150_000);
  /* The agent names its place after the first scene's heading: here the beat sheet's own "Frozen harbour". */
  const { errors, read } = await setup(page, { heading: "Frozen harbour" });
  const add = page.getByTestId("environment-from-beats");
  const status = page.getByTestId("environment-stage").locator(".pd-save");
  const names = async () => ((await read()).production?.environment?.entries ?? []).map((e: { name: string }) => e.name);
  await expect(add).toHaveText("Add 2 places from the beat sheet");
  await hydrated(add);
  /* The button's click handler as rendered now, while there are no places. */
  await add.evaluate((el) => {
    const props = (el as unknown as Record<string, { onClick: () => void }>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!];
    (window as unknown as { staleAdd: () => void }).staleAdd = props.onClick;
  });

  await page.getByTestId("environment-agent-estimate").click();
  await expect(page.getByTestId("environment-agent-quote")).toContainText("agent steps");
  await page.getByTestId("environment-agent-start").click();
  await expect.poll(names, { timeout: 60_000 }).toEqual(["Frozen harbour"]);
  /* The button counts only what is still missing. */
  await expect(add).toHaveText("Add 1 place from the beat sheet");
  await expect(status).toHaveText(/^Saved/);

  /* The click lands now, with that earlier render's two places: only the hut is added. */
  await page.evaluate(() => (window as unknown as { staleAdd: () => void }).staleAdd());
  await expect(page.getByTestId("environment-entry")).toHaveCount(2);
  await expect.poll(names).toEqual(["Frozen harbour", "Hut"]);
  await expect(add).toHaveText("Add 0 places from the beat sheet");
  await expect(add).toBeDisabled();
  await expect(status).toHaveText(/^Saved/);

  /* Once more from that render: nothing is missing, so nothing changes — no edit, and the page still says Saved. */
  const after = await page.evaluate(async () => {
    (window as unknown as { staleAdd: () => void }).staleAdd();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return document.querySelector("[data-testid='environment-stage'] .pd-save")?.textContent ?? "";
  });
  expect(after).toMatch(/^Saved/);
  await expect(page.getByTestId("environment-entry")).toHaveCount(2);
  expect(await names()).toEqual(["Frozen harbour", "Hut"]);
  expect(errors).toEqual([]);
});
