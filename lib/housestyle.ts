/**
 * House style — the studio's own approved work, used as examples.
 *
 * Every other part of the prompt engine makes prompts that are generically
 * good. This is the part that makes them YOURS. The workspace already records
 * an approve / ask-for-changes decision per shot, which means it is sitting on
 * the one dataset nobody else has: prompts this team looked at, rendered, and
 * signed off.
 *
 * Those become few-shot examples. The refiner stops guessing at a house voice
 * and starts copying the one it is shown — the restraint, the vocabulary, the
 * length people here actually approve. It compounds: the more work gets
 * approved, the more the writing converges on the studio's taste.
 *
 * Two deliberate constraints:
 *  • Only APPROVED renders. A prompt nobody signed off is not evidence.
 *  • Ordered oldest-first and capped, so the block is STABLE between calls —
 *    an unstable prefix would invalidate the prompt cache on every render and
 *    quietly cost full price for something meant to be nearly free.
 *
 * And one that is about whose work it is: the examples go into the system
 * prompt of whoever is rendering, so they come only from takes THAT PERSON may
 * read, by the one definition the takes list uses (lib/draftProject.ts ›
 * visibleBoardsOfTakes + visibleTakesClause): another member's private board is
 * never an example, a shared board's and an unfiled take's are. The workspace is
 * the tenant database in scope (`db()`), so another workspace's work is never
 * read, and the memo (lib/memo.ts) is keyed by workspace, person and project.
 */
import { db, ready } from "@/lib/db";
import { visibleBoardsOfTakes, visibleTakesClause, type Viewer } from "@/lib/draftProject";
import { memoGet, memoPut } from "./memo";

export type StyleExample = { prompt: string; shot: string | null };

const MAX_EXAMPLES = 6;
const MAX_CHARS = 700;

/** Cached briefly: this runs on the render path and changes only on approval. */
const TTL = 60_000;

/**
 * The most recently approved renders for a project, falling back to the
 * workspace's own approved work when a project has none of its own yet, in
 * both cases only what `person` may read (the person rendering; nobody, for
 * background work, reads as the takes list reads it).
 */
export async function houseStyle(person: Viewer, projectId: string | null): Promise<StyleExample[]> {
  /* Per person: the same project reads differently to different people, so a block built for one is never handed to another. */
  const key = `house-style:${person?.id ?? "-"}:${projectId ?? "*"}`;
  const hit = memoGet<StyleExample[]>(key, TTL);
  if (hit) return hit;

  await ready();
  /* The takes list's own rule: a private board's takes only for those who may see them (null: nothing to hide). */
  const visible = await visibleBoardsOfTakes(person);
  const readable = visible ? visibleTakesClause(visible) : null;
  const pick = async (scoped: boolean) => {
    const rs = await db().execute({
      sql: `SELECT g.prompt, g.params, s.code AS shot_code
            FROM generations g
            LEFT JOIN shots s ON s.id = g.shot_id
            WHERE g.review_state = 'approved'
              AND g.deleted = 0
              AND g.status = 'succeeded'
              AND LENGTH(g.prompt) BETWEEN 40 AND ?
              ${scoped ? "AND g.project_id = ?" : ""}
              ${readable ? `AND ${readable.sql}` : ""}
            ORDER BY g.reviewed_at DESC
            LIMIT ?`,
      args: [MAX_CHARS, ...(scoped ? [projectId] : []), ...(readable ? readable.args : []), MAX_EXAMPLES] as (string | number | null)[],
    });
    return rs.rows;
  };

  let rows = projectId ? await pick(true) : [];
  if (rows.length < 2) rows = await pick(false);

  const examples: StyleExample[] = rows.map((r) => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const row = r as any;
    return { prompt: String(row.prompt ?? "").trim(), shot: row.shot_code ?? null };
  }).filter((e) => e.prompt);

  // Oldest first: a stable order keeps the cached prefix intact between
  // renders. Newest-first would reshuffle the block every time somebody
  // approved a shot, and every render after that would miss the cache.
  examples.reverse();

  memoPut(key, examples);
  return examples;
}

/** The block that goes into the system prompt, or "" when there is nothing yet. */
export function houseStyleBlock(examples: StyleExample[]): string {
  if (examples.length < 2) return "";
  const body = examples
    .map((e, i) => `Example ${i + 1}${e.shot ? ` (${e.shot})` : ""}:\n${e.prompt}`)
    .join("\n\n");
  return `THE HOUSE STYLE
These are prompts this studio rendered and APPROVED. They are the standard to match — their level of detail, their restraint, their vocabulary, their length. Where your instinct and these examples disagree, follow the examples: this is the work the people you are writing for actually sign off.

${body}`;
}
