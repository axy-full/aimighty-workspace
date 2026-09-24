import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Production › Cast & Elements (owner's brief, 23 September): the cast list
 * comes from the beat sheet or the chosen agent; each character and element is
 * priced and built with Soul Cinema on the connected account (mocked here: the
 * account is external), then saved in the library as Cast or Elements; a
 * character renders with a Particl-built Soul ID. The agent runs on the real
 * local routes with the mock engine.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";
const WALLET = "22222222-2222-4222-8222-222222222222";

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  /* The server writes the same local files; wait for its lock instead of failing on SQLITE_BUSY. */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Cast test", "admin", "test", Date.now()] });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  /* What the real collection step writes when the account returns an original: the generation row the project may reference. */
  const collect = async (id: string) => {
    const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
    try { await tenant.execute({ sql: "INSERT OR IGNORE INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at) VALUES(?,?,'soul_cinematic','cast test','{}','succeeded',?,?)", args: [id, production, Date.now(), Date.now()] }); }
    finally { tenant.close(); }
  };
  const project = newProject(`Cast ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  project.production = { beats: { scriptSha256: sha256, updatedAt: new Date().toISOString(), scenes: [
    { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [{ id: "shot-a", description: "The fox", framing: "", movement: "", lighting: "", sound: "" }], characters: ["Fox"], locations: ["Frozen harbour"], props: ["Lantern"] },
  ] } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const production = String((await saved.json()).productionProjectId);

  /* The connected account (external): Soul Cinema in its catalogue, one ready Soul ID, quote → submit → status. */
  const pixel = await readFile("public/fixtures/still.png");
  const posts: Record<string, unknown>[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const elementsMade: { elementId: string; name: string; category: string; previewUrl: null }[] = [];
  let n = 0;
  await page.route(/\/api\/media\/gen_hfc_[a-f0-9]{40}$/, (route) => route.fulfill({ body: pixel, contentType: "image/png" }));
  await page.route("**/api/higgsfield/consumer/generation**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: {}, jobs: [] } });
    const body = request.postDataJSON();
    posts.push(body);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: [
      { id: "soul_cinematic", name: "Soul Cinema", aspectRatios: ["1:1", "3:4", "16:9", "9:16"], parameters: [{ name: "quality", options: ["1.5k", "2k"], default: "2k" }, { name: "soul_id" }], medias: [{ roles: ["image"] }] },
      { id: "soul_2", name: "Soul 2", aspectRatios: ["1:1", "3:4", "16:9"], parameters: [{ name: "quality", options: ["1.5k", "2k"], default: "2k" }, { name: "soul_id" }], medias: [{ roles: ["image"] }] },
      { id: "soul_location", name: "Soul Location", aspectRatios: ["16:9", "9:16"], parameters: [], medias: [] },
      { id: "soul_cast", name: "Soul Cast", aspectRatios: ["16:9"], parameters: [{ name: "budget", min: 10, max: 500, default: 50 }], medias: [] },
      { id: "bytedance_image_upscale", name: "Image upscale", aspectRatios: [], parameters: [], medias: [{ roles: ["image"] }] },
    ], complete: true } } });
    if (body.action === "elements") return route.fulfill({ json: { connected: true, available: true, elements: elementsMade } });
    if (body.action === "elements-create") { elementsMade.push({ elementId: "el_fox", name: body.name, category: body.category, previewUrl: null }); return route.fulfill({ json: { build: { state: "created", element: { elementId: "el_fox", name: body.name, category: body.category, previewUrl: null } } } }); }
    if (body.action === "characters") return route.fulfill({ json: { connected: true, available: true, characters: [{ soulId: "soul_fox", name: "Fox", type: "soul_cinematic", status: "ready", previewUrl: null }] } });
    if (body.action === "characters-plan") return route.fulfill({ json: { plan: { connected: true, available: true, plan: "Pro", paid: true } } });
    if (body.action === "quote") {
      const job = { id: `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`, draftId: project.id, status: "quoted", input: body.input, model: { id: body.input.model, name: body.input.model, outputType: "image" }, workspaceId: WALLET, workspaceName: "Studio wallet", quoteCredits: 6, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
      jobs.set(job.id, job);
      return route.fulfill({ json: { job } });
    }
    const job = jobs.get(body.id)!;
    if (body.action === "submit") { Object.assign(job, { status: "accepted", providerJobId: "33333333-3333-4333-8333-333333333333" }); return route.fulfill({ json: { job } }); }
    if (body.action === "status") {
      const generationId = `gen_hfc_${createHash("sha1").update(String(job.id)).digest("hex")}`;
      await collect(generationId);
      Object.assign(job, { status: "completed", originalAvailable: true, originalAvailability: "available", result: { original: { generationId, providerJobId: job.providerJobId, bytes: pixel.length, sha256: "b".repeat(64), mime: "image/png", credits: 6, creditUnit: "higgsfield_credits", asset: { generationId, url: `/api/media/${generationId}`, kind: "image", mime: "image/png" } } } });
      return route.fulfill({ json: { job, pollAfterSeconds: 3 } });
    }
    return route.fallback();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=studio&page=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible();
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { errors, posts, read };
}

test("Cast & Elements: from the beat sheet and the agent, built with Soul Cinema at its price, saved as Cast and Elements, a Soul ID carried", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(150_000);
  const { errors, posts, read } = await setup(page);
  await expect(page.getByTestId("page-title")).toHaveText("Cast & Elements");

  /* Free: the beat sheet's character and prop (its locations are built in Environment). */
  await page.getByTestId("cast-from-beats").click();
  const entries = page.getByTestId("cast-entry");
  await expect(entries).toHaveCount(2);
  await expect(page.getByTestId("cast-counts")).toHaveText("1 characters · 1 elements");

  /* The agent adds what the beat sheet did not name (Mara, and a prop), keeping the names already here. */
  await page.getByTestId("cast-agent-estimate").click();
  await expect(page.getByTestId("cast-agent-quote")).toContainText("3 agent steps");
  await page.getByTestId("cast-agent-start").click();
  await expect(entries).toHaveCount(4, { timeout: 60_000 });
  await expect(entries.filter({ has: page.locator('input[value="Mara"]') })).toHaveCount(1);

  /* The fox renders with its Soul ID: priced on the account, then built at that price. */
  const fox = entries.filter({ has: page.locator('input[value="Fox"]') });
  await fox.getByLabel("Fox Soul ID").selectOption("soul_fox");
  await fox.getByTestId("cast-price").click();
  await expect(fox.getByTestId("cast-build")).toHaveText("Build with Soul Cinema · 6 Higgsfield credits");
  const quote = posts.filter((b) => b.action === "quote").at(-1)!;
  expect(quote.input).toMatchObject({ type: "image", model: "soul_cinematic", parameters: { quality: "2k", aspect_ratio: "3:4", soul_id: "soul_fox" }, medias: [] });
  await fox.getByTestId("cast-build").click();
  expect(posts.find((b) => b.action === "submit")).toMatchObject({ workspaceId: WALLET, credits: 6 });
  await expect(fox.locator(".pd-frame-image img")).toBeVisible({ timeout: 30_000 });

  /* Soul Studio: an element set to Environment builds with Soul Location (no reference, no Soul ID, the film's ratio). */
  await page.getByTestId("cast-add-element").click();
  const added = entries.last();
  await added.getByLabel("Name").fill("Frozen harbour");
  await added.getByRole("radio", { name: "Environment" }).click();
  await added.getByTestId("cast-prompt").fill("Frozen harbour, a clean wide plate");
  const harbour = entries.filter({ has: page.locator('input[value="Frozen harbour"]') });
  await expect(harbour.getByTestId("cast-model-soul_location")).toHaveAttribute("aria-checked", "true");
  await harbour.getByTestId("cast-price").click();
  await expect.poll(() => (posts.filter((b) => b.action === "quote").at(-1)!.input as { model?: string }).model).toBe("soul_location");
  expect(posts.filter((b) => b.action === "quote").at(-1)!.input).toMatchObject({ model: "soul_location", parameters: { aspect_ratio: "16:9" }, medias: [] });
  await expect(harbour.getByTestId("cast-build")).toHaveText("Build with Soul Location · 6 Higgsfield credits");

  /* The fox's build: upscaled at its own price, then saved as a reference element (asked once more). */
  await fox.getByTestId("cast-upscale_image").click();
  await expect(fox.getByTestId("cast-upscale_image-run")).toHaveText("Upscale · 6 credits");
  const upscale = posts.filter((b) => b.action === "quote").at(-1)!.input as { model: string; tool: { name: string }; medias: { source: { genId: string } }[] };
  expect(upscale).toMatchObject({ model: "bytedance_image_upscale", tool: { name: "upscale_image", model: "bytedance_image_upscale" } });
  expect(upscale.medias[0].source.genId).toMatch(/^gen_hfc_/);
  await fox.getByTestId("cast-element-save").click();
  await fox.getByTestId("cast-element-confirm").click();
  await expect(fox.getByTestId("cast-element")).toHaveText("Reference element <<<el_fox>>>");
  expect(posts.find((b) => b.action === "elements-create")).toMatchObject({ name: "Fox", category: "character", sources: [{ genId: upscale.medias[0].source.genId }] });
  await expect(page.getByTestId("element-row-el_fox")).toContainText("<<<el_fox>>>");

  /* Saved in the library as Cast. */
  await expect.poll(async () => (await read()).assets.filter((a: { category: string }) => a.category === "Character").map((a: { name: string; soulIdentityId?: string }) => [a.name, a.soulIdentityId]), { timeout: 15_000 }).toEqual([["Fox", "soul_fox"]]);
  if (!["workbench-390x844"].includes(info.project.name)) {
    const library = page.getByTestId("library");
    await library.getByRole("tab", { name: /Assets/ }).click();
    await library.getByRole("button", { name: "Cast", exact: true }).click();
    await expect(library.locator("[data-ctx^='asset:']")).toHaveCount(1);
    await library.getByRole("button", { name: "Elements", exact: true }).click();
    await expect(library.locator("[data-ctx^='asset:']")).toHaveCount(0);
  }
  await expect(page.getByTestId("soul-card")).toBeVisible();
  await page.screenshot({ path: info.outputPath("cast.png") });
  expect(errors).toEqual([]);
});
