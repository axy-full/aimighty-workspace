import { CONSUMER_ORIGINAL_MIMES } from "./higgsfield-consumer/original-identity";

/**
 * What a take's stored original IS: which object it lives in, the type it is
 * served as and the extension a download carries. One answer for every route
 * that hands an original out (media, review links, the selects zip, the
 * takes export), so a 3D model is never read from the .mp4 key and a JPEG
 * still is never named .png.
 *
 * A connected-account original keeps the type the provider served (JPEG,
 * WAV, zip …); the server-written receipt in params is the only source of
 * that value, and only a type on the allowlist for the kind is believed.
 */
export type OriginalMediaKind = "video" | "image" | "audio" | "model";
export type OriginalMedia = { kind: OriginalMediaKind; contentType: string; ext: string };

export const originalKindOf = (kind: unknown): OriginalMediaKind =>
  kind === "image" ? "image" : kind === "audio" ? "audio" : kind === "model" ? "model" : "video";

function paramsOf(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object") return params as Record<string, unknown>;
  if (typeof params !== "string" || !params) return {};
  try {
    const parsed = JSON.parse(params);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const DEFAULT_TYPE: Record<OriginalMediaKind, string> = {
  image: "image/png", audio: "audio/mpeg", model: "model/gltf-binary", video: "video/mp4",
};
const DEFAULT_EXT: Record<OriginalMediaKind, string> = { image: "png", audio: "mp3", model: "glb", video: "mp4" };

function extFor(contentType: string, kind: OriginalMediaKind): string {
  if (contentType === "application/zip") return "zip";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  if (/wav/.test(contentType)) return "wav";
  if (contentType === "audio/ogg") return "ogg";
  if (contentType === "audio/flac") return "flac";
  if (contentType === "audio/mp4" || contentType === "audio/aac") return "m4a";
  return DEFAULT_EXT[kind];
}

/** A generation row's original: `kind` from the row, `params` as stored (JSON text or parsed). */
export function originalMediaOf(gen: { kind: unknown; params?: unknown }): OriginalMedia {
  const kind = originalKindOf(gen.kind);
  const declared = paramsOf(gen.params).consumerOriginalMime;
  const contentType = typeof declared === "string" && CONSUMER_ORIGINAL_MIMES[kind].includes(declared)
    ? declared : DEFAULT_TYPE[kind];
  return { kind, contentType, ext: extFor(contentType, kind) };
}
