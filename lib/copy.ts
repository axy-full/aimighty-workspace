/**
 * The copy table: every string the product shows lives here, never inline in a component (Amendment, 22 October 2026 (iii), F and
 * D12). The owner, 22 Oct: "Copy like 'Just make it. The same quote. No questions' is amateur copy. Revise the copy across the
 * platform and make it more polished, technical, single worded (wherever possible) and crisp." So:
 *  - a button is one word; "Decide for me" is the one multi-word button (R3);
 *  - a label is a noun; no line is longer than eight words; "free" is lowercase;
 *  - no engine, vendor, thinking model, effort setting or retired line, and none of the design's forbidden words.
 * tests/unit/copy-table.spec.ts holds every value to those rules. The v31.16 build lives in components/v31/ (the step PRs build
 * their screens there), and the same test fails a component there that writes words of its own. A copy change is a data PR on this file.
 *
 * Prices are never written here: a price comes from the quote path and is joined to its label at the call site
 * ("Generate · 43 cr"). The words come from design/particl-v31.16 (README.txt) and docs/design/prompts; every figure in the design is a sample.
 */

/** The ten steps, in the order of the rail (S2 as amended 21 Oct: Elements before Look). */
export const STEPS = {
  brief: "Brief",
  script: "Script",
  treatment: "Treatment",
  elements: "Elements",
  look: "Look",
  storyboard: "Storyboard",
  shots: "Shots",
  sound: "Sound",
  edit: "Edit",
  deliver: "Deliver",
} as const;

/** Buttons: one word each, except "Decide for me" (R3, Amendment (iii) H). */
export const BUTTONS = {
  quote: "Quote",
  approve: "Approve",
  change: "Change",
  cancel: "Cancel",
  keep: "Keep",
  revise: "Revise",
  /** Keep and Sent are locked (Amendment (iii) F; owner, 19 Oct); "Send" is one of v31.12's one-word buttons (rule 3). */
  send: "Send",
  generate: "Generate",
  create: "Create",
  render: "Render",
  export: "Export",
  upload: "Upload",
  preview: "Preview",
  again: "Again",
  present: "Present",
  compose: "Compose",
  enhance: "Enhance",
  undo: "Undo",
  retry: "Retry",
  buy: "Buy",
  rename: "Rename",
  decideForMe: "Decide for me",
} as const;

/** The two modes, and the word for the thinking setting with its three values (Amendment (iii) E). */
export const MODES = { agent: "Agent", director: "Director" } as const;

export const THINKING = {
  label: "Thinking",
  high: "High",
  medium: "Medium",
  low: "Low",
  /** One line under each value in the Brief's read-back picker (v31.16 prompt, THINKING 1). */
  highLine: "Asks the most, plans the deepest",
  mediumLine: "The balance",
  lowLine: "Quick, for simple films",
  sampleLine: "Plans and writing quote higher at High",
  workspaceDefault: "Default for new productions",
  adminsOnly: "Admins only",
  /** Whether each setting is served, in the platform owner's health detail (GET /api/health): by name, never a model or an effort. */
  served: "served",
  notSet: "not set",
  notServed: "not served",
} as const;

/** A job's three ticks, at one price (Amendment (iii) A3). */
export const TICKS = { thinking: "Thinking", making: "Making", reviewing: "Reviewing" } as const;

/** A card's one chip (Keep and Next, v31.16 README). */
export const CARD_STATES = {
  toMake: "To make",
  making: "Making…",
  readyToJudge: "Ready to judge",
  kept: "Kept",
  update: "Update?",
} as const;

/** The kinds a new Elements card asks for first in Director mode (Amendment (iii) B3). */
export const ELEMENT_KINDS = {
  question: "What is it?",
  cast: "Cast",
  prop: "Prop",
  environment: "Environment",
  vehicle: "Vehicle",
  wardrobe: "Wardrobe",
  product: "Product",
  words: "Words",
  world: "World",
} as const;

