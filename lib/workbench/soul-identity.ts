import type { Asset, Project } from './studio';
import { mediaReferenceIdentity } from './media-reference-input';

export type SoulReference = { uploadId?: string; genId?: string };
export type SoulIdentity = {
  id: string; projectId: string | null; name: string; description: string;
  subjectType: 'character' | 'element'; references: SoulReference[];
  status: 'submitting' | 'training' | 'ready' | 'failed' | 'uncertain';
  previewUrl: string | null; createdAt: number; updatedAt: number;
  creditsBilled: number | null; error: string | null;
};
export type SoulIdentityState = {
  identities: SoulIdentity[]; configured: boolean; generationAvailable?: boolean;
  terms: { minPhotos: number; maxPhotos: number; trainingCredits: number | null; trainingCostUsd?: number | null };
};

export function soulReferenceKey(reference: SoulReference) {
  return reference.uploadId ? `upload:${reference.uploadId}` : reference.genId ? `generation:${reference.genId}` : '';
}

/** Only original, authorized media IDs are sent; previews and arbitrary URLs are not training inputs. */
export function soulReferenceAssets(assets: Asset[]) {
  const seen = new Set<string>();
  return assets.filter(asset => {
    const reference = asset.kind === 'image' ? mediaReferenceIdentity(asset) : null;
    const key = reference && soulReferenceKey(reference);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Bind the local identity and its original portrait to the ordinary asset/node workflow. */
export function soulIdentityAsset(project: Project, identity: SoulIdentity, category: 'Character' | 'Element', assetId?: string): Asset {
  if (identity.status !== 'ready') throw new Error('This identity is not ready to use.');
  const existing = assetId ? project.assets.find(asset => asset.id === assetId) : undefined;
  if (assetId && !existing) throw new Error('The original asset is no longer in this project.');
  if (existing?.locked) throw new Error('Unlock this asset before changing its identity.');
  const reference = identity.references[0];
  if (!reference || !soulReferenceKey(reference)) throw new Error('This identity has no original portrait reference.');
  const originals = [...project.assets, ...(project.sharedAssets ?? [])];
  const cover = originals.find(asset => asset.kind === 'image' && soulReferenceKey(mediaReferenceIdentity(asset) ?? {}) === soulReferenceKey(reference));
  return {
    ...existing,
    id: existing?.id ?? `soul-${crypto.randomUUID().slice(0, 8)}`,
    name: existing?.name ?? identity.name,
    kind: 'image', category, url: reference.uploadId ? `/api/uploads/${encodeURIComponent(reference.uploadId)}` : `/api/media/${encodeURIComponent(reference.genId!)}`,
    description: identity.description || existing?.description || 'Reusable character likeness · Identity',
    prompt: existing?.prompt || cover?.prompt || '',
    status: 'Draft', locked: false, version: (existing?.version ?? 0) + 1,
    // Training portraits stay on the identity record. They are not ordinary
    // generation references; the trained-likeness engine accepts none.
    refs: existing?.refs ?? [],
    ...(existing?.parentId ? { parentId: existing.parentId } : {}),
    mime: cover?.mime,
    uploadId: reference.uploadId, generationId: reference.genId,
    soulIdentityId: identity.id,
  };
}

/** What a Cast & Elements card says about its identity. `unknown` means the
 * binding exists but the workspace list has not answered yet (or no longer
 * lists it); the card never claims readiness it has not read. */
export type IdentityCardState = 'none' | 'training' | 'ready' | 'failed' | 'unknown';
export const identityCardLabels: Record<IdentityCardState, string> = {
  none: 'No identity', training: 'Identity training', ready: 'Identity ready', failed: 'Identity failed', unknown: 'Identity attached',
};
export function identityCardState(asset: Pick<Asset, 'soulIdentityId'>, identities: SoulIdentity[] | null): IdentityCardState {
  if (!asset.soulIdentityId) return 'none';
  const identity = identities?.find(value => value.id === asset.soulIdentityId);
  if (!identity) return 'unknown';
  if (identity.status === 'ready') return 'ready';
  if (identity.status === 'failed' || identity.status === 'uncertain') return 'failed';
  return 'training';
}
