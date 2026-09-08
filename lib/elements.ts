import { db, ready, now, id } from "./db";
import { getSetting, setSetting } from "./settings";
import {
  attributesOf, elementKind, primaryAttribute, versionLine,
  citedStills, versionsFromTakes,
  type AttributeKind, type ElementKind, type Port, type Slot, type TakeRef,
} from "./rig";

/**
 * Rig's elements, read and written (brief 3).
 *
 * Every query here goes through db(), which hands out the database of the
 * workspace in scope and throws when there is none. There is no query in this
 * file that names a workspace, because there is no way to reach another one:
 * an element, its versions and its bindings live in the same single-tenant
 * database as the cast and the takes they describe.
 *
 * The shape of the layer is in lib/rig.ts, which is pure. This file is the
 * part that touches rows.
 */

export type ElementRow = {
  id: string;
  projectId: string | null;
  castId: string | null;
  kind: ElementKind;
  name: string;
  description: string;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: number | null;
  /** The take this was promoted from, when it was promoted from one. */
  fromShotId: string | null;
  fromGenId: string | null;
  createdAt: number;
};

export type VersionRow = {
  id: string;
  attributeId: string;
  elementId: string;
  label: string;
  uploadId: string | null;
  genId: string | null;
  identityId: string | null;
  status: "pending" | "ready" | "failed";
  createdAt: number;
};

export type AttributeRow = {
  id: string;
  elementId: string;
  kind: AttributeKind;
  label: string;
  currentId: string | null;
  locked: boolean;
  position: number;
  versions: VersionRow[];
};

export type BindingRow = {
  id: string;
  shotId: string;
  projectId: string | null;
  slot: Slot;
  ordinal: number;
  elementId: string;
  attributeId: string | null;
  versionId: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToElement(r: any): ElementRow {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    castId: r.cast_id ?? null,
    kind: elementKind(String(r.kind ?? "character")),
    name: String(r.name ?? ""),
    description: String(r.description ?? ""),
    locked: Number(r.locked ?? 0) === 1,
    lockedBy: r.locked_by ?? null,
    lockedAt: r.locked_at == null ? null : Number(r.locked_at),
    fromShotId: r.from_shot_id ?? null,
    fromGenId: r.from_gen_id ?? null,
    createdAt: Number(r.created_at),
  };
}

function rowToVersion(r: any): VersionRow {
  const status = String(r.status ?? "ready");
  return {
    id: r.id,
    attributeId: r.attribute_id,
    elementId: r.element_id,
    label: String(r.label ?? ""),
    uploadId: r.upload_id ?? null,
    genId: r.gen_id ?? null,
    identityId: r.identity_id ?? null,
    status: status === "pending" || status === "failed" ? status : "ready",
    createdAt: Number(r.created_at),
  };
}

