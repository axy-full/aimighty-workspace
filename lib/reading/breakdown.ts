import { z } from "zod";
import type { AtomikTurn } from "@/lib/atomikModelPolicy";
import { READING } from "@/lib/copy";
import { engineMock } from "@/lib/mock";
import type { ReadingBlock } from "./shapes";

/**
 * The breakdown of a brief or a script, kept as a Reading item (owner, 25 Oct 2026; SOW v2 §9 Brief and Script, Part II.1 and
 * II.2, cited only). What the film is, the hook, the penny-drop moment, the tonality with its reason, the pace, the moments, what
 * we already have and what is still open; for a script, one entry per scene or beat. A story told back, not a list of fields.
 *
 * Nothing invented: every line stands on blocks of the reading it was written from (`cites`), and a line whose citation is not a
 * block of that reading fails the breakdown. What is still open is the one list without citations, since it names what no
 * source says.
 *
 * Two slots, never named here: the Treatment writer writes the prose (`WRITE_TURN`, lib/atomikThinking › textJobPick), and the
 * production's Thinking setting checks it against the source (`CHECK_TURN`, the setting's own slot, not the judge's). Mock engine
 * only in this PR: off ENGINE_MOCK there is no writer here yet, and the answer is "Nothing billed". The price is its own money
 * PR; nothing here bills. Where a breakdown is kept waits for the owner's word, so the store is a stub and the answer says
 * `stored: false`.
 */

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const words = (max: number) => z.string().trim().min(1).max(max);

/** A pointer into a reading: the block a line stands on (document_blocks: reading, page, seq). */
export const citation = z.object({ readingId: z.string().regex(ID), page: z.number().int().min(1), seq: z.number().int().min(0) }).strict();
export type Citation = z.infer<typeof citation>;

/** One line of the breakdown, with the blocks it stands on. */
export const citedLine = z.object({ text: words(2000), cites: z.array(citation).min(1).max(20) }).strict();
export type CitedLine = z.infer<typeof citedLine>;

/** A brief's breakdown: one kind of breakdown per page when shown (the presentation is v31.17's). */
export const briefBreakdown = z.object({
  kind: z.literal("brief"),
  /** What the film is. */
  summary: citedLine.nullable(),
  hook: citedLine.nullable(),
  pennyDrop: citedLine.nullable(),
  /** The tone in one word (the owner's or the person's own), and why. */
  tonality: z.object({ word: words(40), reason: citedLine }).strict().nullable(),
  /** Montage or not, high speed or not: null where no source says. */
  pace: z.object({ montage: z.boolean().nullable(), highSpeed: z.boolean().nullable(), note: citedLine.nullable() }).strict(),
  moments: z.array(citedLine).max(30),
  /** What we already have. */
  have: z.array(citedLine).max(50),
  /** What is still open: named, never cited, never guessed. */
  open: z.array(words(200)).max(50),
}).strict();
export type BriefBreakdown = z.infer<typeof briefBreakdown>;

const names = z.array(words(120)).max(30);

/** One scene or beat of a script's breakdown: what happens, who is in it, the lines, its tone, where it lands, what it needs. */
export const scriptEntry = z.object({
  n: z.number().int().min(1),
  unit: z.enum(["scene", "beat"]),
  happens: citedLine,
  who: names,
  lines: z.array(citedLine).max(60),
  tone: citedLine.nullable(),
  lands: citedLine.nullable(),
  needs: z.object({ cast: names, props: names, place: names, words: names }).strict(),
}).strict();
export type ScriptEntry = z.infer<typeof scriptEntry>;

/** A script's breakdown: one entry per scene or beat, numbered in order from 1. */
export const scriptBreakdown = z.object({ kind: z.literal("script"), entries: z.array(scriptEntry).min(1).max(1000) }).strict()
  .refine((b) => b.entries.every((entry, i) => entry.n === i + 1), { message: "entries are numbered in order from 1" });
export type ScriptBreakdown = z.infer<typeof scriptBreakdown>;

export const breakdown = z.union([briefBreakdown, scriptBreakdown]);
export type Breakdown = z.infer<typeof breakdown>;

/** The Reading item: the breakdown, the reading it stands on, and the two slots that made it (by role, never by model). */
export const breakdownItem = z.object({
  readingId: z.string().regex(ID),
  breakdown,
  writtenBy: z.literal("treatment_writer"),
  checkedBy: z.literal("thinking"),
}).strict();
export type BreakdownItem = z.infer<typeof breakdownItem>;

/** The turn that writes it: the Treatment writer's slot (lib/atomikThinking › textJobPick). */
export const WRITE_TURN = "breakdown" as const;
/** The turn that checks it: the production's Thinking setting, as a plan is (the judge's Low slot is not this check). */
export const CHECK_TURN: AtomikTurn = "plan";

/** Every citation in a breakdown. */
export function citationsOf(item: Breakdown): Citation[] {
  const lines: (CitedLine | null)[] = item.kind === "brief"
    ? [item.summary, item.hook, item.pennyDrop, item.tonality?.reason ?? null, item.pace.note, ...item.moments, ...item.have]
    : item.entries.flatMap((e) => [e.happens, e.tone, e.lands, ...e.lines]);
  return lines.flatMap((line) => line?.cites ?? []);
}

