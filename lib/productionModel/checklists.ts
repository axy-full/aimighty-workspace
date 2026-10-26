import { FILM_TYPE_ID } from "./filmTypes";
import type { AboveFloorRow, Checklist, FloorRow, Pill, PillSet, Prefill } from "./questionTypes";

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
 * H, Brief. Ranks are G's and H's rule, "by what changes the result or the price most" (the owner, 24 Oct 2026, answer 1), read
 * from H's "Sets" and "Why floor" columns, most first: kind sets the rail and every default below it; length scales the quote;
 * plays sets every frame and take (a change remakes everything); language prices voice per language; real sets the consent tick
 * and uploaded-or-generated; material prices Reading; the spend limit is a stop, not a change to the film or its price. That is
 * also H's table order. Each rank is used once, so no tie-break is needed between floor rows (the test holds it to that).
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
    pills: pillSet(
      null,
      { id: FILM_TYPE_ID.adFilm, copy: "kindAd" },
      { id: FILM_TYPE_ID.shortFilm, copy: "kindShortFilm" },
      { id: FILM_TYPE_ID.social, copy: "kindSocial" },
      { id: FILM_TYPE_ID.musicVideo, copy: "kindMusicVideo" },
    ),
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
        [FILM_TYPE_ID.adFilm]: pillSet("30s", { id: "15s", copy: "sec15" }, { id: "30s", copy: "sec30" }, { id: "60s", copy: "sec60" }),
        [FILM_TYPE_ID.shortFilm]: pillSet("3min", { id: "1min", copy: "min1" }, { id: "3min", copy: "min3" }, { id: "5min", copy: "min5" }),
        [FILM_TYPE_ID.social]: pillSet("15s", { id: "6s", copy: "sec6" }, { id: "15s", copy: "sec15" }, { id: "30s", copy: "sec30" }),
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
    /* Hindi ★ is the platform default for now (owner, 24 Oct 2026, answer 7). A workspace's own default lights another pill, and a
       house default answers the row: house over workspace over platform (questionEngine.ts, "The lit pill"). */
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
       {"cap":"none"}, "production" is {"cap":"production"}. Other (owner, 25 Oct 2026, answer 4): its figure is set as the
       production's own cap through the money path (lib/caps.ts setCapFromBrief), and only once that has landed does the row
       record "production". The figure never enters the engine or the record, so the row has no field. H's sample pills (200 cr,
       500 cr) wait for the rate card and are wired to nothing. */
    pills: pillSet("none", { id: "none", copy: "ceilingNone", inLine: "noLimit" }, { id: "production", copy: "ceilingOther" }),
    field: false,
    /* Only a person sets a spend limit (rule 11, rule 14): "Decide for me" never writes it, and a house default never answers
       it (film-record-schema question 7). Left unset, it means no limit. The owner, 24 Oct 2026: the platform default is No
       limit and never anything else (answer 5); a house default (the workspace answering the same way three times) may be
       proposed, lit on the card for the person to tap, never written (answer 5); after "Decide for me" it reads "I assumed no
       limit · Change" and is not asked again, with nothing written (answer 6). */
    personOnly: true,
    decidedShows: "none",
    proposedBy: ["house_default"],
    /* Any member may set the spend limit at the Brief; lifting a cap already set is an owner's or an admin's (owner, 25 Oct 2026,
       answer 3 (b)). Of the pills, No limit lifts a cap; Other's figure is judged where it is set (lib/caps.ts setCapFromBrief). */
    raises: ["none"],
    answeredBy: ["workspace_monthly_limit"],
    sets: ["production_cap"],
    money: true,
  },
];

/**
 * The Brief's "real" pre-fills Elements' consent for that person (owner, 24 Oct 2026, answer 4): "Yes, and I have their consent"
 * lights "Yes, attach it", "Yes, not yet" lights "Not yet". Lit only: the tick itself (who ticked, when, a file if one was attached)
 * is recorded per element when it is first made, by a person, never by the engine or Atomik (rule 11). For the Elements step's
 * consent row (H, Elements), whose checklist is a later step PR (L6); its pill ids are H's: yes, not_yet, not_real.
 */
export const CONSENT_FROM_BRIEF: Prefill = Object.freeze({ from: "real", values: Object.freeze({ yes_consent: "yes", yes_not_yet: "not_yet" }) });

/**
 * Above the floor. G's ASKS rows first, in its order: subject, message and audience are Atomik's to ask in its own words. Then the
 * conversation (owner, 25 Oct 2026; SOW v2 §9 Brief): tonality, the hook, the penny-drop moment, montage or not, high speed or not
 * and the moments, in his order, each one question in the copy table's words. Tonality's bank is his six words; montage and speed
 * offer both sides; the hook, the penny drop and the moments have no bank, since their likely answers are this film's (Atomik's
 * proposals). None is on the floor: nothing here moves money, and any of them may be skipped.
 */
const BRIEF_ABOVE_FLOOR: readonly AboveFloorRow[] = [
  { key: "q:subject", floor: false, step: "brief" },
  { key: "q:message", floor: false, step: "brief" },
  { key: "q:audience", floor: false, step: "brief" },
  {
    key: "q:tone", floor: false, step: "brief", question: "tone",
    bank: [
      { id: "warm", copy: "toneWarm" }, { id: "cold", copy: "toneCold" }, { id: "standoffish", copy: "toneStandoffish" },
      { id: "deadpan", copy: "toneDeadpan" }, { id: "over_the_top", copy: "toneOverTheTop" }, { id: "emotional", copy: "toneEmotional" },
    ],
  },
  { key: "q:hook", floor: false, step: "brief", question: "hook" },
  { key: "q:penny_drop", floor: false, step: "brief", question: "pennyDrop" },
  { key: "q:montage", floor: false, step: "brief", question: "montage", bank: [{ id: "montage", copy: "montageYes" }, { id: "no_montage", copy: "montageNo" }] },
  { key: "q:high_speed", floor: false, step: "brief", question: "highSpeed", bank: [{ id: "high_speed", copy: "highSpeedYes" }, { id: "normal_speed", copy: "highSpeedNo" }] },
  { key: "q:moments", floor: false, step: "brief", question: "moments" },
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
  filmType: FILM_TYPE_ID.adFilm,
  step: "brief",
  floor: BRIEF_FLOOR,
  aboveFloor: BRIEF_ABOVE_FLOOR,
});

const CHECKLISTS: readonly Checklist[] = [AD_FILM_BRIEF];

/** A rail's checklist for one step, or null where none is written yet (only the Ad film's Brief is, today). */
export function checklistFor(filmType: string, step: string): Checklist | null {
  return CHECKLISTS.find((list) => list.filmType === filmType && list.step === step) ?? null;
}