function rowToBinding(r: any): BindingRow {
  return {
    id: r.id,
    shotId: r.shot_id,
    projectId: r.project_id ?? null,
    slot: String(r.slot) as Slot,
    ordinal: Number(r.ordinal ?? 0),
    elementId: r.element_id,
    attributeId: r.attribute_id ?? null,
    versionId: r.version_id ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ElementFull = ElementRow & { attributes: AttributeRow[] };

/** Everything in this production, plus everything shared across the workspace. */
export async function listElements(projectId?: string | null): Promise<ElementFull[]> {
  await ready();
  const rs = projectId
    ? await db().execute({
        sql: `SELECT * FROM elements WHERE project_id = ? OR project_id IS NULL ORDER BY kind, LOWER(name)`,
        args: [projectId],
      })
    : await db().execute(`SELECT * FROM elements ORDER BY kind, LOWER(name)`);

  const elements = rs.rows.map(rowToElement);
  if (!elements.length) return [];
  return withAttributes(elements);
}

export async function getElement(elementId: string): Promise<ElementFull | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM elements WHERE id = ?`, args: [elementId] });
  if (!rs.rows.length) return null;
  return (await withAttributes([rowToElement(rs.rows[0])]))[0];
}

/**
 * Attach every element's attributes and versions in two queries rather than
 * two per element. The canvas asks for the whole library at once.
 */
async function withAttributes(elements: ElementRow[]): Promise<ElementFull[]> {
  const ids = elements.map((e) => e.id);
  const holes = ids.map(() => "?").join(",");
  const [attrs, versions] = await Promise.all([
    db().execute({ sql: `SELECT * FROM element_attributes WHERE element_id IN (${holes}) ORDER BY position, rowid`, args: ids }),
    db().execute({ sql: `SELECT * FROM attribute_versions WHERE element_id IN (${holes}) ORDER BY created_at, rowid`, args: ids }),
  ]);

  const byAttr = new Map<string, VersionRow[]>();
  for (const row of versions.rows) {
    const v = rowToVersion(row);
    const list = byAttr.get(v.attributeId);
    if (list) list.push(v); else byAttr.set(v.attributeId, [v]);
  }

  const byElement = new Map<string, AttributeRow[]>();
  for (const row of attrs.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = row as any;
    const a: AttributeRow = {
      id: r.id, elementId: r.element_id, kind: String(r.kind) as AttributeKind,
      label: String(r.label ?? ""), currentId: r.current_id ?? null,
      locked: Number(r.locked ?? 0) === 1, position: Number(r.position ?? 0),
      versions: byAttr.get(r.id) ?? [],
    };
    const list = byElement.get(a.elementId);
    if (list) list.push(a); else byElement.set(a.elementId, [a]);
  }

  return elements.map((e) => ({ ...e, attributes: byElement.get(e.id) ?? [] }));
}

/* ── Writing ────────────────────────────────────────────────────────── */

export type NewElement = {
  name: string;
  kind: ElementKind;
  description?: string;
  projectId?: string | null;
  castId?: string | null;
  /** Promoted from a take: the origin, written once. */
  fromShotId?: string | null;
  fromGenId?: string | null;
};

/**
 * A new element, with the attributes its kind is made of already in place but
 * empty. An attribute with no versions binds to nothing and costs nothing; it
 * is there so the shape of a character is the same everywhere before anyone
 * has photographed a wardrobe.
 */
export async function createElement(input: NewElement, by: string): Promise<ElementFull> {
  await ready();
  const ts = now();
  const eid = id("el");
  await db().execute({
    sql: `INSERT INTO elements (id, project_id, cast_id, kind, name, description,
                                from_shot_id, from_gen_id, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [eid, input.projectId ?? null, input.castId ?? null, input.kind, input.name.trim(),
           (input.description ?? "").trim(), input.fromShotId ?? null, input.fromGenId ?? null, by, ts, ts],
  });

  const kinds = attributesOf(input.kind);
  for (let i = 0; i < kinds.length; i++) {
    await db().execute({
      sql: `INSERT INTO element_attributes (id, element_id, kind, label, position, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [id("attr"), eid, kinds[i], "", i, ts, ts],
    });
  }
  return (await getElement(eid))!;
}

export type VersionSource = { uploadId?: string | null; genId?: string | null; identityId?: string | null };

/**
 * A new version of one attribute.
 *
 * Additive by construction: nothing already rendered is touched, and the
 * attribute only starts pointing here when `makeCurrent` says so. That
 * separation is the seventh rule of the design — a version is free, the swap
 * is what costs — expressed as two writes rather than one.
 */
export async function addVersion(
  attributeId: string, source: VersionSource, opts: { label?: string; status?: VersionRow["status"]; makeCurrent?: boolean }, by: string,
): Promise<VersionRow | null> {
  await ready();
  const attr = await db().execute({ sql: `SELECT id, element_id FROM element_attributes WHERE id = ?`, args: [attributeId] });
  if (!attr.rows.length) return null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const elementId = String((attr.rows[0] as any).element_id);

  const sources = [source.uploadId, source.genId, source.identityId].filter(Boolean);
  if (sources.length !== 1) return null;

  const ts = now();
  const vid = id("ver");
  const status = opts.status ?? "ready";
  await db().execute({
    sql: `INSERT INTO attribute_versions (id, attribute_id, element_id, label, upload_id, gen_id, identity_id, status, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [vid, attributeId, elementId, (opts.label ?? "").trim(),
           source.uploadId ?? null, source.genId ?? null, source.identityId ?? null, status, by, ts],
  });
  // A version whose views are still rendering is not something to point at yet.
  if (opts.makeCurrent && status === "ready") await setCurrentVersion(attributeId, vid);

  const rs = await db().execute({ sql: `SELECT * FROM attribute_versions WHERE id = ?`, args: [vid] });
  return rowToVersion(rs.rows[0]);
}

/** Point an attribute at one of its versions. What this costs is the quote engine's business. */
export async function setCurrentVersion(attributeId: string, versionId: string | null): Promise<void> {
  await ready();
  await db().execute({
    sql: `UPDATE element_attributes SET current_id = ?, updated_at = ? WHERE id = ?`,
    args: [versionId, now(), attributeId],
  });
}

export async function setElementLock(elementId: string, locked: boolean, by: string): Promise<void> {
  await ready();
  const ts = now();
  await db().execute({
    sql: `UPDATE elements SET locked = ?, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?`,
    args: [locked ? 1 : 0, locked ? by : null, locked ? ts : null, ts, elementId],
  });
}

/* ── Bindings ───────────────────────────────────────────────────────────
   One row per slot per shot. Writing the same slot twice replaces it, which
   is what the design means by a wire landing on a slot: a slot holds one
   wire, and dropping a new one on it takes the old one off. */

export async function listBindings(shotId: string): Promise<BindingRow[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM bindings WHERE shot_id = ? ORDER BY slot, ordinal`,
    args: [shotId],
  });
  return rs.rows.map(rowToBinding);
}

export async function bindingsForProject(projectId: string): Promise<BindingRow[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM bindings WHERE project_id = ? ORDER BY shot_id, slot, ordinal`,
    args: [projectId],
  });
  return rs.rows.map(rowToBinding);
}

