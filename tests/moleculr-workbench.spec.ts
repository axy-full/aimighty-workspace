import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { projectSchema } from "../lib/workbench/studio-schema";

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
      return json({ models: [], jobs: [] });
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
  await page.getByRole("button", { name: /Poster One frame/ }).click();
  await page
    .getByLabel("Campaign hooks")
    .fill("A reflection of you\nA different perspective");
  await page
    .locator(".suite-fields")
    .getByLabel("Creative direction", { exact: true })
    .fill("Keep the original chrome product shape.");
  await page.getByRole("link", { name: "Variants", exact: true }).click();
  await expect(page.getByText("2 combinations")).toBeVisible();
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
    page.getByRole("navigation", { name: "Particl pages" }),
  ).toBeVisible();
  await page.reload();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Switch suite" }).click();
  await page.getByRole("menuitem", { name: /Moleculr/ }).click();
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
    page.getByRole("navigation", { name: "Particl pages" }),
  ).toBeVisible();
  const links = page
    .getByRole("navigation", { name: "Particl pages" })
    .getByRole("link");
  await expect(links).toHaveCount(10);
  await expect(
    page.getByRole("link", { name: "Rig", exact: true }),
  ).toHaveAttribute("href", /stage=canvas/);
  await page
    .getByPlaceholder("Start with a thought, a script or a client brief…")
    .fill("An unsaved brief.");
  await page.getByRole("button", { name: "Switch suite" }).click();
  await page.getByRole("menuitem", { name: /Moleculr/ }).click();
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

test("new home and Subatomic research open existing approval controls without inference", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What are we making?" }),
  ).toBeVisible();
  await expect(page.locator(".suite-home-card")).toHaveCount(4);
  if (page.viewportSize()!.width < 760) {
    const header = await page.locator(".suite-header").boundingBox();
    expect(header!.height).toBeLessThanOrEqual(96);
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
  await expect(page.getByRole("button", { name: "Switch suite" })).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Particl pages" })).toBeInViewport();
  await page.goto("/subatomic?project=suite-test&page=trends");
  await page
    .getByLabel("Sources and observations")
    .fill("A studio reference, based on our own research.");
  await page
    .getByLabel("Creative direction", { exact: true })
    .fill("A repeatable fashion campaign format.");
  await page.reload();
  await expect(page.getByLabel("Sources and observations")).toHaveValue(
    "A studio reference, based on our own research.",
  );
  await expect(
    page.getByRole("link", { name: "Factory", exact: true }),
  ).toHaveAttribute("href", /project=suite-test/);
  await page.screenshot({ path: info.outputPath("subatomic-trends.png") });
  expect(state.mutations).toEqual([]);
});
