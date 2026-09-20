import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { inspectOriginalVideo } from "../videoMetadata.server";
import { REFERENCE_AD_FRAMES, REFERENCE_AD_SECONDS, referenceAdFrameTimes, assertReferenceAnalysisSource, type ReferenceAnalysisSource } from "./reference-ad-analysis";
import { db } from "../db";
import { readImageBytes, readUploadBytes } from "../storage";
import { findWorkbenchMedia } from "./media-records";
import type { Asset, Project } from "./studio";
import { mediaReferenceIdentity } from "./media-reference-input";
import { generatedReferenceSeconds } from "../referenceDuration";
import {
  ATOMIK_IMAGE_EDGE,
  ATOMIK_IMAGE_TOKENS,
  ATOMIK_MAX_VISUALS,
  type AtomikVideoFrame,
} from "./atomik-reference-types";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_VISUAL_BYTES = 256 * 1024;
const SAMPLES = new Set([
  "/campaign/hero.webp",
  "/campaign/character.webp",
  "/campaign/environment.webp",
]);
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/heic",
  "image/heif",
]);
export class AtomikReferenceError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = "AtomikReferenceError";
  }
}
export type AtomikVisual = {
  assetId: string;
  name: string;
  dataUrl: string;
  sha256: string;
  width: number;
  height: number;
  timeSeconds?: number;
  firstFrameOnly: boolean;
};
export type AtomikReferenceContent = {
  text: Record<string, string>;
  images: AtomikVisual[];
  inputTokens: number;
  durationSeconds?: number;
};
export type AtomikReferenceReaders = {
  image: typeof readImageBytes;
  upload: typeof readUploadBytes;
  sample: (url: string) => Promise<Buffer>;
  inspectVideo: typeof inspectOriginalVideo;
};
const defaultReaders: AtomikReferenceReaders = {
  image: readImageBytes,
  upload: readUploadBytes,
  sample: (url) => readFile(path.join(process.cwd(), "public", url.slice(1))),
  inspectVideo: inspectOriginalVideo,
};

export function selectedAtomikAssets(project: Project, refs: string[]) {
  const all = [...project.assets, ...(project.sharedAssets ?? [])];
  if (new Set(refs).size !== refs.length)
    throw new AtomikReferenceError("Select each reference only once.");
  return refs.map((id) => {
    const asset = all.find((a) => a.id === id);
    if (!asset)
      throw new AtomikReferenceError(
        "A selected reference is no longer part of this project. Refresh your references.",
      );
    return asset;
  });
}

/** IDs are looked up in the active tenant before any storage read. Private legacy
 * media additionally requires its uploader or an uploader-published bible. */
async function sourceFor(asset: Asset, owner: string, canonical = false) {
  const identity = canonical ? mediaReferenceIdentity(asset) : null;
  const uploadId = identity ? ("uploadId" in identity ? identity.uploadId : undefined) : asset.uploadId || asset.url.match(/^\/api\/uploads\/([\w-]+)$/)?.[1];
  const generationId = identity ? ("genId" in identity ? identity.genId : undefined) : asset.generationId || asset.url.match(/^\/api\/media\/([\w-]+)$/)?.[1];
  const legacyId = asset.url.match(/^\/api\/workbench\/media\/([\w-]+)$/)?.[1];
  if (uploadId) {
    const row = (
      await db().execute({
        sql: "SELECT id,mime,ext,bytes AS size,stored_url,kind,duration_s FROM uploads WHERE id=?",
        args: [uploadId],
      })
    ).rows[0];
    if (!row)
      throw new AtomikReferenceError(
        "A selected upload is unavailable in this workspace.",
        404,
      );
    return { type: "upload" as const, ...row };
  }
  if (generationId) {
    const row = (
      await db().execute({
        sql: "SELECT id,kind,bytes AS size,stored_url,duration_s,params FROM generations WHERE id=? AND deleted=0 AND status='succeeded'",
        args: [generationId],
      })
    ).rows[0];
    if (!row)
      throw new AtomikReferenceError(
        "A selected take is unavailable in this workspace.",
        404,
      );
    const { params, ...stored } = row;
    return {
      type: "generation" as const,
      mime: row.kind === "image" ? "image/png" : "video/mp4",
      ext: row.kind === "image" ? "png" : "mp4",
      ...stored,
      kind: String(row.kind),
      /* A take's length is the measured column when one was written, and otherwise
       * the duration it was rendered at, which the saved params keep. Without this
       * the frame-bounds guard below never fired for a generated clip. */
      duration_s:
        row.duration_s == null
          ? generatedReferenceSeconds(params)
          : Number(row.duration_s),
    };
  }
  if (legacyId) {
    const row = await findWorkbenchMedia(legacyId, owner);
    if (!row)
      throw new AtomikReferenceError(
        "A selected private upload is unavailable to this account.",
        404,
      );
    return {
      type: "upload" as const,
      duration_s: null as number | null,
      ...row,
      kind: String(row.mime).startsWith("video/")
        ? "video"
        : String(row.mime).startsWith("image/")
          ? "image"
          : "file",
    };
  }
  if (SAMPLES.has(asset.url) && asset.kind === "image")
    return {
      type: "sample" as const,
      id: asset.url,
      mime: "image/webp",
      kind: "image",
      size: 0,
      ext: "webp",
      stored_url: "",
      duration_s: null,
    };
  if (asset.kind === "image" || asset.kind === "video")
    throw new AtomikReferenceError(
      "Upload " +
        asset.name +
        " into this workspace before using it as a visual reference.",
    );
  return null;
}

