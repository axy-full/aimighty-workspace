import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { legacyShell } from "./helpers/legacyShell";

const modelId = "higgsfield/marketing-studio-image";
async function fixture(page: Page, brokenMapping = false, campaign = false, plainEngineOnly = false) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = {
    ...newProject("Marketing generation"),
    id: "marketing-generation",
    productionProjectId: "marketing-production",
    shotMappings: { "marketing-node": "marketing-shot" },
    assets: [
      {
        id: "product",
        generationId: "product-generation",
        name: "Product original",
        kind: "image",
        category: "Reference",
        url: "/campaign/character.webp",
        description: "",
        prompt: "",
        status: "Draft",
        locked: false,
        version: 1,
        refs: [],
      },
      {
        id: "cast",
        uploadId: "cast-upload",
        name: "Cast original",
        kind: "image",
        category: "Reference",
        url: "/campaign/character.webp",
        description: "",
        prompt: "",
        status: "Draft",
        locked: false,
        version: 1,
        refs: [],
      },
    ],
    nodes: [
      {
        id: "product-node",
        type: "media",
        title: "Product",
        assetId: "product",
        x: 40,
        y: 80,
        width: 220,
        linked: [],
      },
      {
        id: "cast-node",
        type: "media",
        title: "Cast",
        assetId: "cast",
        x: 40,
        y: 420,
        width: 220,
        linked: [],
      },
      {
        id: "marketing-node",
        type: "generate",
        title: "Campaign still",
        text: "Original product with cast",
        mode: "Image",
        x: 400,
        y: 80,
        width: 300,
        linked: ["product-node", "cast-node"],
      },
    ],
    ...(campaign ? { moleculr: { ...EMPTY_MOLECULR, productAssetIds: ['product'], castAssetIds: ['cast'], hooks: ['Campaign still'],
      variants: [{ id: 'marketing-variant', nodeId: 'marketing-node', hook: 'Campaign still', kind: 'image' as const,
        /* A variant set up for the Marketing Studio engine. */
        ...(plainEngineOnly ? { generation: { modelId, marketing: { quality: 'high' as const, enhancePrompt: false }, ratio: '3:4' } } : {}) }] } } : {}),
  };
  let revision = 1,
    maps = 0,
    lost = true;
  const quotes: {
    body: Record<string, unknown>;
    fingerprint: string;
    credits: number;
  }[] = [];
  const submissions: {
    body: string;
    key: string | undefined;
    scope: string | undefined;
  }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      endpoint = url.pathname;
    const json = (
      value: unknown,
      status = 200,
      headers?: Record<string, string>,
    ) => route.fulfill({ json: value, status, headers });
    if (endpoint === "/api/me") return json(me);
    if (endpoint === "/api/workbench/projects") {
      if (req.method() === "PUT") {
        project = req.postDataJSON().project;
        return json({
          revision: ++revision,
          productionProjectId: project.productionProjectId,
          shotMappings: project.shotMappings,
        });
      }
      if (req.method() === "POST") {
        maps++;
        expect(req.postDataJSON()).toMatchObject({
          action: "map-shot",
          projectId: project.id,
          nodeId: "marketing-node",
        });
        return json(
          brokenMapping
            ? {}
            : {
                productionProjectId: "marketing-production",
                shotId: "marketing-shot",
              },
        );
      }
      return json({
        project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (endpoint === "/api/workbench/engines" && plainEngineOnly) {
      /* A workspace without the Marketing Studio engine: one ordinary image engine, priced by its own quote. */
      if (url.searchParams.has("model")) return json({ credits: 2 });
      return json({ models: [{ id: "image-plain", label: "Plain image", kind: "image", family: "nano-banana", resolutions: ["1k"], ratios: ["3:4", "16:9"], durations: [], maxReferenceImages: 4, maxReferenceVideos: 0 }] });
    }
    if (endpoint === "/api/workbench/engines") {
      expect(url.searchParams.has("model")).toBe(false); // This engine cannot use a static reference-count price.
      return json({
        models: [
          {
            id: modelId,
            label: "Marketing Studio Image",
            kind: "image",
            family: "higgsfield-marketing",
            marketing: true,
            resolutions: ["2k", "1k", "4k"],
            ratios: ["auto", "16:9", "3:4"],
            durations: [],
            maxReferenceImages: 16,
            maxReferenceVideos: 0,
          },
        ],
      });
    }
    if (endpoint === "/api/higgsfield/marketing/presets")
      return json({ configured: true, items: [], total: 0, cursor: null });
    if (endpoint === "/api/generate/quote") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      const body = req.postDataJSON();
      expect(body).toMatchObject({
        projectId: "marketing-production",
        shotId: "marketing-shot",
        model: modelId,
        refine: false,
      });
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
      const credits = body.marketing.quality === "high" ? 5 : 3;
      quotes.push({ body, fingerprint, credits });
      return json({
        fingerprint,
        estimatedCredits: credits,
        price: credits,
        unit: "cr",
      });
    }
    if (endpoint === "/api/generate") {
      const sent = {
        body: req.postData()!,
        key: req.headers()["idempotency-key"],
        scope: req.headers()["x-workbench-scope"],
      };
      submissions.push(sent);
      if (lost) {
        lost = false;
        return json(
          { error: "Lost acknowledgement; recover the same request." },
          503,
        );
      }
      return json({ id: "marketing-job", status: "queued" }, 202, {
        "Idempotency-Status": "complete",
      });
    }
    if (endpoint === "/api/jobs/marketing-job")
      return json({
        generation: {
          id: "marketing-job",
          kind: "image",
          model: modelId,
          status: "queued",
          projectId: "marketing-production",
          shotId: "marketing-shot",
          params: {},
        },
      });
    if (endpoint === "/api/jobs")
      return json({ generations: [], nextCursor: null });
    if (
      endpoint === "/api/workbench/atomik" ||
      endpoint === "/api/workbench/development"
    )
      return json({ models: [], jobs: [] });
    if (endpoint === "/api/workbench/library")
      return json({
        uploads: [],
        generations: [],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (req.method() !== "GET")
      return json(
        { error: "Unexpected paid mutation is forbidden in this fixture." },
        409,
      );
    return json({});
  });
  return {
    quotes,
    submissions,
    errors,
    scope,
    project: () => project,
    maps: () => maps,
    repair: () => {
      brokenMapping = false;
    },
  };
}
async function openNode(page: Page) {
  const rig = page
    .getByRole("navigation", { name: "Particl Production Studio pages", exact: true })
    .getByRole("link", { name: "Rig", exact: true });
  await expect(rig).toBeEnabled();
  await expect(rig).toHaveAttribute("aria-current", "page");
  if (page.viewportSize()!.width < 760) {
    await page
      .locator(".mobile-node-viewbar")
      .getByRole("tab", { name: "List", exact: true })
      .click();
    await page
      .locator(".mobile-node-list button")
      .filter({ hasText: "Campaign still" })
      .click();
  } else {
    const node = page.getByRole("article", {
      name: "Generate node: Campaign still",
      exact: true,
    });
    await node.focus();
    await node.press("Enter");
  }
  await page
    .getByRole("button", { name: "Generate take", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Generate a new take", exact: true });
}

test("Marketing edits require a new mapped live quote and lost acknowledgement recovers identical request after reload", async ({
  page,
}, info) => {
  test.skip(
    !["workbench-390x844", "workbench-1440x900"].includes(info.project.name),
    "one phone and one desktop",
  );
  const f = await fixture(page);
  await page.goto(await legacyShell(page, "/workbench?project=marketing-generation&stage=canvas"));
  let dialog = await openNode(page);
  const generate = dialog.getByRole("button", {
    name: "Generate · 5 cr estimated",
    exact: true,
  });
  await expect(generate).toBeEnabled();
  expect(f.quotes.at(-1)?.body.references).toEqual([
    { genId: "product-generation", role: "reference_image" },
    { uploadId: "cast-upload", role: "reference_image" },
  ]);
  await dialog
    .getByLabel("Generation direction")
    .fill("Revised product campaign direction");
  await dialog.getByLabel("Marketing image quality").selectOption("medium");
  await expect(
    dialog.getByRole("button", {
      name: "Generate · 3 cr estimated",
      exact: true,
    }),
  ).toBeEnabled();
  expect(f.quotes.at(-1)?.body).toMatchObject({
    prompt: "Revised product campaign direction",
    marketing: { quality: "medium", enhancePrompt: false },
  });
  const quote = f.quotes.at(-1)!;
  await dialog
    .getByRole("button", { name: "Generate · 3 cr estimated", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Recover submitted take", exact: true }),
  ).toBeEnabled();
  expect(f.submissions).toHaveLength(1);
  expect(JSON.parse(f.submissions[0].body)).toEqual({
    ...quote.body,
    maxCredits: 3,
    quoteFingerprint: quote.fingerprint,
  });
  expect(f.submissions[0].scope).toBe(f.scope);
  expect(f.submissions[0].key).toBeTruthy();
  const quoteCount = f.quotes.length,
    mapCount = f.maps();
  await page.reload();
  dialog = await openNode(page);
  await expect(dialog.getByLabel("Generation direction")).toHaveValue(
    "Revised product campaign direction",
  );
  await expect(dialog.getByLabel("Marketing image quality")).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Recover submitted take", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]).toEqual(f.submissions[0]);
  expect(f.quotes).toHaveLength(quoteCount);
  expect(f.maps()).toBe(mapCount);
  expect(f.errors).toEqual([]);
});

test("Moleculr restores accepted prompt and 4k marketing settings after lost acknowledgement recovery and reload without another submission", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone and one desktop");
  const f = await fixture(page, false, true);
  await page.goto(await legacyShell(page, "/workbench?project=marketing-generation&suite=moleculr&page=variants"));
  const openVariant = async () => {
    await page.getByRole("button", { name: "Review generation", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Generate a new take", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  let dialog = await openVariant();
  await expect(dialog.getByRole("button", { name: "Generate · 5 cr estimated", exact: true })).toBeEnabled();
  await dialog.getByLabel("Generation size").selectOption("4k");
  await dialog.getByLabel("Generation aspect").selectOption("3:4");
  await dialog.getByLabel("Marketing image quality").selectOption("medium");
  const acceptedPrompt = "Accepted campaign direction: sculpted light and exact original packaging.";
  await dialog.getByLabel("Generation direction").fill(acceptedPrompt);
  await expect(dialog.getByRole("button", { name: "Generate · 3 cr estimated", exact: true })).toBeEnabled();
  expect(f.quotes.at(-1)?.body).toMatchObject({ prompt: acceptedPrompt, model: modelId, resolution: "4k", ratio: "3:4", marketing: { quality: "medium", enhancePrompt: false } });
  await dialog.getByRole("button", { name: "Generate · 3 cr estimated", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Recover submitted take", exact: true })).toBeEnabled();
  expect(f.submissions).toHaveLength(1);
  expect(f.project().moleculr!.variants[0].generation).toBeUndefined();
  expect(f.project().nodes.find(node => node.id === "marketing-node")!.text).toBe("Original product with cast");
  const quoteCount = f.quotes.length;

  await page.reload();
  dialog = await openVariant();
  await expect(dialog.getByLabel("Generation direction")).toHaveValue(acceptedPrompt);
  await expect(dialog.getByLabel("Generation size")).toHaveValue("4k");
  await expect(dialog.getByLabel("Marketing image quality")).toHaveValue("medium");
  await expect(dialog.getByLabel("Marketing image quality")).toBeDisabled();
  expect(f.submissions).toHaveLength(1);
  await dialog.getByRole("button", { name: "Recover submitted take", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]).toEqual(f.submissions[0]);
  expect(f.quotes).toHaveLength(quoteCount);
  const savedSettings = { modelId, resolution: "4k", ratio: "3:4", marketing: { quality: "medium", enhancePrompt: false } };
  await expect.poll(() => f.project().moleculr!.variants[0].generation).toEqual(savedSettings);
  await expect.poll(() => f.project().nodes.find(node => node.id === "marketing-node")!.text).toBe(acceptedPrompt);

  await page.reload();
  dialog = await openVariant();
  await expect(dialog.getByLabel("Generation engine")).toHaveValue(modelId);
  await expect(dialog.getByLabel("Generation direction")).toHaveValue(acceptedPrompt);
  await expect(dialog.getByLabel("Generation size")).toHaveValue("4k");
  await expect(dialog.getByLabel("Generation aspect")).toHaveValue("3:4");
  await expect(dialog.getByLabel("Marketing image quality")).toHaveValue("medium");
  await expect(dialog.getByLabel("Marketing image quality")).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Generate · 3 cr estimated", exact: true })).toBeEnabled();
  expect(f.quotes.at(-1)?.body).toMatchObject({ prompt: acceptedPrompt, model: modelId, resolution: "4k", ratio: "3:4", marketing: { quality: "medium", enhancePrompt: false } });
  expect(f.submissions).toHaveLength(2);
  await page.screenshot({ path: info.outputPath("moleculr-accepted-generation-restored.png") });
  await page.keyboard.press("Escape");
  expect(f.submissions).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

test("invalid project mapping cannot quote or submit and explicit preparation retry restores it", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "workbench-1440x900",
    "bounded malformed mapping guard",
  );
  const f = await fixture(page, true);
  await page.goto(await legacyShell(page, "/workbench?project=marketing-generation&stage=canvas"));
  const dialog = await openNode(page);
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(f.quotes).toHaveLength(0);
  expect(f.submissions).toHaveLength(0);
  f.repair();
  await dialog.getByRole("button", { name: /Refresh quote/i }).click();
  await expect(
    dialog.getByRole("button", {
      name: "Generate · 5 cr estimated",
      exact: true,
    }),
  ).toBeEnabled();
  expect(f.quotes).toHaveLength(1);
  expect(f.submissions).toHaveLength(0);
});

test("a preset whose engine is not connected here opens on a connected engine, says so, loads its price, and keeps its own engine", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "bounded engine fallback");
  const f = await fixture(page, false, true, true);
  await page.goto(await legacyShell(page, "/workbench?project=marketing-generation&suite=moleculr&page=variants"));
  await page.getByRole("button", { name: "Review generation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a new take", exact: true });
  await expect(dialog.getByLabel("Generation engine")).toHaveValue("image-plain");
  await expect(dialog.getByLabel("Generation aspect")).toHaveValue("3:4");
  await expect(dialog.getByRole("note")).toContainText("isn’t connected in this workspace, so this take uses Plain image.");
  await expect(dialog.getByRole("button", { name: "Generate · 2 cr estimated", exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText("No generation engine is configured");
  expect(f.submissions).toHaveLength(0);
  /* The take is made on the stand-in (mocked: the first acknowledgement is lost, the retry lands). */
  const direction = "Stand-in take: the product on a plain sweep.";
  await dialog.getByLabel("Generation direction").fill(direction);
  await dialog.getByRole("button", { name: "Generate · 2 cr estimated", exact: true }).click();
  await dialog.getByRole("button", { name: "Recover submitted take", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(f.submissions).toHaveLength(2);
  expect(JSON.parse(f.submissions[1].body).model).toBe("image-plain");
  /* The variant stays set up for the Marketing Studio engine, for when it is connected. */
  await expect.poll(() => f.project().nodes.find((node) => node.id === "marketing-node")!.text).toBe(direction);
  expect(f.project().moleculr!.variants[0].generation).toEqual({ modelId, marketing: { quality: "high", enhancePrompt: false }, ratio: "3:4" });
  expect(f.errors).toEqual([]);
});
