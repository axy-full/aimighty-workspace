import type { AboveFloorRow, Checklist, FloorRow, Pill, PillSet } from "./questionTypes";

/**
 * D1 checklists, beside lib/productionModel/filmTypes.ts (SOW D1; Amendment, 22 October 2026 (iii), H and K): per rail × step,
 * two tables, the floor rows and the above-floor examples.
 *
 * This file holds the Ad film's Brief only (Amendment (iii) L5, "the question engine on the Brief"). The rows are H's
 * "Brief (the interview)" table as the owner drafted it on 22 October; on 23 October he said he is editing the floor rows'
 * file and "the engine builds the Ad film rows as drafted below until his edit lands" (H). Ids are H's; the words are in
 * lib/copy.ts (QUESTIONS); pill ids are the values the record holds. Platform data: it names no workspace, client or person
 * (ground rule 3), and a workspace's own answers come through the record as house defaults (D8), never by editing this file.
 */

const pillSet = (lit: string | null, ...pills: Pill[]): PillSet => ({ pills, lit });

/**
 * H, Brief. Ranks follow H's "Sets" and "Why floor" columns, most first: kind sets the rail and every default below it; length
 * scales the quote; plays sets every frame and take (a change remakes everything); language prices voice per language; real
 * sets the consent tick and uploaded-or-generated; material prices Reading; the spend limit is a stop, not a change to the
 * film or its price. That is also H's table order.
 */
const BRIEF_FLOOR: readonly FloorRow[] = [
  {
    key: "kind",
    floor: true,
    step: "brief",
    rank: 1,
    question: "kind",
    shape: "pick_one",
    /* H: "Ad · Short film · Social · Music video · Other (the ten kinds behind Other)". The ids are lib/productionModel/filmTypes.ts's
       film type ids; the field takes any of the other kinds. H marks no default: the + menu's choice usually answers it. */
    pills: pillSet(null, { id: "ad_film", copy: "kindAd" }, { id: "short_film", copy: "kindShortFilm" }, { id: "social", copy: "kindSocial" }, { id: "music_video", copy: "kindMusicVideo" }),
    field: true,
    answeredBy: ["plus_menu", "brief_document"],
    sets: ["rail", "genre_set", "defaults"],
    money: true,
  },
  {
    key: "length",
    floor: true,
    step: "brief",
    rank: 2,
    question: "length",
    shape: "pick_one",
    /* H: "by kind". A kind H gives no pills for gets the field only. */
    pills: {
      by: "kind",
      sets: {
        ad_film: pillSet("30s", { id: "15s", copy: "sec15" }, { id: "30s", copy: "sec30" }, { id: "60s", copy: "sec60" }),
        short_film: pillSet("3min", { id: "1min", copy: "min1" }, { id: "3min", copy: "min3" }, { id: "5min", copy: "min5" }),
        social: pillSet("15s", { id: "6s", copy: "sec6" }, { id: "15s", copy: "sec15" }, { id: "30s", copy: "sec30" }),
      },
    },
    field: true,
    dependsOn: ["kind"],
    answeredBy: ["brief_document", "deliverables"],
    sets: ["shot_count", "script_beats", "plan_price"],
    money: true,
  },
  {
    key: "plays",
    floor: true,
    step: "brief",
    rank: 3,
    question: "plays",
    shape: "pick_one",
    pills: pillSet("wide", { id: "wide", copy: "playsWide" }, { id: "phone", copy: "playsPhone" }, { id: "square", copy: "playsSquare" }, { id: "several", copy: "playsSeveral" }),
    field: false,
    answeredBy: ["brief_document", "client_spec"],
    sets: ["aspect", "frame_rate", "safe_areas", "deliver_rows"],
    money: true,
  },
  {
    key: "language",
    floor: true,
    step: "brief",
    rank: 4,
    question: "language",
    shape: "pick_one",
    pills: pillSet("hindi", { id: "hindi", copy: "hindi" }, { id: "english", copy: "english" }, { id: "both", copy: "both" }),
    field: true,
    answeredBy: ["brief_document", "script_lines", "house_default"],
    sets: ["voice", "titles", "captions", "deliver_rows"],
    money: true,
  },
  {
    key: "real",
    floor: true,
    step: "brief",
    rank: 5,
    question: "real",
    shape: "pick_one",
    pills: pillSet("no_one", { id: "no_one", copy: "realNoOne" }, { id: "yes_consent", copy: "realConsent" }, { id: "yes_not_yet", copy: "realNotYet" }, { id: "product_only", copy: "realProduct" }),
    field: false,
    /* "Yes, and I have their consent" is a person's word about consent (rule 11: Atomik never records it). */
    agentPicks: ["no_one", "yes_not_yet", "product_only"],
    answeredBy: ["brief_document", "library_consent"],
    sets: ["consent_tick", "origin"],
    money: true,
  },
  {
    key: "material",
    floor: true,
    step: "brief",
    rank: 6,
    question: "material",
    shape: "upload",
    pills: pillSet("nothing", { id: "nothing", copy: "materialNothing" }, { id: "script", copy: "materialScript" }, { id: "media", copy: "materialMedia" }, { id: "both", copy: "both" }),
    field: false,
    /* H, Elements › source: "Answered by Brief › material". Nothing to start from means every element is made from its line;
       photos or clips mean they come from the person's references. A script or deck alone says nothing about pictures. */
    carries: {
      nothing: [{ key: "source", value: "made" }],
      media: [{ key: "source", value: "photos" }],
      both: [{ key: "source", value: "photos" }],
    },
    answeredBy: ["drop"],
    sets: ["reading_price", "element_sources"],
    money: true,
  },
  {
    key: "ceiling",
    floor: true,
    step: "brief",
    rank: 7,
    question: "ceiling",
    shape: "pick_one",
    /* The record holds a reference to the production's cap, never a figure (film-record-schema A.0, A.2): "none" is
       {"cap":"none"}. H's other two pills, 200 cr and 500 cr, are SAMPLES awaiting the owner's ruling: a figure cannot be a
       reference without a way to set the production's cap from here, which does not exist, so they are wired to nothing and
       written nowhere. No field: no free-text figure. */
    pills: pillSet("none", { id: "none", copy: "ceilingNone" }),
    field: false,
    /* Only a person sets a spend limit (rule 11, rule 14): "Decide for me" never writes it, and a house default never answers
       it (film-record-schema question 7). Left unset, it means no limit. */
    personOnly: true,
    answeredBy: ["workspace_monthly_limit"],
    sets: ["production_cap"],
    money: true,
  },
];

/** G, Brief, ASKS: the rows it lists that are not on the floor, in its order. Atomik asks above the floor in its own words. */
const BRIEF_ABOVE_FLOOR: readonly AboveFloorRow[] = [
  { key: "q:subject", floor: false, step: "brief" },
  { key: "q:message", floor: false, step: "brief" },
  { key: "q:audience", floor: false, step: "brief" },
  { key: "q:tone", floor: false, step: "brief" },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/** The Ad film's Brief checklist. Frozen: every engine reads the same rows and none can change them for another. */
export const AD_FILM_BRIEF: Checklist = deepFreeze({
  filmType: "ad_film",
  step: "brief",
  floor: BRIEF_FLOOR,
  aboveFloor: BRIEF_ABOVE_FLOOR,
});

const CHECKLISTS: readonly Checklist[] = [AD_FILM_BRIEF];

/** A rail's checklist for one step, or null where none is written yet (only the Ad film's Brief is, today). */
export function checklistFor(filmType: string, step: string): Checklist | null {
  return CHECKLISTS.find((list) => list.filmType === filmType && list.step === step) ?? null;
}