export async function assertAtomikVideoSource(
  project: Project,
  assetId: string,
  owner: string,
) {
  const asset = selectedAtomikAssets(project, [assetId])[0];
  const source = await sourceFor(asset, owner, true);
  if (asset.kind !== "video" || !source || source.kind !== "video")
    throw new AtomikReferenceError("Choose a saved video from this workspace.");
  return { asset, source };
}

async function normalize(
  bytes: Buffer,
  asset: Asset,
  timeSeconds?: number,
): Promise<AtomikVisual> {
  if (bytes.length > MAX_SOURCE_BYTES)
    throw new AtomikReferenceError(
      "Use visual references under 32 MB, or upload a smaller review copy.",
    );
  try {
    const decoder = sharp(bytes, { limitInputPixels: 64_000_000, pages: 1 });
    const metadata = await decoder.metadata();
    if (
      !metadata.format ||
      !["jpeg", "png", "webp", "gif", "tiff", "heif"].includes(metadata.format)
    )
      throw new Error("Unsupported raster");
    const { data, info } = await decoder
      .rotate()
      .resize(ATOMIK_IMAGE_EDGE, ATOMIK_IMAGE_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_VISUAL_BYTES) throw new Error("Large review copy");
    return {
      assetId: asset.id,
      name: asset.name,
      dataUrl: "data:image/jpeg;base64," + data.toString("base64"),
      sha256: createHash("sha256").update(data).digest("hex"),
      width: info.width,
      height: info.height,
      timeSeconds,
      firstFrameOnly: (metadata.pages ?? 1) > 1,
    };
  } catch {
    throw new AtomikReferenceError(
      "A selected image could not be decoded safely. Upload a PNG, JPEG or WebP review copy.",
    );
  }
}

/** This runs during the free quote and again before the durable paid claim.
 * It never follows user URLs or asks the model to fetch private media. */
