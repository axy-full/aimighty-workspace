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
 */
import { db, ready } from "@/lib/db";

export type StyleExample = { prompt: string; shot: string | null };

const MAX_EXAMPLES = 6;
const MAX_CHARS = 700;

/** Cached briefly: this runs on the render path and changes only on approval. */
let cache: { at: number; key: string; examples: StyleExample[] } | null = null;
const TTL = 60_000;

/**
 * The most recently approved renders for a project, falling back to the
 * workspace's own approved work when a project has none of its own yet.
 */
export async function houseStyle(projectId: string | null): Promise<StyleExample[]> {
  const key = projectId ?? "*";
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.examples;

  await ready();
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
            ORDER BY g.reviewed_at DESC
            LIMIT ?`,
      args: scoped ? [MAX_CHARS, projectId, MAX_EXAMPLES] : [MAX_CHARS, MAX_EXAMPLES],
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

  cache = { at: Date.now(), key, examples };
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
