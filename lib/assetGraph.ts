import { db, ready } from "./db";
import { listElements, bindingsForProject, type ElementFull } from "./elements";
import { versionLine, SLOT_LABELS, type Slot } from "./rig";
import type { AssetIn, ShotIn, SlotIn, WireKind } from "./graph";

/**
 * The asset layer's data (brief 3, surface 2a).
 *
 * This is where the port model stops being a schema and becomes a picture.
 * An element's attributes are its ports; a shot's bindings are its slots; and
 * a wire between them carries one of three meanings that the binding row
 * already holds, so the drawing and the database cannot drift:
 *
 *   inherited  version_id IS NULL   the slot follows whatever is current
 *   override   version_id set       the slot is pinned and will not follow
 *   created    the element's from_gen_id is set — it was promoted from a take
 *
 * Tenant-scoped: everything here reads through db().
 */

export type AssetLink = {
  key: string;
  elementId: string;
  attributeId: string | null;
  shotId: string;
  slot: string;
  kind: WireKind;
};

export type AssetGraph = {
  assets: AssetIn[];
  shots: ShotIn[];
  links: AssetLink[];
  counts: { locked: number; overrides: number; created: number };
};

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function assetGraphOf(projectId: string): Promise<AssetGraph> {
  await ready();

  const [elements, bindings, shotRows] = await Promise.all([
    listElements(projectId),
    bindingsForProject(projectId),
    db().execute({
      sql: `SELECT id, code, title, status FROM shots WHERE project_id = ? ORDER BY position, code`,
      args: [projectId],
    }),
  ]);

  const byElement = new Map(elements.map((e) => [e.id, e]));

  /* Only the elements this production actually wires to. A library of forty
     drawn beside four shots is a picture of the library, not of the
     production, and the surface exists to show how the two connect. */
  const used = new Set(bindings.map((b) => b.elementId));
  const shown = elements.filter((e) => used.has(e.id));

  const assets: AssetIn[] = shown.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    locked: e.locked,
    origin: e.fromGenId ? "CREATED FROM A TAKE" : null,
    ports: e.attributes.map((a) => {
      const current = a.versions.find((v) => v.id === a.currentId) ?? null;
      const index = current ? a.versions.findIndex((v) => v.id === current.id) : -1;
      return {
        id: a.id,
        label: a.kind.toUpperCase(),
        version: current ? versionLine(index, current.label) : "none",
        /* An attribute nothing is bound to, or that has no version yet, is
           drawn at half strength: it is a port that exists and is not in use,
           which is a different thing from one that is. */
        idle: !current || !bindings.some((b) => b.attributeId === a.id),
      };
    }),
  }));

  const bySlotKey = (b: { shotId: string; slot: string; ordinal: number }) => `${b.shotId}:${b.slot}:${b.ordinal}`;

  const shots: ShotIn[] = shotRows.rows.map((r) => {
    const row = r as any;
    const mine = bindings.filter((b) => b.shotId === String(row.id));
    const slots: SlotIn[] = mine.map((b) => {
      const el = byElement.get(b.elementId);
      const attr = el?.attributes.find((a) => a.id === b.attributeId) ?? null;
      const pinned = b.versionId
        ? attr?.versions.find((v) => v.id === b.versionId) ?? null
        : attr
          ? attr.versions.find((v) => v.id === attr.currentId) ?? null
          : null;
      const index = attr && pinned ? attr.versions.findIndex((v) => v.id === pinned.id) : -1;
      return {
        id: bySlotKey(b),
        slot: SLOT_LABELS[b.slot as Slot] ?? b.slot.toUpperCase(),
        label: el?.name ?? "—",
        version: pinned ? versionLine(index, pinned.label) : attr ? "none" : "all current",
        overridden: b.versionId !== null,
      };
    });
    return {
      id: String(row.id),
      code: String(row.code ?? ""),
      title: String(row.title ?? ""),
      slots,
      state: String(row.status ?? "open"),
      credits: 0,
    };
  }).filter((s) => s.slots.length);

  const links: AssetLink[] = bindings.map((b) => {
    const el = byElement.get(b.elementId);
    const kind: WireKind = b.versionId
      ? "override"
      : el?.fromGenId
        ? "created"
        : "inherited";
    return {
      key: `${b.elementId}:${b.attributeId ?? "bundle"}→${bySlotKey(b)}`,
      elementId: b.elementId,
      attributeId: b.attributeId,
      shotId: b.shotId,
      slot: bySlotKey(b),
      kind,
    };
  });

  return {
    assets,
    shots,
    links,
    counts: {
      locked: shown.filter((e) => e.locked).length,
      overrides: bindings.filter((b) => b.versionId !== null).length,
      created: shown.filter((e) => e.fromGenId).length,
    },
  };
}

export type { ElementFull };
