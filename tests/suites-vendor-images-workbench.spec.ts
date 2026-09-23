import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Owner, 23 September: OpenAI image models in image gens, and Grok APIs
 * wherever possible. GPT Image and Grok Imagine are offered in the Gen suite's
 * image engines and in Storyboards, where a frame renders at the engine's own
 * ratio and size (GPT Image's quality; Grok's 1K), priced before it runs.
 * Real local routes, mock engine: nothing is spent.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";

test("GPT Image and Grok Imagine: offered in Gen, chosen in Storyboards, priced and rendered at their own size", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(180_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl() });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Vendor images test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }

  /* The Gen suite's image engines include every GPT Image and Grok Imagine model. */
  const engines = await page.request.get("/api/workbench/engines?kind=image", { headers }).then((r) => r.json());
  const ids = JSON.stringify(engines);
  for (const id of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-1.5", "gpt-image-1-mini", "grok-imagine-image-2.0", "grok-imagine-image"]) expect(ids, id).toContain(`"${id}"`);

  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  const project = newProject(`Vendor stills ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  const at = new Date().toISOString();
  project.production = {
    scriptApproval: { at, source: "hand", sha256 },
    beats: { scriptSha256: sha256, updatedAt: at, scenes: [{ id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [], shots: [{ id: "shot-a1", description: "The fox on the ice", framing: "Wide", movement: "Locked", lighting: "Dusk", sound: "Wind" }], characters: [], locations: [], props: [] }] },
    boards: { style: "live", model: "gemini-3.1-flash-image", frames: { "shot-a1": { prompt: "A red fox crosses the frozen harbour at dusk, wide.", takes: [] } } },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const quotes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/generate/quote")) quotes.push(request.postDataJSON()); });
  await page.goto(`/suites?suite=studio&page=boards&project=${project.id}`);
  await expect(page.getByTestId("boards-stage")).toBeVisible();

  const frame = page.getByTestId("board-frame").first();
  for (const [label, model, ratio, resolution, takes] of [["GPT Image 2", "gpt-image-2", "16:9", "Medium", 1], ["Grok Imagine 2", "grok-imagine-image-2.0", "16:9", "1K", 2]] as const) {
    await page.getByRole("radio", { name: label, exact: true }).click();
    await frame.getByTestId("frame-price").click();
    await expect(frame.getByTestId("frame-render")).toContainText(/Render · \d+ credits?/, { timeout: 30_000 });
    expect(quotes.at(-1)).toMatchObject({ model, ratio, resolution });
    if (takes === 1) {
      /* Five engines fit the picker without pushing the page sideways. */
      await page.getByRole("radio", { name: "Grok Imagine 2", exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      /* ...nor the card: every engine sits inside the Look card's edges. */
      const card = await page.getByTestId("boards-stage").locator("section").filter({ has: page.getByRole("radiogroup", { name: "Frame engine" }) }).boundingBox();
      for (const radio of await page.getByRole("radiogroup", { name: "Frame engine" }).getByRole("radio").all()) {
        const box = (await radio.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(card!.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
      }
      await page.screenshot({ path: info.outputPath(`boards-engines-${info.project.name.split("-")[1]}.png`) });
    }
    await frame.getByTestId("frame-render").click();
    await expect.poll(async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project.production.boards.frames["shot-a1"].takes.length, { timeout: 60_000 }).toBe(takes);
  }
  const boards = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project.production.boards;
  expect(boards.model).toBe("grok-imagine-image-2.0");
  expect(errors).toEqual([]);
});
