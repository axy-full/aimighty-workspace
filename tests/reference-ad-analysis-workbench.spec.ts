import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { saveSchema } from "../lib/workbench/studio-schema";
import { referenceAdAnalysisSchema } from "../lib/workbench/reference-ad-analysis";
import { legacyShell } from "./helpers/legacyShell";

test("reference analysis samples the original, quotes the selected thinking controls, and requires reviewed apply", async ({
  page,
}, info) => {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const asset = {
    ...seedProject().assets[0],
    id: "original-ad",
    uploadId: "original-ad",
    generationId: undefined,
    name: "Original advertisement",
    url: "/api/uploads/original-ad",
    kind: "video" as const,
    mime: "video/mp4",
    durationS: 1.5,
  };
  let project: Project = {
    ...seedProject(),
    id: "reference-analysis",
    name: "Reference analysis campaign",
    productionProjectId: "reference-production",
    assets: [
      asset,
      {
        ...asset,
        id: "other-ad",
        uploadId: "other-ad",
        url: "/api/uploads/other-ad",
        name: "Another original",
      },
    ],
    moleculr: {
      ...EMPTY_MOLECULR,
      productName: "Our bottle",
      creative: {
        kind: "video",
        path: "prompt",
        category: "motion",
        aspect: "16:9",
        direction: "A product reveal.",
        seconds: 15,
      },
      referenceAd: {
        assetId: asset.id,
        notes: "My observation stays.",
        direction: "Keep the current direction until review.",
      },
    },
  };
  let revision = 1;
  const jobs: Record<string, unknown>[] = [],
    quotes: Record<string, unknown>[] = [],
    paid: Record<string, unknown>[] = [],
    frames: { id: string; width: number; height: number }[] = [],
    mutations: string[] = [],
    external: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      return route.continue();
    external.push(url.href);
    return route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path.startsWith("/api/uploads/"))
      return route.fulfill({
        path: "tests/fixtures/astra-source.mp4",
        contentType: "video/mp4",
      });
    if (path === "/api/workbench/projects") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "PUT") {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        return json({
          revision: ++revision,
          productionProjectId: project.productionProjectId,
          shotMappings: {},
        });
      }
      return json({
        project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (path === "/api/workbench/atomik/frames") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      expect(url.searchParams.get("assetId")).toBe(asset.id);
      expect(url.searchParams.get("projectId")).toBe(project.id);
      const bytes = request.postDataBuffer()!;
      expect(bytes.length).toBeLessThan(256 * 1024);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.format).toBe("jpeg");
      expect(metadata.width).toBeLessThanOrEqual(512);
      expect(metadata.height).toBeLessThanOrEqual(512);
      const id = `review-frame-${frames.length}`;
      frames.push({ id, width: metadata.width!, height: metadata.height! });
      return json({ id });
    }
    if (path === "/api/workbench/atomik") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET")
        return json({
          configured: true,
          models: [
            {
              id: "anthropic/claude-sonnet-4.6",
              name: "Claude Sonnet 4.6",
              vision: true,
              efforts: [
                { value: "high", label: "High" },
                { value: "low", label: "Low" },
              ],
            },
          ],
          jobs,
        });
      const body = request.postDataJSON();
      expect(body.referenceAd).toEqual({
        assetId: asset.id,
        sourceKey: JSON.stringify({ uploadId: asset.uploadId }),
      });
      expect(body.refs).toEqual([asset.id]);
      expect(body.videoFrames).toHaveLength(12);
      if (body.quoteOnly) {
        quotes.push(body);
        return json({
          model: "anthropic/claude-sonnet-4.6",
          effort: body.effort,
          estimateCredits: 7,
          visualCount: 12,
        });
      }
      paid.push(body);
      expect(body.maxCredits).toBe(7);
      expect(body.model).toBe("anthropic/claude-sonnet-4.6");
      expect(body.effort).toBe("high");
      expect(body.depth).toBe("Quick");
      const analysis = referenceAdAnalysisSchema.parse({
        projectId: project.id,
        jobId: "saved-reference-analysis",
        model: body.model,
        createdAt: new Date().toISOString(),
        evidence: {
          source: body.referenceAd,
          durationSeconds: 1.5,
          samples: body.videoFrames.map(
            (frame: { uploadId: string; timeSeconds: number }) => ({
              uploadId: frame.uploadId,
              timeSeconds: frame.timeSeconds,
              sha256: "a".repeat(64),
            }),
          ),
        },
        result: {
          summary: "A sampled silhouette becomes a bright product reveal.",
          beats: [
            {
              sampleIndex: 0,
              observation: "A centred silhouette.",
              adaptation: "Introduce our own bottle clearly.",
            },
          ],
          camera: "Centred framing is visible; movement is not established.",
          pacing: "A tonal change is inferred between sampled stills.",
          colors: ["dark blue", "warm white"],
          direction: "Adapt the silhouette into an original bottle reveal.",
          uncertainties: ["No audio or precise cut timing was assessed."],
        },
      });
      const job = {
        id: analysis.jobId,
        requestId: body.requestId,
        status: "succeeded",
        plan: {
          id: analysis.jobId,
          request: body.request,
          model: body.model,
          depth: body.depth,
          effort: body.effort,
          refs: body.refs,
          role: "marketing",
          intent: "campaign",
          summary: analysis.result.summary,
          steps: [analysis.result.direction],
          applied: false,
          referenceAdAnalysis: analysis,
        },
      };
      jobs.push(job);
      return json({ job });
    }
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/workbench/development")
      return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/pipelines")
      return json({
        runs: [],
        publications: [],
        models: [],
        audioModels: { speech: [], sound: "", music: "" },
      });
    if (path === "/api/atomik")
      return json({
        chats: [],
        models: { featured: [], rest: [] },
        engines: [],
      });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/engines")
      return json({ engines: [], models: [], vendors: [] });
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${path}`);
      return json({ error: "No other mutation permitted." }, 409);
    }
    return json({});
  });
  await page.goto(
    await legacyShell(page, "/workbench?project=reference-analysis&suite=moleculr&page=variants"),
  );
  const panel = page.getByRole("region", { name: "Reference ad", exact: true });
  await expect(
    panel.getByRole("button", { name: "Analyze reference ad", exact: true }),
  ).toBeEnabled();
  expect(paid).toEqual([]);
  await panel
    .getByRole("button", { name: "Analyze reference ad", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Analyze reference ad",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Run · 7 cr estimated", exact: true }),
  ).toBeEnabled();
  expect(frames).toHaveLength(12);
  expect(paid).toEqual([]);
  await dialog
    .getByRole("button", { name: "Atomik request model", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Claude Sonnet 4.6", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "Atomik request effort", exact: true })
    .click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await dialog
    .getByLabel("Atomik request depth", { exact: true })
    .selectOption("Quick");
  await expect(
    dialog.getByRole("button", { name: "Run · 7 cr estimated", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Run · 7 cr estimated", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const review = panel.getByRole("region", {
    name: "Reference ad analysis",
    exact: true,
  });
  await expect(review).toBeVisible();
  expect(paid).toHaveLength(1);
  expect(frames).toHaveLength(12);
  await expect(
    panel.getByLabel("Reference ad matching direction", { exact: true }),
  ).toHaveValue("Keep the current direction until review.");
  await expect(review).toContainText("virality have not been assessed");
  await review
    .getByLabel("Reviewed reference matching direction", { exact: true })
    .fill("My reviewed original product reveal.");
  await review
    .getByRole("button", { name: "Apply matching direction", exact: true })
    .click();
  await expect
    .poll(() => project.moleculr?.referenceAd?.direction)
    .toBe("My reviewed original product reveal.");
  expect(project.moleculr?.referenceAd?.notes).toBe("My observation stays.");
  expect(project.assets[0]).toMatchObject({
    id: asset.id,
    uploadId: asset.uploadId,
    url: asset.url,
  });
  expect(project.moleculr?.referenceAd?.analysis?.evidence.source).toEqual(
    paid[0].referenceAd,
  );
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("reviewed-reference-analysis.png"),
  });
  await page.reload();
  await expect(
    panel.getByLabel("Reference ad matching direction", { exact: true }),
  ).toHaveValue("My reviewed original product reveal.");
  await panel
    .getByLabel("Reference ad video", { exact: true })
    .selectOption("other-ad");
  await expect(review).not.toBeVisible();
  expect(paid).toHaveLength(1);
  expect(quotes.length).toBeGreaterThan(0);
  expect(mutations).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
