import { db, ready, now } from "./db";
import { listBindings } from "./elements";
import { portKey, expandPorts, type Port } from "./rig";

/**
 * What produced a take (brief 3, surface 1c).
 *
 * Written once, when the take is made, and never afterwards. That is the
 * whole discipline: a record that can be edited later is not a record, and
 * the question this answers — what exactly made this, so I can make another
 * like it — is worthless if the answer drifts with the library.
 *
 * The port triple `elementId:attributeId:versionId` is recorded here exactly
 * as the wire carried it and the compiler resolved it. One function produces
 * all three, which is what stops the canvas, the render and the record from
 * disagreeing about what a shot was made with.
 *
 * Three things the original schema plan called out as unrecoverable for old
 * takes start being recorded here, and only from here: the seed, the ids of
 * the rules in scope, and the ports. Nothing is backfilled onto takes made
 * before this, because a provenance card that guessed would be worse than
 * one that says it does not know.
 */

export type Conditions = {
  /** What the file is, and what the engine metered. */
  width: number | null;
  height: number | null;
  billedWidth: number | null;
  billedHeight: number | null;
  durationSeconds: number | null;
  /** The number the engine was given, when it takes one. Null means unrecorded. */
  seed: number | null;
};

export type Recorded = {
  engine: string;
  model: string;
  provider: string;
  /** The port triples in force, as strings, in slot order. */
  ports: string[];
  /** The names the prompt cited. */
  cast: string[];
  /** The Setup carried in, as the composer sent it. */
  setup: Record<string, string>;
  /** The ids of the rules that applied, so the card can name them later. */
  rules: string[];
  conditions: Conditions;
  by: string;
  at: number;
};

export type PortRow = { elementId: string; attributeId: string | null; versionId: string | null; slot: string; ordinal: number };

/**
 * Record what made this take.
 *
 * Best effort by design: a render that succeeded must not be reported as
 * failed because the note about it could not be filed. The caller writes the
 * take first and calls this after.
 */
export async function recordProvenance(
  takeId: string, shotId: string | null, recorded: Recorded, ports: PortRow[],
): Promise<void> {
  try {
    await ready();
    const ts = now();
    await db().execute({
      sql: `INSERT INTO take_provenance (take_id, shot_id, recorded, created_at) VALUES (?,?,?,?)
            ON CONFLICT(take_id) DO NOTHING`,
      args: [takeId, shotId, JSON.stringify(recorded), ts],
    });
    for (const p of ports) {
      await db().execute({
        sql: `INSERT INTO take_ports (take_id, element_id, attribute_id, version_id, slot, ordinal, created_at)
              VALUES (?,?,?,?,?,?,?)`,
        args: [takeId, p.elementId, p.attributeId, p.versionId, p.slot, p.ordinal, ts],
      });
    }
  } catch {
    /* The take is real whatever happened here. */
  }
}

/**
 * The ports a shot's bindings resolve to at this moment.
 *
 * A binding that follows current is recorded as the version it actually
 * resolved to, not as "current" — six months later "current" means something
 * else, and the point of the record is to survive that.
 */
export async function portsForShot(shotId: string): Promise<{ rows: PortRow[]; keys: string[] }> {
  await ready();
  const bindings = await listBindings(shotId);
  if (!bindings.length) return { rows: [], keys: [] };

  /* A BUNDLE is expanded, not recorded as itself — the rule lives in
     lib/rig.ts as `expandPorts`, pure and tested, because provenance records
     its output and the version counts read it back. */
  const elementIds = [...new Set(bindings.map((b) => b.elementId))];
  const attrsOf = new Map<string, { id: string; currentId: string | null }[]>();
  if (elementIds.length) {
    const holes = elementIds.map(() => "?").join(",");
    const rs = await db().execute({
      sql: `SELECT id, element_id, current_id FROM element_attributes
            WHERE element_id IN (${holes}) ORDER BY position, rowid`,
      args: elementIds,
    });
    for (const r of rs.rows) {
      const row = r as unknown as { id: string; element_id: string; current_id: string | null };
      const list = attrsOf.get(String(row.element_id)) ?? [];
      list.push({ id: String(row.id), currentId: row.current_id ?? null });
      attrsOf.set(String(row.element_id), list);
    }
  }

  const rows: PortRow[] = expandPorts(bindings, (id) => attrsOf.get(id) ?? []);
  const keys = rows.map((r) => portKey({
    elementId: r.elementId, attributeId: r.attributeId, versionId: r.versionId,
  } as Port));
  return { rows, keys };
}

/* ── Reading it back ────────────────────────────────────────────────── */

export type Provenance = { takeId: string; shotId: string | null; recorded: Recorded; at: number };

export async function provenanceOf(takeId: string): Promise<Provenance | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM take_provenance WHERE take_id = ?`, args: [takeId] });
  if (!rs.rows.length) return null;
  const r = rs.rows[0] as unknown as { take_id: string; shot_id: string | null; recorded: string; created_at: number };
  try {
    return { takeId: String(r.take_id), shotId: r.shot_id ?? null, recorded: JSON.parse(r.recorded), at: Number(r.created_at) };
  } catch { return null; }
}

/** Which takes were made with a given version. The question the blob cannot answer. */
export async function takesWithVersion(versionId: string): Promise<string[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT DISTINCT take_id FROM take_ports WHERE version_id = ?`,
    args: [versionId],
  });
  return rs.rows.map((r) => String((r as unknown as { take_id: string }).take_id));
}
