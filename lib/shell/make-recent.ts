import { engineLabel } from "../workspace/engines";
import { audioSeconds, composerSettings, type ComposerModel } from "../workspace/composer";
import type { LibraryEntry } from "../workspace/library";
import { nodeAudioBody } from "../workbench/generation-audio";
import { mediaQuoteReferences } from "../workbench/media-reference-input";
import type { Asset } from "../workbench/studio";
import { DRAFT_RESOLUTION, FINAL_RESOLUTION } from "../draftFinal";
import { recreateBlock, recreatePreset } from "./recipe";

/**
 * Make › Recent (design/particl-graphite/README.md § 7: the takes wall is Make's Recent; the graphite Make frames (deleted in redesign C3; Make is now docs/redesign/inventory.md § 5.12) 4):
 * its filters, the line under a card's name, and what "Again" would cost. Pure; reads nothing from the
 * network, and prices nothing itself. The price of an Again is the server's: the same read the composer
 * makes for its live quote (GET /api/workbench/engines, or the audio route's quoteOnly), asked at the
 * take's own settings (`againAsk`, `askAgain`).
 */

/** Recent's chips, as the master draws them. */
export const RECENT_CHIPS = ["All", "Takes", "Unfiled", "Filed"] as const;
export type RecentChip = (typeof RECENT_CHIPS)[number];

/** What Recent reads of a library card: a take or an upload, and the shot a take is filed on. */
type RecentEntry = { take: { kind: "GEN" | "UPLOAD" }; asset: { origin: "generation" | "upload"; value: object } };
const shotOf = (entry: RecentEntry): string | null => {
  if (entry.asset.origin !== "generation") return null;
  const shot = (entry.asset.value as { shotId?: unknown }).shotId;
  return typeof shot === "string" && shot ? shot : null;
};

/**
 * The cards a chip shows, in the Library's order (newest first): All is every take and upload; Takes the
 * generations; Unfiled the takes on no shot; Filed the takes on a shot.
 */
export function recentEntries<T extends RecentEntry>(entries: readonly T[], chip: RecentChip): T[] {
  if (chip === "All") return [...entries];
  return entries.filter((entry) => {
    if (entry.take.kind !== "GEN" || entry.asset.origin !== "generation") return false;
    if (chip === "Takes") return true;
    return chip === "Filed" ? shotOf(entry) !== null : shotOf(entry) === null;
  });
}

/** The words for a chip with nothing under it. */
export const recentEmpty = (chip: RecentChip): string =>
  chip === "Filed" ? "Nothing filed on a shot yet." : chip === "Unfiled" ? "Nothing unfiled." : chip === "Takes" ? "No takes yet." : "Nothing made in this project yet.";

const seconds = (n: number) => `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} s`;

/**
 * The line under a card's name, minus its price: the engine by its whole name ("Nano Banana 2", never the
 * Rig column's "NB 2"), then what it was made at. An upload keeps the take's own line (its size and type).
 */
export function recentMeta(entry: LibraryEntry): string {
  if (entry.asset.origin !== "generation") return entry.take.meta;
  const g = entry.asset.value;
  const length = g.durationS ?? (typeof g.params?.duration === "number" ? g.params.duration : null);
  const detail = g.kind === "image"
    ? (typeof g.params?.resolution === "string" ? g.params.resolution : typeof g.params?.ratio === "string" ? g.params.ratio : "")
    : length != null && length > 0 ? seconds(length) : "";
  const pair = entry.take.pair ? `${entry.take.pair.role} ${entry.take.pair.role === "draft" ? DRAFT_RESOLUTION : FINAL_RESOLUTION}` : "";
  return [engineLabel(g.model, g.kind).long, detail, pair].filter(Boolean).join(" · ");
}

/** Whether a card has an Again: a take the composer can run again as it was (lib/shell/recipe.ts › recreateBlock). */
export function canAgain(entry: LibraryEntry): boolean {
  return entry.asset.origin === "generation" && recreateBlock(entry.asset.value) === null;
}

/** One read that prices an Again: the engines route (image and video), or the audio route's quote. */
export type AgainAsk =
  | { key: string; kind: "engine"; url: string }
  | { key: string; kind: "audio"; body: Record<string, unknown> };
export type AgainPrice = { credits: number; approximate: boolean };

/** A reference as the quote helpers read it: an Asset citing its saved id, as the composer's own quote does. */
const refAsset = (r: { origin: "upload" | "generation"; id: string; kind?: "image" | "video" | "audio" }): Asset =>
  ({ id: `${r.origin}:${r.id}`, name: "", url: "", kind: r.kind === "video" ? "video" : "image", ...(r.origin === "upload" ? { uploadId: r.id } : { generationId: r.id }) }) as unknown as Asset;

/**
 * The read that prices running this take again, at its own settings and references: the very parameters the
 * composer's live quote sends once Again has put the recipe back (lib/workspace/use-composer.ts), so the
 * figure on Again is the figure on Make. Null when there is nothing to ask: not a take Make can run again, or
 * an engine this workspace does not offer.
 */
export function againAsk(entry: LibraryEntry, models: readonly ComposerModel[], aspect?: string | null): AgainAsk | null {
  if (!canAgain(entry) || entry.asset.origin !== "generation") return null;
  const preset = recreatePreset(entry.asset.value, { name: entry.take.name });
  const model = models.find((m) => m.id === preset.model);
  if (!model) return null;
  if (model.type === "audio") {
    const task = model.audioTask;
    if (!task) return null;
    const voiceId = preset.sound?.voiceId ?? "";
    if (task === "speech" && !voiceId) return null;
    const length = audioSeconds(task, preset.sound?.seconds ?? 10);
    const body = nodeAudioBody({ task, text: preset.prompt, seconds: length, instrumental: preset.sound?.instrumental ?? false, voiceId, modelId: model.id });
    return { key: `audio:${JSON.stringify(body)}`, kind: "audio", body };
  }
  const settings = composerSettings(model, aspect ?? undefined, preset.picks);
  const query = new URLSearchParams({ model: model.id, resolution: settings.resolution, ratio: settings.ratio, duration: String(settings.duration),
    ...(settings.generateAudio ? { audio: "1" } : {}) });
  const refs = preset.references?.length ? mediaQuoteReferences(preset.references.map(refAsset)) : "";
  const url = `/api/workbench/engines?${query}${refs ? `&${refs}` : ""}`;
  return { key: `engine:${url}`, kind: "engine", url };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Asks the server what `ask` costs. Null when the server has no figure for it (never a guess). */
export async function askAgain(ask: AgainAsk, fetcher: Fetcher): Promise<AgainPrice | null> {
  if (ask.kind === "audio") {
    const response = await fetcher("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ask.body, quoteOnly: true }) });
    if (!response.ok) return null;
    const reply = await response.json().catch(() => null) as { estimatedCredits?: unknown } | null;
    const credits = reply?.estimatedCredits;
    return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? { credits, approximate: false } : null;
  }
  const response = await fetcher(ask.url, { cache: "no-store" });
  if (!response.ok) return null;
  const reply = await response.json().catch(() => null) as { credits?: unknown; approximate?: unknown } | null;
  const credits = reply?.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? { credits, approximate: reply?.approximate === true } : null;
}