/** The citations that are not blocks of this reading (nothing invented): empty when every line stands on the source. */
export function danglingCitations(item: Breakdown, readingId: string, blocks: readonly ReadingBlock[]): Citation[] {
  const held = new Set(blocks.map((b) => `${b.page}:${b.seq}`));
  return citationsOf(item).filter((c) => c.readingId !== readingId || !held.has(`${c.page}:${c.seq}`));
}

export type BreakdownInput = { readingId: string; kind: "brief" | "script"; blocks: readonly ReadingBlock[] };

/** The writer: given the reading's blocks, a draft breakdown (unchecked; it is parsed here). */
export type BreakdownWriter = (input: BreakdownInput) => Promise<unknown>;
/** The check against the source, at the production's Thinking: whether the draft holds, with no text echoed back. */
export type BreakdownChecker = (draft: Breakdown, input: BreakdownInput) => Promise<{ holds: boolean }>;

/** Where a breakdown is kept. Until the owner says where, nothing is kept. */
export type BreakdownStore = { readonly keeps: boolean; put(item: BreakdownItem): Promise<void> };
export const stubBreakdownStore: BreakdownStore = { keeps: false, async put() {} };

export type BreakdownErrorCode = "writer_unavailable" | "bad_breakdown" | "uncited" | "check_failed";
export type BreakdownOutput =
  | { state: "done"; item: BreakdownItem; stored: boolean }
  | { state: "failed"; errorCode: BreakdownErrorCode; message: string };

const failed = (errorCode: BreakdownErrorCode): BreakdownOutput =>
  ({ state: "failed", errorCode, message: errorCode === "writer_unavailable" ? READING.unavailable : READING.breakdownFailed });

const blockInput = z.object({
  readingId: z.string().regex(ID),
  kind: z.enum(["brief", "script"]),
  blocks: z.array(z.object({ page: z.number().int().min(1), seq: z.number().int().min(0) }).passthrough()).min(1),
}).strict();

/**
 * Write the breakdown of one reading, check it, and keep it. The writer and the checker are the two slots; the defaults are the
 * mock engine's under ENGINE_MOCK=1 and nothing elsewhere. A failure answers a code and fixed words, never the source's text.
 */
export async function writeBreakdown(
  input: BreakdownInput,
  deps: { write?: BreakdownWriter | null; check?: BreakdownChecker | null; store?: BreakdownStore } = {},
): Promise<BreakdownOutput> {
  blockInput.parse(input);
  const write = deps.write === undefined ? (engineMock() ? mockBreakdownWriter : null) : deps.write;
  const check = deps.check === undefined ? (engineMock() ? mockBreakdownChecker : null) : deps.check;
  if (!write || !check) return failed("writer_unavailable");
  let draft: Breakdown;
  try {
    const parsed = breakdown.safeParse(await write(input));
    if (!parsed.success || parsed.data.kind !== input.kind) return failed("bad_breakdown");
    draft = parsed.data;
  } catch {
    return failed("writer_unavailable");
  }
  if (danglingCitations(draft, input.readingId, input.blocks).length) return failed("uncited");
  try {
    if (!(await check(draft, input)).holds) return failed("check_failed");
  } catch {
    return failed("writer_unavailable");
  }
  const item = breakdownItem.parse({ readingId: input.readingId, breakdown: draft, writtenBy: "treatment_writer", checkedBy: "thinking" });
  const store = deps.store ?? stubBreakdownStore;
  await store.put(item);
  return { state: "done", item, stored: store.keeps };
}

const cite = (input: BreakdownInput, block: ReadingBlock): CitedLine =>
  ({ text: block.text.trim().slice(0, 2000), cites: [{ readingId: input.readingId, page: block.page, seq: block.seq }] });

/**
 * The mock writer: a deterministic breakdown built from the blocks alone, every line citing the block it came from. A brief's
 * summary is its first paragraph and its moments its headings; a script's entries are its headings, one per scene.
 */
export async function mockBreakdownWriter(input: BreakdownInput): Promise<Breakdown> {
  const text = input.blocks.filter((b) => b.text.trim());
  const headings = text.filter((b) => b.kind === "heading" || b.kind === "title");
  const paragraphs = text.filter((b) => b.kind === "paragraph");
  if (input.kind === "script") {
    const scenes = (headings.length ? headings : text.slice(0, 1)).map((b, i): ScriptEntry => ({
      n: i + 1, unit: "scene", happens: cite(input, b), who: [], lines: [], tone: null, lands: null, needs: { cast: [], props: [], place: [], words: [] },
    }));
    return { kind: "script", entries: scenes };
  }
  return {
    kind: "brief",
    summary: paragraphs[0] ? cite(input, paragraphs[0]) : text[0] ? cite(input, text[0]) : null,
    hook: null, pennyDrop: null, tonality: null,
    pace: { montage: null, highSpeed: null, note: null },
    moments: headings.slice(0, 30).map((b) => cite(input, b)),
    have: [],
    open: ["hook", "penny drop", "tonality", "pace"],
  };
}

/** The mock check: holds when every line stands on a block of this reading. */
export async function mockBreakdownChecker(draft: Breakdown, input: BreakdownInput): Promise<{ holds: boolean }> {
  return { holds: danglingCitations(draft, input.readingId, input.blocks).length === 0 };
}
