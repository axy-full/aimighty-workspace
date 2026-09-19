import type { Reference } from "./ark";
import { GENJUTSU_LIMITS, GENJUTSU_RESOLUTIONS, genjutsuVariantForModel } from "./genjutsuTypes";
import { HiggsfieldHttpError, higgsfieldCredentials } from "./higgsfield";
import { marketingJson, MarketingError } from "./higgsfieldMarketing";
import { engineMock } from "./mock";
import { withRecoveryActivity } from "./recovery";
import { imagePath, videoPath, uploadPath, usingBlob, presignedReadUrl } from "./storage";

export function genjutsuPath(model: string): string {
  const variant = genjutsuVariantForModel(model);
  if (!variant) throw new HiggsfieldHttpError(422, "Choose a supported transform operation.");
  // The spelling is the provider's published API identifier.
  return `higgsfiled/genjutsu/${variant}/v1.0`;
}

export function genjutsuSourceProblem(seconds: number): string | null {
  return !Number.isFinite(seconds) || seconds < GENJUTSU_LIMITS.minSeconds || seconds > GENJUTSU_LIMITS.maxSeconds
    ? "Transform needs an original video between 1 and 30 seconds." : null;
}

/** Only authorized, retained originals reach this helper; never accept client URLs. */
export async function genjutsuInput(model: string, prompt: string, resolution: string, source: Reference | null, images: Reference[]) {
  genjutsuPath(model);
  if (typeof prompt !== "string" || prompt.length > GENJUTSU_LIMITS.maxPromptChars || !GENJUTSU_RESOLUTIONS.includes(resolution as "480p" | "720p") ||
      !source || source.kind !== "video" || images.length > GENJUTSU_LIMITS.maxImages || images.some(r => r.kind !== "image" || r.role !== "reference_image"))
    throw new HiggsfieldHttpError(422, "Choose one original video, up to eight still references, and 480p or 720p output.");
  const refs = [source, ...images];
  if (refs.some(r => !/^[A-Za-z0-9_-]{1,160}$/.test(r.id) || !/^[A-Za-z0-9]+$/.test(r.ext)))
    throw new HiggsfieldHttpError(422, "A transform source identity is invalid.");
  if (!engineMock() && !usingBlob()) throw new HiggsfieldHttpError(422, "Transform requires deployed private media storage for original references.");
  const urls = await Promise.all(refs.map(r => {
    const path = r.fromGeneration ? (r.kind === "video" ? videoPath(r.id) : imagePath(r.id)) : uploadPath(r.id, r.ext);
    return engineMock() ? `https://fixtures.particl.invalid/${path}` : presignedReadUrl(path);
  }));
  return { prompt, video_url: urls[0], image_urls: urls.slice(1), resolution: resolution as "480p" | "720p" };
}

/** Official non-generating estimate API. A missing/invalid price never falls back to a list-rate guess. */
export async function estimateGenjutsuInput(model: string, input: Awaited<ReturnType<typeof genjutsuInput>>): Promise<number> {
  const endpoint = `https://api.higgsfield.ai/estimate/${genjutsuPath(model)}`;
  if (engineMock()) return 0.75; // Synthetic fixture price only.
  return withRecoveryActivity("external-read", async () => {
    const { keyId, keySecret } = higgsfieldCredentials();
    try {
      const response = await fetch(endpoint, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Key ${keyId}:${keySecret}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("quote unavailable"); }
      const result = await marketingJson(response);
      const usd = typeof result.usd === "string" && /^\d+(?:\.\d+)?$/.test(result.usd) ? Number(result.usd) : NaN;
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("price unavailable");
      return usd;
    } catch {
      throw new MarketingError("A live transform price could not be verified. Nothing was submitted. Try a fresh quote.", 503, "price_unavailable");
    }
  });
}

export const genjutsuPreflightError = () => new HiggsfieldHttpError(422,
  "The transform source, connection or live price changed or could not be verified. Nothing was submitted; review a fresh quote.");
