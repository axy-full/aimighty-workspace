import { db } from "./db";
import type { Reference } from "./ark";
import { readImageBytes, readUploadBytes } from "./storage";
import { topazImageOutput, type TopazImageSettings } from "./topaz";

/** Resolve the tenant-owned ORIGINAL. Delivery JPEGs must never become upscale masters. */
export async function inspectTopazImage(
  source: Reference,
  settings: TopazImageSettings,
) {
  const row = (
    await db().execute({
      sql: source.fromGeneration
        ? "SELECT bytes FROM generations WHERE id=? AND deleted=0 AND status='succeeded' AND kind='image' AND stored_url IS NOT NULL"
        : "SELECT bytes FROM uploads WHERE id=? AND kind='image'",
      args: [source.id],
    })
  ).rows[0];
  if (!row)
    throw new Error(
      "The source image is no longer available in this workspace.",
    );
  if (!(Number(row.bytes) > 0) || Number(row.bytes) > 30 * 1024 * 1024)
    throw new Error("Use an original image up to 30 MB for upscaling.");
  const bytes = source.fromGeneration
    ? await readImageBytes(source.id)
    : await readUploadBytes(source.id, source.ext, source.storedUrl);
  if (bytes.length > 30 * 1024 * 1024)
    throw new Error("Use an original image up to 30 MB for upscaling.");
  const sharp = (await import("sharp")).default;
  const meta = await sharp(bytes, { limitInputPixels: 48_000_000 }).metadata();
  if (
    !meta.width ||
    !meta.height ||
    !["png", "jpeg", "webp"].includes(meta.format ?? "") ||
    (meta.pages ?? 1) !== 1
  )
    throw new Error(
      "Upscaling accepts one PNG, JPEG or WebP image. Export an individual frame from animated media.",
    );
  if (meta.hasAlpha)
    throw new Error(
      "Flatten transparency before using the precision upscale models.",
    );
  // EXIF orientation exchanges axes but does not change the quoted pixel count.
  const rotated = [5, 6, 7, 8].includes(meta.orientation ?? 1);
  return topazImageOutput(
    rotated ? meta.height : meta.width,
    rotated ? meta.width : meta.height,
    settings.factor,
  );
}
