import { test, expect } from "@playwright/test";
import { MARKETING_IMAGE_MODEL_ID } from "../../lib/models";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { moleculrNode } from "../../lib/workbench/moleculr";
import { marketingPlanRequests, marketingRequestGaps } from "../../lib/workspace/marketing-requests";
import { missingRequest, withRequestGate, type RequestKey } from "../../lib/workspace/plan-requests";
import { PLANS } from "../../lib/workspace/plans";
import type { PlanContext, PlanRequest } from "../../lib/workspace/plan-types";

/**
 * The three plans that had no page supplying their request bodies: Marketing
 * Studio and Shorts now have one, Boards still does not.
 *
 * Every assertion here is about what a page may publish, never about a
 * dispatch: nothing in this file calls a paid route.
 */

const fetcher = (() => {
  throw new Error("no request may leave a request builder");
}) as typeof fetch;

const ctx = (request: PlanRequest | null = null): PlanContext => ({
  projectId: "draft-1",
  productionId: "prod-1",
  data: {},
  request,
  fetch: fetcher,
});

/* ------------------------------------------------------------ Marketing */

const image = (id: string, extra: Partial<Asset> = {}): Asset => ({
  id,
  url: `/api/uploads/${id}`,
  uploadId: id,
  kind: "image",
  mime: "image/webp",
  name: id,
  category: "Product",
  description: "",
  prompt: "",
  status: "Draft",
  version: 1,
  locked: false,
  refs: [],
  ...extra,
});

/** A prepared variant: its node, its bound reference and its saved settings. */
function withVariant(options: {
  generation?: Record<string, unknown>;
  mapped?: boolean;
  references?: Asset[];
  kind?: "image" | "video";
}): Project {
  const kind = options.kind ?? "image";
  const node: CanvasNode = {
    ...moleculrNode("variant-1", "A plain bottle on a clean studio background.", "Bottle · Quiet mornings", 0, kind),
    linked: ["ref-node"],
  };
  const source: CanvasNode = { ...moleculrNode("ref-node", "", "Product reference", 1, "image"), assetId: "asset-1" };
  const references = options.references ?? [image("asset-1")];
  return {
    ...newProject("Coastal light study"),
    id: "draft-1",
    productionProjectId: "prod-1",
    ...(options.mapped === false ? {} : { shotMappings: { "variant-1": "shot-1" } }),
    assets: references,
    nodes: [source, node],
    moleculr: {
      productName: "Still Water",
      productUrl: "",
      productAssetIds: ["asset-1"],
      castAssetIds: [],
      format: "cinematic-demo",
      hooks: ["Quiet mornings"],
      notes: "",
      variants: [
        {
          id: "campaign-1",
          nodeId: "variant-1",
          hook: "Quiet mornings",
          kind,
          createdAt: "2026-09-19T10:00:00Z",
          ...(options.generation === undefined ? {} : { generation: options.generation }),
        },
      ],
    },
  } as Project;
}

const acceptedImage = {
  modelId: MARKETING_IMAGE_MODEL_ID,
  ratio: "1:1",
  resolution: "2k",
  marketing: { quality: "high" as const, enhancePrompt: false },
};
const acceptedVideo = { modelId: "dreamina-seedance-2-5-260628", ratio: "16:9", resolution: "720p", duration: 5 };

test("an accepted marketing variant publishes the body GenerationDialog sent for it", () => {
  const project = withVariant({ generation: acceptedImage });
  const requests = marketingPlanRequests(project);
  expect(requests).toHaveLength(1);
  expect(requests[0].name).toBe("Quiet mornings");
  /* The dialog's own body: an image engine has no duration, carries marketing
     options, and cites the bound reference by its saved upload id. */
  expect(requests[0].body).toEqual({
    prompt: "A plain bottle on a clean studio background.",
    model: MARKETING_IMAGE_MODEL_ID,
    projectId: "prod-1",
    shotId: "shot-1",
    ratio: "1:1",
    resolution: "2k",
    refine: false,
    references: [{ uploadId: "asset-1", role: "reference_image" }],
    marketing: { quality: "high", enhancePrompt: false },
    quoteFingerprint: undefined,
  });
  /* Never a price or an approval: the gate quotes and the dispatch adds both. */
  expect(requests[0].body.maxCredits).toBeUndefined();
  expect(marketingRequestGaps(project)).toEqual([]);
});

test("a video variant keeps its accepted length and first frame; the engine's own limits are honoured", () => {
  const ok = marketingPlanRequests(withVariant({ kind: "video", generation: acceptedVideo }));
  expect(ok).toHaveLength(1);
  expect(ok[0].body).toMatchObject({ model: "dreamina-seedance-2-5-260628", duration: 5, firstFrameAssetId: "" });
  /* A length the engine does not list is not silently clamped — the variant is left out. */
  const bad = withVariant({ kind: "video", generation: { ...acceptedVideo, duration: 3.5 } });
  expect(marketingPlanRequests(bad)).toEqual([]);
  expect(marketingRequestGaps(bad)).toEqual(["Quiet mornings: its length is not one this engine accepts."]);
});

