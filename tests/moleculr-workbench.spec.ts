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

test("Moleculr reviews website branding, imports the original logo and preserves reviewed identity", async ({ page }, info) => {
  const state = await fixture(page);
  let extracted = 0, imported = 0, externalImages = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().startsWith("https://brand.example.test/") && request.resourceType() === "image") externalImages++; });
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=", "base64");
  await page.route("**/api/workbench/moleculr/extract-brand", async route => {
    expect(route.request().headers()["x-workbench-scope"]).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({projectId:"suite-test",url:"https://brand.example.test"});
    extracted++;
    await route.fulfill({json:{source:{requestedUrl:"https://brand.example.test",finalUrl:"https://brand.example.test/",fetchedAt:"2026-09-18T12:00:00.000Z"},brand:{name:"North",description:"Camera equipment for filmmakers.",tagline:"Find your frame.",colors:["#225544","#FFFFFF"],fontFamilies:["Inter","Georgia"]},logoCandidates:[{url:"https://brand.example.test/logo.png",source:"json-ld",alt:"North logo"},{url:"https://brand.example.test/logo.svg",source:"html-image",alt:"Vector logo"}],imageryCandidates:[],evidence:[{field:"name",source:"json-ld",value:"North",sourceUrl:"https://brand.example.test/"}],warnings:["Review the extracted colours before use."],requiresReview:true}});
  });
  await page.route("**/api/workbench/moleculr/import-image", async route => {
    expect(route.request().postDataJSON()).toEqual({projectId:"suite-test",url:"https://brand.example.test/logo.png"});
    expect(route.request().headers()["x-workbench-scope"]).toBeTruthy();
    imported++;
    await route.fulfill({contentType:"image/png",body:bytes});
  });
  await page.route("**/api/uploads/chunk", route => route.fulfill({json:{ok:true}}));
  await page.route("**/api/uploads/finish", route => route.fulfill({json:{id:"north-logo",filename:"brand-reference.png",mime:"image/png",kind:"image",bytes:bytes.length,width:1,height:1,durationS:null,sha256:"a".repeat(64),url:"/api/uploads/north-logo"}}));
  await page.route("**/api/uploads/north-logo", route => route.fulfill({contentType:"image/png",body:bytes}));
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=brand");
  const kit = page.getByRole("region",{name:"Brand kit",exact:true});
  const review = page.getByRole("region",{name:"Import brand from website"});
  await kit.getByLabel("Brand voice",{exact:true}).fill("Quiet confidence.");
  await kit.getByLabel("Brand audience",{exact:true}).fill("Professional filmmakers.");
  await review.getByLabel("Brand website",{exact:true}).fill("https://brand.example.test");
  await review.getByRole("button",{name:"Extract brand",exact:true}).click();
  await expect(review.getByLabel("Extracted brand name",{exact:true})).toHaveValue("North");
  await expect(kit.getByLabel("Brand name",{exact:true})).toHaveValue("");
  expect(imported).toBe(0); expect(externalImages).toBe(0);
  await expect(review.getByRole("button",{name:"Import logo",exact:true}).nth(1)).toBeDisabled();
  await review.getByRole("button",{name:"Import logo",exact:true}).first().click();
  await expect.poll(()=>state.project.moleculr?.brandKit?.logoAssetId).toBe("north-logo");
  expect(state.project.assets.find(asset=>asset.id==="north-logo")).toMatchObject({kind:"image",category:"Brand",uploadId:"north-logo"});
  await review.getByLabel("Extracted brand name",{exact:true}).fill("North Studio");
  await review.getByRole("button",{name:"Apply reviewed brand",exact:true}).click();
  await expect.poll(()=>state.project.moleculr?.brandKit?.name).toBe("North Studio");
  expect(state.project.moleculr?.brandKit).toMatchObject({description:"Camera equipment for filmmakers.",voice:"Quiet confidence.",audience:"Professional filmmakers.",fontFamilies:["Inter","Georgia"],colors:["#225544","#FFFFFF"],logoAssetId:"north-logo",source:{url:"https://brand.example.test/"}});
  await page.screenshot({path:info.outputPath("reviewed-brand.png")});
  await review.getByLabel("Brand website",{exact:true}).fill("https://brand.example.test/new");
  await expect(review.getByRole("button",{name:"Apply reviewed brand",exact:true})).toHaveCount(0);
  await expect.poll(()=>state.project.moleculr?.brandKit?.website).toBe("https://brand.example.test/new");
  await page.reload();
  await expect(kit.getByLabel("Brand name",{exact:true})).toHaveValue("North Studio");
  await expect(kit.getByLabel("Brand voice",{exact:true})).toHaveValue("Quiet confidence.");
  expect(extracted).toBe(1); expect(imported).toBe(1); expect(externalImages).toBe(0);
  expect(state.mutations).toEqual([]); expect(errors).toEqual([]);
});

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
    page.getByRole("navigation", { name: "Particl Production Studio pages" }),
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

