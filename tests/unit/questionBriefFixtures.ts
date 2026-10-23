import type { RowSource } from "../../lib/productionModel/questionTypes";

/**
 * Mocked briefs for the question engine (Amendment, 22 October 2026 (iii), K D11, G "Questions", H; SOW R2).
 *
 * SYNTHETIC STAND-INS. D11 asks for "three of the owner's own past briefs, client and product names stripped (rule 3), in the
 * shapes people send (a PDF deck, a WhatsApp paragraph, a voice note)". Those briefs are the owner's material and are not in
 * the repo, so the first three fixtures below are written by the lead in those three shapes, with made-up products and no
 * person, client, brand or workspace name. They are replaced by the owner's own when he supplies them (an owner question).
 * The last three are test shapes the floor test needs as well: only the + menu's choice, nothing at all, and a workspace whose
 * house defaults (D8) answer two rows.
 *
 * Reading a deck and transcribing a voice note are model turns (priced, out of scope here). So each fixture carries `read`:
 * the rows that turn would write to the record before the first question, with their source. The engine starts from those.
 * `expect` is what H's floor makes of them: which floor rows are known, which are assumed, and which are asked, in order.
 */
export type BriefFixture = {
  readonly id: string;
  readonly shape: "deck" | "chat" | "voice_note" | "menu_only" | "nothing" | "house_defaults";
  /** Every fixture here is the lead's stand-in, never the owner's own brief. */
  readonly synthetic: true;
  /** The brief as the person sent it (synthetic). Empty where nothing was sent. */
  readonly words: string;
  /** What the record holds before the first question: Reading's rows, the + menu's choice, the house defaults. */
  readonly read: Readonly<Record<string, { value: string; source: RowSource }>>;
  readonly expect: { readonly known: readonly string[]; readonly assumed: readonly string[]; readonly asks: readonly string[] };
};

const menu = { kind: { value: "ad_film", source: "said" } } as const;

export const BRIEF_FIXTURES: readonly BriefFixture[] = [
  {
    id: "d11-deck",
    shape: "deck",
    synthetic: true,
    words:
      "Page 2 · Format: one 30-second film for TV and cinema, 16:9. Hindi VO. " +
      "Page 3 · Product: a steel water bottle that keeps a drink cold all day. For people who commute by train. " +
      "Page 4 · Message: cold at the end of the day.",
    read: {
      ...menu,
      length: { value: "30s", source: "document" },
      plays: { value: "wide", source: "document" },
      language: { value: "hindi", source: "document" },
      material: { value: "script", source: "document" },
      "q:subject": { value: "a steel water bottle", source: "document" },
      "q:audience": { value: "people who commute by train", source: "document" },
      "q:message": { value: "cold at the end of the day", source: "document" },
    },
    expect: { known: ["kind", "length", "plays", "language", "material"], assumed: [], asks: ["real", "ceiling"] },
  },
  {
    id: "d11-chat",
    shape: "chat",
    synthetic: true,
    words: "hi! need a quick 15 sec ad for phones, english only. no actors, just the product - a jar of lime pickle. something fun",
    read: {
      ...menu,
      length: { value: "15s", source: "said" },
      plays: { value: "phone", source: "said" },
      language: { value: "english", source: "said" },
      real: { value: "product_only", source: "said" },
      "q:subject": { value: "a jar of lime pickle", source: "said" },
      "q:tone": { value: "fun", source: "said" },
    },
    expect: { known: ["kind", "length", "plays", "language", "real"], assumed: [], asks: ["material", "ceiling"] },
  },
  {
    id: "d11-voice-note",
    shape: "voice_note",
    synthetic: true,
    words:
      "(transcript) So it's for phones, the tall format. Hindi and English both, two versions. " +
      "No people in it, only the loaf and the oven. We don't have anything shot yet.",
    read: {
      ...menu,
      plays: { value: "phone", source: "said" },
      language: { value: "both", source: "said" },
      real: { value: "no_one", source: "said" },
      material: { value: "nothing", source: "said" },
      "q:subject": { value: "a bakery's loaf", source: "said" },
    },
    expect: { known: ["kind", "plays", "language", "real", "material"], assumed: [], asks: ["length", "ceiling"] },
  },
  {
    id: "menu-only",
    shape: "menu_only",
    synthetic: true,
    words: "",
    read: { ...menu },
    expect: { known: ["kind"], assumed: [], asks: ["length", "plays", "language", "real", "material", "ceiling"] },
  },
  {
    id: "nothing",
    shape: "nothing",
    synthetic: true,
    words: "",
    read: {},
    expect: { known: [], assumed: [], asks: ["kind", "length", "plays", "language", "real", "material", "ceiling"] },
  },
  {
    id: "house-defaults",
    shape: "house_defaults",
    synthetic: true,
    words: "",
    read: {
      ...menu,
      /* D8: answered the same way in the workspace's last three productions (film-record-schema question 7). */
      language: { value: "english", source: "default" },
      plays: { value: "square", source: "default" },
    },
    expect: { known: ["kind"], assumed: ["plays", "language"], asks: ["length", "real", "material", "ceiling"] },
  },
];

export const fixture = (id: string): BriefFixture => {
  const found = BRIEF_FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};