export async function setBinding(
  input: { shotId: string; slot: Slot; ordinal?: number; port: Port }, by: string,
): Promise<BindingRow | null> {
  await ready();
  const ts = now();
  const ordinal = Number.isInteger(input.ordinal) ? Number(input.ordinal) : 0;
  const bid = id("bind");

  /* The production is read off the shot, never taken from the caller. It is
     denormalised here so that scoping an impact query and cascading a project
     delete are each one filter, and a copy that disagrees with the shot would
     quietly break both: the shot would go missing from its own production's
     count, and its binding would survive that production being deleted. */
  const shot = await db().execute({ sql: `SELECT project_id FROM shots WHERE id = ?`, args: [input.shotId] });
  if (!shot.rows.length) return null;
  const projectId = (shot.rows[0] as unknown as { project_id: string | null }).project_id ?? null;
  await db().execute({
    sql: `INSERT INTO bindings (id, shot_id, project_id, slot, ordinal, element_id, attribute_id, version_id, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (shot_id, slot, ordinal) DO UPDATE SET
            element_id = excluded.element_id,
            attribute_id = excluded.attribute_id,
            version_id = excluded.version_id,
            project_id = excluded.project_id,
            updated_at = excluded.updated_at`,
    args: [bid, input.shotId, projectId, input.slot, ordinal,
           input.port.elementId, input.port.attributeId, input.port.versionId, by, ts, ts],
  });
  const rs = await db().execute({
    sql: `SELECT * FROM bindings WHERE shot_id = ? AND slot = ? AND ordinal = ?`,
    args: [input.shotId, input.slot, ordinal],
  });
  return rowToBinding(rs.rows[0]);
}

export async function clearBinding(shotId: string, slot: Slot, ordinal = 0): Promise<boolean> {
  await ready();
  const rs = await db().execute({
    sql: `DELETE FROM bindings WHERE shot_id = ? AND slot = ? AND ordinal = ?`,
    args: [shotId, slot, ordinal],
  });
  return rs.rowsAffected > 0;
}

/* ── The reverse lookup ─────────────────────────────────────────────────
   Which shots move if this version changes. It is the query the impact
   panel counts and the quote engine multiplies, so it is an index scan on
   bindings and never a scan of anything larger. */

export type Dependent = { shotId: string; projectId: string | null; slots: Slot[]; pinned: boolean };

