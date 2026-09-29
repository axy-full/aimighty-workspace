import { createHash } from "node:crypto";
import { HiggsfieldHttpError, higgsfieldCredentials } from "./higgsfield";
import { marketingJson } from "./higgsfieldMarketing";
import { withRecoveryActivity } from "./recovery";
import { engineMock } from "./mock";
import {
  SOUL_RENDER_RATIOS,
  SOUL_RENDER_RESOLUTIONS,
  isSoulRenderBatch,
  soulVersionOf,
  type SoulRenderBatch,
  type SoulVersion,
} from "./soulRenderTypes";

/**
 * Soul Standard, Soul 2 and Soul Cinema with a trained identity, on the
 * platform's API key (docs.higgsfield.ai › models › soul-standard, soul-2,
 * soul-cinema). The identity's `custom_reference_id` must belong to the
 * calling account and have finished training; Particl resolves it on the
 * server from the workspace's own identity and never takes it from a browser.
 * Every request is priced first by the provider's free estimate of the same
 * body; a request with no numeric estimate is refused, never sent.
 */
export const SOUL_RENDER_ORIGIN = "https://api.higgsfield.ai";
export const SOUL_RENDER_PATHS: Readonly<Record<SoulVersion, string>> = {
  v1: "higgsfield-ai/soul/standard",
  v2: "higgsfield-ai/soul/v2/standard",
  cinema: "higgsfield-ai/soul/cinema",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Synthetic mock-mode price for one still. A fixture for the billing pipeline, never a live fallback. */
const MOCK_STILL_USD = 0.25;

export class SoulRenderError extends Error {
  constructor(
    message: string,
    public readonly status = 503,
    public readonly code = "provider_unavailable",
  ) {
    super(message);
    this.name = "SoulRenderError";
  }
}

export type SoulRenderSettings = {
  prompt: string;
  /** The provider's id for the trained identity, resolved by admission. */
  referenceId: string;
  strength: number;
  batch: number;
  resolution: string;
  ratio: string;
};
export type SoulRenderInput = {
  prompt: string;
  custom_reference_id: string;
  custom_reference_strength: number;
  batch_size: SoulRenderBatch;
  resolution: string;
  aspect_ratio: string;
  enhance_prompt: false;
};

/** The documented request body for one family. Throws before anything is priced or sent when a setting is outside it. */
export function soulRenderInput(modelId: string, settings: SoulRenderSettings): SoulRenderInput {
  if (!soulVersionOf(modelId))
    throw new SoulRenderError("Choose Soul Standard, Soul 2 or Soul Cinema.", 400, "invalid_model");
  if (typeof settings.prompt !== "string" || !settings.prompt.trim() || settings.prompt.length > 10_000)
    throw new SoulRenderError("A Soul render needs a prompt of up to 10,000 characters.", 400, "invalid_input");
  if (typeof settings.referenceId !== "string" || !UUID.test(settings.referenceId))
    throw new SoulRenderError("Choose a ready Soul ID for this render.", 400, "invalid_identity");
  /* Zero would drop the identity (Soul 2's page says to keep it above zero). */
  if (typeof settings.strength !== "number" || !Number.isFinite(settings.strength) || settings.strength <= 0 || settings.strength > 1)
    throw new SoulRenderError("Likeness strength is above 0 and at most 1.", 400, "invalid_input");
  if (!isSoulRenderBatch(settings.batch))
    throw new SoulRenderError("A Soul render makes 1 or 4 stills.", 400, "invalid_input");
  if (!(SOUL_RENDER_RESOLUTIONS as readonly string[]).includes(settings.resolution) ||
      !(SOUL_RENDER_RATIOS as readonly string[]).includes(settings.ratio))
    throw new SoulRenderError("Choose 720p or 1080p and a supported aspect ratio.", 400, "invalid_input");
  return {
    prompt: settings.prompt,
    custom_reference_id: settings.referenceId,
    custom_reference_strength: settings.strength,
    batch_size: settings.batch,
    resolution: settings.resolution,
    aspect_ratio: settings.ratio,
    // Particl's compiled prompt is sent as written (Soul Cinema enhances on its own when an identity is set).
    enhance_prompt: false,
  };
}

/* The estimate is a non-generating read: tracked as external activity, never as paid work. */
async function estimateCall(url: string, body: unknown): Promise<Record<string, unknown>> {
  return withRecoveryActivity("external-read", async () => {
    const { keyId, keySecret } = higgsfieldCredentials();
    try {
      const response = await fetch(url, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Key ${keyId}:${keySecret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        throw new SoulRenderError(
          status === 401 || status === 403 ? "The identity account cannot price this Soul render."
            : status === 429 ? "The identity account is rate limiting requests. Try again shortly."
            : [400, 404, 422].includes(status) ? "The identity account did not price this Soul render. Nothing was submitted."
            : "Soul pricing is unavailable right now. Try again.",
          status === 429 ? 429 : 503,
          status === 429 ? "rate_limited" : "price_unavailable",
        );
      }
      return await marketingJson(response);
    } catch (error) {
      if (error instanceof SoulRenderError) throw error;
      throw new SoulRenderError("Soul pricing could not be reached. Try again.", 503, "price_unavailable");
    }
  });
}

/** The provider's own price for exactly this request, in dollars. No positive number, no price: the render is refused. */
export async function estimateSoulRender(modelId: string, input: SoulRenderInput): Promise<number> {
  const version = soulVersionOf(modelId);
  if (!version) throw new SoulRenderError("Choose Soul Standard, Soul 2 or Soul Cinema.", 400, "invalid_model");
  if (engineMock()) return MOCK_STILL_USD * input.batch_size;
  const result = await estimateCall(`${SOUL_RENDER_ORIGIN}/estimate/${SOUL_RENDER_PATHS[version]}`, input);
  const usd = typeof result.usd === "number" ? result.usd
    : typeof result.usd === "string" && /^\d+(?:\.\d+)?$/.test(result.usd) ? Number(result.usd) : NaN;
  if (!Number.isFinite(usd) || usd <= 0)
    throw new SoulRenderError("The identity account returned no price for this Soul render. Nothing was submitted.", 503, "price_unavailable");
  return usd;
}

/** A failed read-only preflight proves this worker sent no paid request. */
export const soulRenderPreflightError = () => new HiggsfieldHttpError(422,
  "The Soul render's identity, connection or price changed or could not be verified. Nothing was submitted; review a fresh quote.");

/**
 * What a finished render settles at. The provider's status reply states no
 * per-job charge today, so the live estimate it quoted for this exact request
 * stands. A charge it does state is used only between half and three times
 * that quote; outside the band a unit mistake is assumed and the quote stands.
 */
export function soulRenderSettlementUsd(quoteUsd: number, reportedUsd?: number | null): number {
  return typeof reportedUsd === "number" && Number.isFinite(reportedUsd) && reportedUsd >= quoteUsd * 0.5 && reportedUsd <= quoteUsd * 3
    ? reportedUsd : quoteUsd;
}

/** The stills a finished request delivered: at least one, never more than the batch asked for. */
export function soulRenderDelivered(urls: readonly string[], batch: number): string[] {
  if (!isSoulRenderBatch(batch) || !urls.length || urls.length > batch)
    throw new Error("The identity account returned an unexpected image count. The request remains available for collection.");
  return [...urls];
}

/** The take a batch's n-th still (2–4) is filed as: fixed by the request's own take, so collecting again files it once. */
export const soulBatchTakeId = (genId: string, n: number) => `${genId}-${n}`;
/** The batch strip a request's stills share (lib/variations.ts isBatchId), fixed by its first take. */
export const soulBatchId = (genId: string) => `b_${createHash("sha1").update(genId).digest("hex").slice(0, 16)}`;
