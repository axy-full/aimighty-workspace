import { shotState, type ShotTakes } from "../take/take-model";

/*
 * "Where to next?" (design/particl-graphite/README.md § 3.1 j): three small cards after the cut, each a way into a
 * tool that exists today, by its own price. Nothing here spends: each card opens Make (or the Crew room), where the
 * price is shown and a person presses. Pure.
 *
 * The design's first card reframes the approved takes "free, on this device"; no such tool exists, so it opens Make
 * on a 9:16 video instead (a new make, priced there). The code's truth, not a promise.
 */
export type NextChoiceId = "vertical" | "stills" | "crew";
export type NextChoice = { id: NextChoiceId; name: string; line: string; icon: string };

export const NEXT_GROUP_TITLE = "Where to next?";
const ICON = {
  video: "M2 4h8v8H2zM10 7l4-2v6l-4-2",
  image: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3",
  sparkle: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z",
} as const;

/** Shown once every shot has an approved take: the film is cut and there is a next thing to make from it. */
export function showWhereNext(rows: readonly Pick<ShotTakes, "shown" | "versions">[]): boolean {
  return rows.length > 0 && rows.every((row) => shotState(row) === "done");
}

/** The three choices. A vertical project's first card is the widescreen one. */
export function nextChoices(aspect: string): NextChoice[] {
  const vertical = aspect === "9:16";
  return [
    { id: "vertical", name: vertical ? "16:9 version" : "9:16 cutdown", line: `Make it again in ${vertical ? "16:9" : "9:16"} · priced in Make`, icon: ICON.video },
    { id: "stills", name: "Campaign stills", line: "From the approved takes", icon: ICON.image },
    { id: "crew", name: "Crew review of the cut", line: "Director · DOP · Costume · Continuity", icon: ICON.sparkle },
  ];
}

/** What a card opens in Make: its type, the ratio and (for stills) the engine's size. */
export function nextPreset(id: Exclude<NextChoiceId, "crew">, aspect: string): { type: "video" | "image"; picks: { ratio?: string; resolution?: string }; note: string } {
  if (id === "vertical") return { type: "video", picks: { ratio: aspect === "9:16" ? "16:9" : "9:16" }, note: "A new version, from the cut" };
  return { type: "image", picks: { resolution: "1K" }, note: "Campaign stills from the approved takes" };
}
