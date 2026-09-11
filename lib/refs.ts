/**
 * A reference handed to an engine (design/particl-v2/README.md §10: the
 * composer's reference well). The upload is the workspace's; the role is
 * what the engine is told to do with it.
 */
export type ImageRole = "first_frame" | "last_frame" | "reference_image" | "reference_video";

export type RefItem = {
  id: string; filename: string; mime: string; kind: "image" | "video";
  bytes: number; width: number | null; height: number | null;
  durationS: number | null;
  sha256: string; url: string; base64Bytes: number;
  role: ImageRole; verified: boolean;
};

export const ROLE_LABEL: Record<ImageRole, string> = {
  first_frame: "FIRST", last_frame: "LAST", reference_image: "REF", reference_video: "REF",
};