/** Settings rows and chips (Make's Settings row, the Inspector). "How many" is retired: it is Count everywhere (v31.13). */
export const SETTINGS = {
  settings: "Settings",
  kind: "Kind",
  ratio: "Ratio",
  length: "Length",
  count: "Count",
  resolution: "Resolution",
  engine: "Engine",
  referenceStrength: "Reference strength",
  styleFrom: "Style from",
  negative: "Negative",
  /** Director's Prompt row (Amendment (iii) J). Assembly is free and shows no price. */
  prompt: "Prompt · as it will be sent",
  promptSent: "Prompt · as sent",
  againWith: "Again with…",
} as const;

/** The Library's filter row (v31.16 README, THE LIBRARY). */
export const LIBRARY = {
  library: "Library",
  all: "All",
  stills: "Stills",
  clips: "Clips",
  sound: "Sound",
  documents: "Documents",
  uploads: "Uploads",
  worlds: "Worlds",
  kept: "Kept",
  unkept: "Unkept",
  trash: "Trash",
  thisProduction: "This production",
  everything: "Everything",
} as const;

/** Placeholders for the bar and Make's composer. */
export const PLACEHOLDERS = {
  directorBar: "Change something · tighter, from below, warmer",
  /** The design's line ("Say it · @ a face, a product or a look from the Library") cut to eight words (C5). */
  make: "Say it · @ a face, product or look",
  makeHeadline: "What are we making?",
} as const;

/**
 * The Brief's floor questions and pills (Amendment (iii) H, "Brief (the interview)"), as the owner drafted them for the Ad film,
 * until his edit of the floor rows lands. "Other" is the field. The spend limit offers "No limit" only: H's
 * figures are samples awaiting the owner's ruling. Read by the question engine's Brief checklist.
 */
export const QUESTIONS = {
  other: "Other",
  kind: "What are we making?",
  kindAd: "Ad",
  kindShortFilm: "Short film",
  kindSocial: "Social",
  kindMusicVideo: "Music video",
  length: "How long?",
  sec6: "6 s",
  sec15: "15 s",
  sec30: "30 s",
  sec60: "60 s",
  min1: "1 min",
  min3: "3 min",
  min5: "5 min",
  plays: "Where does it play?",
  playsWide: "TV and cinema 16:9",
  playsPhone: "Phone 9:16",
  playsSquare: "Square 1:1",
  playsSeveral: "Several",
  language: "Which language?",
  hindi: "Hindi",
  english: "English",
  both: "Both",
  real: "Is anyone real in it?",
  realNoOne: "No one",
  realConsent: "Yes, and I have their consent",
  realNotYet: "Yes, not yet",
  realProduct: "A real product only",
  material: "What do you already have?",
  materialNothing: "Nothing yet",
  materialScript: "A script or deck",
  materialMedia: "Photos or clips",
  ceiling: "A spend limit for this film?",
  ceilingNone: "No limit",
  /** "No limit" as it reads inside "I assumed … · Change". */
  noLimit: "no limit",
  /** A row read in place of its question (R2, H): "I assumed Hindi · Change", "from the brief · Change" (with the step's name). */
  assumed: "I assumed",
  fromThe: "from the",
} as const;

/** Money words (rule 14; Amendment (ii) A3: "free" is lowercase). */
export const MONEY = {
  free: "free",
  nothingBilled: "Nothing billed",
  upTo: "up to",
  topUp: "Top up",
  history: "History",
  statement: "Download statement",
} as const;

/** The visitor site and "How Particl works" (v31.12–v31.16). */
export const SITE = {
  inviteOnly: "Invite only.",
  requestAccess: "Request access",
  signIn: "Sign in",
  howItWorks: "How Particl works",
} as const;

/** The whole table, by section; the strings test walks it. */
export const COPY = {
  STEPS, BUTTONS, MODES, THINKING, TICKS, CARD_STATES, ELEMENT_KINDS, SETTINGS, LIBRARY, PLACEHOLDERS, QUESTIONS, MONEY, SITE,
} as const;
