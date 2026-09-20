import type { Asset, CanvasNode, Project } from "../workbench/studio";
import { soulReferenceKey, type SoulIdentity, type SoulIdentityState } from "../workbench/soul-identity";
import { isShotNode } from "./shots";

/**
 * Cast & Elements, derived from the draft and the project's identities —
 * the same records the workbench's Cast stage reads (Studio renderLibrary
 * 'characters': Character assets are cast; Element, Environment, Prop and
 * Look assets are elements; an identity binds through asset.soulIdentityId).
 * An identity trained for this project but not attached to any asset is
 * listed too, in its subject's group. Pure: same inputs, same cards.
 */

export type CastGroup = "cast" | "elements";
export type CastTone = "green" | "blue" | "amber" | "red" | "grey";
export type CastReference = { key: string; url: string };

export type CastCard = {
  /** The asset id, or `identity:<id>` for an identity with no asset. */
  id: string;
  group: CastGroup;
  name: string;
  sub: string;
  badge: string;
  tag: string;
  tone: CastTone;
  asset: Asset | null;
  identity: SoulIdentity | null;
  /** Cover image URL. */
  url: string | null;
  references: CastReference[];
  /** Shot node ids (Rig) whose inputs cite this card. */
  citedBy: string[];
  /** How many more references a draft needs before it can be locked; null when unknown. */
  needs: number | null;
};

export const CAST_CATEGORIES = ["Character"];
export const ELEMENT_CATEGORIES = ["Element", "Environment", "Prop", "Look"];

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const referenceUrl = (ref: { uploadId?: string; genId?: string }) =>
  ref.uploadId ? `/api/uploads/${encodeURIComponent(ref.uploadId)}` : ref.genId ? `/api/media/${encodeURIComponent(ref.genId)}` : null;

/** Shot nodes whose linked inputs resolve to one of `assetIds`. */
export function citingShots(project: Project, assetIds: ReadonlySet<string>): string[] {
  if (!assetIds.size) return [];
  const nodes = new Map<string, CanvasNode>([...(project.sharedNodes ?? []), ...project.nodes].map((n) => [n.id, n]));
  return project.nodes
    .filter(isShotNode)
    .filter((shot) => shot.linked.some((id) => {
      const input = nodes.get(id);
      return !!input && !input.bypassed && !!input.assetId && assetIds.has(input.assetId);
    }))
    .map((shot) => shot.id);
}

function identityTag(identity: SoulIdentity): { tag: string; tone: CastTone } {
  switch (identity.status) {
    case "ready": return { tag: "Identity locked", tone: "green" };
    case "failed": return { tag: "Identity failed", tone: "red" };
    case "uncertain": return { tag: "Identity needs review", tone: "amber" };
    default: return { tag: "Identity training", tone: "blue" };
  }
}

export function castCards(project: Project, identityState: Pick<SoulIdentityState, "identities" | "terms"> | null): CastCard[] {
  const identities = identityState?.identities ?? [];
  const minPhotos = identityState?.terms?.minPhotos ?? null;
  const assets = project.assets;
  const cards: CastCard[] = [];

  for (const asset of assets) {
    const group: CastGroup | null = CAST_CATEGORIES.includes(asset.category) ? "cast" : ELEMENT_CATEGORIES.includes(asset.category) ? "elements" : null;
    if (!group) continue;
    const identity = asset.soulIdentityId ? identities.find((i) => i.id === asset.soulIdentityId) ?? null : null;
    const references: CastReference[] = identity
      ? identity.references.flatMap((ref) => { const url = referenceUrl(ref); return url ? [{ key: soulReferenceKey(ref), url }] : []; })
      : [asset, ...assets.filter((a) => a.parentId === asset.id)]
          .filter((a) => a.kind === "image" && a.url)
          .map((a) => ({ key: a.id, url: a.url }));
    const bound = new Set([asset.id, ...(asset.soulIdentityId ? assets.filter((a) => a.soulIdentityId === asset.soulIdentityId).map((a) => a.id) : [])]);
    const citedBy = citingShots(project, bound);
    const needs = group === "cast" && !identity && minPhotos != null ? Math.max(0, minPhotos - references.length) : null;
    const { tag, tone } = identity
      ? identityTag(identity)
      : asset.soulIdentityId
        ? { tag: "Identity attached", tone: "grey" as const }
        : group === "cast"
          ? needs ? { tag: `Draft · needs ${needs.toLocaleString("en-US")} more`, tone: "grey" as const } : { tag: "Draft", tone: "grey" as const }
          : citedBy.length ? { tag: `Cited by ${plural(citedBy.length, "shot")}`, tone: "blue" as const } : { tag: "Not cited yet", tone: "grey" as const };
    const detail = (asset.description ?? "").trim();
    cards.push({
      id: asset.id,
      group,
      name: asset.name,
      sub: group === "cast"
        ? [plural(references.length, "reference"), identity ? null : "draft identity"].filter(Boolean).join(" · ")
        : [asset.category, detail].filter(Boolean).join(" · "),
      badge: group === "cast" ? (identity || asset.soulIdentityId ? "IDENTITY" : "CAST") : asset.category.toUpperCase(),
      tag, tone, asset, identity,
      url: asset.kind === "image" && asset.url ? asset.url : references[0]?.url ?? null,
      references, citedBy, needs,
    });
  }

  /* Identities trained for this project that no asset carries yet. */
  const attached = new Set(assets.map((a) => a.soulIdentityId).filter(Boolean));
  for (const identity of identities) {
    if (attached.has(identity.id) || (identity.projectId && identity.projectId !== project.id)) continue;
    const group: CastGroup = identity.subjectType === "element" ? "elements" : "cast";
    const references = identity.references.flatMap((ref) => { const url = referenceUrl(ref); return url ? [{ key: soulReferenceKey(ref), url }] : []; });
    const { tag, tone } = identityTag(identity);
    cards.push({
      id: `identity:${identity.id}`, group, name: identity.name,
      sub: [plural(references.length, "reference"), "not in a shot yet"].join(" · "),
      badge: "IDENTITY", tag, tone, asset: null, identity,
      url: identity.previewUrl ?? references[0]?.url ?? null,
      references, citedBy: [], needs: null,
    });
  }
  /* Grid order: every cast card, then every element — ← → walk what is on screen. */
  return [...cards.filter((c) => c.group === "cast"), ...cards.filter((c) => c.group === "elements")];
}

