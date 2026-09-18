import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

test("Topaz Gen uses the original upload, quotes dimensions, recovers one paid request and reuses its saved output", async ({
  page,
}, info) => {
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
    submitted.push({
      body: request.postData(),
      key: request.headers()["idempotency-key"],
    });
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    generationId = (await response.json()).id;
    if (submitted.length === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  await page.goto(`/generate?mode=images&project=${draft.id}`);
  await page.getByRole("button", { name: "Engine", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Choose a model" })
    .getByRole("button", { name: /Topaz Image Upscale/ })
    .click();
  const panel = page.getByRole("region", {
    name: "Topaz Image Upscale",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: /Review upscale cost/ }),
  ).toBeDisabled();
  await panel
    .getByLabel("Upload upscale source", { exact: true })
    .setInputFiles({
      name: "Original frame.png",
      mimeType: "image/png",
      buffer: source,
    });
  await expect(panel.getByLabel("Source image", { exact: true })).toHaveValue(
    /^upload:/,
  );
  const sourceKey = await panel
    .getByLabel("Source image", { exact: true })
    .inputValue();
  await panel.getByRole("button", { name: /Review upscale cost/ }).click();
  await expect(
    panel.getByRole("button", { name: /Upscale image.*2 cr/ }),
  ).toBeEnabled();
  expect(submitted).toHaveLength(0);
  await panel.getByLabel("Image scale", { exact: true }).selectOption("4");
  await expect(
    panel.getByRole("button", { name: /Review upscale cost/ }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: /Review upscale cost/ }).click();
  const primary = panel.getByRole("button", { name: /Upscale image.*3 cr/ });
  await expect(primary).toBeEnabled();
  await page.screenshot({ path: info.outputPath("topaz-image.png") });
  const box = await primary.boundingBox(),
    viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await primary.click();
  await expect(
    panel.getByRole("button", { name: /Recover upscale/ }),
  ).toBeEnabled();
  await page.reload();
  await expect(panel.getByLabel("Image scale", { exact: true })).toHaveValue(
    "4",
  );
  await expect(panel.getByLabel("Image scale", { exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: /Recover upscale/ }).click();
  await expect(
    page.getByText("Upscale queued. Its progress is in Your takes.", {
      exact: true,
    }),
  ).toBeVisible();
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
  await page.goto(
    `/generate?mode=images&project=${draft.id}&task=upscale&source=generation:${generationId}`,
  );
  await expect(panel.getByLabel("Source image", { exact: true })).toHaveValue(
    `generation:${generationId}`,
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
