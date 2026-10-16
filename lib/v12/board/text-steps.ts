/**
 * The text steps of a Film board in the new interface: Brief and Script (docs/plans/demo-31oct-plan.md PR 11; design/particl-prototype-25,
 * README "CARD SYSTEM"). Each is one text card whose words are the draft's own (`brief`, `script`), so nothing is invented and nothing is
 * stored twice. Pure: no React, no fetch (tests/unit/v12-text-steps.spec.ts).
 *
 * A card's ✓ or ✕ is kept in the draft as `boardMarks` (docs/plans/v25-build-plan.md, question 4: no migration, no audit trail), with a
 * fingerprint of the words it was given for: when the words change, the mark no longer holds and the card reads Ready again.
 */
import type { CardStatus } from "@/components/v12/board/card-model";
import type { BeatScene } from "@/lib/production/beats";
import type { Project } from "@/lib/workbench/studio";

export type TextStepId = "brief" | "script";
export type Marks = NonNullable<Project["boardMarks"]>;

/** ✕'s reasons for each text step (the card adds "Other"). */
export const TEXT_REASONS: Record<TextStepId, readonly string[]> = {
  brief: ["Wrong audience", "Too long", "Missing detail", "Tone"],
  script: ["Too long", "Voice", "Pacing", "Facts"],
};

/** A short fingerprint of some words (FNV-1a, base 36): enough to tell that a mark was given for other words. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export type TextCard = {
  id: TextStepId;
  title: string;
  /** The first lines, for the card's page. Empty: the card has not been started. */
  excerpt: string;
  /** The whole text the card stands for. */
  text: string;
  status: CardStatus;
  version?: number;
  reason?: string;
  /** Small chips under the title: the brief's spec; the script's size. */
  chips: { id: string; label: string }[];
};

const EXCERPT = 280;
const excerptOf = (text: string) => {
  const flat = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT).trimEnd()}…` : flat;
};

/** A mark that still holds: given for these very words. */
function markFor(marks: Marks | undefined, id: TextStepId, text: string) {
  const mark = marks?.[id];
  return mark && mark.fp === fingerprint(text) ? mark : null;
}

function statusOf(marks: Marks | undefined, id: TextStepId, text: string): Pick<TextCard, "status" | "reason"> {
  if (!text.trim()) return { status: "none" };
  const mark = markFor(marks, id, text);
  if (mark?.s === "approved") return { status: "approved" };
  if (mark?.s === "rejected") return { status: "rejected", ...(mark.reason ? { reason: mark.reason } : {}) };
  return { status: "ready" };
}

/** "30 s" · "16:9" · "24 fps": the brief's spec, from what the draft holds (a length only when it reads as one). */
export function specChips(project: Pick<Project, "aspect" | "fps" | "deliverables">): { id: string; label: string }[] {
  const length = project.deliverables?.trim().match(/^\d+(?:\.\d+)?\s*(?:s|sec|seconds|min|m)\b/i)?.[0].replace(/\s+/g, " ");
  return [
    ...(length ? [{ id: "length", label: length }] : []),
    ...(project.aspect ? [{ id: "aspect", label: project.aspect }] : []),
    ...(project.fps ? [{ id: "fps", label: `${project.fps} fps` }] : []),
  ];
}

export function briefCard(project: Pick<Project, "brief" | "aspect" | "fps" | "deliverables" | "boardMarks">): TextCard {
  const text = project.brief ?? "";
  return { id: "brief", title: "Brief", text, excerpt: excerptOf(text), ...statusOf(project.boardMarks, "brief", text), chips: specChips(project) };
}

/** The scenes, beats and shots of the script's breakdown, if one has been made. */
const scenesOf = (project: Pick<Project, "production">): BeatScene[] => project.production?.beats?.scenes ?? [];

export function scriptCard(project: Pick<Project, "script" | "scriptVersions" | "production" | "boardMarks">): TextCard {
  const text = project.script ?? "";
  const scenes = scenesOf(project);
  const shots = scenes.reduce((n, s) => n + s.shots.length, 0);
  const earlier = project.scriptVersions?.length ?? 0;
  return {
    id: "script", title: "Script", text, excerpt: excerptOf(text), ...statusOf(project.boardMarks, "script", text),
    ...(earlier > 0 && text.trim() ? { version: earlier + 1 } : {}),
    chips: scenes.length ? [{ id: "scenes", label: `${scenes.length} ${scenes.length === 1 ? "scene" : "scenes"}` }, ...(shots ? [{ id: "shots", label: `${shots} ${shots === 1 ? "shot" : "shots"}` }] : [])] : [],
  };
}

/** The draft's marks with this card's verdict written for these words; a verdict is replaced, never stacked. */
export function withMark(marks: Marks | undefined, id: TextStepId, text: string, verdict: "approved" | "rejected", at: number, reason?: string): Marks {
  const clean = reason?.trim().slice(0, 200);
  return { ...(marks ?? {}), [id]: { s: verdict, fp: fingerprint(text), ...(verdict === "rejected" && clean ? { reason: clean } : {}), at } };
}

/** ✓ again takes the approval back (the card's ✓ toggles). */
export function withoutMark(marks: Marks | undefined, id: TextStepId): Marks {
  const { [id]: _gone, ...rest } = marks ?? {};
  void _gone;
  return rest;
}

/* ── The script's preview: Script · Beats · Breakdown ─────────────────────────────────────────────── */

export const SCRIPT_TABS = ["Script", "Beats", "Breakdown"] as const;
export type ScriptTab = (typeof SCRIPT_TABS)[number];

const roman = (n: number) => ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n - 1] ?? String(n);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const names = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat().map((x) => x.trim()).filter(Boolean))];

/** The Beats tab: one line per scene, "I · Arrive — 2 shots". Empty when no breakdown has been made. */
export function beatLines(project: Pick<Project, "production">): string[] {
  return scenesOf(project).map((scene, i) => `${roman(i + 1)} · ${scene.heading.trim() || scene.summary.trim().slice(0, 60) || "Scene"} — ${plural(scene.shots.length, "shot", "shots")}`);
}

/** The Breakdown tab: what the script names, as "Label: a, b". Empty when no breakdown has been made. */
export function breakdownLines(project: Pick<Project, "production">): string[] {
  const scenes = scenesOf(project);
  if (!scenes.length) return [];
  const rows: [string, string[]][] = [
    ["Characters", names(scenes.map((s) => s.characters))],
    ["Locations", names(scenes.map((s) => s.locations))],
    ["Props", names(scenes.map((s) => s.props))],
  ];
  const seconds = scenes.reduce((n, s) => n + s.shots.reduce((m, shot) => m + (shot.duration ?? 0), 0), 0);
  return [
    ...rows.filter(([, list]) => list.length).map(([label, list]) => `${label}: ${list.join(", ")}`),
    `Shots: ${scenes.reduce((n, s) => n + s.shots.length, 0)}${seconds ? ` · ${Math.round(seconds)} s` : ""}`,
  ];
}
