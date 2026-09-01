/**
 * R4 — the translation layer between our master and an API's limits.
 *
 * The rule that governs this file: **the master is never touched.** What
 * lands in storage is the bytes the browser sent, hashed on both sides and
 * proven identical. That guarantee is the reason the platform exists for a
 * team shooting commercial work.
 *
 * But a vendor with a 30 MB ceiling shouldn't be allowed to decide what we
 * can keep. So when a master is too big, too large in pixels, or too extreme
 * in aspect for the provider it's about to be sent to, we derive a SECOND
 * file for transmission only — stored alongside, labelled, and never
 * substituted for the original in the library, in a download, or in an
 * export. The master stays the master.
 *
 * `sharp` appears in this project for exactly this and nothing else. It must
 * never be pointed at an upload on its way into storage.
 */
import sharp from "sharp";
import type { ProviderDef } from "@/lib/providers";
import type { ImageMeta } from "@/lib/imagemeta";

export type Assessment = {
  /** Can the master go to this provider untouched? */
  ok: boolean;
  /** Why not — in the words we'd say to a producer. */
  reasons: string[];
  /** Can we fix it by deriving a copy, or does it need a different asset? */
  derivable: boolean;
};

export function assess(
  meta: Pick<ImageMeta, "width" | "height">, bytes: number, p: ProviderDef
): Assessment {
  const L = p.limits;
  const reasons: string[] = [];
  let derivable = true;

  if (bytes > L.maxImageBytes) {
    reasons.push(`${(bytes / 1048576).toFixed(1)} MB is over ${p.label}'s ${(L.maxImageBytes / 1048576).toFixed(0)} MB ceiling`);
  }
  const { width: w, height: h } = meta;
  if (w != null && h != null) {
    if (w > L.maxImagePx || h > L.maxImagePx) {
      reasons.push(`${w}×${h} is over the ${L.maxImagePx}px maximum`);
    }
    if (w < L.minImagePx || h < L.minImagePx) {
      // Upscaling invents detail. Better to say so than to quietly fake it.
      reasons.push(`${w}×${h} is under the ${L.minImagePx}px minimum`);
      derivable = false;
    }
    const ratio = w / h;
    if (ratio < L.minAspect || ratio > L.maxAspect) {
      reasons.push(`aspect ${ratio.toFixed(2)} is outside ${L.minAspect}–${L.maxAspect}`);
    }
  }
  return { ok: reasons.length === 0, reasons, derivable: derivable && reasons.length > 0 };
}

export type Derived = {
  bytes: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
  /** Plain-English record of what was done, stored with the file. */
  note: string;
};

/**
 * Produce a copy that fits the provider, changing as little as possible and
 * in this order: bring the pixels inside the ceiling, pad the aspect into
 * range (padding rather than cropping — losing frame is a creative decision,
 * not one a file-size limit gets to make), then step quality down only as far
 * as the byte ceiling demands.
 */
export async function deriveForProvider(
  master: Buffer, p: ProviderDef
): Promise<Derived> {
  const L = p.limits;
  const img = sharp(master, { failOn: "none" });
  const meta = await img.metadata();
  let w = meta.width ?? 0;
  let h = meta.height ?? 0;
  if (!w || !h) throw new Error("Could not read the master's dimensions.");

  const steps: string[] = [];
  let pipeline = sharp(master, { failOn: "none" }).rotate(); // honour EXIF orientation

  // 1 — pixel ceiling
  if (w > L.maxImagePx || h > L.maxImagePx) {
    const scale = Math.min(L.maxImagePx / w, L.maxImagePx / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    pipeline = pipeline.resize(w, h, { fit: "inside" });
    steps.push(`scaled to ${w}×${h}`);
  }

  // 2 — aspect, by padding
  const ratio = w / h;
  if (ratio > L.maxAspect || ratio < L.minAspect) {
    const target = ratio > L.maxAspect ? L.maxAspect : L.minAspect;
    let tw = w, th = h;
    if (ratio > L.maxAspect) th = Math.round(w / target);   // too wide → taller canvas
    else tw = Math.round(h * target);                        // too tall → wider canvas
    tw = Math.min(tw, L.maxImagePx); th = Math.min(th, L.maxImagePx);
    pipeline = pipeline.resize(tw, th, {
      fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 },
    });
    steps.push(`padded to ${tw}×${th} to reach aspect ${target}`);
    w = tw; h = th;
  }

  // 3 — byte ceiling, quality last
  let quality = 95;
  let out = await pipeline.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  while (out.length > L.maxImageBytes && quality > 40) {
    quality -= 10;
    out = await pipeline.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (out.length > L.maxImageBytes) {
    // Quality alone wasn't enough — take the pixels down and try once more.
    const scale = Math.sqrt(L.maxImageBytes / out.length) * 0.95;
    w = Math.max(L.minImagePx, Math.round(w * scale));
    h = Math.max(L.minImagePx, Math.round(h * scale));
    out = await pipeline.clone().resize(w, h, { fit: "inside" })
      .jpeg({ quality, mozjpeg: true }).toBuffer();
    steps.push(`scaled again to ${w}×${h}`);
  }
  if (quality < 95) steps.push(`JPEG quality ${quality}`);
  if (out.length > L.maxImageBytes) {
    throw new Error(
      `Could not bring this asset under ${p.label}'s ${(L.maxImageBytes / 1048576).toFixed(0)} MB limit. ` +
      `The master is untouched — send a smaller crop instead.`);
  }

  return {
    bytes: out, mime: "image/jpeg", ext: "jpg", width: w, height: h,
    note: steps.length
      ? `Delivery copy for ${p.label}: ${steps.join(", ")}. Master untouched.`
      : `Delivery copy for ${p.label}. Master untouched.`,
  };
}
