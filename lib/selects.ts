import { csvCell } from "./csvCell";
/**
 * The selects, on the way out (brief 2.6): the shot list a producer bills
 * from. Pure — the route reads the takes, this writes the file.
 *
 * There was a CMX 3600 edit list here too, and it is gone: an EDL is a
 * conform artefact for a cutting room this product does not sit in, and it
 * was carrying its own timecode implementation and its own frame-rate
 * assumption to serve a feature nobody asked to keep. What an editor needs
 * from here is the masters and the shot list, which the zip still carries.
 */
export type Select = {
  id: string; shot: string; shotTitle: string; version: number; kind: string;
  engine: string; credits: number; usd: number; seconds: number; prompt: string; filename: string;
  /** The starter's sample clip carries its credit (lib/sampleClip.ts); absent for every other take. */
  credit?: string;
};


/** One row per approved take, in shot order, the money column in the workspace's unit. */
export function selectsCsv(rows: Select[], unit: "cr" | "$"): string {
  const head = ["shot", "shot_title", "take", "version", "engine", unit === "cr" ? "credits" : "usd", "seconds", "prompt", "file"];
  /* A "credit" column only when a take in the file is the starter's sample clip: every other selects file keeps its columns exactly. */
  const credited = rows.some((r) => r.credit);
  const lines = rows.map((r) => [
    r.shot, r.shotTitle, r.id, r.version, r.engine,
    unit === "cr" ? r.credits : Math.round(r.usd * 10000) / 10000,
    r.seconds, r.prompt, r.filename, ...(credited ? [r.credit ?? ""] : []),
  ].map(csvCell).join(","));
  return [[...head, ...(credited ? ["credit"] : [])].join(","), ...lines].join("\r\n") + "\r\n";
}