export async function loadAtomikReferences(
  project: Project,
  refs: string[],
  owner: string,
  videoFrames: AtomikVideoFrame[] = [],
  overrides: Partial<AtomikReferenceReaders> = {},
  referenceAd?: ReferenceAnalysisSource,
): Promise<AtomikReferenceContent> {
  const readers = { ...defaultReaders, ...overrides };
  const assets = selectedAtomikAssets(project, refs);
  const imageCount =
    assets.filter((a) => a.kind === "image").length + videoFrames.length;
  if (referenceAd) {
    assertReferenceAnalysisSource(project, referenceAd);
    if (assets.length !== 1 || assets[0].id !== referenceAd.assetId || assets[0].kind !== "video")
      throw new AtomikReferenceError("Reference-ad analysis uses exactly one original project video.");
  }
  if (imageCount > (referenceAd ? REFERENCE_AD_FRAMES : ATOMIK_MAX_VISUALS))
    throw new AtomikReferenceError(
      "Use at most six images or sampled video frames per request. Each video uses three frames.",
    );
  if (
    videoFrames.some(
      (frame) =>
        !assets.some((a) => a.id === frame.assetId && a.kind === "video"),
    )
  )
    throw new AtomikReferenceError(
      "Video frames must belong to a selected video reference.",
    );
  if (new Set(videoFrames.map((f) => f.uploadId)).size !== videoFrames.length)
    throw new AtomikReferenceError(
      "A video frame was attached more than once.",
    );
  const result: AtomikReferenceContent = {
    text: {},
    images: [],
    inputTokens: 0,
  };
  for (const asset of assets) {
    const source = await sourceFor(asset, owner, !!referenceAd);
    if (!source) continue;
    if (asset.kind === "video") {
      if (source.kind !== "video")
        throw new AtomikReferenceError(
          "The selected video does not match its saved source.",
        );
      const frames = videoFrames
        .filter((frame) => frame.assetId === asset.id)
        .sort((a, b) => a.timeSeconds - b.timeSeconds);
      if (frames.length !== (referenceAd ? REFERENCE_AD_FRAMES : 3))
        throw new AtomikReferenceError(
          referenceAd ? "Prepare twelve stills from the original reference ad before requesting an estimate." : "Prepare three representative frames for each selected video before requesting an estimate.",
        );
      if (referenceAd) {
        const metadata = await readers.inspectVideo({ id: String(source.id), mime: String(source.mime), ext: String(source.ext), storedUrl: String(source.stored_url), kind: "video", role: "reference_video", fromGeneration: source.type === "generation" }, Number(source.size));
        if (metadata.seconds > REFERENCE_AD_SECONDS) throw new AtomikReferenceError("Reference-ad analysis supports videos up to 60 seconds.");
        const expected = referenceAdFrameTimes(metadata.seconds);
        if (frames.some((frame, index) => !Number.isFinite(frame.durationSeconds) || Math.abs(frame.durationSeconds! - metadata.seconds) > 0.15 || Math.abs(frame.timeSeconds - expected[index]) > 0.15))
          throw new AtomikReferenceError("The sampled times do not match this original. Prepare its review frames again.");
        result.durationSeconds = metadata.seconds;
      }
      /* One known length per source, whichever kind it is: a sampled time past the
       * end is refused for an upload and for a take alike. Unknown stays unbounded,
       * held only by the absolute ceiling below. */
      const clipSeconds = Number(source.duration_s);
      const knownSeconds =
        Number.isFinite(clipSeconds) && clipSeconds > 0 ? clipSeconds : null;
      for (const frame of frames) {
        if (
          !Number.isFinite(frame.timeSeconds) ||
          frame.timeSeconds < 0 ||
          frame.timeSeconds > 3600 ||
          (knownSeconds !== null && frame.timeSeconds > knownSeconds)
        )
          throw new AtomikReferenceError(
            "A sampled frame is outside the selected video.",
          );
        const row = (
          await db().execute({
            sql: "SELECT id,mime,ext,bytes AS size,stored_url FROM uploads WHERE id=? AND kind='image'",
            args: [frame.uploadId],
          })
        ).rows[0];
        if (!row)
          throw new AtomikReferenceError(
            "A sampled frame is unavailable in this workspace.",
            404,
          );
        if (
          !IMAGE_MIMES.has(String(row.mime)) ||
          Number(row.size) > MAX_SOURCE_BYTES
        )
          throw new AtomikReferenceError(
            "Use a supported image under 32 MB for each video frame.",
          );
        result.images.push(
          await normalize(
            await readers.upload(
              String(row.id),
              String(row.ext),
              String(row.stored_url),
            ),
            asset,
            frame.timeSeconds,
          ),
        );
      }
    } else if (asset.kind === "image") {
      if (
        !IMAGE_MIMES.has(String(source.mime)) ||
        Number(source.size) > MAX_SOURCE_BYTES
      )
        throw new AtomikReferenceError(
          "Use supported image references under 32 MB.",
        );
      const bytes =
        source.type === "sample"
          ? await readers.sample(String(source.id))
          : source.type === "generation"
            ? await readers.image(String(source.id))
            : await readers.upload(
                String(source.id),
                String(source.ext),
                String(source.stored_url),
              );
      result.images.push(await normalize(bytes, asset));
    } else if (source.mime === "text/plain") {
      if (Number(source.size) > 100000)
        throw new AtomikReferenceError(
          "Use TXT references under 100 KB, or paste an excerpt into the screenplay.",
        );
      const bytes = await readers.upload(
        String(source.id),
        String(source.ext),
        String(source.stored_url),
      );
      if (bytes.length > 100000)
        throw new AtomikReferenceError("Use TXT references under 100 KB.");
      result.text[asset.id] = bytes.toString("utf8").slice(0, 6000);
    }
  }
  result.inputTokens = result.images.length * ATOMIK_IMAGE_TOKENS;
  return result;
}
