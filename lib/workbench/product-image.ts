import sharp, { type Metadata } from "sharp";
import { createHash } from "node:crypto";
import { identifyImage } from "../imagemeta";
import { withRecoveryActivity } from "../recovery";
import {
  fetchPublicProductImageBytes,
  PRODUCT_IMAGE_BYTES,
  ProductExtractionError,
} from "./product-fetch";

export const PRODUCT_IMAGE_PIXELS = 40_000_000;
const formats = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "heif",
} as const;
function invalidImage() {
  return new ProductExtractionError(
    "This response is not a supported, readable JPEG, PNG, WebP or AVIF still image.",
    422,
    "invalid_image",
  );
}
function animatedImage() {
  return new ProductExtractionError(
    "Choose a still original. Animated or multi-page images cannot be imported here.",
    422,
    "animated_image",
  );
}

/** Inspection only: the supplied master is never resized, re-encoded or replaced. */
export async function validateProductImage(
  bytes: Buffer,
  declaredMime: string,
) {
  if (!bytes.length || bytes.length > PRODUCT_IMAGE_BYTES)
    throw new ProductExtractionError(
      "Choose an original image no larger than 10 MB.",
      413,
      "image_too_large",
    );
  const identified = identifyImage(bytes);
  if (
    !identified ||
    identified.kind !== "image" ||
    !(declaredMime in formats) ||
    identified.mime !== declaredMime
  )
    throw invalidImage();
  if (
    declaredMime === "image/png" &&
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw invalidImage();
  // Some PNG decoders inspect only APNG's first frame. Refuse its animation
  // control chunk before metadata so uninspected frames cannot bypass the cap.
  if (declaredMime === "image/png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (size > bytes.length - offset - 12) throw invalidImage();
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") {
        if (size !== 8 || !bytes.readUInt32BE(offset + 8)) throw invalidImage();
        if (bytes.readUInt32BE(offset + 8) > 1) throw animatedImage();
      }
      offset += size + 12;
    }
  }
  if (
    declaredMime === "image/jpeg" &&
    !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  )
    throw invalidImage();
  if (
    identified.width &&
    identified.height &&
    identified.width * identified.height > PRODUCT_IMAGE_PIXELS
  )
    throw new ProductExtractionError(
      "Choose an image with no more than 40 million pixels.",
      422,
      "image_dimensions",
    );
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      limitInputPixels: PRODUCT_IMAGE_PIXELS,
      failOn: "error",
      animated: true,
    })
      .timeout({ seconds: 5 })
      .metadata();
  } catch {
    throw invalidImage();
  }
  const { width, height } = metadata;
  if (
    metadata.format !== formats[declaredMime as keyof typeof formats] ||
    (declaredMime === "image/avif" && metadata.compression !== "av1")
  )
    throw invalidImage();
  if ((metadata.pages ?? 1) > 1) throw animatedImage();
  if (
    !width ||
    !height ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width * height > PRODUCT_IMAGE_PIXELS
  )
    throw new ProductExtractionError(
      "Choose an image with no more than 40 million pixels.",
      422,
      "image_dimensions",
    );
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return {
    bytes,
    mime: identified.mime,
    filename: `product-original-${digest}.${identified.ext}`,
    width,
    height,
  };
}

/** No storage write occurs. The client explicitly passes the original through
 * the normal captured-scope upload, quota reservation and intake workflow. */
export async function downloadProductImage(url: string) {
  return withRecoveryActivity("external-read", async () => {
    const downloaded = await fetchPublicProductImageBytes(url);
    return validateProductImage(downloaded.bytes, downloaded.mime);
  });
}
