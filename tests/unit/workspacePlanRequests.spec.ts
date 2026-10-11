import { test, expect } from "@playwright/test";
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


/** A prepared variant: its node, its bound reference and its saved settings. */





/* ------------------------------------------------ the plans themselves */


test("Shorts' plan refuses whatever the form holds: no API-key engine makes a set of shorts", () => {
  const plans = withRequestGate(PLANS, () => new Set<RequestKey>(["shorts"]));
  const input = {
    source: { uploadId: "clip-1" },
    preset: { id: "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f", source: "cms" as const, name: "Bold Urban" },
    aspectRatio: "9:16" as const,
  };
  const reason = (request: PlanRequest) => (plans.shorts.runnable(ctx(request)) as { reason: string }).reason;
  for (const request of [{}, { shorts: input }, { shorts: { preset: input.preset, aspectRatio: "9:16" } }] as PlanRequest[])
    expect(reason(request)).toBe("Not runnable yet — no API-key engine makes a set of shorts.");
  /* Shorts owns its own reason, so the shared "Needs <page> data" never fires for it. */
  expect(missingRequest("shorts", new Set<RequestKey>())).toBeNull();
});

test("Motion Transfer and Object Swap run on the page's /api/generate bodies for the API-key engines, and need the page to publish them", () => {
  const body = (model: string) => [{ name: "Take 1", body: { task: "genjutsu", model, prompt: "recast", resolution: "720p" } }];
  const none = withRequestGate(PLANS, () => new Set<RequestKey>());
  expect(none.motion.runnable(ctx())).toEqual({ ok: false, reason: "Needs Motion Transfer data" });
  expect(none.swap.runnable(ctx())).toEqual({ ok: false, reason: "Needs Object Swap data" });
  const both = withRequestGate(PLANS, () => new Set<RequestKey>(["motion", "swap"]));
  expect(both.motion.runnable(ctx({ motion: body("higgsfield-genjutsu-motion-transfer") }))).toEqual({ ok: true });
  expect(both.swap.runnable(ctx({ swap: body("higgsfield-genjutsu-object-swap") }))).toEqual({ ok: true });
  expect((both.motion.runnable(ctx({ motion: [] })) as { reason: string }).reason).toMatch(/choose a source video on Motion Transfer first/);
});

