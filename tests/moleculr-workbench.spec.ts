import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { projectSchema } from "../lib/workbench/studio-schema";
import { generationReferenceIds } from "../lib/workbench/node-graph";

async function fixture(page: Page, failSave = false) {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  let project: Project = {
    ...seedProject(),
    id: "suite-test",
    name: "Studio test",
    productionProjectId: "suite-production",
  };
  let revision = 1;
  const mutations: string[] = [],
    saves: Project[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      json = (data: unknown) => route.fulfill({ json: data });
    if (url.pathname === "/api/me") return json(me);
    if (url.pathname === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        if (failSave)
          return route.fulfill({
            status: 409,
            json: { error: "Save conflict. Keep current work." },
          });
        expect(request.headers()["x-workbench-scope"]).toBeTruthy();
        project = projectSchema.parse(
          request.postDataJSON().project,
        ) as Project;
        saves.push(structuredClone(project));
        revision++;
        return json({
          revision,
          productionProjectId: project.productionProjectId,
          shotMappings: {},
        });
      }
      return json({
        project,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
        revision,
      });
    }
    if (
      url.pathname === "/api/workbench/atomik" ||
      url.pathname === "/api/workbench/development"
    )
      return json({ configured: false, models: [], jobs: [] });
    if (url.pathname === "/api/pipelines")
      return json({
        runs: [],
        publications: [],
        models: [],
        audioModels: { speech: [], sound: "", music: "" },
      });
    if (url.pathname === "/api/jobs") return json({ generations: [] });
    if (url.pathname === "/api/workbench/engines")
      return json(
        url.searchParams.has("model")
          ? { credits: 4 }
          : {
              models: [
                {
                  id: "test-video",
                  label: "Test video",
                  kind: "video",
                  family: "seedance",
                  resolutions: ["720p"],
                  ratios: ["16:9", "9:16"],
                  durations: [5],
                  maxReferenceImages: 9,
                  maxReferenceVideos: 1,
                },
              ],
            },
      );
    if (url.pathname === "/api/atomik")
      return json({
        chats: [],
        models: { featured: [], rest: [] },
        engines: [],
      });
    if (url.pathname === "/api/projects")
      return json({
        projects: [
          {
            id: "suite-production",
            name: "Studio test",
            description: "",
            createdAt: 1,
            genCount: 0,
            spend: 0,
            credits: 0,
          },
        ],
      });
    if (url.pathname === "/api/engines")
      return json({ models: [], vendors: [] });
    if (request.method() !== "GET") {
      mutations.push(url.pathname);
      return route.fulfill({
        status: 409,
        json: { error: "No provider dispatch permitted in fixture." },
      });
    }
    return json({});
  });
  return {
    mutations,
    saves,
    get project() {
      return project;
    },
  };
}

