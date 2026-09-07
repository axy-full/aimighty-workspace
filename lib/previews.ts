import { CATEGORIES } from "./studio";
import { estimateCostUsd, getModel } from "./models";

/**
 * The bank's neutral previews (brief 1.4): one short looping clip per camera
 * move and technique, from one fixed scene, generated ONCE at platform level
 * — in an internal test workspace, with the price said first — and served
 * to every workspace. Never regenerated per workspace. This file is the
 * plan: what to render and what it costs. No Node imports; the console
 * prices the batch from here before anyone presses anything.
 */
export const PREVIEW_SCENE =
  "A small wooden rowing boat tied to a stone jetty on a calm lake at midday, soft overcast light, still water, no people, no text.";

export const PREVIEW_MODELS = ["dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"] as const;
export const PREVIEW_RESOLUTIONS = ["480p", "720p"] as const;
export const PREVIEW_DURATIONS = [3, 4, 5] as const;

export type PreviewItem = { key: string; kind: "move" | "technique"; value: string; label: string; prompt: string; shotSpec: Record<string, string> };

export const previewKey = (kind: string, value: string): string => `${kind}:${value}`;

/** Every move and technique in the bank, with the one scene and the pick that makes it that move. */
export function previewItems(): PreviewItem[] {
  return (["move", "technique"] as const).flatMap((kind) => {
    const cat = CATEGORIES.find((c) => c.key === kind)!;
    return cat.options.map((o) => ({ key: previewKey(kind, o.value), kind, value: o.value, label: o.label, prompt: PREVIEW_SCENE, shotSpec: { [kind]: o.value } }));
  });
}

export type PreviewPlan = { modelId: string; resolution: string; duration: number; items: PreviewItem[]; count: number; perClipUsd: number; totalUsd: number };

/** The length the engine will actually render: the shortest it supports that is not shorter than what was asked, else its longest. */
export function supportedDuration(modelId: string, duration: number): number {
  const list = [...(getModel(modelId).durations ?? [])].sort((a, b) => a - b);
  if (!list.length) return duration;
  return list.find((d) => d >= duration) ?? list[list.length - 1];
}

/** The batch, priced: the count times the catalogue's price for one clip, silent, 16:9, at the length the engine will really render. */
export function previewPlan(modelId: string, resolution: string, duration: number): PreviewPlan {
  const items = previewItems();
  const d = supportedDuration(modelId, duration);
  const perClipUsd = estimateCostUsd(modelId, resolution, "16:9", d, 0, false, { audio: false })?.net ?? 0;
  return { modelId, resolution, duration: d, items, count: items.length, perClipUsd, totalUsd: Math.round(perClipUsd * items.length * 100) / 100 };
}