test("a variant missing any dialog choice is left out and named, never completed with a guess", () => {
  /* Freshly prepared by prepareMoleculrVariants: an image engine and a ratio, no resolution. */
  const prepared = withVariant({ generation: { modelId: MARKETING_IMAGE_MODEL_ID, ratio: "1:1", marketing: acceptedImage.marketing } });
  expect(marketingPlanRequests(prepared)).toEqual([]);
  expect(marketingRequestGaps(prepared)).toEqual([
    "Quiet mornings: no resolution accepted yet — configure its generation in Marketing Studio once.",
  ]);

  /* Never configured at all: no engine. */
  const unconfigured = withVariant({});
  expect(marketingPlanRequests(unconfigured)).toEqual([]);
  expect(marketingRequestGaps(unconfigured)[0]).toContain("no engine accepted yet");

  /* No production mapping: the Rig maps a shot on its first Generate, which is a write. */
  const unmapped = withVariant({ generation: acceptedImage, mapped: false });
  expect(marketingPlanRequests(unmapped)).toEqual([]);
  expect(marketingRequestGaps(unmapped)).toEqual(["Quiet mornings: not mapped to a production shot yet."]);

  /* A reference that is not yet an upload or a generation would have to be uploaded first. */
  const local = withVariant({
    generation: acceptedImage,
    references: [image("asset-1", { url: "/campaign/local.webp", uploadId: undefined, generationId: undefined })],
  });
  expect(marketingPlanRequests(local)).toEqual([]);
  expect(marketingRequestGaps(local)).toEqual(["Quiet mornings: its references are not saved to this project yet."]);

  /* No project, or a project with no production, publishes nothing. */
  expect(marketingPlanRequests(null)).toEqual([]);
  expect(marketingPlanRequests({ ...withVariant({ generation: acceptedImage }), productionProjectId: undefined })).toEqual([]);
});

/* ------------------------------------------------ the plans themselves */

test("Marketing Studio's plan runs on the page's bodies and refuses without them", () => {
  let provided = new Set<RequestKey>();
  const plans = withRequestGate(PLANS, () => provided);
  expect(plans.marketing.runnable(ctx())).toEqual({ ok: false, reason: "Needs Marketing Studio data" });

  const variants = marketingPlanRequests(withVariant({ generation: acceptedImage }));
  provided = new Set<RequestKey>(["variants"]);
  /* Published but empty: the plan's own reason, not a run. */
  expect((plans.marketing.runnable(ctx({ variants: [] })) as { reason: string }).reason).toMatch(/configure the variant set/);
  expect(plans.marketing.runnable(ctx({ variants }))).toEqual({ ok: true });
  /* Without a project, "open a project first" outranks the page's data. */
  expect(plans.marketing.runnable({ ...ctx({ variants }), projectId: null }).ok).toBe(false);
});

test("Shorts' plan runs on the form's own input and refuses without a source or a style", () => {
  const plans = withRequestGate(PLANS, () => new Set<RequestKey>(["shorts"]));
  const input = {
    source: { uploadId: "clip-1" },
    preset: { id: "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f", source: "cms" as const, name: "Bold Urban" },
    aspectRatio: "9:16" as const,
  };
  expect(plans.shorts.runnable(ctx({ shorts: input }))).toEqual({ ok: true });
  const reason = (request: PlanRequest) => (plans.shorts.runnable(ctx(request)) as { reason: string }).reason;
  expect(reason({})).toMatch(/choose a source video and a style on Shorts first/);
  expect(reason({ shorts: { preset: input.preset, aspectRatio: "9:16" } })).toMatch(/choose a source video and a style/);
  expect(reason({ shorts: { source: input.source, aspectRatio: "9:16" } })).toMatch(/choose a source video and a style/);
  /* Shorts owns its own reason, so the shared "Needs <page> data" never fires for it. */
  expect(missingRequest("shorts", new Set<RequestKey>())).toBeNull();
});

test("Boards stays non-runnable: no page can supply a board generation body yet", () => {
  const plans = withRequestGate(PLANS, () => new Set<RequestKey>());
  expect(plans.boards.runnable(ctx())).toEqual({ ok: false, reason: "Needs Boards data" });
  /* A board frame carries no engine, ratio, resolution or prompt of its own
     (`Shot` in lib/workbench/studio.ts), and no surface in the product
     generates one, so nothing can publish `boards` without inventing them. */
  const frame = newProject("Coastal light study").shots[0];
  if (frame) expect(Object.keys(frame).sort()).toEqual(["assetId", "duration", "id", "name", "note", "sourceIn"]);
  expect(marketingPlanRequests(withVariant({ generation: acceptedImage })).length).toBeGreaterThan(0);
});
