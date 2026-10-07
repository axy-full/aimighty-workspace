import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

/**
 * Topaz image upscale, end to end against the mock backend: the original upload is the source, the price on the button is
 * the server's quote for exactly that request (2× and 4× each priced), a paid request whose reply is lost is saved before it
 * is sent and replayed whole (same body, same key) by Recover, never sent as a second request, and the result is a new take
 * with the original left as it was. Retargeted from the old Gen page's Topaz Image Upscale panel (retired in Release 1) to
 * Make › Upscale, which keeps the same claim (usePaidAction) and the same routes. The panel's quick tools are the board's
 * (desktop); a phone's Make is the simple form and has no tool row.
 */
const DESKTOPS = ["customer-1440x900", "customer-1920x1080"];

test("Topaz upscale uses the original upload, quotes dimensions, recovers one paid request and reuses its saved output", async ({
  page,
}, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "Make's quick tools are the board's; a phone's Make is the simple form");
  // A compiled production server deliberately cannot provision local tenant
  // databases. Reuse a previously provisioned, isolated fixture for that run.
  const existingEmail = process.env.PW_TOPAZ_EXISTING_EMAIL;
  if (existingEmail) {
    expect(process.env.PW_BASE_URL).toMatch(
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/,
    );
    expect(existingEmail).toMatch(/^workbench-.+@example\.test$/);
    const health = await page.request.get("/api/health");
    expect((await health.json()).mock).toBe(true);
    const login = await page.request.post("/api/auth/login", {
      data: {
        email: existingEmail,
        password: "a local browser test passphrase 42",
      },
    });
    expect(login.ok(), await login.text()).toBe(true);
  } else {
    await signInLocally(page.request);
  }
  const me = await page.request.get("/api/me").then(response => response.json());
  const draft = newProject("Topaz original recovery project");
  const saved = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": workbenchScopeFor(me.workspace.id, me.id) },
    data: { project: draft, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  expect(productionProjectId).toBeTruthy();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const source = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: "#354765" },
  })
    .png()
    .toBuffer();
  const submitted: { body: string | null; key: string }[] = [];
  let generationId = "";
  await page.route("**/api/generate", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    submitted.push({
      body: request.postData(),
      key: request.headers()["idempotency-key"],
    });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    generationId = (await response.json()).id;
    /* The first reply is lost after the server took the request. */
    if (submitted.length === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  await page.goto(`/suites?project=${draft.id}&view=board&make=upscale`);
  await expect(page.getByTestId("upscale-tool")).toBeVisible();
  const go = page.getByTestId("upscale-go");
  const select = page.getByTestId("upscale-select");
  await expect(go).toBeDisabled();
  /* The project is open and saved once the tool asks for a source: the page is hydrated and the input listens. */
  await expect(page.getByTestId("upscale-reason")).toHaveText("Choose a picture or a clip.", { timeout: 30_000 });
  await page.getByLabel("Upload a source").setInputFiles({
    name: "Original frame.png",
    mimeType: "image/png",
    buffer: source,
  });
  await expect(page.getByTestId("upscale-source")).toHaveText("Original frame.png", { timeout: 30_000 });
  await expect(select).toHaveValue(/^upload:/);
  const sourceKey = await select.inputValue();
  await expect(page.getByTestId("upscale-model")).toHaveText("Topaz image upscale");
  /* 2×, then 4×: each priced by its own quote, and nothing is sent by reading either. */
  await expect(go).toHaveText(/^Upscale · (up to )?2 cr$/, { timeout: 30_000 });
  await expect(go).toBeEnabled();
  expect(submitted).toHaveLength(0);
  await page.getByRole("radio", { name: "4× larger" }).click();
  await expect(go).toHaveText(/^Upscale · (up to )?3 cr$/, { timeout: 30_000 });
  await expect(go).toBeEnabled();
  await page.screenshot({ path: info.outputPath("topaz-image.png") });
  const box = await go.boundingBox(),
    viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await go.click();
  await expect(go).toHaveText(/^Recover upscale/);
  await expect(go).toBeEnabled();
  expect(submitted).toHaveLength(1);
  await page.reload();
  /* The saved request is what is on offer, and nothing else can be changed or sent while it is unsettled. */
  await expect(page.getByTestId("upscale-recover")).toBeVisible();
  await expect(page.getByTestId("upscale-select")).toBeDisabled();
  await expect(page.getByRole("radio", { name: "4× larger" })).toBeDisabled();
  await expect(go).toHaveText(/^Recover upscale · (up to )?3 cr$/);
  await go.click();
  await expect(page.getByTestId("upscale-note")).toContainText("Queued");
  /* The same request, byte for byte and under the same key: never a second one. */
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  const getJob = () =>
    page.request.get(`/api/jobs/${generationId}`).then((r) => r.json());
  await expect
    .poll(async () => (await getJob()).generation?.status, { timeout: 45000 })
    .toBe("succeeded");
  const job = (await getJob()).generation;
  expect(job.params).toMatchObject({
    resolution: "48MP",
    topaz: { model: "High Fidelity V2", factor: 4, faceEnhancement: false },
    references: [{ uploadId: sourceKey.split(":")[1] }],
  });
  expect(job.projectId).toBe(productionProjectId);
  const original = await page.request.get(
    `/api/uploads/${sourceKey.split(":")[1]}`,
  );
  expect(await original.body()).toEqual(source);
  /* The result is a take in the project, offered as a source for the next upscale. */
  await page.goto(`/suites?project=${draft.id}&view=board&make=upscale`);
  await expect(page.getByTestId("upscale-select").locator(`option[value="generation:${generationId}"]`)).toHaveCount(1, { timeout: 30_000 });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