export async function dependentsOf(
  elementId: string, attributeId: string, versionId: string,
  opts: { projectId?: string | null; following?: boolean } = {},
): Promise<Dependent[]> {
  await ready();
  /* The element is named first and is not optional. A bundle binding carries
     no attribute, so a query that asked only about the attribute would match
     every bundle in the workspace: add one plate to a location and every
     character wired as a bundle would be counted, and the producer would be
     quoted for shots the change cannot reach.

     Within one element, a binding reaches this version three ways: it follows
     the element and takes whatever is current, it is pinned to this exact
     version, or it takes the bundle and so follows every attribute at once. A
     binding pinned to some other version is not affected and is not counted.

     Only shots whose row still exists count. Foreign keys are declared and not
     enforced here, so the join is what keeps a shot somebody deleted from
     going on voting for what a change costs. */
  /* Two different questions, and confusing them costs money.

     By default: which ports does a change TO THIS VERSION reach — a port
     pinned to it is reached, because it is that version.

     `following`: which ports would MOVE if current changed. A pinned port
     does not move, whatever it is pinned to. Asking the first question about
     a swap counts shots already sitting on the target, prices a re-render
     that cannot change their output, and un-approves them for it. */
  const args: (string | null)[] = [elementId, attributeId, versionId];
  let sql = `SELECT b.* FROM bindings b
             JOIN shots s ON s.id = b.shot_id
             WHERE b.element_id = ?
               AND (b.attribute_id = ? OR b.attribute_id IS NULL)
               AND ${opts.following ? "b.version_id IS NULL" : "(b.version_id IS NULL OR b.version_id = ?)"}`;
  if (opts.following) args.pop();
  if (opts.projectId) { sql += ` AND s.project_id = ?`; args.push(opts.projectId); }
  sql += ` ORDER BY b.shot_id, b.slot, b.ordinal`;
  const rs = await db().execute({ sql, args });

  /* One entry per SHOT, not per wire. The panel counts shots and multiplies a
     per-shot price, so a shot that wires the same element into two slots must
     not be re-rendered twice or quoted twice. */
  const byShot = new Map<string, Dependent>();
  for (const b of rs.rows.map(rowToBinding)) {
    const found = byShot.get(b.shotId);
    if (found) {
      if (!found.slots.includes(b.slot)) found.slots.push(b.slot);
      found.pinned = found.pinned && b.versionId !== null;
    } else {
      byShot.set(b.shotId, {
        shotId: b.shotId, projectId: b.projectId, slots: [b.slot], pinned: b.versionId !== null,
      });
    }
  }
  return [...byShot.values()];
}

/* ── The backfill ───────────────────────────────────────────────────────
   What 1.0 shipped, read into the shape Rig needs, once per workspace.

   It mirrors each cast member into an element and gives it the versions its
   own takes prove it was rendered with. It writes no bindings: a shot with
   no binding behaves exactly as it does today, and that is what lets a
   workspace that never opens Rig carry on as if none of this existed.

   Idempotent, and cheap the second time: the marker is a settings key, and
   every insert is guarded by whether the element already exists. */

const MARK = "rigBackfilledAt";

/** How many cast members one call will mirror before handing back. */
const SLICE = 25;

export type Backfill = { elements: number; versions: number; skipped: number; remaining: number };

/**
 * Mirror what has not been mirrored yet, and say what is left.
 *
 * Bounded on purpose. A workspace with a long cast and years of takes is more
 * work than one request should hold, and a request that dies halfway used to
 * be the worst case: rows written, no marker, and the half-built elements
 * skipped forever by a guard that only asked whether an element existed. Now
 * a slice is finished before the next is begun, an element that exists but was
 * never given its versions is picked up again, and the marker is written only
 * when there is nothing left to do.
 */
export async function ensureRig(by = "system"): Promise<Backfill> {
  await ready();
  if (await getSetting(MARK)) return { elements: 0, versions: 0, skipped: 0, remaining: 0 };
  const report = await backfillRig(by, SLICE);
  if (report.remaining === 0) await setSetting(MARK, String(now()), by);
  return report;
}

