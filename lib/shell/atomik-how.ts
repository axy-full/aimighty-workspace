import { exact, priceWords, type PriceValue } from "./price-words";

/**
 * "Ask Atomik how" (design/particl-graphite/README.md § 3.4, `&atomik=how`): a
 * question about Particl, answered free, with an offer to do the thing.
 *
 * Answered from this table: no model is called, so an answer costs nothing,
 * comes back at once, and says only what the product does today (lead
 * decision 29). Each offer is the same thing the screen's own button does
 * (the panel maps it to that function); for what only a person may do
 * (approving, a top-up, spending rules, consent) the offer opens the place,
 * and never presses anything.
 *
 * A figure in an answer is the server's: the rate card it publishes
 * (GET /api/plans › rates). Without it, an answer says where the price is
 * shown instead of giving a number.
 */

/** What an offer does: the panel calls the function the screen's own button calls. */
export type HowAction =
  | { kind: "library" }
  | { kind: "make"; tool?: "motion" | "swap" }
  | { kind: "control"; page: "approvals" | "runs" | "saved-skills" | "memory" }
  | { kind: "settings"; section: "team" | "credits" | "rules" | "connections" | "advanced" }
  | { kind: "region"; region: string }
  | { kind: "palette"; query: string }
  | { kind: "home" };

export type HowOffer = { label: string; action: HowAction };
export type HowAnswer = { topic: string; text: string; offer: HowOffer | null };

/** What the answers may quote: rate-card figures by name, each the server's own, or absent. */
export type HowFacts = { heroTake?: PriceValue | null; identity?: PriceValue | null };

type Topic = { id: string; when: RegExp; answer: (facts: HowFacts) => string; offer: HowOffer | null };

const sentence = (lead: string, price: PriceValue | null | undefined, fallback: string) => {
  const words = priceWords(price);
  return words ? `${lead}: ${words} on the rate card.` : fallback;
};

/* Most specific first: the first topic that matches answers. */
const TOPICS: readonly Topic[] = [
  {
    id: "quick-tools", when: /motion transfer|object swap|\bswap\b|recast/i,
    answer: () => "Both are in Make. Motion transfer takes one source video and up to eight references; Object swap replaces one element and keeps the rest of the shot. The price shows on the button before anything runs.",
    offer: { label: "Open Motion transfer", action: { kind: "make", tool: "motion" } },
  },
  {
    id: "hero-cost", when: /hero/i,
    answer: (f) => `${sentence("A hero take is Seedance 2.5 at 1080p for 5 s", f.heroTake, "A hero take is Seedance 2.5 at 1080p for 5 s; Make shows its price on the button before you press.")} Make shows the exact price before you press, and hovering it shows the dollars.`,
    offer: { label: "Open Make", action: { kind: "make" } },
  },
  {
    id: "identity", when: /identit|consent|\bface\b|\bvoice\b|\bcast\b|actor|same person/i,
    answer: (f) => `An identity keeps a person looking the same in every shot. Build one from the Cast card once their consent is on record; only a person records consent.${priceWords(f.identity) ? ` Training one is ${priceWords(f.identity)}.` : ""}`,
    offer: { label: "Go to Cast", action: { kind: "region", region: "cast" } },
  },
  {
    id: "reference", when: /referenc|\brefs?\b/i,
    answer: () => "Drag anything from the Library onto the shot, or press + in Make’s references tray. I can open the Library for you.",
    offer: { label: "Open the Library", action: { kind: "library" } },
  },
  {
    id: "review", when: /review|compare|reject|approve (?:a|the|this) take|keyboard|shortcut|\bkeys?\b/i,
    answer: () => "Open a take in review mode: J and K move between takes, A approves, R rejects, Space plays and C compares. Approving or rejecting a take spends nothing.",
    offer: { label: "Go to Shots", action: { kind: "region", region: "shots" } },
  },
  {
    id: "undo", when: /undo|delete|erase|lost|get (?:it )?back|restore/i,
    answer: () => "Nothing is erased. ⌘Z undoes your last step, and archived work can be restored.",
    offer: null,
  },
  {
    id: "memory", when: /memor|remember|forget|brand|audience/i,
    answer: () => "Atomik keeps your brand, audience, references and cast in Memory. Type “remember …” here to keep a line, or “forget …” to take one out; both are free.",
    offer: { label: "Open Memory", action: { kind: "control", page: "memory" } },
  },
  {
    id: "skills", when: /skill|saved run|run (?:it )?again|reuse|template run/i,
    answer: () => "A finished run can be saved as a skill and run again with new words. Its steps are priced before anything spends.",
    offer: { label: "Open Skills", action: { kind: "control", page: "saved-skills" } },
  },
  {
    id: "connect", when: /\bmcp\b|connect|claude|chatgpt|openai|outside agent|api|token/i,
    answer: () => "Outside agents connect over MCP with a token made in Settings › Connections. A person makes each token, and can give it a monthly ceiling for what it spends.",
    offer: { label: "Open Connections", action: { kind: "settings", section: "connections" } },
  },
  {
    id: "top-up", when: /top.?up|buy|balance|more credits|pack|invoice|pay\b/i,
    answer: () => "Your balance is in the header. An owner or admin asks for a top-up in Settings › Plan & credits; only a person can.",
    offer: { label: "Open Plan & credits", action: { kind: "settings", section: "credits" } },
  },
  {
    id: "team", when: /invite|team|member|people|role|admin/i,
    answer: () => "Invite people and set their roles in Settings › Team.",
    offer: { label: "Open Team", action: { kind: "settings", section: "team" } },
  },
  {
    id: "auto", when: /without asking|\bauto\b|automatic|spending rule|who (?:can|may) approve/i,
    answer: () => "Every paid step waits for a person’s tap. Who may approve what is set in Settings › Spending rules, by an admin.",
    offer: { label: "Open Spending rules", action: { kind: "settings", section: "rules" } },
  },
  {
    id: "approvals", when: /approv|gate|limit|waiting|budget/i,
    answer: () => "Nothing is spent until a person approves it. Approvals is one queue across your projects, each item with its price.",
    offer: { label: "Open Approvals", action: { kind: "control", page: "approvals" } },
  },
  {
    id: "search", when: /search|find|⌘k|cmd.?k|command/i,
    answer: () => "Press ⌘K to find a project, a place on the board or an asset, or to tell Atomik what to do.",
    offer: { label: "Open ⌘K", action: { kind: "palette", query: "" } },
  },
  {
    id: "library", when: /library|upload|file|import|drop/i,
    answer: () => "The Library holds every upload and take in this project. Drop files anywhere on the page to add them.",
    offer: { label: "Open the Library", action: { kind: "library" } },
  },
  {
    id: "make", when: /\bmake\b|generate|render|still|image|video|audio|sound|music|voice/i,
    answer: () => "Open Make with ⌥M, say what you want and press Make. The engine and its price are on one line, and the price is on the button.",
    offer: { label: "Open Make", action: { kind: "make" } },
  },
  {
    id: "cost", when: /cost|price|how much|credit|\bcr\b|spent|spend|dollar/i,
    answer: () => "Every paid button shows its price before anything runs; hover it for dollars. Activity shows what each run settled at.",
    offer: { label: "Open Activity", action: { kind: "control", page: "runs" } },
  },
  {
    id: "start", when: /start|begin|new project|film|campaign|board|template/i,
    answer: () => "Start on Home: say what we are making, or pick a template. Each project is one board, and anything that spends waits for your approval.",
    offer: { label: "Go Home", action: { kind: "home" } },
  },
];

