import { z } from 'zod';
import type { Asset } from '../workbench/studio';

const id = z.string().min(1).max(120);
/** This is executable Blender Python, never server-side JavaScript. Its execution
 * boundary is the isolated native worker, not a Python keyword deny-list. */
export const astraNativeSchema = z.object({
  schemaVersion: z.literal(1), name: z.string().trim().min(1).max(160),
  program: z.string().min(1).max(180000).refine(value => !value.includes('\0'), 'Python cannot contain NUL bytes.'),
  assetIds: z.array(id).max(64).refine(ids => new Set(ids).size === ids.length, 'Use distinct asset IDs.'),
  baseBlendAssetId: id.optional(),
}).strict();
export type AstraNativeSource = z.infer<typeof astraNativeSchema>;
export const astraNativeProposalSchema = z.object({
  baseSceneDigest: z.string().regex(/^[a-f0-9]{64}$/),
  baseNativeDigest: z.string().regex(/^[a-f0-9]{64}$/), source: astraNativeSchema,
}).strict();
export type AstraNativeProposal = z.infer<typeof astraNativeProposalSchema>;
export const astraNativeResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  steps: z.array(z.string().min(1).max(1000)).min(1).max(8),
  sourceJson: z.string().min(1).max(190000),
}).strict();
export function serializeAstraNative(source?: AstraNativeSource) {
  return source ? JSON.stringify(astraNativeSchema.parse(source)) : 'null';
}
export async function astraNativeDigest(source?: AstraNativeSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeAstraNative(source)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function isAstraBlendAsset(asset: Pick<Asset, 'kind' | 'mime' | 'name'>) {
  return asset.kind === 'document' && (asset.mime === 'application/x-blender' || /\.blend$/i.test(asset.name));
}
export function validateAstraNativeBindings(source: AstraNativeSource, assets: Pick<Asset, 'id' | 'kind' | 'mime' | 'name'>[]) {
  const available = new Map(assets.map(asset => [asset.id, asset]));
  for (const assetId of [...source.assetIds, ...(source.baseBlendAssetId ? [source.baseBlendAssetId] : [])]) {
    const asset = available.get(assetId);
    if (!asset) throw new Error('A native Blender input is no longer in this project.');
    if (assetId === source.baseBlendAssetId ? !isAstraBlendAsset(asset) : !(asset.kind === 'image' || asset.kind === 'document' && asset.mime === 'model/gltf-binary')) throw new Error('Native Blender inputs must be images, embedded GLB models or the selected base .blend file.');
  }
}
export function validateAstraNativeResult(value: z.infer<typeof astraNativeResultSchema>, assets: Pick<Asset, 'id' | 'kind' | 'mime' | 'name'>[]) {
  const source = astraNativeSchema.parse(JSON.parse(value.sourceJson));
  validateAstraNativeBindings(source, assets);
  return source;
}