export async function backfillRig(by = "system", slice = SLICE): Promise<Backfill> {
  await ready();
  const cast = await db().execute(
    `SELECT id, project_id, name, kind, description, upload_id FROM cast_members ORDER BY created_at, id`);

  /* What is already mirrored, and whether the run that mirrored it finished.
     An element written without its versions is one an interrupted run left
     half-built, so it is picked up where it stopped rather than skipped for
     good. A cast member with nothing to give is finished all the same, which
     is what stops it being retried on every call for ever. */
  const mirrored = await db().execute(
    `SELECT cast_id, mirrored_at FROM elements WHERE cast_id IS NOT NULL`);
  const done = new Map<string, boolean>();
  for (const r of mirrored.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const row = r as any;
    done.set(String(row.cast_id), row.mirrored_at != null);
  }

  /* Every take that cited a name, with the words the compiler wrote and the
     files it attached. Both are needed together: the citation line names the
     image index, and the reference list says which file that index was.

     Soft-deleted takes are read too. A binned render still recorded what went
     into it, and leaving it out moves the still it used later in the sequence,
     which would number an older wardrobe as the newer version. */
  const takes = await db().execute(
    `SELECT project_id, prompt, params, created_at FROM generations
     WHERE params LIKE '%"cast"%' ORDER BY created_at ASC`);
  const history: { projectId: string | null; compiled: string; refs: TakeRef[]; createdAt: number }[] = [];
  for (const row of takes.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = row as any;
    let refs: TakeRef[] = [];
    try { refs = (JSON.parse(String(r.params ?? "{}")).references ?? []) as TakeRef[]; } catch { refs = []; }
    history.push({ projectId: r.project_id ?? null, compiled: String(r.prompt ?? ""), refs, createdAt: Number(r.created_at) });
  }

  let elements = 0, versions = 0, skipped = 0, remaining = 0, worked = 0;
  for (const row of cast.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const c = row as any;
    const castId = String(c.id);
    const seen = done.get(castId);
    if (seen === true) { skipped++; continue; }
    if (worked >= slice) { remaining++; continue; }
    worked++;

    const kind = elementKind(String(c.kind ?? "character"));
    const projectId: string | null = c.project_id ?? null;

    let element: ElementFull | null = null;
    if (seen === undefined) {   // never mirrored

      try {
        element = await createElement({
          name: String(c.name ?? ""), kind, description: String(c.description ?? ""),
          projectId, castId,
        }, by);
        elements++;
      } catch (e) {
        /* Someone else mirrored this cast member between the read above and
           this insert. The unique index on elements(cast_id) is what turns a
           race into a skip instead of a second copy of the whole cast. */
        if (!/unique|constraint/i.test((e as Error).message)) throw e;
        skipped++;
        continue;
      }
    } else {
      element = await elementForCast(castId);
      if (!element) { skipped++; continue; }
    }

    const attr = element.attributes.find((a) => a.kind === primaryAttribute(kind));
    if (!attr) { skipped++; continue; }

    /* A cast member filed under a production only ever appeared in that
       production's prompts, and names are unique per production rather than
       per workspace. Reading the whole workspace's takes would give two
       productions that each have a Maya the other one's photographs. */
    const scoped = projectId ? history.filter((h) => h.projectId === projectId) : history;
    const uploads = versionsFromTakes(String(c.name ?? ""), scoped, c.upload_id ?? null);
    const had = new Set(attr.versions.map((v) => v.uploadId ?? ""));
    for (const uploadId of uploads) {
      if (had.has(uploadId)) continue;   // a resumed run: this one already landed
      const v = await addVersion(attr.id, { uploadId },
        { label: "", makeCurrent: uploadId === (c.upload_id ?? null) }, by);
      if (v) versions++;
    }
    /* Nothing was ever rendered with this name and it has no still. The
       element exists so it can be given one; it has no version to invent. */
    if (!uploads.length) skipped++;

    await db().execute({
      sql: `UPDATE elements SET mirrored_at = ?, updated_at = ? WHERE id = ?`,
      args: [now(), now(), element.id],
    });
  }
  return { elements, versions, skipped, remaining };
}

async function elementForCast(castId: string): Promise<ElementFull | null> {
  const rs = await db().execute({ sql: `SELECT id FROM elements WHERE cast_id = ?`, args: [castId] });
  if (!rs.rows.length) return null;
  return getElement(String((rs.rows[0] as unknown as { id: string }).id));
}

/** For the report the backfill writes: what each version came out as. */
export const describeVersion = (v: VersionRow, index: number): string => versionLine(index, v.label);

/** Exported for the tests that read a take's citations without a database. */
export { citedStills };
