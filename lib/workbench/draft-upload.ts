import type { Asset } from "./studio";
import { uploadWorkbench } from "./upload";

/**
 * Uploading device files onto the open draft with a category.
 *
 * Lifted out of Studio's `uploadFiles` so every host — Studio's hidden file
 * input and the workspace's Marketing picker — stores bytes through the same
 * chunked upload client and files the same shaped draft asset. The category is
 * what the campaign brief cites ("Product", "Brand", "Character"), so it is
 * never guessed here: a caller states it.
 */

export const DRAFT_UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,text/plain";

/** The draft asset one stored upload becomes. */
export function draftUploadAsset(
  file: File,
  stored: { id: string; url: string; durationS?: number | null },
  category: string,
): Asset {
  return {
    id: stored.id,
    uploadId: stored.id,
    ...(typeof stored.durationS === "number" && stored.durationS > 0 ? { seconds: stored.durationS } : {}),
    name: file.name,
    kind: file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
          ? "audio"
          : "document",
    category,
    url: stored.url,
    mime: file.type,
    description: "Uploaded from device",
    prompt: "",
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  };
}

/**
 * Store every file and return the draft assets, reporting each failure through
 * `onError` and continuing — one bad file never loses the rest, as Studio's
 * loop has always done.
 */
export async function uploadDraftFiles(
  files: File[],
  options: { scope: string; category: string; onError: (message: string) => void },
): Promise<Asset[]> {
  const received: Asset[] = [];
  for (const file of files) {
    try {
      received.push(draftUploadAsset(file, await uploadWorkbench(file, undefined, options.scope), options.category));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Upload failed");
    }
  }
  return received;
}