test("suite navigation waits for hydration and project initialization, then follows the first click", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "startup race on phone and desktop");
  const state = await fixture(page);
  let releaseScripts = () => {};
  const scripts = new Promise<void>(resolve => { releaseScripts = resolve; });
  await page.route("**/_next/static/**", async route => {
    if (route.request().resourceType() === "script") await scripts;
    await route.continue();
  });
  let releaseProject = () => {}, projectRequested = false;
  const project = new Promise<void>(resolve => { releaseProject = resolve; });
  await page.route("**/api/workbench/projects?*", async route => {
    if (route.request().method() === "GET") { projectRequested = true; await project; }
    await route.fallback();
  });
  await page.goto("/workbench?project=suite-test&stage=export", { waitUntil: "commit" });
  const suite = page.getByRole("navigation", { name: "Suites", exact: true }).getByRole("link", { name: "Moleculr Business Suite", exact: true });
  const room = page.getByRole("navigation", { name: "Rooms", exact: true }).getByRole("link", { name: "Make", exact: true });
  await expect(suite).toBeDisabled();
  await expect(suite).not.toHaveAttribute("href");
  await expect(room).toBeDisabled();
  await expect(room).not.toHaveAttribute("href");
  releaseScripts();
  await expect.poll(() => projectRequested).toBe(true);
  await expect(suite).toBeDisabled();
  releaseProject();
  await expect(suite).toBeEnabled();
  await expect(suite).toHaveAttribute("href", "/workbench?project=suite-test&suite=moleculr&page=marketing");
  await expect(room).toBeEnabled();
  await suite.click();
  await expect(page).toHaveURL(/project=suite-test&suite=moleculr&page=marketing/);
  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The product, precisely." })).toBeVisible();
  expect(state.mutations).toEqual([]);
});