const DEFAULT: Topic = {
  id: "default", when: /$^/,
  answer: () => "Say what you want in this box and I’ll plan it, with every paid step priced first. Anything that spends waits for your approval.",
  offer: null,
};

/** The free answer to a question about Particl. */
export function howAnswer(question: string, facts: HowFacts = {}): HowAnswer {
  const topic = TOPICS.find((t) => t.when.test(question)) ?? DEFAULT;
  return { topic: topic.id, text: topic.answer(facts), offer: topic.offer };
}

/** The three questions the empty panel offers (the design's, as asked). The last is a command: it opens ⌘K's list. */
export const HOW_HINTS: readonly string[] = ["How do I add a reference to a shot?", "What does a hero take cost?", "Approve everything under 10 cr"];

/** Every topic id, for tests. */
export const HOW_TOPICS: readonly string[] = TOPICS.map((t) => t.id);

/* ── Rate-card figures, from GET /api/plans › rates (credits only) ───────────── */

type RateCell = { option: string; credits: number };
type RateRow = { engine: string; audio: boolean; cells: RateCell[] };
type RateGroup = { kind: string; rows: RateRow[] };

const SEEDANCE_25 = "dreamina-seedance-2-5-260628";

/** The facts the answers quote, read from the rate card the server publishes; each absent when the card lacks it. */
export function howFacts(rates: unknown): HowFacts {
  if (!Array.isArray(rates)) return {};
  const rows = (rates as RateGroup[]).filter((g) => g && g.kind === "video" && Array.isArray(g.rows)).flatMap((g) => g.rows);
  const seedance = rows.filter((r) => r && r.engine === SEEDANCE_25 && Array.isArray(r.cells));
  const row = seedance.find((r) => r.audio) ?? seedance[0];
  const cell = row?.cells.find((c) => c && c.option === "1080p");
  return { heroTake: cell && Number.isFinite(cell.credits) ? exact(cell.credits) : null };
}
