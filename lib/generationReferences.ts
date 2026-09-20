import type { ModelDef } from "./models";
import type { RefItem } from "./refs";

export const referenceKey = (ref: Pick<RefItem, "origin" | "id">) => `${ref.origin ?? "upload"}:${ref.id}`;

/** Selecting no first frame keeps the images as references; it never discards media. */
export function selectFirstFrame(refs: RefItem[], key: string | null): RefItem[] {
  if (key && !refs.some(ref => referenceKey(ref) === key && ref.kind === "image"))
    throw new Error("Choose an attached image as the first frame.");
  return refs.map(ref => ({ ...ref, role: referenceKey(ref) === key ? "first_frame" :
    ref.role === "first_frame" || (!key && ref.role === "last_frame") ? "reference_image" : ref.role }));
}

export function videoReferenceProblem(model: Pick<ModelDef, "kind" | "label" | "family" | "maxReferenceImages" | "maxReferenceVideos">,
  refs: { kind: string; role: string }[]): string | null {
  if (model.kind !== "video") return null;
  const first = refs.filter(ref => ref.role === "first_frame"), last = refs.filter(ref => ref.role === "last_frame");
  const images = refs.filter(ref => ref.role === "reference_image"), videos = refs.filter(ref => ref.kind === "video");
  if ([...first, ...last].some(ref => ref.kind !== "image")) return "First and last frames must be images.";
  if (first.length > 1 || last.length > 1) return "Choose only one first frame and one last frame.";
  if (last.length && !first.length) return "A last frame needs a first frame.";
  if ((first.length || last.length) && (images.length || videos.length))
    return "First/last frames and reference media cannot be mixed. Choose No first frame to use references, or remove the other references.";
  if (model.family === "kling-3" && images.length)
    return `${model.label} supports image frames, not ordinary image references. Choose Use as first frame, remove the image, or choose Seedance 2.5 for references.`;
  if (images.length > model.maxReferenceImages) return `${model.label} accepts at most ${model.maxReferenceImages} image references.`;
  if (videos.length > model.maxReferenceVideos) return `${model.label} accepts at most ${model.maxReferenceVideos} video references.`;
  return null;
}