test("suite navigation includes Astra blender in order, retains every prior stage and blocks leaving unsaved work", async ({
  page,
}, info) => {
  await fixture(page, true);
  await page.goto("/workbench?project=suite-test&stage=brief");
  await expect(
    page.getByRole("navigation", { name: "Particl Production Studio pages" }),
  ).toBeVisible();
  const links = page
    .getByRole("navigation", { name: "Particl Production Studio pages" })
    .getByRole("link");
  const stages = [
    ["Brief & Script", "brief"],
    ["Boards", "storyboard"],
    ["Cast & Elements", "characters"],
    ["Astra blender", "astra-blender"],
    ["Rig", "canvas"],
    ["Takes", "assets"],
    ["Edit & Sound", "edit"],
    ["Deliver", "export"],
  ] as const;
  await expect(links).toHaveCount(stages.length);
  for (const [index, [label, stage]] of stages.entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(label);
    await expect(links.nth(index)).toBeEnabled();
    await expect(links.nth(index)).toHaveAttribute(
      "href", `/workbench?project=suite-test&stage=${stage}`,
    );
  }
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

test("retired stage IDs, the home project selector and the Marketing Studio sections follow the 19 September information architecture", async ({
  page,
}, info) => {
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dock = page.getByRole("navigation", { name: "Particl Production Studio pages", exact: true });
  await page.goto("/workbench?project=suite-test&stage=brief");
  await expect(dock.getByRole("link")).toHaveText([
    /Brief & Script$/,
    /Boards$/,
    /Cast & Elements$/,
    /Astra blender$/,
    /Rig$/,
    /Takes$/,
    /Edit & Sound$/,
    /Deliver$/,
  ]);
  for (const [alias, target, label] of [
    ["script", "brief", "Brief & Script"],
    ["moodboard", "storyboard", "Boards"],
    ["elements", "characters", "Cast & Elements"],
  ] as const) {
    await page.goto(`/workbench?project=suite-test&stage=${alias}`);
    await expect(dock.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(new RegExp(`[?&]stage=${target}(&|$)`));
    await expect(dock.getByRole("link", { name: alias, exact: true })).toHaveCount(0);
  }
  await page.goto("/workbench?project=suite-test&stage=script");
  await expect(page.getByLabel("Project title", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Script format", exact: true })).toBeVisible();
  await expect(page.locator(".stage-scroll").filter({ visible: true })).toHaveCount(1);
  await page.goto("/workbench?project=suite-test&stage=moodboard");
  const look = page.locator("details.look-section");
  await expect(look).toBeVisible();
  await expect(page.getByText("LOOK DEVELOPMENT", { exact: true })).toBeHidden();
  await look.locator("summary").click();
  await expect(page.getByText("LOOK DEVELOPMENT", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find the frame. Feel the rhythm." })).toBeVisible();
  await page.goto("/workbench?project=suite-test&stage=elements");
  await expect(page.getByRole("region", { name: "Cast", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Elements", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Identity", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Element identity", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Soul ID", exact: true })).toHaveCount(0);
  await page.goto("/workbench?project=suite-test&stage=assets");
  await expect(page.getByRole("region", { name: "Project generations", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All workspace assets" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What are we making?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open a saved project", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const projects = document.querySelector(".suite-home-projects")!,
        cards = document.querySelector(".suite-home-cards")!,
        brief = document.querySelector(".suite-home-brief")!;
      const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [before(projects, cards), before(cards, brief)];
    }),
  ).toEqual([true, true]);
  await page.goto("/workbench?project=suite-test&suite=moleculr&page=brand");
  await expect(page).toHaveURL(/suite=moleculr&page=marketing#brand$/);
  const moleculrDock = page.getByRole("navigation", { name: "Moleculr Business Suite pages", exact: true });
  await expect(moleculrDock.getByRole("link")).toHaveCount(1);
  await expect(moleculrDock.getByRole("link", { name: "Marketing Studio", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Marketing Studio sections", exact: true }).getByRole("link")).toHaveText([
    "Product",
    "Brand",
    "Cast",
    "Format",
    "Variants",
    "Design",
    "Publish",
  ]);
  for (const id of ["product", "brand", "cast", "format", "variants", "design", "publish"]) {
    await expect(page.locator(`section.moleculr-section#${id}`)).toHaveCount(1);
  }
  await expect(page.getByRole("heading", { name: "The product, precisely." })).toBeVisible();
  const expanded = (id: string) => page.locator(`section.moleculr-section#${id} > h2 > button`);
  await expect(expanded("brand")).toHaveAttribute("aria-expanded", "true");
  await expect(expanded("product")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Brand kit", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Marketing Studio sections", exact: true }).getByRole("link", { name: "Variants", exact: true }).click();
  await expect(page).toHaveURL(/suite=moleculr&page=marketing#variants$/);
  await expect(expanded("variants")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "Brand kit", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(expanded("variants")).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: info.outputPath("marketing-studio-sections.png") });
  expect(state.mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test("four-suite home and legacy Subatomic redirect preserve project without inference", async ({
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
    page.getByRole("navigation", { name: "Particl Production Studio pages" }),
  ).toBeInViewport();
  await page.goto("/subatomic?project=suite-test&page=trends");
  await expect(page).toHaveURL(/\/subatomik\?project=suite-test&page=motion-transfer/);
  await expect(
    page
      .getByRole("navigation", { name: "Suites", exact: true })
      .getByRole("link"),
  ).toHaveCount(4);
  await expect(
    page.getByRole("navigation", { name: "Subatomik Viral Studio pages", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("subatomik-redirect.png") });
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