test("Moleculr saves product and cast, configures video, preserves original references and returns to delivery", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await fixture(page);
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=product");
  await expect(
    page.getByRole("heading", { name: "The product, precisely." }),
  ).toBeVisible();
  const product = page.getByLabel("Product name", { exact: true });
  await expect(product).toBeEnabled();
  await product.fill("Mirror collection");
  await page
    .getByLabel("Product URL", { exact: false })
    .fill("https://example.test/product");
  await page
    .getByRole("button", { name: "The mirrored dunes", exact: true })
    .click();
  await page
    .locator(".work-area")
    .evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: info.outputPath("moleculr-product.png") });
  await page.getByRole("link", { name: "Cast", exact: true }).click();
  await page
    .getByRole("button", { name: "Mira / character study", exact: true })
    .click();
  await page.getByRole("link", { name: "Format", exact: true }).click();
  await page
    .getByLabel("Production format", { exact: true })
    .selectOption("poster");
  await page
    .getByLabel("Campaign hooks")
    .fill("A reflection of you\nA different perspective");
  await page
    .locator(".suite-fields")
    .getByLabel("Creative direction", { exact: true })
    .fill("Keep the original chrome product shape.");
  await page.getByRole("link", { name: "Variants", exact: true }).click();
  await expect(page.getByText("2 combinations")).toBeVisible();
  await page.getByLabel("Output", { exact: true }).selectOption("video");
  await page.getByRole("button", { name: "Configure generation" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Generation engine")).toHaveValue(
    "test-video",
  );
  await expect(dialog.getByLabel("Node first frame")).toHaveValue("");
  await expect(dialog.getByLabel("Generation direction")).toContainText(
    "A reflection of you",
  );
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(1);
  expect(state.project.moleculr?.productAssetIds).toEqual(["environment"]);
  expect(state.project.moleculr?.castAssetIds).toEqual(["character"]);
  expect(state.project.nodes.at(-1)?.mode).toBe("Video");
  expect(state.mutations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByLabel("Output", { exact: true })).toHaveValue("video");
  await page.getByRole("button", { name: "Open in Rig", exact: false }).click();
  const variantName = "Mirror collection · A reflection of you";
  if (page.viewportSize()!.width < 760) {
    await page
      .locator(".mobile-node-viewbar")
      .getByRole("tab", { name: "List", exact: true })
      .click();
    await page
      .locator(".mobile-node-list button")
      .filter({ hasText: variantName })
      .click();
  } else {
    const node = page.getByRole("article", {
      name: `Generate node: ${variantName}`,
      exact: true,
    });
    await node.focus();
    await node.press("Enter");
  }
  await page
    .getByRole("button", { name: "Generate take", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/2 bound media references/),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByLabel("Node first frame"),
  ).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=publish");
  await page
    .getByRole("button", { name: "Open delivery", exact: true })
    .click();
  await expect(page).toHaveURL(/stage=export/);
  await expect(
    page.getByRole("navigation", { name: "Particl Studio pages" }),
  ).toBeVisible();
  await page.reload();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  await page
    .getByRole("navigation", { name: "Suites", exact: true })
    .getByRole("link", { name: "Moleculr Business Suite", exact: true })
    .click();
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "Mirror collection",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test("suite navigation blocks leaving an unsaved project and keeps every original stage reachable", async ({
  page,
}, info) => {
  await fixture(page, true);
  await page.goto("/workbench?project=suite-test&stage=brief");
  await expect(
    page.getByRole("navigation", { name: "Particl Studio pages" }),
  ).toBeVisible();
  const links = page
    .getByRole("navigation", { name: "Particl Studio pages" })
    .getByRole("link");
  await expect(links).toHaveCount(10);
  await expect(
    page.getByRole("link", { name: "Rig", exact: true }),
  ).toHaveAttribute("href", /stage=canvas/);
  await page
    .getByPlaceholder("Start with a thought, a script or a client brief…")
    .fill("An unsaved brief.");
  await page
    .getByRole("navigation", { name: "Suites", exact: true })
    .getByRole("link", { name: "Moleculr Business Suite", exact: true })
    .click();
  await expect(
    page
      .getByText("Save conflict. Keep current work.", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page).toHaveURL(/stage=brief/);
  await expect(
    page.getByPlaceholder("Start with a thought, a script or a client brief…"),
  ).toHaveValue("An unsaved brief.");
  await page.screenshot({ path: info.outputPath("particl-brief.png") });
});

test("three-suite home and retired suite redirects preserve project without inference", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What are we making?" }),
  ).toBeVisible();
  await expect(page.locator(".suite-home-card")).toHaveCount(3);
  if (page.viewportSize()!.width < 760) {
    const header = await page.locator(".suite-header").boundingBox();
    expect(header!.height).toBeLessThanOrEqual(140);
  }
  await expect(
    page.getByRole("link", { name: "Studio test Open production" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("suite-home.png") });
  await page
    .getByRole("link", { name: "Studio test Open production" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("link", { name: "Studio test Open production" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("navigation", { name: "Suites", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("navigation", { name: "Particl Studio pages" }),
  ).toBeInViewport();
  await page.goto("/subatomic?project=suite-test&page=trends");
  await expect(page).toHaveURL(/\/atomik\?project=suite-test&page=runs/);
  await expect(
    page
      .getByRole("navigation", { name: "Suites", exact: true })
      .getByRole("link"),
  ).toHaveCount(3);
  await expect(
    page.getByRole("navigation", { name: "Atomik Agent pages", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("atomik-redirect.png") });
  expect(state.mutations).toEqual([]);
});

test("Moleculr keeps reviewed product profiles and brand kit, selects native briefs and builds editable storyboards without spend", async ({
  page,
}, info) => {
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let extracted = 0;
  let imported = 0;
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("**/api/workbench/moleculr/import-image", async (route) => {
    expect(route.request().headers()["x-workbench-scope"]).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({
      projectId: "suite-test",
      url: "https://example.test/camera.jpg",
    });
    imported++;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "content-disposition": 'attachment; filename="camera.png"' },
      body: imageBytes,
    });
  });
  await page.route("**/api/uploads/chunk", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/uploads/finish", (route) =>
    route.fulfill({
      json: {
        id: "imported-camera",
        filename: "camera.png",
        mime: "image/png",
        kind: "image",
        bytes: imageBytes.length,
        width: 1,
        height: 1,
        durationS: null,
        sha256: "a".repeat(64),
        url: "/api/uploads/imported-camera",
      },
    }),
  );
  await page.route("**/api/uploads/imported-camera", (route) =>
    route.fulfill({ contentType: "image/png", body: imageBytes }),
  );
  await page.route(
    "**/api/workbench/moleculr/extract-product",
    async (route) => {
      expect(route.request().headers()["x-workbench-scope"]).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({
        projectId: "suite-test",
        url: "https://example.test/camera",
      });
      extracted++;
      await route.fulfill({
        json: {
          source: {
            requestedUrl: "https://example.test/camera",
            finalUrl: "https://example.test/camera",
            fetchedAt: "2026-09-17T12:00:00.000Z",
          },
          product: {
            name: "Camera One",
            description: "Aluminium camera body.",
            brand: "North",
          },
          evidence: [
            {
              field: "description",
              source: "json-ld",
              value: "Aluminium camera body.",
              sourceUrl: "https://example.test/camera",
            },
          ],
          imageCandidates: [
            {
              url: "https://example.test/camera.jpg",
              source: "json-ld",
              alt: "Camera product photograph",
            },
          ],
          warnings: [
            "Check specifications against the approved product sheet.",
          ],
          requiresReview: true,
        },
      });
    },
  );
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=brand");
  const kit = page.getByRole("region", { name: "Brand kit" });
  await kit.getByLabel("Brand name", { exact: true }).fill("North Studio");
  await kit
    .getByLabel("Brand voice", { exact: true })
    .fill("Precise, curious and quietly confident.");
  await kit
    .getByLabel("Brand typography", { exact: true })
    .selectOption("editorial");
  await kit.getByRole("button", { name: "Add colour" }).click();
  await kit.getByLabel("Brand colour 1", { exact: true }).fill("#225544");
  await expect
    .poll(() => state.project.moleculr?.brandKit?.colors)
    .toEqual(["#225544"]);
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await page
    .getByLabel("Product URL", { exact: false })
    .fill("https://example.test/camera");
  await page
    .getByRole("button", { name: "Review product page", exact: true })
    .click();
  const review = page.getByRole("region", { name: "Product page review" });
  await expect(review).toBeVisible();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    review.getByText("Camera product photograph", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Product URL", { exact: false })
    .fill("https://example.test/other");
  await expect(review).not.toBeVisible();
  await page
    .getByLabel("Product URL", { exact: false })
    .fill("https://example.test/camera");
  await page
    .getByRole("button", { name: "Review product page", exact: true })
    .click();
  await expect(review).toBeVisible();
  expect(imported).toBe(0);
  await review
    .getByRole("button", { name: "Import original", exact: true })
    .click();
  await expect(
    review.getByRole("button", { name: "Imported", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      state.project.moleculr?.productAssetIds.includes("imported-camera"),
    )
    .toBe(true);
  expect(
    state.project.assets.find((asset) => asset.id === "imported-camera")
      ?.uploadId,
  ).toBe("imported-camera");
  await page.screenshot({
    path: info.outputPath("moleculr-reviewed-product.png"),
  });
  await review
    .getByLabel("Reviewed description")
    .fill("Approved aluminium camera body.");
  await review
    .getByRole("button", { name: "Use reviewed product facts" })
    .click();
  await expect(page.getByLabel("Approved product facts")).toHaveValue(
    "Approved aluminium camera body.",
  );
  await page
    .getByRole("button", { name: "The mirrored dunes", exact: true })
    .click();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => state.project.moleculr?.products?.length).toBe(1);
  const firstId = state.project.moleculr!.activeProductId!;
  await page.getByRole("button", { name: "New product", exact: true }).click();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Product name", { exact: true }).fill("Camera Two");
  await page.getByLabel("Saved product", { exact: true }).selectOption(firstId);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Save the current product profile" }),
  ).toBeVisible();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "Camera Two",
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect.poll(() => state.project.moleculr?.products?.length).toBe(2);
  const secondId = state.project.moleculr!.activeProductId!;
  await page.getByLabel("Saved product", { exact: true }).selectOption(firstId);
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "Camera One",
  );
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Camera One revised");
  await page
    .getByLabel("Saved product", { exact: true })
    .selectOption(secondId);
  await page.getByLabel("Saved product", { exact: true }).selectOption(firstId);
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(
    "Camera One revised",
  );
  await expect
    .poll(() => state.project.moleculr?.productName)
    .toBe("Camera One revised");
  await page.reload();
  await expect(page.getByLabel("Approved product facts")).toHaveValue(
    "Approved aluminium camera body.",
  );
  await page.getByRole("link", { name: "Format", exact: true }).click();
  const templates = page.getByRole("region", { name: "Creative templates" });
  await expect(
    templates
      .getByRole("group", { name: "Creative categories" })
      .getByRole("button"),
  ).toHaveCount(6);
  await templates
    .getByRole("button", { name: "UGC Videos", exact: true })
    .click();
  await templates
    .getByRole("button", { name: "Choose Faceless demonstration", exact: true })
    .click();
  await expect
    .poll(() => state.project.moleculr?.creative?.templateId)
    .toBe("ugc-faceless");
  await templates
    .getByRole("button", { name: "Build editable storyboard", exact: true })
    .click();
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(3);
  const shotIds = state.project.moleculr!.variants.map(
    (variant) => variant.nodeId,
  );
  expect(
    state.project.nodes
      .filter((node) => shotIds.includes(node.id))
      .every((node) => node.mode === "Video"),
  ).toBe(true);
  await page.getByRole("link", { name: "Variants", exact: true }).click();
  await expect(page.getByLabel("Output", { exact: true })).toHaveValue("video");
  await page
    .getByRole("button", { name: "Review generation", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("Generation direction"),
  ).toContainText("SHOT 3 OF 3");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Format", exact: true }).click();
  await templates.getByRole("button", { name: "Posters", exact: true }).click();
  await templates
    .getByRole("button", { name: "Choose Editorial poster", exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("moleculr-creative-templates.png"),
  });
  await templates
    .getByRole("button", { name: "Write a prompt", exact: true })
    .click();
  await templates
    .getByLabel("Creative prompt")
    .fill("Make a warm architectural product study.");
  await expect
    .poll(() => state.project.moleculr?.creative?.path)
    .toBe("prompt");
  expect(extracted).toBe(2);
  expect(imported).toBe(1);
  expect(state.mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("Moleculr prepares quoted-later hook and cast drafts while single video can stay product-only", async ({
  page,
}) => {
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=variants");
  await expect(
    page.getByRole("button", { name: "Prepare hook × cast variants" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Mirror collection");
  await page
    .getByRole("button", { name: "The mirrored dunes", exact: true })
    .click();
  await page.getByRole("link", { name: "Cast", exact: true }).click();
  await page
    .getByRole("button", { name: "Mira / character study", exact: true })
    .click();
  await page.getByRole("link", { name: "Format", exact: true }).click();
  await page
    .getByLabel("Campaign hooks")
    .fill("A reflection of you\nA different perspective");
  await page.getByRole("link", { name: "Variants", exact: true }).click();
  await page.getByLabel("Output", { exact: true }).selectOption("video");
  await page.getByLabel("Video cast", { exact: true }).selectOption("");
  await expect(page.getByLabel("Video cast", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Configure generation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/1 bound media reference/),
  ).toBeVisible();
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(1);
  const single = state.project.moleculr!.variants[0];
  expect(single.castAssetId).toBeUndefined();
  expect(
    generationReferenceIds(
      state.project.nodes.find((node) => node.id === single.nodeId)!,
      state.project,
    ),
  ).toEqual(["environment"]);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Prepare hook × cast variants" })
    .click();
  await expect.poll(() => state.project.moleculr?.variants.length).toBe(3);
  const prepared = state.project.moleculr!.variants.slice(1);
  expect(prepared.map((variant) => variant.hook)).toEqual([
    "A reflection of you",
    "A different perspective",
  ]);
  for (const variant of prepared) {
    expect(variant.castAssetId).toBe("character");
    expect(variant.kind).toBe("video");
    expect(
      generationReferenceIds(
        state.project.nodes.find((node) => node.id === variant.nodeId)!,
        state.project,
      ),
    ).toEqual(["environment", "character"]);
  }
  await expect(
    page.getByText("Draft · ready to review", { exact: true }),
  ).toHaveCount(3);
  await page
    .getByRole("button", { name: "Review generation", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog").getByText(/2 bound media references/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Design", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Every layer, considered.",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
