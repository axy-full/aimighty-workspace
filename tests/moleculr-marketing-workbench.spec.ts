import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { projectSchema } from "../lib/workbench/studio-schema";

test("Moleculr discovers real preset IDs, saves selection and quotes ordered image references without submitting", async ({
  page,
}, info) => {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const presetId = "96c22aa0-9d48-4f71-8c24-b9e5cf6e9ced";
  const image = (id: string): Asset => ({
    id,
    name: id,
    kind: "image",
    category: "Reference",
    url: `/api/uploads/${id}`,
    uploadId: id,
    description: "",
    prompt: "",
    status: "Draft",
    locked: false,
    version: 1,
    refs: [],
  });
  let project: Project = {
    ...newProject("Brand campaign"),
    id: "marketing-draft",
    productionProjectId: "marketing-production",
    assets: [image("cast-image"), image("product-b"), image("product-a")],
    moleculr: {
      ...EMPTY_MOLECULR,
      productName: "Camera",
      productAssetIds: ["product-a", "product-b"],
      castAssetIds: ["cast-image"],
      hooks: ["Carry your perspective"],
    },
  };
  const quotes: Record<string, unknown>[] = [],
    dispatched: string[] = [],
    catalogScopes: string[] = [];
  let revision = 1;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === "/api/me") return json(me);
    if (url.pathname === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = projectSchema.parse(
          request.postDataJSON().project,
        ) as Project;
        return json({
          revision: ++revision,
          productionProjectId: project.productionProjectId,
          shotMappings: {},
        });
      }
      if (request.method() === "POST") {
        expect(request.postDataJSON().projectId).toBe(project.id);
        return json({
          productionProjectId: project.productionProjectId,
          shotId: "marketing-shot",
        });
      }
      return json({
        project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (url.pathname === "/api/higgsfield/marketing/presets") {
      catalogScopes.push(request.headers()["x-workbench-scope"]);
      return json({
        configured: true,
        total: 1,
        items:
          url.searchParams.get("cursor") === "page-2"
            ? [{ id: presetId, name: "Studio product portrait", type: "ads" }]
            : [],
        cursor: url.searchParams.has("cursor") ? null : "page-2",
        capabilities: {
          qualities: ["low", "medium", "high"],
          resolutions: ["1k", "2k", "4k"],
          ratios: ["16:9", "1:1"],
          maxImages: 16,
        },
      });
    }
    if (url.pathname === "/api/workbench/engines")
      return json({
        models: [
          {
            id: "higgsfield/marketing-studio-image",
            label: "Higgsfield Marketing Studio Image",
            kind: "image",
            family: "gptimage",
            resolutions: ["2k", "4k"],
            ratios: ["16:9", "1:1"],
            durations: [],
            maxReferenceImages: 16,
            maxReferenceVideos: 0,
            marketing: true,
          },
        ],
      });
    if (url.pathname === "/api/generate/quote") {
      quotes.push(request.postDataJSON());
      return json({ estimatedCredits: 3, fingerprint: "f".repeat(64) });
    }
    if (url.pathname === "/api/jobs") return json({ generations: [] });
    if (
      url.pathname === "/api/workbench/atomik" ||
      url.pathname === "/api/workbench/development"
    )
      return json({ models: [], jobs: [] });
    if (url.pathname === "/api/workbench/agent") return json({ models: [] });
    if (request.method() !== "GET") {
      dispatched.push(url.pathname);
      return route.fulfill({
        status: 409,
        json: { error: "Paid generation disabled in fixture." },
      });
    }
    return json({});
  });
  await page.goto(
    "/workbench?project=marketing-draft&suite=moleculr&page=brand",
  );
  await expect(
    page.getByRole("heading", { name: "Build a brand worth knowing." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Variants", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Higgsfield Marketing Studio images",
  });
  await expect(
    panel.getByRole("button", { name: "Review campaign image" }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: /^Provider preset/ }).click();
  await expect(
    panel.getByRole("button", { name: "Review campaign image" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Load more presets" }).click();
  await panel.getByRole("button", { name: /Studio product portrait/ }).click();
  await panel.getByLabel("Product image").selectOption("product-b");
  await panel.getByLabel("Cast reference").selectOption("cast-image");
  await expect(panel.getByLabel("Image quality")).toBeDisabled();
  await expect.poll(() => project.moleculr?.marketing?.presetId).toBe(presetId);
  await page.screenshot({
    path: info.outputPath("moleculr-image-presets.png"),
  });
  await panel.getByRole("button", { name: "Review campaign image" }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Generation engine"),
  ).toHaveValue("higgsfield/marketing-studio-image");
  await expect.poll(() => quotes.length).toBeGreaterThan(0);
  expect(quotes.at(-1)).toMatchObject({
    projectId: "marketing-production",
    shotId: "marketing-shot",
    marketing: { quality: "high", enhancePrompt: true, presetId },
    references: [
      { uploadId: "product-b", role: "reference_image" },
      { uploadId: "cast-image", role: "reference_image" },
    ],
  });
  expect(String(quotes.at(-1)!.prompt).length).toBeLessThanOrEqual(5000);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    panel.getByRole("button", { name: /^Provider preset/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "Review campaign image" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Load more presets" }).click();
  await expect(
    panel.getByRole("button", { name: /Studio product portrait/ }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(catalogScopes.every(Boolean)).toBe(true);
  expect(dispatched).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
